// Data (databases, backups, schedules, destinations, restores, files) through the API, against a real EMPTY database
// (run by freshdb.sh, or on any machine with PostgreSQL by datalocal.sh). Queues are in-memory stand-ins; the backups
// and restores themselves run for real: pg_dump and pg_restore against the same PostgreSQL server, volumes as folders
// under a temporary DK_VOLUME_ROOT, "This server" in a temporary DK_BACKUP_DIR. Needs pg_dump, pg_restore and psql.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

async function main() {
  const root = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dk-data-"));
  process.env.DK_VOLUME_ROOT = path.join(tmp, "volumes");
  process.env.DK_BACKUP_DIR = path.join(tmp, "backups");
  process.env.DK_BACKUP_RETRY_DELAY_MS = "0";
  process.env.RCLONE_BIN = path.join(tmp, "no-rclone-here");
  process.env.MASTER_KEY ||= "a1".repeat(32); // test key, this run only
  const admin = new URL(process.env.DATABASE_URL!);
  admin.pathname = "/postgres";
  process.env.DK_PG_ADMIN_URL ||= admin.toString();

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  if (spawnSync(path.join(process.env.DK_PG_BIN ?? "", "pg_dump"), ["--version"]).status !== 0) {
    console.log("FAIL  pg_dump is not installed here (install postgresql-client)");
    process.exit(1);
  }

  // ── in-memory queues ──
  const queues = await import(root + "/src/queues");
  const queued: Array<{ name: string; data: any }> = [];
  let repeat: Array<{ key: string; id: string; name: string; pattern: string; tz: string }> = [];
  let n = 0;
  Object.assign(queues.backupQueue, {
    add: async (name: string, data: any, opts: any = {}) => {
      if (opts.repeat) repeat.push({ key: `k${++n}`, id: opts.jobId, name, pattern: opts.repeat.pattern, tz: opts.repeat.tz });
      else queued.push({ name, data });
      return { id: String(++n) };
    },
    getRepeatableJobs: async () => repeat.map((r) => ({ ...r })),
    removeRepeatableByKey: async (key: string) => { repeat = repeat.filter((r) => r.key !== key); return true; },
  });
  const dbJobs: any[] = [];
  Object.assign(queues.databaseQueue, { add: async (name: string, data: any) => { dbJobs.push({ name, data }); return {}; } });

  const { appRouter } = await import(root + "/src/trpc/index");
  const { db, users, sites, siteAccess, siteEnvVars, dbInstances, backups, backupRestores, auditLogs } = await import("@dbbkp/db");
  const { eq } = await import("drizzle-orm");
  const { encrypt } = await import("@dbbkp/security");
  const { issueSession } = await import(root + "/src/services/team");
  const { syncBackupSchedules } = await import(root + "/src/services/backups");
  const B = await import("@dbbkp/backup");
  const express = (await import("express")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const bcrypt = (await import("bcryptjs")).default;

  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 80));
  const msg = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => String(e?.message));
  const mk = async (username: string, role: string, extra: any = {}) => (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash("x".repeat(14), 4), role, ...extra }).returning())[0];
  const tokens = new Map<string, string>();
  const as = async (u: any) => { const s = await issueSession(u); tokens.set(u.id, s.token); const p: any = jwt.decode(s.token); return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1" }); };
  const ownerRow = await mk("owner", "admin");
  const devRow = await mk("dev", "user", { teamRole: "developer" });
  const dev2Row = await mk("dev2", "user", { teamRole: "developer", grants: { restoreBackups: true } });
  const viewRow = await mk("view", "user", { teamRole: "viewer" });
  const site = async (domain: string, volumes: any[] = []) => {
    const docRoot = path.join(tmp, "sites", domain);
    fs.mkdirSync(docRoot, { recursive: true });
    return (await db.insert(sites).values({ userId: ownerRow.id, domain, type: "node", docRoot, source: "image", image: "x:y", status: "active", currentTag: "x:1", port: 3000, volumes }).returning())[0];
  };
  const A = await site("shop.test", [{ name: "uploads", mountPath: "/app/uploads" }]);
  const Bs = await site("other.test");
  await db.insert(siteAccess).values([{ siteId: A.id, userId: devRow.id }, { siteId: A.id, userId: dev2Row.id }, { siteId: A.id, userId: viewRow.id }]);
  const owner = await as(ownerRow), dev = await as(devRow), dev2 = await as(dev2Row), view = await as(viewRow);
  // audit rows are written without holding up the request, so give them a moment
  const audits = async (action: string) => (await new Promise((r) => setTimeout(r, 150)), await db.select().from(auditLogs).where(eq(auditLogs.action, action))).length;

  // ── real databases on the server, as the database worker makes them ──
  const tag = Math.random().toString(36).slice(2, 7);
  const shop = `dkchk_${tag}_shop`, other = `dkchk_${tag}_other`, gone = `dkchk_${tag}_gone`, ext = `dkchk_${tag}_ext`;
  const made: string[] = [];
  const su = B.localConn("postgres");
  const sql = (dbName: string, q: string) => B.psql(B.localConn(dbName), q);
  for (const name of [shop, other, ext]) {
    await B.psql(su, `CREATE DATABASE ${B.ident(name)}`);
    made.push(name);
  }
  await B.psql(su, `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dkchk_app') THEN CREATE ROLE dkchk_app LOGIN PASSWORD 'Chk-App-Passw0rd'; END IF; END $$`);
  await sql(shop, `ALTER SCHEMA public OWNER TO dkchk_app`);
  await sql(shop, `SET ROLE dkchk_app; CREATE TABLE items (id serial PRIMARY KEY, name text NOT NULL); INSERT INTO items (name) VALUES ('one'), ('two'), ('three')`);
  const [shopDb] = await db.insert(dbInstances).values({ name: shop, type: "pgsql", dbUser: "dkchk_app", siteId: A.id }).returning();
  const [otherDb] = await db.insert(dbInstances).values({ name: other, type: "pgsql", dbUser: "postgres", siteId: Bs.id }).returning();
  const [lonelyDb] = await db.insert(dbInstances).values({ name: `dkchk_${tag}_lonely`, type: "pgsql", dbUser: "postgres" }).returning();
  const [goneDb] = await db.insert(dbInstances).values({ name: gone, type: "pgsql", dbUser: "postgres", siteId: A.id }).returning();
  const pgUrl = new URL(process.env.DK_PG_ADMIN_URL!);
  const appUrl = `postgres://dkchk_app:Chk-App-Passw0rd@${pgUrl.hostname}:${pgUrl.port || 5432}/${shop}`;
  const e = encrypt(appUrl);
  await db.insert(siteEnvVars).values({ siteId: A.id, key: "DATABASE_URL", encryptedValue: e.encryptedValue, iv: e.iv, authTag: e.authTag });
  const work = async () => {
    const out: any[] = [];
    while (queued.length) {
      const j = queued.shift()!;
      if (j.name === "run-backup") out.push(await B.runBackup(j.data.backupId));
      else if (j.name === "run-restore") out.push(await B.runRestore(j.data.restoreId));
    }
    return out;
  };

  // ── Databases ──
  const devList: any[] = await dev.database.list();
  const ownerList: any[] = await owner.database.list();
  pass(devList.length === 2 && devList.every((d) => d.app?.id === A.id) && ownerList.length === 4, "a developer sees the databases of their apps; an admin sees every one", `${devList.length} / ${ownerList.length}`);
  const shopView = devList.find((d) => d.id === shopDb.id);
  pass(shopView.state === "running" && shopView.sizeBytes > 0 && /^PostgreSQL \d+$/.test(shopView.engineLabel), "the list shows that it answers, its size and its engine", `${shopView.state} ${shopView.engineLabel} ${shopView.stateError ?? ""}`);
  pass(shopView.connection.includes("••••••") && !JSON.stringify(devList).includes("Chk-App-Passw0rd") && shopView.variable?.key === "DATABASE_URL", "the connection string hides the password, and says which app variable holds it", shopView.connection);
  pass(devList.find((d) => d.id === goneDb.id).state === "unreachable", "a database that does not answer is shown as unreachable, with the reason");
  pass((await code(dev.database.revealConnection({ id: shopDb.id }))) === "FORBIDDEN" && (await owner.database.revealConnection({ id: shopDb.id })).url === appUrl && (await audits("secret_read")) === 1, "only an admin can see the full URL, and that is in the audit log");
  pass((await code(dev.database.get({ id: otherDb.id }))) === "NOT_FOUND" && (await code(dev.database.get({ id: lonelyDb.id }))) === "NOT_FOUND", "a database of another app, or of no app, does not exist for a developer");
  pass((await code(owner.database.create({ name: `dkchk_${tag}_my`, dbUser: "myuser", type: "mysql" }))) === "PRECONDITION_FAILED" && !(await db.select().from(dbInstances).where(eq(dbInstances.name, `dkchk_${tag}_my`))).length, "MySQL says it is not available yet, and leaves nothing behind");
  const created: any = await owner.database.create({ name: `dkchk_${tag}_new`, dbUser: `dkchk_${tag}_u`, siteId: A.id });
  pass(created.credentials.password.length >= 20 && dbJobs.length === 1 && (await audits("db_create")) === 1, "a new database is queued for the worker, its password shown once, and it is audited");
  await owner.database.delete({ id: created.instance.id });
  pass((await audits("db_delete")) === 1, "removing a database record is audited");
  pass((await code(owner.database.connectExisting({ name: `dkchk_${tag}_x`, url: "mysql://a:b@h/x" }))) === "BAD_REQUEST" && (await code(owner.database.connectExisting({ name: `dkchk_${tag}_x`, url: "postgres://a:b@127.0.0.1:1/x" }))) === "PRECONDITION_FAILED", "connecting an existing database needs a PostgreSQL URL that answers");
  const extUrl = new URL(process.env.DK_PG_ADMIN_URL!);
  extUrl.pathname = "/" + ext;
  const connected: any = await owner.database.connectExisting({ name: ext, url: extUrl.toString(), siteId: A.id });
  const extView: any = await owner.database.get({ id: connected.id });
  pass(extView.external && extView.engineLabel.endsWith("· external") && extView.connection.includes(":••••••@") && !JSON.stringify(extView).includes(`:${extUrl.password}@`) && (await audits("db_connect")) === 1, "an existing database is connected by URL, stored encrypted and shown without its password", extView.engineLabel);
  pass((await code(dev.database.connectExisting({ name: `dkchk_${tag}_y`, url: extUrl.toString(), siteId: A.id }))) === "FORBIDDEN", "a developer cannot connect databases");

  // ── Destinations ──
  const dests: any = await owner.backup.destinations();
  const local = dests.destinations.find((d: any) => d.builtIn);
  pass(local && local.name === "This server" && local.location === process.env.DK_BACKUP_DIR, "This server is always a destination, at DK_BACKUP_DIR");
  pass(dests.kinds.find((k: any) => k.kind === "s3").available === false && (await code(owner.backup.addDestination({ name: "S3", kind: "s3", location: "s3://x" }))) === "BAD_REQUEST", "S3 with its own keys says it is not available yet and cannot be added");
  pass((await msg(owner.backup.addDestination({ name: "Drive", kind: "rclone", location: "gdrive:dbbkp" }))).includes("rclone is not installed"), "an rclone remote is refused, with the reason, when rclone is missing");
  pass((await code(owner.backup.addDestination({ name: "Etc", kind: "local", location: "/etc" }))) === "BAD_REQUEST" && (await code(dev.backup.addDestination({ name: "x", kind: "local", location: path.join(tmp, "x") }))) === "FORBIDDEN", "system folders are refused, and only admins add destinations");
  const second: any = await owner.backup.addDestination({ name: "Second disk", kind: "local", location: path.join(tmp, "second"), keepLast: 1 });
  pass(second.lastCheckOk && (await audits("backup_destination")) === 1, "a folder destination is checked (write, read back, remove) before it is added, and audited");
  pass((await code(owner.backup.removeDestination({ id: local.id }))) === "BAD_REQUEST", "This server cannot be removed");
  pass((await dev.backup.destinations()).destinations.every((d: any) => d.location === null), "members see destination names, not where they are");

  // ── Back up now ──
  const target = { type: "database" as const, id: shopDb.id };
  pass((await code(view.backup.runNow({ target }))) === "FORBIDDEN" && (await code(dev.backup.runNow({ target: { type: "database", id: otherDb.id } }))) === "NOT_FOUND", "a viewer cannot make backups, nor anyone of an app they cannot see");
  const b1: any = await dev.backup.runNow({ target });
  pass(queued.length === 1 && queued[0]!.name === "run-backup" && b1.status === "queued" && (await audits("backup_run")) === 1, "Back up now queues one backup and audits it");
  pass((await code(dev.backup.runNow({ target }))) === "CONFLICT", "a second one while the first is waiting is refused");
  const [r1] = await work();
  const onDisk = path.join(process.env.DK_BACKUP_DIR!, B.targetFolder(shop), r1.fileName);
  const sum = fs.existsSync(onDisk) ? (await B.sha256File(onDisk)).sha256 : "";
  pass(r1.status === "ok" && r1.attempts === 1 && r1.fileName.endsWith(".dump") && sum === r1.sha256 && r1.copies[0].verified, "the dump is made with pg_dump, its SHA-256 recorded, copied to This server and read back", `${r1.status} ${r1.error ?? ""}`);

  const bad: any = await dev.backup.runNow({ target: { type: "database", id: goneDb.id } });
  const [r2] = await work();
  pass(r2.status === "failed" && r2.attempts === 3 && r2.error.includes("attempt 3 of 3") && !r2.error.includes("Passw0rd"), "a backup that keeps failing is tried 3 times and says why", r2.error);
  const again: any = await dev.backup.retry({ id: bad.id });
  pass(again.trigger === "retry" && queued.length === 1, "Retry queues a new backup of the same database");
  queued.length = 0;
  await db.update(backups).set({ status: "failed" }).where(eq(backups.id, again.id));

  // ── Schedules and keep rules ──
  pass((await msg(dev.backup.savePolicy({ target, schedule: "61 2 * * *", timezone: "UTC", keep: 2, destinationIds: [local.id] }))).includes("minute") && (await code(view.backup.savePolicy({ target, schedule: "0 2 * * *", timezone: "UTC", keep: 2, destinationIds: [local.id] }))) === "FORBIDDEN", "a wrong schedule is refused with a sentence, and viewers cannot set one");
  const pol: any = await dev.backup.savePolicy({ target, schedule: "0 2 * * *", timezone: "Asia/Kolkata", keep: 2, destinationIds: [local.id, second.id] });
  pass(pol.words === "Every day at 02:00" && repeat.length === 1 && repeat[0]!.id === `backup-policy-${pol.id}` && repeat[0]!.tz === "Asia/Kolkata" && (await audits("backup_policy")) === 1, "a schedule goes into the queue once, in its own time zone, and is audited");
  await dev.backup.setPolicyEnabled({ id: pol.id, enabled: false });
  pass(!repeat.length && "skipped" in (await B.runScheduledBackup(pol.id)), "a paused schedule is out of the queue and does not run");
  await dev.backup.setPolicyEnabled({ id: pol.id, enabled: true });
  repeat = [{ key: "stray", id: "backup-policy-00000000-0000-4000-8000-000000000000", name: "scheduled-backup", pattern: "* * * * *", tz: "UTC" }];
  const synced = await syncBackupSchedules();
  pass(synced.added === 1 && repeat.length === 1 && repeat[0]!.id === `backup-policy-${pol.id}`, "at start-up missing schedules come back and stray ones go");
  const runs: any[] = [];
  for (let i = 0; i < 3; i++) {
    const r: any = await B.runScheduledBackup(pol.id);
    runs.push(r);
    await new Promise((res) => setTimeout(res, 1100)); // file names carry the second
  }
  const rows = await db.select().from(backups).where(eq(backups.targetKey, `db:${shopDb.id}`));
  const liveOn = (destId: string) => rows.filter((r) => r.copies.some((c) => c.ok && !c.removedAt && c.destinationId === destId)).length;
  pass(runs.every((r) => r.status === "ok" && r.trigger === "schedule" && r.copies.length === 2 && r.copies.every((c: any) => c.verified)), "a scheduled backup is copied to every destination of the schedule and checked there", runs.map((r) => r.status + " " + (r.error ?? "")).join(", "));
  pass(liveOn(local.id) === 2 && liveOn(second.id) === 1, "keep 2 leaves two backups, and the destination that keeps 1 only the newest", `${liveOn(local.id)} / ${liveOn(second.id)}`);
  const removedFile = path.join(process.env.DK_BACKUP_DIR!, B.targetFolder(shop), r1.fileName);
  pass(!fs.existsSync(removedFile), "files removed by the keep rule are gone from the destination");
  const policies: any[] = await view.backup.policies();
  pass(policies.length === 1 && policies[0].targetName === shop && policies[0].destinations.length === 2 && policies[0].nextRunAt, "everyone who can see the app sees its schedule, with its destinations and next run");

  // ── Restore ──
  const latest = runs[2];
  pass((await code(dev.backup.restore({ backupId: latest.id, mode: "full", into: "new" }))) === "FORBIDDEN", "restoring is a separate permission: a developer without it cannot");
  pass((await code(dev2.backup.restore({ backupId: latest.id, mode: "data", into: "new" }))) === "BAD_REQUEST", "a new copy always gets a full restore");
  const plan: any = await dev2.backup.restorable({ target });
  pass(plan.backups.length === 2 && plan.newName.startsWith(`${shop}_restore_`) && plan.target.app.id === A.id, "the dialog gets the backups that can be restored and the name of the new copy", plan.newName);
  await sql(shop, `DELETE FROM items WHERE name = 'one'; INSERT INTO items (name) VALUES ('four')`);
  const rNew: any = await dev2.backup.restore({ backupId: latest.id, mode: "full", into: "new" });
  const [doneNew] = await work();
  if (doneNew.newName) made.push(doneNew.newName);
  const copyRows = doneNew.status === "ok" ? await sql(doneNew.newName, "select string_agg(name, ',' order by id) from items") : "";
  const liveRows = await sql(shop, "select string_agg(name, ',' order by id) from items");
  const [copyInst] = doneNew.resultDbInstanceId ? await db.select().from(dbInstances).where(eq(dbInstances.id, doneNew.resultDbInstanceId)) : [];
  pass(doneNew.status === "ok" && copyRows === "one,two,three" && liveRows === "two,three,four" && copyInst?.siteId === A.id, "restoring into a new copy makes a new database with the backup's data and leaves the live one alone", `${doneNew.status} ${doneNew.error ?? ""} copy=${copyRows} live=${liveRows}`);
  pass(rNew.safetyBackup === false && (await audits("backup_restore")) === 1, "a new copy needs no safety backup; the restore is audited");

  await sql(shop, `SET ROLE dkchk_app; CREATE TABLE extra (id int)`);
  await dev2.backup.restore({ backupId: latest.id, mode: "full", into: "replace", safetyBackup: true });
  const [doneFull] = await work();
  const afterFull = await sql(shop, "select string_agg(name, ',' order by id) from items");
  const extraGone = (await sql(shop, "select to_regclass('public.extra') is null")) === "t";
  const [safety] = doneFull.safetyBackupId ? await db.select().from(backups).where(eq(backups.id, doneFull.safetyBackupId)) : [];
  pass(doneFull.status === "ok" && afterFull === "one,two,three" && extraGone, "a full restore drops and recreates the schema, then loads the data", `${doneFull.status} ${doneFull.error ?? ""} rows=${afterFull}`);
  pass(safety?.trigger === "safety" && safety.status === "ok" && doneFull.steps.some((s: any) => s.text.startsWith("Safety backup taken")) && doneFull.steps.some((s: any) => s.text.includes("Checksum matches")), "it takes a safety backup first and checks the checksum", doneFull.steps.map((s: any) => s.text).join(" / "));
  const owned = await sql(shop, "select tableowner from pg_tables where tablename = 'items'");
  pass(owned === "dkchk_app", "restored tables belong to the app's database user, not to the superuser", owned);

  await sql(shop, `SET ROLE dkchk_app; UPDATE items SET name = 'changed'; INSERT INTO items (name) VALUES ('x'), ('y'); CREATE TABLE kept (id int)`);
  await dev2.backup.restore({ backupId: latest.id, mode: "data", into: "replace", safetyBackup: false });
  const [doneData] = await work();
  const afterData = await sql(shop, "select string_agg(name, ',' order by id) from items");
  const nextId = await sql(shop, "select nextval('items_id_seq')");
  const keptStill = (await sql(shop, "select to_regclass('public.kept') is not null")) === "t";
  pass(doneData.status === "ok" && afterData === "one,two,three" && nextId === "4" && keptStill, "data only keeps the schema, reloads the rows and sets the sequences", `${doneData.status} ${doneData.error ?? ""} rows=${afterData} next=${nextId}`);

  // a file that was changed after the backup is not used
  const victim = runs[2].copies.find((c: any) => c.destinationId === local.id).location;
  fs.appendFileSync(victim, "tampered");
  await dev2.backup.restore({ backupId: latest.id, mode: "full", into: "replace", safetyBackup: true });
  const [doneBad] = await work();
  pass(doneBad.status === "failed" && doneBad.error.includes("does not match") && doneBad.error.includes("Nothing was changed") && !doneBad.safetyBackupId, "a backup whose checksum no longer matches is refused before anything is changed", doneBad.error);

  // ── Files ──
  const volDir = path.join(process.env.DK_VOLUME_ROOT!, B.engineVolumeName(A.id, "uploads"), "_data");
  fs.mkdirSync(path.join(volDir, "products", "2026-11"), { recursive: true });
  fs.writeFileSync(path.join(volDir, "products", "2026-11", "manifest.json"), '{ "images": 42 }\n');
  fs.writeFileSync(path.join(volDir, "products", "2026-11", "photo.bin"), Buffer.from([0, 1, 2, 3, 0, 5]));
  fs.writeFileSync(path.join(tmp, "secret.txt"), "outside");
  fs.symlinkSync(path.join(tmp, "secret.txt"), path.join(volDir, "link-out"));
  fs.writeFileSync(path.join(A.docRoot, "package.json"), "{}");
  const vt = { siteId: A.id, volume: "uploads" };
  const roots: any = await dev.files.roots();
  pass(roots.volumes.length === 1 && roots.volumes[0].reachable && roots.volumes[0].mountPath === "/app/uploads" && roots.sources.some((s: any) => s.siteId === A.id) && !roots.sources.some((s: any) => s.siteId === Bs.id), "Files lists the volumes and sources of the apps this member can see");
  const listing: any = await dev.files.browse({ ...vt, path: "/products/2026-11" });
  pass(listing.entries.length === 2 && listing.entries.some((x: any) => x.name === "manifest.json" && x.size === 17) && !listing.readOnly, "a volume folder lists its files with sizes");
  const opened: any = await dev.files.read({ ...vt, path: "/products/2026-11/manifest.json" });
  const bin: any = await dev.files.read({ ...vt, path: "/products/2026-11/photo.bin" });
  pass(opened.content.includes('"images": 42') && bin.content === null && bin.reason.includes("Not a text file"), "a text file opens in the editor; a binary one says to download it");
  const saved: any = await dev.files.write({ ...vt, path: "/products/2026-11/manifest.json", content: '{ "images": 43 }\n', expectedModifiedAt: new Date(opened.modifiedAt).toISOString() });
  pass(fs.readFileSync(path.join(volDir, "products", "2026-11", "manifest.json"), "utf8").includes("43") && saved.size === 17 && (await audits("file_edit")) === 1, "Save writes the file to the volume and is audited");
  pass((await code(dev.files.write({ ...vt, path: "/products/2026-11/manifest.json", content: "x", expectedModifiedAt: new Date(Date.now() - 3600_000).toISOString() }))) === "CONFLICT", "saving over a file that changed since it was opened is refused");
  pass((await code(dev.files.read({ ...vt, path: "/../../../../etc/passwd" }))) === "NOT_FOUND" && (await code(dev.files.read({ ...vt, path: "/link-out" }))) === "BAD_REQUEST", "paths cannot leave the volume, not even through a link");
  pass((await code(dev.files.write({ siteId: A.id, volume: null, path: "/package.json", content: "x" }))) === "FORBIDDEN" && (await dev.files.read({ siteId: A.id, volume: null, path: "/package.json" }) as any).readOnly, "the app's source can be read but not changed");
  pass((await code(view.files.browse({ ...vt, path: "/" }))) === "FORBIDDEN" && (await code(dev.files.browse({ siteId: Bs.id, volume: null, path: "/" }))) === "NOT_FOUND", "viewers cannot open files, and nobody opens another app's");
  await dev.files.mkdir({ ...vt, path: "/", name: "new-folder" });
  pass(fs.existsSync(path.join(volDir, "new-folder")) && (await code(dev.files.mkdir({ ...vt, path: "/", name: "../x" }))) === "BAD_REQUEST" && (await audits("folder_create")) === 1, "New folder makes one, refuses names with slashes, and is audited");
  await dev.files.remove({ ...vt, path: "/new-folder" });
  pass(!fs.existsSync(path.join(volDir, "new-folder")) && (await code(dev.files.remove({ ...vt, path: "/" }))) === "BAD_REQUEST" && (await audits("file_delete")) === 1, "removing works inside the volume, never on the volume itself");

  // downloads and uploads over HTTP
  const filesRest = (await import(root + "/src/routes/files")).default;
  const app = express();
  app.use("/api/files", filesRest);
  const server = app.listen(0);
  const port = (server.address() as any).port;
  const base = `http://127.0.0.1:${port}/api/files`;
  const auth = (u: any) => ({ authorization: `Bearer ${tokens.get(u.id)}` });
  const form = new FormData();
  form.append("files", new Blob(["hello upload"]), "hello.txt");
  const up = await fetch(`${base}/upload?siteId=${A.id}&volume=uploads&path=/products`, { method: "POST", headers: auth(devRow), body: form });
  const upAgain = await fetch(`${base}/upload?siteId=${A.id}&volume=uploads&path=/products`, { method: "POST", headers: auth(devRow), body: form });
  pass(up.status === 200 && fs.readFileSync(path.join(volDir, "products", "hello.txt"), "utf8") === "hello upload" && upAgain.status === 409 && (await audits("file_upload")) === 1, "Upload puts files into the volume folder, will not overwrite unasked, and is audited", `${up.status} ${upAgain.status}`);
  const upView = await fetch(`${base}/upload?siteId=${A.id}&volume=uploads&path=/products`, { method: "POST", headers: auth(viewRow), body: form });
  const upSource = await fetch(`${base}/upload?siteId=${A.id}&path=/`, { method: "POST", headers: auth(devRow), body: form });
  pass(upView.status === 403 && upSource.status === 403 && (await fetch(`${base}/upload?siteId=${A.id}&volume=uploads`, { method: "POST", body: form })).status === 401, "viewers, the read-only source and callers without a session cannot upload");
  const zip = await fetch(`${base}/download?siteId=${A.id}&volume=uploads&path=/`, { headers: auth(devRow) });
  const zbuf = Buffer.from(await zip.arrayBuffer());
  const AdmZip = (await import("adm-zip")).default;
  const names = zip.status === 200 ? new AdmZip(zbuf).getEntries().map((x: any) => x.entryName) : [];
  pass(zip.status === 200 && zbuf.subarray(0, 2).toString() === "PK" && names.includes("products/2026-11/manifest.json") && !names.includes("link-out"), "Download .zip packs the folder, leaving out links", names.join(","));
  const one = await fetch(`${base}/download?siteId=${A.id}&volume=uploads&path=/products/hello.txt`, { headers: auth(devRow) });
  pass(one.status === 200 && (await one.text()) === "hello upload" && (await fetch(`${base}/download?siteId=${Bs.id}&path=/`, { headers: auth(devRow) })).status === 404, "a single file downloads as it is; another app's files do not");
  server.close();

  // volume backups and restores
  const vtarget = { type: "volume" as const, siteId: A.id, volume: "uploads" };
  await dev.backup.runNow({ target: vtarget });
  const [vb] = await work();
  pass(vb.status === "ok" && vb.fileName.endsWith(".tar.gz") && vb.engine === "files" && vb.copies[0].verified, "Back up volume makes a checksummed .tar.gz", `${vb.status} ${vb.error ?? ""}`);
  fs.writeFileSync(path.join(volDir, "added-later.txt"), "later");
  await dev2.backup.restore({ backupId: vb.id, mode: "full", into: "new" });
  const [vNew] = await work();
  pass(vNew.status === "ok" && fs.readFileSync(path.join(volDir, vNew.newName, "products", "2026-11", "manifest.json"), "utf8").includes("43") && fs.existsSync(path.join(volDir, "added-later.txt")), "a file restore into a new folder puts the backup next to the live files", `${vNew.status} ${vNew.error ?? ""}`);
  await dev2.backup.restore({ backupId: vb.id, mode: "full", into: "replace", safetyBackup: true, stopApp: true });
  const [vRep] = await work();
  const stepText = vRep.steps.map((s: any) => s.text).join(" / ");
  if (vRep.status === "ok") pass(!fs.existsSync(path.join(volDir, "added-later.txt")) && fs.existsSync(path.join(volDir, "products", "hello.txt")) && vRep.safetyBackupId && /app was not running|Stopped the app/.test(stepText), "replacing a volume's files takes a safety backup, stops the app and puts back exactly the backup", stepText);
  else pass(vRep.error.includes("container engine could not be reached") && fs.existsSync(path.join(volDir, "added-later.txt")), "without a container engine the app cannot be stopped, so nothing is changed", vRep.error);
  pass((await code(dev2.backup.restore({ backupId: vb.id, mode: "data", into: "replace" }))) === "BAD_REQUEST", "files are always restored in full");

  // ── What each person sees ──
  const ov: any = await dev.backup.overview();
  pass(ov.last24h.failed >= 1 && ov.last24h.failedNames.includes(gone) && ov.checksums.verified === ov.checksums.copies && ov.nextRun?.at && ov.storedBytes > 0, "the overview counts the last 24 hours, the failures, the checksums and the next run", JSON.stringify(ov.last24h));
  const histDev: any[] = await view.backup.history({ kind: "all", limit: 200 });
  const histOwner: any[] = await owner.backup.history({ kind: "all", limit: 200 });
  pass(histDev.length > 0 && histDev.every((h) => h.siteId === A.id) && histOwner.length >= histDev.length, "history shows the backups of the apps each person can see; a viewer can read it");
  pass(((await view.backup.history({ kind: "volume" })) as any[]).every((h) => h.targetType === "volume"), "history can show only databases or only files");
  pass(!JSON.stringify(histDev).includes(process.env.DK_BACKUP_DIR!), "where files are kept is not sent to members");
  const restores: any[] = await dev.backup.restores();
  pass(restores.length >= 5 && (await code(dev.backup.restoreStatus({ id: restores[0].id }))) === "OK", "restores can be followed step by step");

  // ── clean up ──
  for (const name of made) await B.psql(su, `DROP DATABASE IF EXISTS ${B.ident(name)} WITH (FORCE)`).catch(() => {});
  await B.psql(su, `DROP ROLE IF EXISTS dkchk_app`).catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : "data holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
