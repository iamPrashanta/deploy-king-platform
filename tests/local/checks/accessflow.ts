// Who may reach what, outside the apps router: files, scheduled jobs, databases, backups, servers, pipelines, the audit log,
// and the old open registration route. Needs an EMPTY database (run by freshdb.sh); no containers.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

async function main() {
  const root = process.cwd();
  const { appRouter } = await import(root + "/src/trpc/index");
  const { db, users, sites, siteAccess, dbInstances, cronJobs } = await import("@dbbkp/db");
  const { issueSession } = await import(root + "/src/services/team");
  const authRouter = (await import(root + "/src/routes/auth")).default;
  const jwt = (await import("jsonwebtoken")).default;
  const bcrypt = (await import("bcryptjs")).default;
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 60));

  // the registration route, called the way Express would
  const register = async (body: any) => {
    const layer = (authRouter as any).stack.find((l: any) => l.route?.path === "/register");
    let status = 200, json: any = null;
    const res: any = { status: (s: number) => ((status = s), res), json: (j: any) => ((json = j), res) };
    await layer.route.stack[0].handle({ body, ip: "10.0.0.7", headers: {} }, res, () => {});
    return { status, json };
  };
  const first = await register({ username: "owner", email: "owner@t.local", password: "Owner-Passw0rd-1", role: "user" });
  const ownerRow = (await db.select().from(users))[0];
  pass(first.status === 201 && ownerRow?.role === "admin", "on an empty installation, registration creates the first account as admin");
  const second = await register({ username: "intruder", email: "x@t.local", password: "Intruder-Passw0rd", role: "admin" });
  pass(second.status === 403 && (await db.select().from(users)).length === 1, "after that it is closed: nobody can register, least of all as admin", String(second.status));

  const mk = async (username: string, teamRole: string, grants: any = {}) => (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash("x".repeat(14), 4), role: "user", teamRole, grants }).returning())[0];
  const as = async (u: any) => { const s = await issueSession(u); const p: any = jwt.decode(s.token); return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1" }); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dk-access-"));
  const site = async (domain: string) => {
    fs.mkdirSync(path.join(tmp, domain, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmp, domain, "src", "index.js"), "// " + domain);
    return (await db.insert(sites).values({ userId: ownerRow.id, domain, type: "image", docRoot: path.join(tmp, domain), source: "image", image: "x:y", status: "active" }).returning())[0];
  };
  const A = await site("a.test"), B = await site("a.test-other");
  const devRow = await mk("dev", "developer"), viewRow = await mk("view", "viewer");
  await db.insert(siteAccess).values([{ siteId: A.id, userId: devRow.id }, { siteId: A.id, userId: viewRow.id }]);
  await db.insert(dbInstances).values([{ type: "pgsql", name: "a_db", dbUser: "a_user", siteId: A.id }, { type: "pgsql", name: "b_db", dbUser: "b_user", siteId: B.id }, { type: "pgsql", name: "loose_db", dbUser: "l_user" }]);
  await db.insert(cronJobs).values([{ siteId: A.id, command: "echo a", schedule: "0 * * * *" }, { siteId: B.id, command: "echo b", schedule: "0 * * * *" }]);
  const owner = await as(ownerRow), dev = await as(devRow), view = await as(viewRow);

  // files
  const listed: any[] = await dev.files.list({ siteId: A.id, directory: "/" });
  pass(listed.some((f) => f.name === "src" && f.isDirectory), "a developer browses the files of an app shared with them");
  pass((await dev.files.readFile({ siteId: A.id, filePath: "/src/index.js" })) === "// a.test", "and reads one");
  pass((await code(dev.files.readFile({ siteId: B.id, filePath: "/src/index.js" }))) === "NOT_FOUND", "an app that was not shared does not exist for them");
  pass((await code(dev.files.readFile({ siteId: A.id, filePath: "../a.test-other/src/index.js" }))) !== "OK" && (await code(dev.files.readFile({ siteId: A.id, filePath: "/../a.test-other/src/index.js" }))) !== "OK", "a path cannot climb out of the app folder, not even into a folder with a similar name");
  await dev.files.writeFile({ siteId: A.id, filePath: "/notes/hello.txt", content: "hi" });
  pass(fs.readFileSync(path.join(tmp, "a.test", "notes", "hello.txt"), "utf8") === "hi", "a developer writes a file");
  pass((await code(dev.files.delete({ siteId: A.id, targetPath: "/" }))) !== "OK" && fs.existsSync(path.join(tmp, "a.test")), "the app folder itself cannot be deleted");
  pass((await code(view.files.list({ siteId: A.id, directory: "/" }))) === "FORBIDDEN" && (await code(view.files.writeFile({ siteId: A.id, filePath: "/x", content: "x" }))) === "FORBIDDEN", "a viewer neither reads nor writes source files");

  // scheduled jobs
  pass(((await view.cron.list({ siteId: A.id })) as any[]).length === 1 && (await code(view.cron.list({ siteId: B.id }))) === "NOT_FOUND", "scheduled jobs are listed only for apps a member may see");
  pass((await code(view.cron.create({ siteId: A.id, name: "x", command: "id", schedule: "* * * * *" }))) === "FORBIDDEN", "a viewer cannot schedule a command");
  pass((await code(dev.cron.create({ siteId: B.id, name: "x", command: "id", schedule: "* * * * *" }))) === "NOT_FOUND", "a developer cannot schedule one on an app that was not shared");
  const bJob = (await db.select().from(cronJobs)).find((c: any) => c.siteId === B.id)!;
  pass((await code(dev.cron.delete({ id: bJob.id }))) === "NOT_FOUND" && (await db.select().from(cronJobs)).length === 2, "nor delete another app's job");

  // databases and backups
  const seen = ((await dev.database.list()) as any[]).map((d) => d.name).join();
  pass(seen === "a_db" && ((await owner.database.list()) as any[]).length === 3, "a member sees only the databases of their apps; an admin sees all", seen);
  pass((await code(dev.database.create({ name: "mine_db", dbUser: "mine_user", siteId: A.id }))) === "FORBIDDEN", "creating a database needs its own permission");
  const bDb = (await db.select().from(dbInstances)).find((d: any) => d.name === "b_db")!;
  pass((await code(dev.database.delete({ id: bDb.id }))) !== "OK" && (await db.select().from(dbInstances)).length === 3, "and so does removing one");
  pass((await code(dev.backup.pgsql({ DB_USER: "u", DB_PASS: "p", DB_NAME: "n" }))) === "FORBIDDEN" && (await code(dev.backup.seed({}))) === "FORBIDDEN", "backup and seed jobs are for admins");

  // the installation itself
  const closed = await Promise.all([code(dev.infra.jobs()), code(dev.infra.health()), code(dev.pipeline.list()), code(dev.nodes.list()), code(view.audit.list({ limit: 5 })), code(dev.audit.list({ limit: 5 }))]);
  pass(closed.every((c) => c === "FORBIDDEN"), "servers, host jobs, pipelines and the audit log are closed to members", closed.join());
  pass((await code(owner.audit.list({ limit: 5 }))) === "OK" && (await code(owner.nodes.list())) === "OK", "and open to an admin");
  pass((await code(dev.system.fit({ siteId: B.id }))) === "NOT_FOUND" && (await code(dev.system.fit({ siteId: A.id }))) === "OK", "the fit check answers only for apps a member may see");

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : "access holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
