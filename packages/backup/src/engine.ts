import crypto from "node:crypto";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import fs from "fs-extra";
import tar from "tar";
import Docker from "dockerode";
import { and, desc, eq, inArray } from "drizzle-orm";
import {
  db, backups, backupDestinations, backupPolicies, backupRestores, dbInstances, dbConnections, sites,
  type Backup, type BackupCopy, type BackupDestination, type BackupRestore, type DbInstance, type RestoreStep,
} from "@dbbkp/db";
import { decrypt, encrypt } from "@dbbkp/security";
import { backupFileName, overKeep, parseTargetKey, targetFolder, targetKey, type TargetRef } from "./names";
import { PgError, firstError, ident, isSuperuser, localConn, psql, runPg, urlConn, withDatabase, type PgConn } from "./pg";
import { fetchCopy, localBackupDir, putFile, removeCopy, sha256File, verifyCopy } from "./destinations";
import { insideRoot, volumeDir } from "./volumes";

/**
 * Runs backups and restores. Called by the worker (queue "backup": run-backup, scheduled-backup, run-restore)
 * and directly by the checks. Every backup is checksummed with SHA-256, tried up to 3 times, copied to each
 * destination and read back there; restores verify the checksum, can take a safety backup first and can stop the app.
 */

export const MAX_ATTEMPTS = 3;
const docker = new Docker();
const retryDelayMs = () => Number(process.env.DK_BACKUP_RETRY_DELAY_MS ?? 20_000);
const staging = () => path.join(localBackupDir(), ".staging");

export type Target = {
  key: string;
  ref: TargetRef;
  type: "database" | "volume";
  name: string;
  engine: "pgsql" | "mysql" | "files";
  siteId: string | null;
  instance?: DbInstance;
  external?: boolean;
  volume?: string;
};

export class TargetGone extends Error {}

export async function describeTarget(ref: TargetRef): Promise<Target> {
  if (ref.type === "database") {
    const [instance] = await db.select().from(dbInstances).where(eq(dbInstances.id, ref.id)).limit(1);
    if (!instance) throw new TargetGone("This database is not in Deploy King any more.");
    const [conn] = await db.select({ id: dbConnections.dbInstanceId }).from(dbConnections).where(eq(dbConnections.dbInstanceId, instance.id)).limit(1);
    return { key: targetKey(ref), ref, type: "database", name: instance.name, engine: instance.type === "mysql" ? "mysql" : "pgsql", siteId: instance.siteId ?? null, instance, external: !!conn };
  }
  const [site] = await db.select().from(sites).where(eq(sites.id, ref.siteId)).limit(1);
  if (!site) throw new TargetGone("This app is not in Deploy King any more.");
  if (!(site.volumes ?? []).some((v) => v.name === ref.volume)) throw new TargetGone(`The app has no volume called ${ref.volume}.`);
  return { key: targetKey(ref), ref, type: "volume", name: `${site.domain.split(".")[0]}-${ref.volume}`, engine: "files", siteId: site.id, volume: ref.volume };
}

/** How to reach a database: its stored URL when it was connected, the server's own PostgreSQL otherwise. */
export async function connFor(instance: Pick<DbInstance, "id" | "name">): Promise<PgConn> {
  const [c] = await db.select().from(dbConnections).where(eq(dbConnections.dbInstanceId, instance.id)).limit(1);
  if (c) return urlConn(decrypt({ encryptedValue: c.encryptedUrl, iv: c.iv, authTag: c.authTag }));
  return localConn(instance.name);
}

/** "This server": always there, at DK_BACKUP_DIR. */
export async function ensureLocalDestination(): Promise<BackupDestination> {
  const [have] = await db.select().from(backupDestinations).where(eq(backupDestinations.builtIn, true)).limit(1);
  const location = localBackupDir();
  if (have) {
    if (have.location !== location) {
      const [u] = await db.update(backupDestinations).set({ location }).where(eq(backupDestinations.id, have.id)).returning();
      return u!;
    }
    return have;
  }
  const [row] = await db.insert(backupDestinations).values({ name: "This server", kind: "local", location, builtIn: true }).returning();
  return row!;
}

/** The destinations a backup of this target goes to: its schedule's, or "This server" when it has none. */
export async function destinationsFor(key: string): Promise<BackupDestination[]> {
  const [policy] = await db.select().from(backupPolicies).where(eq(backupPolicies.targetKey, key)).limit(1);
  const ids = policy?.destinationIds ?? [];
  const rows = ids.length ? await db.select().from(backupDestinations).where(inArray(backupDestinations.id, ids)) : [];
  return rows.length ? rows : [await ensureLocalDestination()];
}

export async function createBackup(target: Target, trigger: "manual" | "schedule" | "safety" | "retry", userId: string | null, policyId: string | null = null): Promise<Backup> {
  const [row] = await db.insert(backups).values({
    targetKey: target.key, targetType: target.type, dbInstanceId: target.instance?.id ?? null, siteId: target.siteId,
    volumeName: target.volume ?? null, targetName: target.name, engine: target.engine, trigger, status: "queued", createdBy: userId, policyId,
  }).returning();
  return row!;
}

/** Streams a source into a file, counting bytes and computing SHA-256 on the way. */
function hasher() {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  const t = new Transform({ transform(chunk, _enc, cb) { h.update(chunk); bytes += chunk.length; cb(null, chunk); } });
  return { t, result: () => ({ sha256: h.digest("hex"), bytes }) };
}

async function dumpDatabase(target: Target, file: string) {
  if (target.engine === "mysql") throw new Error("MySQL backups are not available yet.");
  const conn = await connFor(target.instance!);
  const { t, result } = hasher();
  const out = fs.createWriteStream(file);
  const written = pipeline(t, out);
  const r = await runPg(conn, "pg_dump", ["-Fc", "-Z", "6", "--no-password"], { stdout: t, timeoutMs: 4 * 3600_000 });
  t.end();
  await written;
  if (r.code !== 0) throw new Error(firstError(r.stderr) || `pg_dump stopped with code ${r.code}.`);
  return result();
}

async function archiveVolume(target: Target, file: string) {
  const dir = await volumeDir(target.siteId!, target.volume!);
  const { t, result } = hasher();
  await pipeline(tar.c({ gzip: true, cwd: dir, portable: true }, ["."]) as unknown as NodeJS.ReadableStream, t, fs.createWriteStream(file));
  return result();
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Runs one queued backup to the end. Safe to call for a backup that already finished (returns it as it is). */
export async function runBackup(backupId: string): Promise<Backup> {
  const [b] = await db.select().from(backups).where(eq(backups.id, backupId)).limit(1);
  if (!b) throw new Error("No such backup");
  if (b.status !== "queued") return b;
  const startedAt = new Date();
  await db.update(backups).set({ status: "running", startedAt }).where(eq(backups.id, b.id));
  const finish = async (set: Partial<Backup>) => {
    const [row] = await db.update(backups).set({ finishedAt: new Date(), durationMs: Date.now() - startedAt.getTime(), ...set }).where(eq(backups.id, b.id)).returning();
    return row!;
  };

  let target: Target;
  try {
    const ref = parseTargetKey(b.targetKey);
    if (!ref) throw new TargetGone("Unknown target.");
    target = await describeTarget(ref);
  } catch (e) {
    return finish({ status: "failed", error: msg(e) });
  }

  const fileName = backupFileName(target.name, target.engine, startedAt, b.trigger);
  const dir = staging();
  await fs.ensureDir(dir);
  const file = path.join(dir, `${b.id}-${fileName}`);
  let made: { sha256: string; bytes: number } | null = null;
  let lastError = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await db.update(backups).set({ attempts: attempt }).where(eq(backups.id, b.id));
    try {
      made = target.type === "database" ? await dumpDatabase(target, file) : await archiveVolume(target, file);
      break;
    } catch (e) {
      lastError = msg(e);
      await fs.remove(file).catch(() => {});
      // a missing tool or an engine that is not built will not fix itself
      if (/not available yet|not installed/.test(lastError)) { lastError += ` (attempt ${attempt} of ${MAX_ATTEMPTS}; not retried)`; break; }
      if (attempt < MAX_ATTEMPTS) await sleep(retryDelayMs() * attempt);
      else lastError += ` (attempt ${attempt} of ${MAX_ATTEMPTS})`;
    }
  }
  if (!made) return finish({ status: "failed", error: lastError, fileName });

  const dests = await destinationsFor(target.key);
  const copies: BackupCopy[] = [];
  for (const d of dests) {
    try {
      const location = await putFile(d, file, `${targetFolder(target.name)}/${fileName}`);
      const v = await verifyCopy(d, location, made.sha256);
      copies.push({ destinationId: d.id, name: d.name, kind: d.kind, location, ok: true, verified: v.ok, ...(v.error ? { error: v.error } : {}) });
    } catch (e) {
      copies.push({ destinationId: d.id, name: d.name, kind: d.kind, location: "", ok: false, verified: false, error: msg(e) });
    }
  }
  await fs.remove(file).catch(() => {});
  const good = copies.filter((c) => c.ok && c.verified);
  const status = good.length === copies.length ? "ok" : good.length ? "partial" : "failed";
  const error = status === "ok" ? null : copies.filter((c) => !(c.ok && c.verified)).map((c) => `${c.name}: ${c.error ?? "not verified"}`).join("; ");
  const row = await finish({ status, error: status === "failed" ? `Could not copy it anywhere. ${error}` : error, fileName, sizeBytes: made.bytes, sha256: made.sha256, copies });
  if (good.length) await pruneTarget(target.key).catch((e) => console.error("[backup] keep rule:", msg(e)));
  return row;
}

/** A scheduled run: makes the backup row and runs it. Paused or removed schedules do nothing. */
export async function runScheduledBackup(policyId: string): Promise<Backup | { skipped: string }> {
  const [p] = await db.select().from(backupPolicies).where(eq(backupPolicies.id, policyId)).limit(1);
  if (!p) return { skipped: "removed" };
  if (!p.enabled) return { skipped: "paused" };
  const ref = parseTargetKey(p.targetKey);
  if (!ref) return { skipped: "unknown target" };
  let target: Target;
  try {
    target = await describeTarget(ref);
  } catch (e) {
    return { skipped: msg(e) };
  }
  const b = await createBackup(target, "schedule", null, p.id);
  return runBackup(b.id);
}

const live = (c: BackupCopy) => c.ok && !c.removedAt;

/** Applies the keep rules: the schedule's "keep" for every destination, and each destination's own "keep last". */
export async function pruneTarget(key: string) {
  const [policy] = await db.select().from(backupPolicies).where(eq(backupPolicies.targetKey, key)).limit(1);
  const rows = (await db.select().from(backups).where(and(eq(backups.targetKey, key), inArray(backups.status, ["ok", "partial"])))).filter((r) => r.copies.some(live));
  const dests = new Map((await db.select().from(backupDestinations)).map((d) => [d.id, d]));
  const removals = new Map<string, Set<string>>(); // backup id -> destination ids
  const mark = (id: string, dest: string) => removals.set(id, (removals.get(id) ?? new Set()).add(dest));
  if (policy) for (const r of overKeep(rows, policy.keep)) for (const c of r.copies.filter(live)) mark(r.id, c.destinationId);
  for (const d of dests.values()) {
    if (!d.keepLast) continue;
    const here = rows.filter((r) => r.copies.some((c) => live(c) && c.destinationId === d.id));
    for (const r of overKeep(here, d.keepLast)) mark(r.id, d.id);
  }
  let removed = 0;
  for (const [id, destIds] of removals) {
    const r = rows.find((x) => x.id === id)!;
    const copies = await Promise.all(r.copies.map(async (c) => {
      if (!live(c) || !destIds.has(c.destinationId)) return c;
      const d = dests.get(c.destinationId);
      try {
        if (d) await removeCopy(d, c.location);
        removed++;
        return { ...c, removedAt: new Date().toISOString() };
      } catch (e) {
        return { ...c, error: `Could not remove it for the keep rule: ${msg(e)}` };
      }
    }));
    await db.update(backups).set({ copies }).where(eq(backups.id, id));
  }
  return { removed };
}

// ─── Restore ──────────────────────────────────────────────────────────────────

class RestoreStop extends Error {}

/** Runs one queued restore to the end. */
export async function runRestore(restoreId: string): Promise<BackupRestore> {
  const [r] = await db.select().from(backupRestores).where(eq(backupRestores.id, restoreId)).limit(1);
  if (!r) throw new Error("No such restore");
  if (r.status !== "queued") return r;
  const steps: RestoreStep[] = [];
  const step = async (text: string, ok = true) => {
    steps.push({ at: new Date().toISOString(), text, ok });
    await db.update(backupRestores).set({ steps }).where(eq(backupRestores.id, r.id));
  };
  const end = async (status: "ok" | "failed", error: string | null, extra: Partial<BackupRestore> = {}) => {
    const [row] = await db.update(backupRestores).set({ status, error, steps, finishedAt: new Date(), ...extra }).where(eq(backupRestores.id, r.id)).returning();
    return row!;
  };
  await db.update(backupRestores).set({ status: "running" }).where(eq(backupRestores.id, r.id));

  let changed = false;
  let safetyName: string | null = null;
  let fetched: { file: string; temp: boolean } | null = null;
  const stopped: string[] = [];
  try {
    const [b] = await db.select().from(backups).where(eq(backups.id, r.backupId)).limit(1);
    if (!b || !b.sha256) throw new RestoreStop("This backup has no file to restore.");
    const ref = parseTargetKey(b.targetKey);
    if (!ref) throw new RestoreStop("Unknown target.");
    const target = await describeTarget(ref).catch((e) => { throw new RestoreStop(msg(e)); });

    // 1. get the file: a copy on this server first
    const dests = new Map((await db.select().from(backupDestinations)).map((d) => [d.id, d]));
    const candidates = b.copies.filter((c) => live(c) && dests.has(c.destinationId)).sort((x, y) => (x.kind === "local" ? 0 : 1) - (y.kind === "local" ? 0 : 1));
    const problems: string[] = [];
    for (const c of candidates) {
      try {
        fetched = await fetchCopy(dests.get(c.destinationId)!, c.location, staging());
        await step(`Got the backup from ${c.name}.`);
        break;
      } catch (e) {
        problems.push(`${c.name}: ${msg(e)}`);
      }
    }
    if (!fetched) throw new RestoreStop(`No copy of this backup could be read. ${problems.join("; ")}`.trim());

    // 2. checksum
    if (r.verifyChecksum) {
      const { sha256 } = await sha256File(fetched.file);
      if (sha256 !== b.sha256) throw new RestoreStop("The file's SHA-256 does not match the one taken when the backup was made, so it was not used.");
      await step("Checksum matches (SHA-256).");
    }

    // 3. safety backup of what is about to be replaced
    if (r.into === "replace" && r.safetyBackup) {
      const sb = await createBackup(target, "safety", r.createdBy);
      await db.update(backupRestores).set({ safetyBackupId: sb.id }).where(eq(backupRestores.id, r.id));
      const done = await runBackup(sb.id);
      if (done.status !== "ok" && done.status !== "partial") throw new RestoreStop(`The safety backup failed: ${done.error ?? "unknown error"}`);
      safetyName = done.fileName;
      await step(`Safety backup taken: ${done.fileName}.`);
    }

    // 4. stop the app
    if (r.stopApp && target.siteId) {
      let running: Docker.ContainerInfo[];
      try {
        running = await docker.listContainers({ filters: { label: [`dbbkp.site=${target.siteId}`], status: ["running"] } });
      } catch {
        throw new RestoreStop("The container engine could not be reached, so the app could not be stopped.");
      }
      for (const c of running) {
        await docker.getContainer(c.Id).stop({ t: 30 }).catch((e: any) => { if (e?.statusCode !== 304) throw new RestoreStop(`Could not stop the app: ${msg(e)}`); });
        stopped.push(c.Id);
      }
      await step(running.length ? `Stopped the app (${running.length} container${running.length === 1 ? "" : "s"}).` : "The app was not running.");
    }

    // 5. restore
    const touch = () => { changed = true; };
    let resultDbInstanceId: string | null = null;
    if (target.type === "database") resultDbInstanceId = await restoreDatabase(r, target, fetched.file, step, touch);
    else await restoreFiles(r, target, fetched.file, step, touch);

    await startAgain(stopped, step);
    stopped.length = 0;
    return end("ok", null, resultDbInstanceId ? { resultDbInstanceId } : {});
  } catch (e) {
    const why = msg(e);
    await startAgain(stopped, step).catch(() => {});
    const note = !changed ? " Nothing was changed." : r.into === "new" ? " The live data was not touched." : safetyName ? ` The data from before is in the safety backup ${safetyName}.` : "";
    await step(why + note, false);
    return end("failed", why + note);
  } finally {
    if (fetched?.temp) await fs.remove(fetched.file).catch(() => {});
  }
}

async function startAgain(ids: string[], step: (t: string, ok?: boolean) => Promise<void>) {
  if (!ids.length) return;
  let failed = 0;
  for (const id of ids) await docker.getContainer(id).start().catch((e: any) => { if (e?.statusCode !== 304) failed++; });
  await step(failed ? `Could not start ${failed} of the app's containers again. Start the app from its page.` : "Started the app again.", !failed);
}

/** Tables whose rows are in a custom-format dump, from its table of contents. */
async function dumpTables(file: string, conn: PgConn): Promise<string[]> {
  const r = await runPg(conn, "pg_restore", ["-l", file], { connect: false });
  if (r.code !== 0) throw new Error(firstError(r.stderr) || "Could not read the backup's table of contents.");
  const out: string[] = [];
  for (const line of r.stdout.split("\n")) {
    const m = /^\d+; \d+ \d+ TABLE DATA (\S+) (\S+) /.exec(line);
    if (m) out.push(`${ident(m[1]!)}.${ident(m[2]!)}`);
  }
  return out;
}

type Step = (t: string, ok?: boolean) => Promise<void>;

async function restoreDatabase(r: BackupRestore, target: Target, file: string, step: Step, touch: () => void): Promise<string | null> {
  if (target.engine !== "pgsql") throw new Error("MySQL restores are not available yet.");
  const instance = target.instance!;
  const conn = await connFor(instance);
  const superuser = await isSuperuser(conn).catch(() => false);
  const owner = instance.dbUser;
  const restore = async (into: PgConn, args: string[]) => {
    const res = await runPg(into, "pg_restore", ["--no-password", "--no-owner", "--no-acl", "--exit-on-error", ...args, file], { timeoutMs: 6 * 3600_000 });
    if (res.code !== 0) throw new Error(`pg_restore: ${firstError(res.stderr) || `stopped with code ${res.code}`}`);
  };

  if (r.into === "new") {
    const name = r.newName!;
    await psql(conn, `CREATE DATABASE ${ident(name)}${superuser ? ` OWNER ${ident(owner)}` : ""}`).catch((e) => { throw new Error(`Could not create the database ${name}: ${msg(e)}`); });
    await step(`Created the database ${name}.`);
    try {
      await restore(withDatabase(conn, name), superuser ? ["--role", owner] : []);
    } catch (e) {
      await psql(conn, `DROP DATABASE IF EXISTS ${ident(name)}`).catch(() => {});
      throw new Error(`${msg(e)} The new database was removed again.`);
    }
    const [row] = await db.insert(dbInstances).values({ name, type: instance.type, dbUser: owner, siteId: instance.siteId }).returning();
    if (target.external) {
      const [c] = await db.select().from(dbConnections).where(eq(dbConnections.dbInstanceId, instance.id)).limit(1);
      const url = new URL(decrypt({ encryptedValue: c!.encryptedUrl, iv: c!.iv, authTag: c!.authTag }));
      url.pathname = "/" + encodeURIComponent(name);
      const e = encrypt(url.toString());
      await db.insert(dbConnections).values({ dbInstanceId: row!.id, host: c!.host, port: c!.port, database: name, encryptedUrl: e.encryptedValue, iv: e.iv, authTag: e.authTag });
    }
    await step(`Loaded the backup into ${name}. The live database was not touched.`);
    return row!.id;
  }

  if (r.mode === "full") {
    const as = superuser ? ident(owner) : "CURRENT_USER";
    touch();
    await psql(conn, `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public AUTHORIZATION ${as}`);
    await step("Dropped and recreated the schema.");
    await restore(conn, ["--clean", "--if-exists", ...(superuser ? ["--role", owner] : [])]);
    await step(`Loaded the backup into ${instance.name}.`);
    return null;
  }

  // data only: keep the schema, empty the tables the backup has rows for, load the rows (sequences are set from the dump)
  const tables = await dumpTables(file, conn);
  if (tables.length) {
    const exist = await psql(conn, `select string_agg(t, ',') from unnest(array[${tables.map((t) => `'${t.replace(/'/g, "''")}'`).join(",")}]) as t where to_regclass(t) is not null`);
    const missing = tables.filter((t) => !exist.split(",").includes(t));
    if (missing.length) throw new PgError(`The current schema has no table ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? " and others" : ""}. Run your migrations first, or use a full restore.`);
    touch();
    await psql(conn, `TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);
    await step(`Emptied ${tables.length} table${tables.length === 1 ? "" : "s"}.`);
  }
  touch();
  await restore(conn, ["--data-only", ...(superuser ? ["--disable-triggers"] : [])]);
  await step(`Reloaded the rows and set the sequences in ${instance.name}.`);
  return null;
}

async function restoreFiles(r: BackupRestore, target: Target, file: string, step: Step, touch: () => void) {
  const dir = await volumeDir(target.siteId!, target.volume!);
  if (r.into === "new") {
    const into = insideRoot(dir, r.newName!);
    if (await fs.pathExists(into)) throw new Error(`A folder called ${r.newName} is already in the volume.`);
    await fs.ensureDir(into);
    await tar.x({ file, cwd: into, preservePaths: false });
    await step(`Put the files in the folder ${r.newName} inside the volume. Nothing else was touched.`);
    return;
  }
  touch();
  await fs.emptyDir(dir);
  await step("Emptied the volume.");
  await tar.x({ file, cwd: dir, preservePaths: false });
  await step("Put the files from the backup back.");
}
