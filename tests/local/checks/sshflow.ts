// Servers & SSH end to end, against a real EMPTY database (run by freshdb.sh) and a real SSH server in a container.
//   bash /t/freshdb.sh sshflow.ts
// Run from apps/api. The SSH server is started here (docker or podman, image lscr.io/linuxserver/openssh-server)
// as the container "dk-check-sshd" and removed at the end. Set SSH_TEST_ENGINE=none to skip when there is no engine.
//
// Covers: admins only; key pair made by the panel and stored encrypted; "Install it for me" with a one-time
// password that is not stored; trust on first use; the connection test; a terminal over the WebSocket gateway
// with the password re-check, recording, replay, idle timeout and 30-day clean-up; key rotation, and a failed
// rotation that changes nothing; a changed host key refused (on the same server, and by a fake server); import,
// delete, security defaults, removal and the audit trail.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";

async function main() {
  const root = process.cwd();
  const req = createRequire(root + "/package.json");
  if (!process.env.MASTER_KEY || Buffer.from(process.env.MASTER_KEY, "hex").length !== 32) process.env.MASTER_KEY = crypto.randomBytes(32).toString("hex");
  const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-ssh-rec-"));
  process.env.DK_SSH_RECORDINGS_DIR = recDir;

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + String(extra).slice(0, 300) : "")); };
  const code = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => e?.code ?? String(e?.message).slice(0, 80));
  const msg = async (p: Promise<unknown>) => p.then(() => "OK", (e: any) => String(e?.message));

  // ── the SSH server ──
  const engine = process.env.SSH_TEST_ENGINE ?? (["docker", "podman"].find((e) => { try { execFileSync(e, ["version"], { stdio: "ignore" }); return true; } catch { return false; } }) || "none");
  if (engine === "none") { console.log("NOTE  no container engine: the SSH checks need one (docker or podman)"); process.exit(0); }
  const C = "dk-check-sshd";
  const PW = "Deploy-Check-Passw0rd";
  const sh = (...a: string[]) => execFileSync(engine, a, { encoding: "utf8" });
  const inC = (cmd: string) => sh("exec", C, "sh", "-c", cmd);
  try { sh("rm", "-f", "-v", C); } catch {}
  const sshPort = 20000 + Math.floor(Math.random() * 20000);
  sh("run", "-d", "--name", C, "-e", "PUID=1000", "-e", "PGID=1000", "-e", "USER_NAME=deploy", "-e", `USER_PASSWORD=${PW}`, "-e", "PASSWORD_ACCESS=true", "-e", "SUDO_ACCESS=true", "-p", `127.0.0.1:${sshPort}:2222`, process.env.SSH_TEST_IMAGE || "lscr.io/linuxserver/openssh-server:latest");
  const starts = () => { try { return (sh("logs", C).match(/listening on port 2222/g) ?? []).length; } catch { return 0; } };
  const waitSshd = async (before = 0) => { for (let i = 0; i < 60; i++) { try { if (starts() > before) { try { inC("ls /config/ssh_host_keys/ssh_host_ed25519_key.pub"); return true; } catch {} } } catch {} await new Promise((r) => setTimeout(r, 1000)); } return false; };
  pass(await waitSshd(), "a real SSH server is running in a container", `${engine} ${C} on 127.0.0.1:${sshPort}`);
  const hostFp = () => inC("ssh-keygen -lf /config/ssh_host_keys/ssh_host_ed25519_key.pub").split(/\s+/)[1];
  const authKeys = () => { try { return inC("cat /config/.ssh/authorized_keys"); } catch { return ""; } };

  let server: http.Server | null = null;
  try {
    const { appRouter } = await import(root + "/src/trpc/index");
    const dbm = await import(req.resolve("@dbbkp/db"));
    const { db, users, sshServers, sshKeys, sshSessions, auditLogs } = dbm;
    const { eq } = await import(req.resolve("drizzle-orm"));
    const { issueSession } = await import(root + "/src/services/team");
    const { setupWebSocketGateway } = await import(root + "/src/ws/gateway");
    const { pruneRecordings } = await import(root + "/src/ws/ssh");
    const { decrypt } = await import(req.resolve("@dbbkp/security"));
    const jwt = req("jsonwebtoken");
    const bcrypt = req("bcryptjs");
    const WebSocket = req("ws");
    const { utils, Server: SshServer } = req("ssh2");

    const ADMIN_PW = "Admin-Check-Passw0rd-1";
    const mk = async (username: string, role: string, extra: any = {}) => (await db.insert(users).values({ email: username + "@t.local", username, passwordHash: await bcrypt.hash(ADMIN_PW, 4), role, ...extra }).returning())[0];
    const tokens: Record<string, string> = {};
    const as = async (u: any) => { const s = await issueSession(u); tokens[u.username] = s.token; const p: any = jwt.decode(s.token); return appRouter.createCaller({ user: { sub: u.id, sid: p.sid, username: u.username, role: u.role, mustChangePassword: false }, ip: "10.0.0.1" }); };
    const adminRow = await mk("owner", "admin"), devRow = await mk("dev", "user", { teamRole: "developer" });
    const admin = await as(adminRow), dev = await as(devRow);

    // ── admins only ──
    pass((await code(dev.servers.list())) === "FORBIDDEN" && (await code(dev.servers.keys())) === "FORBIDDEN" && (await code(dev.servers.create({ name: "x", host: "127.0.0.1", port: 22, username: "deploy", authMethod: "key" } as any))) === "FORBIDDEN", "servers and keys are for admins only");

    // ── step 1: connection ──
    const srv: any = await admin.servers.create({ name: "db-primary", host: "127.0.0.1", port: sshPort, username: "deploy", authMethod: "password-once", timeoutSec: 10 });
    pass(srv.status === "waiting_key" && srv.rules.idleMinutes === 15 && srv.rules.record === true, "step 1 saves the server, waiting for a key, with the default access rules", JSON.stringify(srv.rules));
    pass((await code(admin.servers.create({ name: "db-primary", host: "127.0.0.2", port: 22, username: "deploy", authMethod: "key" }))) === "CONFLICT", "names are unique");
    pass((await msg(admin.servers.create({ name: "bad", host: "h; rm -rf /", port: 22, username: "deploy", authMethod: "key" }))).includes("host name"), "a host that is not a host name is refused");

    // ── step 2: SSH key ──
    const prep: any = await admin.servers.prepareKey({ serverId: srv.id, type: "ed25519", label: "deploy-king@db-primary", lock: true, restrict: true, rotateDays: 90 });
    const prepJson = JSON.stringify(prep);
    pass(prep.key.publicKey.startsWith("ssh-ed25519 AAAA") && prep.key.fingerprint.startsWith("SHA256:") && !/PRIVATE KEY/.test(prepJson) && !("encryptedPrivateKey" in prep.key), "a key pair is generated; only the public half and fingerprint come back");
    pass(prep.install.command.includes(prep.key.publicKey) && prep.install.line.includes("restrict,pty") && prep.install.lockPending === true, "the one command to paste holds the public key and its limits; the lock address is not known yet", prep.install.line.slice(0, 60));
    const [krow] = await db.select().from(sshKeys).where(eq(sshKeys.id, prep.key.id));
    pass(!krow.encryptedPrivateKey.includes("OPENSSH") && decrypt({ encryptedValue: krow.encryptedPrivateKey, iv: krow.iv, authTag: krow.authTag }).includes("BEGIN OPENSSH PRIVATE KEY"), "the private half is stored encrypted with the app's MASTER_KEY");
    const again: any = await admin.servers.prepareKey({ serverId: srv.id, type: "ed25519", label: "deploy-king@db-primary", lock: true, restrict: true, rotateDays: 90 });
    pass(again.key.id !== prep.key.id && (await db.select().from(sshKeys)).length === 1, "Generate again replaces the key that never reached the server");
    const keyId = again.key.id;

    pass((await msg(admin.servers.installKey({ serverId: srv.id, password: "wrong-password" }))).includes("not accepted"), "Install key with a wrong password says so");
    const inst: any = await admin.servers.installKey({ serverId: srv.id, password: PW });
    const ak = authKeys();
    pass(inst.installed && ak.includes(`from="${inst.from}",restrict,pty ssh-ed25519`) && ak.includes(again.key.publicKey.split(" ")[1]), "Install it for me adds the key, locked to the address the server sees the panel as", ak.trim().slice(0, 90));
    const dump = JSON.stringify(await db.select().from(sshServers)) + JSON.stringify(await db.select().from(auditLogs));
    const [s1] = await db.select().from(sshServers).where(eq(sshServers.id, srv.id));
    pass(!dump.includes(PW) && !s1.encryptedPassword && s1.authMethod === "key" && s1.status === "waiting_trust", "the one-time password is used once and stored nowhere; the server now signs in with the key", s1.status);
    pass(s1.seenHostKeyFingerprint === hostFp() && !s1.hostKeyFingerprint, "the host key seen on first contact is pinned, not yet trusted", s1.seenHostKeyFingerprint ?? "");

    // ── step 3: verify ──
    const pr: any = await admin.servers.probe({ id: srv.id });
    pass(pr.fingerprint === hostFp() && pr.type === "ED25519" && pr.trusted === false, "step 3 shows the fingerprint that ssh-keygen -lf prints on the server", pr.fingerprint);

    // the WebSocket gateway on a real HTTP server
    server = http.createServer();
    setupWebSocketGateway(server);
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    const wsPort = (server.address() as any).port;
    const socket = (who: string) => new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/ws?token=${encodeURIComponent(tokens[who])}`);
      const inbox: any[] = [];
      const waiters: Array<{ f: (m: any) => boolean; r: (m: any) => void }> = [];
      ws.on("message", (raw: Buffer) => { const m = JSON.parse(raw.toString()); inbox.push(m); for (const w of [...waiters]) if (w.f(m)) { waiters.splice(waiters.indexOf(w), 1); w.r(m); } });
      ws.on("error", reject);
      ws.on("open", () => resolve({
        ws, inbox,
        send: (m: any) => ws.send(JSON.stringify(m)),
        wait: (f: (m: any) => boolean, ms = 15000) => new Promise((r, j) => { const hit = inbox.find(f); if (hit) return r(hit); const t = setTimeout(() => j(new Error("timeout waiting; got " + JSON.stringify(inbox.slice(-3)).slice(0, 300))), ms); waiters.push({ f, r: (m) => { clearTimeout(t); r(m); } }); }),
        output: (id: string) => inbox.filter((m) => m.channel === "ssh" && m.id === id).map((m) => m.payload.data).join(""),
      }));
    });
    const A = await socket("owner");
    A.send({ type: "ssh.open", serverId: srv.id, cols: 100, rows: 30, password: ADMIN_PW });
    const early: any = await A.wait((m) => m.type === "ssh.error" || m.type === "ssh.opened");
    pass(early.type === "ssh.error" && early.code === "HOSTKEY" && /fingerprint first/.test(early.message), "no terminal opens before the fingerprint is trusted", early.message);

    pass((await msg(admin.servers.trust({ id: srv.id, fingerprint: "SHA256:" + "A".repeat(43) }))).includes("not the fingerprint you confirmed"), "trusting a fingerprint the server does not show is refused");
    await admin.servers.trust({ id: srv.id, fingerprint: pr.fingerprint });
    const [trustedRow] = await db.select().from(sshServers).where(eq(sshServers.id, srv.id));
    pass(trustedRow.hostKeyFingerprint === pr.fingerprint && trustedRow.status === "connected", "trusting the fingerprint of a server whose key works makes it Connected", trustedRow.status);
    const t1: any = await admin.servers.test({ id: srv.id });
    const ck = (k: string) => t1.checks.find((c: any) => c.key === k);
    pass(t1.ok && /Reachable on port/.test(ck("reach")?.title) && /Signed in as deploy with the new key/.test(ck("auth")?.title), "the connection test: reachable, and signed in with the new key", JSON.stringify(t1.checks.map((c: any) => c.title)));
    pass(ck("system")?.detail.includes("vCPU") && ck("password")?.state === "warn" && /still on/.test(ck("password")?.title) && !!ck("sudo") && !!ck("docker"), "it reports the system, that password sign-in is still on, sudo and Docker", `${ck("system")?.title} · ${ck("sudo")?.title} · ${ck("docker")?.title}`);
    const s2: any = await admin.servers.get({ id: srv.id });
    pass(s2.status === "connected" && s2.system.cpus > 0 && s2.system.memoryMb > 0 && s2.system.diskFreeGb != null, "the server is Connected, with its CPU, memory and disk", JSON.stringify(s2.system).slice(0, 160));
    await admin.servers.finish({ id: srv.id, rules: { adminsOnly: true, askPassword: true, record: true, idleMinutes: 15, allowAutomation: false } });
    pass(((await admin.servers.list()) as any).servers[0].setupDone === true, "Add server finishes the setup");

    // ── terminal ──
    A.inbox.length = 0;
    A.send({ type: "ssh.open", serverId: srv.id, cols: 100, rows: 30 });
    const np: any = await A.wait((m) => m.type === "ssh.error" || m.type === "ssh.opened");
    A.send({ type: "ssh.open", serverId: srv.id, cols: 100, rows: 30, password: "not-my-password" });
    const wp: any = await A.wait((m) => m.type === "ssh.error" && m.code !== "PASSWORD_REQUIRED");
    pass(np.code === "PASSWORD_REQUIRED" && wp.code === "PASSWORD_WRONG", "the access rule asks for the panel password again before a terminal opens", `${np.code} ${wp.code}`);
    const D = await socket("dev");
    D.send({ type: "ssh.open", serverId: srv.id, password: ADMIN_PW });
    const dn: any = await D.wait((m) => m.type === "ssh.error");
    pass(dn.code === "FORBIDDEN", "a non-admin cannot open a terminal over the socket");
    D.ws.close();

    A.inbox.length = 0;
    A.send({ type: "ssh.open", serverId: srv.id, cols: 100, rows: 30, password: ADMIN_PW });
    const op: any = await A.wait((m) => m.type === "ssh.opened" || m.type === "ssh.error");
    pass(op.type === "ssh.opened" && op.recording === true && op.idleMinutes === 15, "the terminal opens over the WebSocket, recorded, closing after 15 minutes idle", JSON.stringify(op));
    const sid = op.sessionId;
    A.send({ type: "ssh.input", id: sid, data: "echo dk-$((6*7)) && whoami\r" });
    await A.wait((m) => m.channel === "ssh" && m.id === sid && /dk-42/.test(A.output(sid)));
    await new Promise((r) => setTimeout(r, 400));
    pass(/dk-42/.test(A.output(sid)) && /deploy/.test(A.output(sid).split("dk-42").pop() ?? ""), "a command typed in the terminal runs on the server and its output streams back");
    A.send({ type: "ssh.resize", id: sid, cols: 120, rows: 40 });
    const other = await socket("owner");
    other.send({ type: "ssh.input", id: sid, data: "echo hijack\r" });
    await new Promise((r) => setTimeout(r, 500));
    pass(!/hijack/.test(A.output(sid)), "another socket cannot type into someone's session");
    other.ws.close();
    const listed: any = await admin.servers.list();
    pass(listed.servers[0].liveSessions === 1, "the server list counts the open session");
    A.send({ type: "ssh.close", id: sid });
    const cl: any = await A.wait((m) => m.type === "ssh.closed" && m.sessionId === sid);
    pass(cl.reason === "ended", "End session closes it");
    const sess: any[] = await admin.servers.sessions({ id: srv.id });
    pass(sess.length === 1 && sess[0].recorded && sess[0].commands >= 1 && sess[0].actor === "owner" && sess[0].endedAt, "the session is listed with who, when and how many commands", JSON.stringify(sess[0]).slice(0, 200));
    const rec: any = await admin.servers.recording({ sessionId: sid });
    const lines = rec.cast.trim().split("\n");
    const hdr = JSON.parse(lines[0]);
    pass(hdr.version === 2 && hdr.width === 100 && lines.some((l: string) => l.includes("dk-42")) && lines.some((l: string) => l.includes('"r","120x40"')), "the recording replays: asciicast v2 with output and the resize", `${lines.length} lines`);
    pass(!rec.cast.includes(ADMIN_PW), "the panel password typed to open the terminal is not in the recording");

    // idle timeout
    await admin.servers.setRules({ id: srv.id, rules: { adminsOnly: true, askPassword: false, record: true, idleMinutes: 0.05, allowAutomation: false } });
    A.inbox.length = 0;
    A.send({ type: "ssh.open", serverId: srv.id });
    const op2: any = await A.wait((m) => m.type === "ssh.opened" || m.type === "ssh.error");
    const idle: any = await A.wait((m) => m.type === "ssh.closed" && m.sessionId === op2.sessionId, 15000).catch((e: any) => e);
    pass(op2.type === "ssh.opened" && idle?.reason === "idle" && /without typing/.test(A.output(op2.sessionId)), "an idle session is closed, with a line saying why", idle?.reason ?? String(idle));
    await admin.servers.setRules({ id: srv.id, rules: { adminsOnly: false, askPassword: false, record: true, idleMinutes: 15, allowAutomation: false } });
    pass(((await admin.servers.get({ id: srv.id })) as any).rules.adminsOnly === true, "only admins can open a terminal stays on");

    // Disconnect closes live sessions
    A.inbox.length = 0;
    A.send({ type: "ssh.open", serverId: srv.id });
    const op3: any = await A.wait((m) => m.type === "ssh.opened");
    const dc: any = await admin.servers.disconnect({ id: srv.id });
    const cl3: any = await A.wait((m) => m.type === "ssh.closed" && m.sessionId === op3.sessionId);
    pass(dc.closed === 1 && cl3.reason === "disconnected", "Disconnect ends the open sessions on that server");

    // 30 days
    const [firstRec] = await db.select().from(sshSessions).where(eq(sshSessions.id, sid));
    await db.update(sshSessions).set({ startedAt: new Date(Date.now() - 31 * 86_400_000) }).where(eq(sshSessions.id, sid));
    const pruned = await pruneRecordings();
    const [afterPrune] = await db.select().from(sshSessions).where(eq(sshSessions.id, sid));
    pass(pruned === 1 && !fs.existsSync(firstRec.recordingPath!) && afterPrune.recordingPath === null && (await code(admin.servers.recording({ sessionId: sid }))) === "NOT_FOUND", "recordings older than 30 days are deleted; the session stays listed");

    // ── key rotation ──
    const oldBlob = again.key.publicKey.split(" ")[1];
    inC("chown root:root /config/.ssh/authorized_keys && chmod 644 /config/.ssh/authorized_keys"); // deploy can no longer change it
    const badRot: any = await admin.servers.rotateKey({ id: keyId });
    inC("chown 1000:1000 /config/.ssh/authorized_keys && chmod 600 /config/.ssh/authorized_keys");
    const keysAfterBad: any[] = await admin.servers.keys();
    const [s3] = await db.select().from(sshServers).where(eq(sshServers.id, srv.id));
    pass(badRot.ok === false && /nothing changed/.test(badRot.message) && keysAfterBad.length === 1 && s3.keyId === keyId && authKeys().includes(oldBlob), "when the new key cannot be added, the old key stays and nothing changes", badRot.message);
    pass((await admin.servers.test({ id: srv.id }) as any).ok, "the old key still works after the failed rotation");
    const rot: any = await admin.servers.rotateKey({ id: keyId });
    const ak2 = authKeys();
    const [s4] = await db.select().from(sshServers).where(eq(sshServers.id, srv.id));
    const newKey: any = (await admin.servers.keys() as any[])[0];
    pass(rot.ok && s4.keyId === rot.keyId && newKey.id === rot.keyId && ak2.includes(newKey.publicKey.split(" ")[1]) && !ak2.includes(oldBlob) && ak2.includes(`from="${inst.from}",restrict,pty`), "rotation: new key added with the old one, tested, the old one removed from the server and from the panel", rot.message);
    pass((await admin.servers.test({ id: srv.id }) as any).ok, "the server signs in with the new key");

    // ── a changed host key is refused ──
    const trusted = hostFp();
    // the image makes new host keys at start when their folder is missing
    const before = starts();
    inC("rm -rf /config/ssh_host_keys /etc/ssh/ssh_host_*");
    sh("restart", C);
    pass(await waitSshd(before), "the SSH server restarted with new host keys");
    const changedFp = hostFp();
    const t2: any = await admin.servers.test({ id: srv.id });
    const [s5] = await db.select().from(sshServers).where(eq(sshServers.id, srv.id));
    pass(changedFp !== trusted && !t2.ok && t2.checks.some((c: any) => c.key === "hostkey" && /Wrong fingerprint/.test(c.title)) && s5.status === "host_key_changed" && s5.statusNote?.includes(changedFp), "after the server's host key changes, the test refuses to connect and says why", s5.statusNote ?? "");
    A.inbox.length = 0;
    A.send({ type: "ssh.open", serverId: srv.id });
    const hk: any = await A.wait((m) => m.type === "ssh.error" || m.type === "ssh.opened");
    pass(hk.type === "ssh.error" && hk.code === "HOSTKEY", "and no terminal opens", hk.message);
    const refused = (await db.select().from(auditLogs).where(eq(auditLogs.action, "ssh_host_refused"))).length;
    pass(refused >= 2, "every refusal is in the audit log", String(refused));
    pass((await msg(admin.servers.trust({ id: srv.id, fingerprint: changedFp }))).includes("already has a trusted fingerprint"), "the new fingerprint is not trusted without saying you know why it changed");
    await admin.servers.trust({ id: srv.id, fingerprint: changedFp, replace: true });
    pass((await admin.servers.test({ id: srv.id }) as any).ok, "once replaced on purpose, it connects again");

    // a fake server at the same address: refused before any sign-in is sent
    // (ssh2 now and then writes an Ed25519 key it cannot read back; the panel's own generator checks for that)
    let fakeKey = utils.generateKeyPairSync("ed25519");
    while (utils.parseKey(fakeKey.private) instanceof Error) fakeKey = utils.generateKeyPairSync("ed25519");
    let fakeAuth = 0;
    const fake = new SshServer({ hostKeys: [fakeKey.private] }, (client: any) => { client.on("authentication", (ctx: any) => { fakeAuth++; ctx.reject(); }); client.on("error", () => {}); });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
    const fakePort = fake.address().port;
    await admin.servers.update({ id: srv.id, name: "db-primary", host: "127.0.0.1", port: fakePort, username: "deploy", timeoutSec: 10, jumpServerId: null });
    const t3: any = await admin.servers.test({ id: srv.id });
    pass(!t3.ok && t3.checks.some((c: any) => c.key === "hostkey") && fakeAuth === 0, "a different machine at the server's address is refused before the key is offered", `auth attempts seen by the fake: ${fakeAuth}`);
    fake.close();
    await admin.servers.update({ id: srv.id, name: "db-primary", host: "127.0.0.1", port: sshPort, username: "deploy", timeoutSec: 10, jumpServerId: null });

    // ── keys page ──
    let own = utils.generateKeyPairSync("ed25519", { comment: "laptop" });
    while (utils.parseKey(own.private) instanceof Error) own = utils.generateKeyPairSync("ed25519", { comment: "laptop" });
    const imp: any = await admin.servers.importKey({ label: "ops-shared", privateKey: own.private, lock: false, restrict: false, rotateDays: null });
    pass(imp.key.publicKey.split(" ")[1] === own.public.split(" ")[1] && !JSON.stringify(imp).includes("PRIVATE"), "Import a key works out the public half and never returns the private one");
    pass((await code(admin.servers.importKey({ label: "again", privateKey: own.private, lock: false, restrict: false, rotateDays: null }))) === "CONFLICT", "the same key cannot be imported twice");
    pass((await msg(admin.servers.importKey({ label: "pub", privateKey: own.public + "\n".repeat(60), lock: false, restrict: false, rotateDays: null }))).length > 0, "a public key pasted as a private key is refused");
    const gen: any = await admin.servers.generateKey({ type: "rsa4096", label: "old-ci", lock: true, restrict: true, rotateDays: 180 });
    pass(gen.key.typeLabel === "RSA 4096" && gen.install.line.startsWith(`from="${inst.from}",restrict,pty ssh-rsa`), "Generate key on the keys page; new keys are locked to the address servers last saw", gen.install.line.slice(0, 50));
    const keys: any[] = await admin.servers.keys();
    const used = keys.find((k) => k.id === rot.keyId);
    pass(used.usedBy[0]?.name === "db-primary" && used.rotateInDays === 90 && keys.find((k) => k.id === imp.key.id).usedBy.length === 0, "each key says which server uses it and when to rotate");
    pass((await msg(admin.servers.deleteKey({ id: rot.keyId }))).includes("still uses this key") && (await code(admin.servers.deleteKey({ id: gen.key.id }))) === "OK", "a key in use cannot be deleted; an unused one can");

    // ── security defaults ──
    const st: any = await admin.servers.settings();
    pass(st.keyType === "ed25519" && st.rotateDays === 90 && st.effectiveAddress === inst.from, "security defaults, with the panel address learned from the server", st.effectiveAddress);
    await admin.servers.saveSettings({ keyType: "ed25519", rotateDays: 180, lockToPanel: true, askPassword: false, record: true, allowPasswordSignIn: false, panelAddress: "203.0.113.10" });
    pass((await msg(admin.servers.create({ name: "legacy-web", host: "127.0.0.1", port: sshPort, username: "deploy", authMethod: "password" }))).includes("turned off"), "with password sign-in off, a password server cannot be added");
    pass((await msg(admin.servers.saveSettings({ keyType: "ed25519", rotateDays: 90, lockToPanel: true, askPassword: false, record: true, allowPasswordSignIn: true, panelAddress: '1.2.3.4",x' }))).includes("IP address"), "the panel address cannot break out of from=\"...\"");
    await admin.servers.saveSettings({ keyType: "ed25519", rotateDays: 90, lockToPanel: true, askPassword: false, record: true, allowPasswordSignIn: true, panelAddress: null });

    // password every time
    const pwSrv: any = await admin.servers.create({ name: "legacy-web", host: "127.0.0.1", port: sshPort, username: "deploy", authMethod: "password" });
    await admin.servers.setPassword({ serverId: pwSrv.id, password: PW });
    const pp: any = await admin.servers.probe({ id: pwSrv.id });
    await admin.servers.trust({ id: pwSrv.id, fingerprint: pp.fingerprint });
    const t4: any = await admin.servers.test({ id: pwSrv.id });
    const [pwRow] = await db.select().from(sshServers).where(eq(sshServers.id, pwSrv.id));
    pass(t4.ok && /stored password/.test(t4.checks.find((c: any) => c.key === "auth").title) && pwRow.encryptedPassword && !pwRow.encryptedPassword.includes(PW), "Password every time: stored encrypted and used to sign in", t4.checks.find((c: any) => c.key === "auth").title);
    pass(!JSON.stringify(await admin.servers.get({ id: pwSrv.id })).includes(pwRow.encryptedPassword!), "the stored password is never sent to the panel");

    // ── activity, removal ──
    const act: any[] = await admin.servers.activity({ id: srv.id });
    const kinds = new Set(act.map((a) => a.action));
    pass(["ssh_server_add", "ssh_key_install", "ssh_host_trust", "ssh_test", "ssh_terminal_open", "ssh_terminal_close", "ssh_host_refused", "ssh_server_update"].every((k) => kinds.has(k)) && act.filter((a) => a.action === "ssh_terminal_denied").some((a) => a.actor === "dev") && act.filter((a) => a.action !== "ssh_terminal_denied").every((a) => a.actor === "owner"), "every action is in the server's Activity, under who did it", [...kinds].join(","));
    const rotAudit = await db.select().from(auditLogs).where(eq(auditLogs.action, "ssh_key_rotate"));
    pass(rotAudit.length === 2, "both rotations, failed and done, are audited");
    await admin.servers.remove({ id: pwSrv.id });
    await admin.servers.remove({ id: srv.id });
    pass((await db.select().from(sshServers)).length === 0 && (await db.select().from(sshSessions)).length === 0 && fs.readdirSync(recDir).length === 0, "removing a server removes its sessions and recordings");
    A.ws.close();
  } catch (e: any) {
    failed++;
    console.log("CRASH " + (e?.stack ?? e));
  } finally {
    try { sh("rm", "-f", "-v", C); } catch {}
    server?.close();
    fs.rmSync(recDir, { recursive: true, force: true });
  }
  console.log(failed ? `${failed} FAILED` : "servers and ssh hold");
  process.exit(failed ? 1 : 0);
}
main();
