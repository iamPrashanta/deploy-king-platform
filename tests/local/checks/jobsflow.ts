// Scheduled jobs and workers through the API, against a real EMPTY database (run by freshdb.sh).
// The job queues are replaced by in-memory stand-ins, so neither Redis nor a container engine is needed;
// what the runner does inside a container is covered by the container checks.
async function main() {
  const root = process.cwd();
  const queues = await import(root + "/src/queues");
  // ── in-memory queues ──
  let repeat: Array<{ key: string; id: string; name: string; pattern: string; tz: string }> = [];
  const manual: any[] = [], hosting: any[] = [];
  let n = 0;
  Object.assign(queues.cronQueue, {
    add: async (name: string, data: any, opts: any = {}) => {
      if (opts.repeat) repeat.push({ key: `k${++n}`, id: opts.jobId, name, pattern: opts.repeat.pattern, tz: opts.repeat.tz });
      else manual.push({ name, data });
      return {};
    },
    getRepeatableJobs: async () => repeat.map((r) => ({ ...r })),
    removeRepeatableByKey: async (key: string) => { repeat = repeat.filter((r) => r.key !== key); return true; },
  });
  Object.assign(queues.hostingQueue, { add: async (name: string, data: any) => { hosting.push({ name, data }); return {}; } });

  const { appRouter } = await import(root + "/src/trpc/index");
  const { db, users, sites, siteAccess, cronJobs, cronRuns } = await import("@dbbkp/db");
  const { eq } = await import("drizzle-orm");
  const { issueSession } = await import(root + "/src/services/team");
  const { syncSchedules } = await import(root + "/src/services/cronjobs");
  const jwt = (await import("jsonwebtoken")).default;
  const bcrypt = (await import("bcryptjs")).default;
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 80));
  const msg = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => String(e?.message));
  const mk = async (username: string, role: string, extra: any = {}) => (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash("x".repeat(14), 4), role, ...extra }).returning())[0];
  const as = async (u: any) => { const s = await issueSession(u); const p: any = jwt.decode(s.token); return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1" }); };
  const ownerRow = await mk("owner", "admin"), devRow = await mk("dev", "user", { teamRole: "developer" }), viewRow = await mk("view", "user", { teamRole: "viewer" });
  const site = async (domain: string) => (await db.insert(sites).values({ userId: ownerRow.id, domain, type: "node", docRoot: "/var/www/sites/" + domain, source: "image", image: "x:y", status: "active", currentTag: "dbbkp-site-x:1", port: 3000 }).returning())[0];
  const A = await site("a.test"), B = await site("b.test");
  await db.insert(siteAccess).values([{ siteId: A.id, userId: devRow.id }, { siteId: A.id, userId: viewRow.id }]);
  const owner = await as(ownerRow), dev = await as(devRow), view = await as(viewRow);
  const job = { name: "Daily report", command: "node scripts/report.js", schedule: "0 6 * * *", timezone: "Asia/Kolkata", runIn: "web", timeoutSec: 600, notifyOnFailure: true };

  // ── scheduled jobs ──
  const pv: any = await dev.cron.preview({ schedule: "*/15 * * * *", timezone: "UTC" });
  pass(pv.valid && pv.words === "Every 15 minutes" && pv.next.length === 3, "the editor's preview says what a schedule means and when it runs next");
  const j1: any = await dev.cron.create({ siteId: A.id, ...job });
  pass(j1.words === "Every day at 06:00" && j1.nextRunAt && repeat.length === 1 && repeat[0].pattern === "0 6 * * *" && repeat[0].tz === "Asia/Kolkata" && repeat[0].id === `cron-${j1.id}`, "a developer adds a job on their app; it is scheduled once, in its own time zone", JSON.stringify(repeat));
  pass(((await view.cron.list({ siteId: A.id })) as any[]).length === 1 && (await code(view.cron.create({ siteId: A.id, ...job }))) === "FORBIDDEN" && (await code(view.cron.runNow({ id: j1.id }))) === "FORBIDDEN", "a viewer sees the jobs and cannot add or run one");
  pass((await code(dev.cron.create({ siteId: B.id, ...job }))) === "NOT_FOUND" && (await code(dev.cron.runs({ jobId: j1.id }))) === "OK", "an app that was not shared does not exist for a developer");
  pass((await msg(dev.cron.create({ siteId: A.id, ...job, schedule: "61 * * * *" }))).includes("minute") && (await msg(dev.cron.create({ siteId: A.id, ...job, timezone: "Mars/Base" }))).includes("time zone") && (await msg(dev.cron.create({ siteId: A.id, ...job, runIn: "worker:nope" }))).includes("worker"), "a wrong schedule, time zone or worker is refused with a sentence that says why");
  const shortcut: any = await dev.cron.create({ siteId: A.id, ...job, name: "Nightly", schedule: "@daily", timezone: "UTC" });
  pass(shortcut.schedule === "0 0 * * *", "a shortcut like @daily is stored as five fields");
  await dev.cron.update({ id: j1.id, ...job, schedule: "30 2 * * 1" });
  const mine = repeat.filter((r) => r.id === `cron-${j1.id}`);
  pass(mine.length === 1 && mine[0].pattern === "30 2 * * 1", "changing the schedule replaces it; it is never scheduled twice", JSON.stringify(mine));
  await dev.cron.setActive({ id: j1.id, active: false });
  pass(!repeat.some((r) => r.id === `cron-${j1.id}`), "pausing takes it out of the schedule");
  await dev.cron.setActive({ id: j1.id, active: true });
  pass(repeat.some((r) => r.id === `cron-${j1.id}`), "resuming puts it back");
  await dev.cron.runNow({ id: j1.id });
  pass(manual.length === 1 && manual[0].data.trigger === "manual" && manual[0].data.triggeredBy === devRow.id, "Run now starts one run, recorded as started by that person");
  await dev.cron.delete({ id: shortcut.id });
  pass(!repeat.some((r) => r.id === `cron-${shortcut.id}`) && (await db.select().from(cronJobs)).length === 1, "removing a job removes its schedule");

  // the queue lost track (Redis flushed) and a deleted job's schedule is still there
  repeat = [{ key: "stray", id: "cron-00000000-0000-4000-8000-000000000000", name: "execute-cron", pattern: "* * * * *", tz: "UTC" }];
  const synced = await syncSchedules();
  pass(synced.added === 1 && repeat.length === 1 && repeat[0].id === `cron-${j1.id}`, "at start-up, missing schedules are restored and stray ones removed", JSON.stringify(repeat));

  // ── workers ──
  const fit: any = await dev.workers.fit({ siteId: A.id, copies: 2, memoryLimit: 256 });
  pass(fit.verdict && "canOverride" in fit, "the worker dialog can ask whether the memory fits");
  const w: any = await dev.workers.create({ siteId: A.id, name: "queue", command: "node dist/worker.js", copies: 2, memoryLimit: 256, restart: true, gracefulStop: true, enabled: true });
  pass(w.name === "queue" && hosting.some((h) => h.name === "sync-workers" && h.data.siteId === A.id), "adding a worker asks the deploy worker to start it");
  pass((await code(view.workers.create({ siteId: A.id, name: "x", command: "y" } as any))) === "FORBIDDEN" && (await code(dev.workers.create({ siteId: B.id, name: "x", command: "y" } as any))) === "NOT_FOUND", "viewers cannot add workers, nor can anyone on an app they cannot see");
  pass((await msg(dev.workers.create({ siteId: A.id, name: "Queue 2", command: "y" } as any))).includes("lowercase") && (await code(dev.workers.create({ siteId: A.id, name: "queue", command: "y" } as any))) === "CONFLICT", "worker names are checked, and unique per app");
  const cap: any = await owner.system.capacity();
  pass(cap.memory.workersMb === 512, "the worker's 2 x 256 MB is counted in the server's memory ledger", String(cap.memory.workersMb));
  const list: any = await dev.workers.list({ siteId: A.id });
  pass(list.workers.length === 1 && list.appWorkersMb === 512 && list.freeToPromiseMb === null, "a member sees the app's workers and their memory, not the server's numbers");
  pass(((await owner.workers.list({ siteId: A.id })) as any).freeToPromiseMb !== null, "an admin also sees what the server can still give out");
  const big = await code(dev.workers.update({ id: w.id, command: "node dist/worker.js", copies: 8, memoryLimit: 16384, restart: true, gracefulStop: true, enabled: true }));
  pass(big === "PRECONDITION_FAILED", "raising a worker's memory beyond what the server can promise is refused", big);
  pass((await code(dev.workers.update({ id: w.id, command: "node dist/worker.js", copies: 1, memoryLimit: 128, restart: true, gracefulStop: true, enabled: true }))) === "OK", "lowering it never needs a check");
  const wj: any = await dev.cron.create({ siteId: A.id, ...job, name: "In the worker", runIn: "worker:queue" });
  pass(wj.runIn === "worker:queue", "a job can run inside a worker");
  const del: any = await dev.workers.delete({ id: w.id });
  const [moved] = await db.select().from(cronJobs).where(eq(cronJobs.id, wj.id));
  pass(del.jobsMoved === 1 && moved.runIn === "web", "removing the worker moves its jobs to the web container");
  pass((await code(dev.workers.logs({ siteId: A.id, container: "a".repeat(64) }))) === "NOT_FOUND", "logs are only served for a container that is one of this app's workers");

  // ── the runner, where no container can be reached ──
  const { runJob, hideSecrets } = await import(root + "/../worker/src/cron.worker");
  const r1: any = await runJob({ cronId: j1.id, trigger: "schedule" });
  const [after1] = await db.select().from(cronJobs).where(eq(cronJobs.id, j1.id));
  const runs1 = await db.select().from(cronRuns).where(eq(cronRuns.jobId, j1.id));
  pass(r1.status === "failed" && runs1.length === 1 && /container engine|not running/.test(runs1[0].output ?? "") && after1.failStreak === 1 && after1.lastStatus === "failed", "a run that cannot reach the app is recorded as failed, with the reason", runs1[0]?.output ?? "");
  await runJob({ cronId: j1.id, trigger: "schedule" });
  const ov: any = await owner.system.overview();
  const att = ov.attention.find((a: any) => a.kind === "job-failed");
  pass(att && att.text.includes("2 times in a row") && att.href.includes("tab=jobs"), "two failures in a row show in Needs attention, with a link to the runs", att?.text);
  pass(((await dev.system.overview()) as any).attention.some((a: any) => a.kind === "job-failed") && !((await (await as(await mk("other", "user", { teamRole: "developer" }))).system.overview()) as any).attention.some((a: any) => a.kind === "job-failed"), "the developer of that app sees it too; someone without the app does not");
  await db.insert(cronRuns).values({ jobId: j1.id, siteId: A.id, status: "running", startedAt: new Date() });
  const r3: any = await runJob({ cronId: j1.id, trigger: "schedule" });
  const [after3] = await db.select().from(cronJobs).where(eq(cronJobs.id, j1.id));
  pass(r3.status === "skipped" && after3.failStreak === 2, "while a run is still going, the next one is skipped, and a skip is not a failure");
  await db.update(cronRuns).set({ startedAt: new Date(Date.now() - 2 * 3600_000) }).where(eq(cronRuns.status, "running"));
  const r4: any = await runJob({ cronId: j1.id, trigger: "schedule" });
  const stale = (await db.select().from(cronRuns).where(eq(cronRuns.jobId, j1.id))).filter((r: any) => (r.output ?? "").includes("cut short"));
  pass(r4.status === "failed" && stale.length === 1, "a run left 'running' by a restart long ago is closed, and the new run goes ahead");
  await dev.cron.setActive({ id: j1.id, active: false });
  const r5: any = await runJob({ cronId: j1.id, trigger: "schedule" });
  pass(r5.skipped === "paused", "a paused job does not run on its schedule");
  pass(hideSecrets("token=abc123secret and abc123secret again", ["abc123secret"]) === "token=•••••• and •••••• again", "values of the app's variables are hidden in output");
  const runsList: any[] = await view.cron.runs({ jobId: j1.id });
  const one: any = await view.cron.run({ runId: runsList[0].id });
  pass(runsList.length >= 4 && one.output && one.job.id === j1.id, "a viewer can read the runs and their output");

  console.log(failed ? `${failed} FAILED` : "jobs and workers hold");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
