import { spawn } from "node:child_process";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { hidePasswords, parsePgUrl } from "./names";

/**
 * How Deploy King reaches a PostgreSQL server, and the PostgreSQL tools it runs against it.
 *
 * Databases Deploy King created live on the server's own PostgreSQL. It is reached
 *   - with DK_PG_ADMIN_URL (a superuser URL, e.g. postgres://postgres:...@dbbkp-postgres:5432/postgres) when set, or
 *   - as the postgres system user through sudo, the way the database worker creates them.
 * Connected ("existing") databases use their own stored URL.
 * Passwords go to the tools through PGPASSWORD, never on the command line.
 * DK_PG_BIN may name the folder of pg_dump, pg_restore and psql (default: the PATH).
 */

export type PgConn =
  | { kind: "env"; env: Record<string, string>; user: string; host: string; port: number; database: string }
  | { kind: "sudo"; database: string; user: "postgres"; host: string; port: number };

export const pgBin = (name: string) => (process.env.DK_PG_BIN ? path.join(process.env.DK_PG_BIN, name) : name);

export class PgError extends Error {}

function fromUrl(url: string, database?: string): PgConn {
  const p = parsePgUrl(url);
  if (!p) throw new PgError("That is not a PostgreSQL URL (postgres://user:password@host:5432/database).");
  const env: Record<string, string> = { PGHOST: p.host, PGPORT: String(p.port), PGUSER: p.user, PGPASSWORD: p.password, PGDATABASE: database ?? p.database };
  const ssl = p.params.get("sslmode");
  if (ssl) env.PGSSLMODE = ssl;
  return { kind: "env", env, user: p.user, host: p.host, port: p.port, database: database ?? p.database };
}

/** The server's own PostgreSQL, for one database on it. */
export function localConn(database: string): PgConn {
  const url = process.env.DK_PG_ADMIN_URL;
  if (url) return fromUrl(url, database);
  return { kind: "sudo", database, user: "postgres", host: "127.0.0.1", port: 5432 };
}

/** A connected database, from its stored URL. */
export const urlConn = (url: string) => fromUrl(url);

export function withDatabase(conn: PgConn, database: string): PgConn {
  if (conn.kind === "sudo") return { ...conn, database };
  return { ...conn, database, env: { ...conn.env, PGDATABASE: database } };
}

/** Host and port the app databases are reached on, for the connection string shown in the panel. */
export function localHost(): { host: string; port: number } {
  const p = process.env.DK_PG_ADMIN_URL ? parsePgUrl(process.env.DK_PG_ADMIN_URL) : null;
  return p ? { host: p.host, port: p.port } : { host: "127.0.0.1", port: 5432 };
}

export const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;
export const literal = (s: string) => `'${s.replace(/'/g, "''")}'`;

type RunOpts = { stdout?: Writable; stdin?: Readable; timeoutMs?: number; connect?: boolean };

/** Runs a PostgreSQL tool. With `connect`, it is pointed at the connection's database (-d). */
export function runPg(conn: PgConn, bin: string, args: string[], opts: RunOpts = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const connect = opts.connect !== false;
  const full = connect ? [...args, "-d", conn.database] : args;
  const spec =
    conn.kind === "sudo"
      ? { cmd: "sudo", args: ["-n", "-u", "postgres", pgBin(bin), ...full], env: process.env }
      : { cmd: pgBin(bin), args: full, env: { ...process.env, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? "8", ...conn.env } };
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(spec.cmd, spec.args, { env: spec.env as NodeJS.ProcessEnv, stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"] });
    const done = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr: hidePasswords((stderr + extra).trim()).slice(-4000) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(null, `\nStopped: ${bin} took longer than ${Math.round((opts.timeoutMs ?? 0) / 60000)} minutes.`);
    }, opts.timeoutMs ?? 2 * 3600_000);
    child.on("error", (e: any) => done(null, e?.code === "ENOENT" ? `${conn.kind === "sudo" ? "sudo" : bin} is not installed where Deploy King runs.` : String(e?.message ?? e)));
    if (opts.stdout) child.stdout!.pipe(opts.stdout, { end: false });
    else child.stdout!.on("data", (d) => (stdout += d.toString()));
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    if (opts.stdin && child.stdin) {
      opts.stdin.pipe(child.stdin);
      child.stdin.on("error", () => {});
    }
    child.on("close", (code) => done(code));
  });
}

/** One SQL statement through psql; returns the rows as text (tab separated). Throws with psql's message on failure. */
export async function psql(conn: PgConn, sql: string): Promise<string> {
  const r = await runPg(conn, "psql", ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-tA", "-c", sql]);
  if (r.code !== 0) throw new PgError(firstError(r.stderr) || "psql failed");
  return r.stdout.trim();
}

/** The line of PostgreSQL output worth showing a person. */
export function firstError(stderr: string) {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /error|fatal|could not|not installed|stopped|denied|refused/i.test(l)) ?? lines[0] ?? "").replace(/^(pg_dump|pg_restore|psql): /, "").slice(0, 400);
}

export async function isSuperuser(conn: PgConn) {
  if (conn.kind === "sudo") return true;
  return (await psql(conn, "select rolsuper from pg_roles where rolname = current_user")) === "t";
}

/** Size in bytes and server version, or why it cannot be reached. */
export async function probe(conn: PgConn): Promise<{ ok: true; sizeBytes: number; version: string } | { ok: false; error: string }> {
  try {
    const out = await psql(conn, "select pg_database_size(current_database()) || '|' || current_setting('server_version')");
    const [size, version] = out.split("|");
    return { ok: true, sizeBytes: Number(size), version: (version ?? "").split(" ")[0] ?? "" };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}
