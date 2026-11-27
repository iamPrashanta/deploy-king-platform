import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { users } from "./schema";

/**
 * Start-up steps for a new install or an update, so neither needs a manual command:
 *   1. apply every migration in packages/db/drizzle that has not run yet
 *   2. create the first admin when the users table is empty
 *
 * Both are safe to run on every start. The migrations use the same bookkeeping table as
 * `drizzle-kit migrate` (drizzle.__drizzle_migrations), so the two can be mixed.
 */

const MIGRATIONS_DIR = process.env.DB_MIGRATIONS_DIR || path.resolve(__dirname, "../drizzle");
// Any fixed number; only processes that run these start-up steps take it.
const LOCK_KEY = 72_011_905;

function connectionString() {
  return process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/dbbkp_panel";
}

/** Waits for the database to accept connections (a container may still be starting). */
async function waitForDatabase(sql: postgres.Sql, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    try {
      await sql`select 1`;
      return;
    } catch (err: any) {
      if (Date.now() > until) throw new Error(`The database did not answer within ${Math.round(timeoutMs / 1000)}s: ${err?.message ?? err}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

export async function runMigrations(opts: { timeoutMs?: number } = {}) {
  if (!fs.existsSync(path.join(MIGRATIONS_DIR, "meta", "_journal.json"))) {
    throw new Error(`No migrations found in ${MIGRATIONS_DIR}`);
  }
  // One connection of its own: the advisory lock belongs to the session that took it.
  const sql = postgres(connectionString(), { max: 1, onnotice: () => {} });
  try {
    await waitForDatabase(sql, opts.timeoutMs ?? 60_000);
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      await migrate(drizzle(sql), { migrationsFolder: MIGRATIONS_DIR });
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Creates the first admin when no user exists yet.
 * The password comes from INITIAL_ADMIN_PASSWORD (the installer sets it and prints it);
 * without it, one is made up and printed once in the log. The admin is asked to change it
 * at the first sign-in. Returns the user name when a user was created.
 */
export async function ensureFirstAdmin(): Promise<string | null> {
  const sql = postgres(connectionString(), { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(sql);
    await sql`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      const existing = await db.select({ id: users.id }).from(users).limit(1);
      if (existing.length > 0) return null;

      const username = (process.env.INITIAL_ADMIN_USERNAME || "admin").trim();
      const email = (process.env.INITIAL_ADMIN_EMAIL || `${username}@dbbkp.local`).trim();
      const given = process.env.INITIAL_ADMIN_PASSWORD || "";
      const password = given || crypto.randomBytes(18).toString("base64url");

      await db.insert(users).values({
        id: crypto.randomUUID(),
        username,
        email,
        passwordHash: await bcrypt.hash(password, 12),
        role: "admin",
        mustChangePassword: true,
      });

      console.log(`[DB] First admin created: user name "${username}".`);
      if (given) {
        console.log("[DB] Its password is INITIAL_ADMIN_PASSWORD. It must be changed at the first sign-in.");
      } else {
        console.log(`[DB] Password (shown once, change it at the first sign-in): ${password}`);
      }
      return username;
    } finally {
      await sql`select pg_advisory_unlock(${LOCK_KEY})`.catch(() => {});
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}
