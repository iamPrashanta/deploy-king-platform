import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, permissionProcedure, adminProcedure } from "../trpc";
import { db, backups, backupPolicies, backupDestinations, dbConnections, dbInstances, siteEnvVars, sites, type DbInstance } from "@dbbkp/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { logAudit } from "@dbbkp/audit";
import { decrypt, encrypt } from "@dbbkp/security";
import { localConn, localHost, maskedUrl, parsePgUrl, probe, urlConn } from "@dbbkp/backup";
import { PERMISSIONS } from "../../utils/rbac";
import { requireSite, visibleSites } from "../../services/team";
import { describePolicy, removePolicySchedule } from "../../services/backups";
import { databaseQueue } from "../../queues";
import crypto from "node:crypto";

/**
 * Databases (panel: Data · Databases). PostgreSQL databases Deploy King made on this server, and existing ones
 * connected by URL. Passwords are never sent to the panel, except to an admin who asks to see one (audited).
 */

const decryptOr = (p: { encryptedValue: string; iv: string; authTag: string }) => {
  try {
    return decrypt(p);
  } catch {
    return null;
  }
};

// Size and version, asked of PostgreSQL at most once a minute per database.
const probes = new Map<string, { at: number; value: Awaited<ReturnType<typeof probe>> }>();
async function probeCached(row: DbInstance, url: string | null) {
  const hit = probes.get(row.id);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = row.type === "mysql" ? ({ ok: false, error: "MySQL is not available yet." } as const) : await probe(url ? urlConn(url) : localConn(row.name));
  probes.set(row.id, { at: Date.now(), value });
  return value;
}

/** The app variable that holds this database's URL, if there is one. Its value stays on the server. */
async function linkedVariable(row: DbInstance): Promise<{ key: string; value: string } | null> {
  if (!row.siteId) return null;
  const vars = await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, row.siteId));
  const hits: Array<{ key: string; value: string }> = [];
  for (const v of vars) {
    const value = decryptOr({ encryptedValue: v.encryptedValue, iv: v.iv, authTag: v.authTag });
    const p = value ? parsePgUrl(value) : null;
    if (p && p.database === row.name) hits.push({ key: v.key, value: value! });
  }
  return hits.find((h) => h.key === "DATABASE_URL") ?? hits[0] ?? null;
}

async function describeDb(row: DbInstance) {
  const [conn] = await db.select().from(dbConnections).where(eq(dbConnections.dbInstanceId, row.id)).limit(1);
  const url = conn ? decryptOr({ encryptedValue: conn.encryptedUrl, iv: conn.iv, authTag: conn.authTag }) : null;
  const where = conn ? { host: conn.host, port: conn.port } : localHost();
  const user = (url && parsePgUrl(url)?.user) || row.dbUser;
  const key = `db:${row.id}`;
  const [site] = row.siteId ? await db.select({ id: sites.id, domain: sites.domain }).from(sites).where(eq(sites.id, row.siteId)).limit(1) : [];
  const [last] = await db.select().from(backups).where(and(eq(backups.targetKey, key), inArray(backups.status, ["ok", "partial", "failed"]))).orderBy(desc(backups.createdAt)).limit(1);
  const [running] = await db.select({ id: backups.id, status: backups.status }).from(backups).where(and(eq(backups.targetKey, key), inArray(backups.status, ["queued", "running"]))).limit(1);
  const [policy] = await db.select().from(backupPolicies).where(eq(backupPolicies.targetKey, key)).limit(1);
  const destNames = policy?.destinationIds.length ? new Map((await db.select().from(backupDestinations).where(inArray(backupDestinations.id, policy.destinationIds))).map((d) => [d.id, d.name])) : new Map<string, string>();
  const p = await probeCached(row, conn ? url : null);
  const variable = await linkedVariable(row).catch(() => null);
  const major = p.ok ? p.version.split(".")[0] : null;
  return {
    id: row.id, name: row.name, type: row.type, dbUser: user, siteId: row.siteId, createdAt: row.createdAt,
    engine: row.type === "mysql" ? "MySQL" : "PostgreSQL", version: p.ok ? p.version : null, engineLabel: `${row.type === "mysql" ? "MySQL" : "PostgreSQL"}${major ? " " + major : ""}${conn ? " · external" : ""}`,
    external: !!conn,
    app: site ? { id: site.id, name: site.domain.split(".")[0], domain: site.domain } : null,
    state: p.ok ? "running" : "unreachable", stateError: p.ok ? null : (p as { error: string }).error,
    sizeBytes: p.ok ? p.sizeBytes : null,
    host: where.host, port: where.port,
    connection: maskedUrl({ user, host: where.host, port: where.port, database: conn?.database ?? row.name }),
    variable: variable ? { key: variable.key, app: site?.domain.split(".")[0] ?? null } : null,
    lastBackup: last ? { id: last.id, status: last.status, at: last.finishedAt ?? last.createdAt, error: last.error } : null,
    backingUp: !!running,
    policy: policy ? describePolicy(policy, policy.destinationIds.map((id) => destNames.get(id)).filter(Boolean) as string[]) : null,
  };
}

async function visibleRows(user: { sub: string; role: string }) {
  const limit = await visibleSites(user);
  if (!limit) return db.select().from(dbInstances).orderBy(sql`created_at DESC`);
  const ids = (await db.select({ id: sites.id }).from(sites).where(limit)).map((s) => s.id);
  if (!ids.length) return [];
  return db.select().from(dbInstances).where(inArray(dbInstances.siteId, ids)).orderBy(sql`created_at DESC`);
}

/** The database, if this user may see it. Not found otherwise. */
async function requireDb(user: { sub: string; role: string }, id: string) {
  const [row] = await db.select().from(dbInstances).where(eq(dbInstances.id, id)).limit(1);
  const notFound = new TRPCError({ code: "NOT_FOUND", message: "Database not found" });
  if (!row) throw notFound;
  if (user.role !== "admin") {
    if (!row.siteId) throw notFound;
    await requireSite(user, row.siteId).catch(() => { throw notFound; });
  }
  return row;
}

const nameRule = z.string().min(3).max(30).regex(/^[a-z0-9_]+$/, "Use 3 to 30 lowercase letters, digits and _.");

export const databaseRouter = router({
  // Admins see every database; everyone else only those attached to an app they may see.
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows = await visibleRows(ctx.user!);
    return Promise.all(rows.map(describeDb));
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => describeDb(await requireDb(ctx.user!, input.id))),

  create: permissionProcedure(PERMISSIONS.DATABASE_CREATE)
    .input(
      z.object({
        name: nameRule,
        type: z.enum(["pgsql", "mysql"]).default("pgsql"),
        dbUser: nameRule,
        siteId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // A database for an app needs that app; one that belongs to no app is the admin's to create.
      if (input.siteId) await requireSite(ctx.user!, input.siteId);
      else if (ctx.user!.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Choose the app this database is for." });
      if (input.type !== "pgsql") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MySQL databases are not available yet." });
      const dbPass = crypto.randomBytes(12).toString("hex");

      const existing = await db.select().from(dbInstances).where(eq(dbInstances.name, input.name)).limit(1);
      if (existing.length > 0) throw new TRPCError({ code: "CONFLICT", message: "Database name already in use." });

      const [newInstance] = await db.insert(dbInstances).values({
        id: crypto.randomUUID(),
        name: input.name,
        type: input.type,
        dbUser: input.dbUser,
        siteId: input.siteId,
      }).returning();

      await databaseQueue.add("create-postgres", {
        instanceId: newInstance!.id,
        dbName: input.name,
        dbUser: input.dbUser,
        dbPass: dbPass,
      });
      logAudit("db_create", { actorId: ctx.user!.sub, targetId: newInstance!.id, targetType: "db", targetName: input.name, metadata: { type: input.type, dbUser: input.dbUser, siteId: input.siteId ?? null }, ip: ctx.ip ?? undefined });

      const where = localHost();
      return {
        instance: newInstance!,
        // Shown once. Deploy King does not keep the password.
        credentials: {
          username: input.dbUser,
          password: dbPass,
          host: where.host,
          port: where.port,
          database: input.name,
          url: `postgres://${input.dbUser}:${dbPass}@${where.host}:${where.port}/${input.name}`,
        },
      };
    }),

  /** Adds an existing PostgreSQL database by URL, after checking that it answers. */
  connectExisting: permissionProcedure(PERMISSIONS.DATABASE_CREATE)
    .input(z.object({ name: nameRule, url: z.string().min(10).max(1000), siteId: z.string().uuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      if (input.siteId) await requireSite(ctx.user!, input.siteId);
      else if (ctx.user!.role !== "admin") throw new TRPCError({ code: "FORBIDDEN", message: "Choose the app this database is for." });
      const p = parsePgUrl(input.url.trim());
      if (!p) throw new TRPCError({ code: "BAD_REQUEST", message: "Paste a PostgreSQL URL: postgres://user:password@host:5432/database. MySQL is not available yet." });
      const [taken] = await db.select({ id: dbInstances.id }).from(dbInstances).where(eq(dbInstances.name, input.name)).limit(1);
      if (taken) throw new TRPCError({ code: "CONFLICT", message: "Database name already in use." });
      const answer = await probe(urlConn(input.url.trim()));
      if (!answer.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Could not connect: ${(answer as { error: string }).error}` });
      const e = encrypt(input.url.trim());
      const [row] = await db.insert(dbInstances).values({ name: input.name, type: "pgsql", dbUser: p.user, siteId: input.siteId }).returning();
      await db.insert(dbConnections).values({ dbInstanceId: row!.id, host: p.host, port: p.port, database: p.database, encryptedUrl: e.encryptedValue, iv: e.iv, authTag: e.authTag });
      logAudit("db_connect", { actorId: ctx.user!.sub, targetId: row!.id, targetType: "db", targetName: input.name, metadata: { host: p.host, port: p.port, database: p.database, user: p.user, siteId: input.siteId ?? null }, ip: ctx.ip ?? undefined });
      const ok = answer as { version: string; sizeBytes: number };
      return { id: row!.id, version: ok.version, sizeBytes: ok.sizeBytes };
    }),

  /** The full connection URL with its password, for an admin. Audited. */
  revealConnection: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const row = await requireDb(ctx.user!, input.id);
    const [conn] = await db.select().from(dbConnections).where(eq(dbConnections.dbInstanceId, row.id)).limit(1);
    let url: string | null = null;
    let from = "";
    if (conn) {
      url = decryptOr({ encryptedValue: conn.encryptedUrl, iv: conn.iv, authTag: conn.authTag });
      from = "the stored connection";
    } else {
      const v = await linkedVariable(row);
      if (v) { url = v.value; from = `the app's ${v.key} variable`; }
    }
    if (!url) throw new TRPCError({ code: "NOT_FOUND", message: "Deploy King does not keep this password: it was shown once when the database was made. Put it in the app's variables to keep it." });
    logAudit("secret_read", { actorId: ctx.user!.sub, targetId: row.id, targetType: "db", targetName: row.name, metadata: { what: "connection url", from }, ip: ctx.ip ?? undefined });
    return { url, from };
  }),

  delete: permissionProcedure(PERMISSIONS.DATABASE_CREATE)
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const row = await requireDb(ctx.user!, input.id);
      const [policy] = await db.select({ id: backupPolicies.id }).from(backupPolicies).where(eq(backupPolicies.targetKey, `db:${row.id}`)).limit(1);
      if (policy) await removePolicySchedule(policy.id);
      // NOTE: For safety in this early version, we only delete the DB record.
      // We don't automatically drop production databases from PostgreSQL to prevent data loss.
      // The user must drop them manually or we can add a specific `forceDrop` flag later. Its backups are kept.
      await db.delete(dbInstances).where(eq(dbInstances.id, input.id));
      logAudit("db_delete", { actorId: ctx.user!.sub, targetId: row.id, targetType: "db", targetName: row.name, metadata: { recordOnly: true }, ip: ctx.ip ?? undefined });
      return { success: true, message: "Database record deleted. Physical DB preserved for safety." };
    }),
});
