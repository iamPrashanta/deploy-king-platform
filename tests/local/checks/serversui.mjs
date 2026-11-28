// Servers & SSH in the browser, against the running API and panel and a real SSH server in a container:
// add a server with the 3-step wizard (one-time password installs the key), confirm the fingerprint,
// open the terminal over the WebSocket and run a command, replay the session, rotate the key on the Keys tab,
// and see a changed host key refused. Screenshots go to /tmp/shots/servers-*.jpg.
//   node /t/serversui.mjs
// Settings (defaults are the test environment's): DK_API, DK_PANEL, SHOT_DIR (holds puppeteer-core), CHROME,
// SSH_TEST_ENGINE (docker | podman | none), SSH_TEST_IMAGE. The SSH server must be reachable from the API
// at 127.0.0.1, so run this where the container engine and the API share a network (as sshflow.ts does).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";

const API = process.env.DK_API || "http://localhost:4000";
const PANEL = process.env.DK_PANEL || "http://localhost:3000";
const require = createRequire((process.env.SHOT_DIR || "/tmp/shot") + "/package.json");
const puppeteer = require("puppeteer-core");
const PW = process.env.DK_ADMIN_PASSWORD || "Check-Passw0rd-12345";
const out = "/tmp/shots";
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const pass = (ok, label, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + String(extra).slice(0, 200) : "")); };

let token = null;
async function call(kind, path, input) {
  const h = { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) };
  const r = kind === "q"
    ? await fetch(`${API}/trpc/${path}${input === undefined ? "" : "?input=" + encodeURIComponent(JSON.stringify(input))}`, { headers: h })
    : await fetch(`${API}/trpc/${path}`, { method: "POST", headers: h, body: JSON.stringify(input ?? {}) });
  const j = await r.json().catch(() => ({}));
  if (j.error) return { error: j.error.data?.code, message: j.error.message };
  return j.result?.data;
}
const login = async (username, password = PW) => { token = null; const d = await call("m", "auth.login", { username, password }); token = d?.token ?? null; return token; };

// ── the SSH server ──
const engine = process.env.SSH_TEST_ENGINE ?? (["docker", "podman"].find((e) => { try { execFileSync(e, ["version"], { stdio: "ignore" }); return true; } catch { return false; } }) || "none");
if (engine === "none") { console.log("NOTE  no container engine: the Servers browser check needs one (docker or podman)"); process.exit(0); }
const C = "dk-check-sshd-ui";
const SSH_PW = "Deploy-Ui-Passw0rd";
const sh = (...a) => execFileSync(engine, a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const inC = (cmd) => sh("exec", C, "sh", "-c", cmd);
try { sh("rm", "-f", C); } catch {}
const sshPort = 20000 + Math.floor(Math.random() * 20000);
sh("run", "-d", "--name", C, "-e", "PUID=1000", "-e", "PGID=1000", "-e", "USER_NAME=deploy", "-e", `USER_PASSWORD=${SSH_PW}`, "-e", "PASSWORD_ACCESS=true", "-p", `127.0.0.1:${sshPort}:2222`, process.env.SSH_TEST_IMAGE || "lscr.io/linuxserver/openssh-server:latest");
const starts = () => { try { return (sh("logs", C).match(/listening on port 2222/g) ?? []).length; } catch { return 0; } };
const waitSshd = async (before = 0) => { for (let i = 0; i < 60; i++) { if (starts() > before) { try { inC("ls /config/ssh_host_keys/ssh_host_ed25519_key.pub"); return true; } catch {} } await sleep(1000); } return false; };
const hostFp = () => inC("ssh-keygen -lf /config/ssh_host_keys/ssh_host_ed25519_key.pub").split(/\s+/)[1];
const authKeys = () => { try { return inC("cat /config/.ssh/authorized_keys"); } catch { return ""; } };

const errors = [];
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
async function open(path, tok) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.evaluateOnNewDocument((t) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", "dark"); }, tok);
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto(PANEL + path, { waitUntil: "networkidle0", timeout: 60000 });
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);
const waitText = (page, t, timeout = 30000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t).then(() => true, () => false);
const shot = (page, name) => page.screenshot({ path: `${out}/servers-${name}.jpg`, type: "jpeg", quality: 80, fullPage: true });
const click = async (page, label, sel = "button, a") => {
  const ok = await page.evaluate((l, s) => { const el = [...document.querySelectorAll(s)].find((e) => e.innerText.trim() === l && !e.disabled); if (el) el.click(); return !!el; }, label, sel);
  if (!ok) throw new Error(`no enabled "${label}" to click`);
};
const typeInto = async (page, selector, value) => { await page.focus(selector); await page.keyboard.down("Control"); await page.keyboard.press("A"); await page.keyboard.up("Control"); await page.type(selector, value); };
const termText = (page) => page.evaluate(() => document.querySelector(".xterm-rows")?.innerText ?? "");
const waitTerm = (page, re, timeout = 20000) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector(".xterm-rows")?.innerText ?? ""), { timeout }, re.source).then(() => true, () => false);

let serverId = null;
let adminTok = null;
try {
  pass(await waitSshd(), "a real SSH server is running in a container", `${engine} ${C} on 127.0.0.1:${sshPort}`);
  adminTok = await login("admin");
  pass(!!adminTok, "signed in as admin");
  for (const s of (await call("q", "servers.list"))?.servers ?? []) if (s.name === "web-eu") await call("m", "servers.remove", { id: s.id });

  // ── Servers ──
  let page = await open("/servers", adminTok);
  pass(await waitText(page, "Connect your other servers over SSH"), "Servers lists this server and the three steps to add one");
  const t0 = await text(page);
  pass(t0.includes("this server") && t0.includes("Add the server") && t0.includes("Create an SSH key") && t0.includes("Check and connect"), "the steps are in the design's words");
  pass(await page.evaluate(() => [...document.querySelectorAll("nav a, aside a")].some((a) => a.getAttribute("href") === "/servers")), "Servers is in the sidebar");
  await shot(page, "1-list");

  // ── 1 Connection ──
  await click(page, "Add server");
  await page.waitForSelector("#sv-name", { timeout: 30000 });
  await typeInto(page, "#sv-name", "web-eu");
  await typeInto(page, "#sv-host", "127.0.0.1");
  await typeInto(page, "#sv-port", String(sshPort));
  await typeInto(page, "#sv-user", "deploy");
  await page.evaluate(() => [...document.querySelectorAll("label.choice")].find((l) => l.innerText.includes("Password once, then a key"))?.click());
  await shot(page, "2-connection");
  await click(page, "Continue");

  // ── 2 SSH key ──
  pass(await waitText(page, "Key pair created"), "step 2 makes a key pair straight away");
  serverId = new URL(page.url()).searchParams.get("id");
  const pub = await page.evaluate(() => [...document.querySelectorAll("pre.code")].map((p) => p.innerText).find((t) => t.startsWith("ssh-ed25519 ")) ?? "");
  const t2 = await text(page);
  pass(pub.startsWith("ssh-ed25519 AAAA") && !t2.includes("PRIVATE KEY") && t2.includes("Limit what this key can do"), "the public key is shown, the private one never", pub.slice(0, 40));
  await shot(page, "3-key");
  await page.type("#k-install-pw", SSH_PW);
  await click(page, "Install key");
  await page.waitForFunction(() => location.search.includes("step=3"), { timeout: 40000 }).catch(() => {});
  const ak = authKeys();
  pass(page.url().includes("step=3") && ak.includes(pub.split(" ")[1]) && /from="[^"]+",restrict,pty ssh-ed25519/.test(ak), "Install it for me puts the key on the server with a one-time password, locked to this panel", ak.trim().slice(0, 60));

  // ── 3 Verify ──
  pass(await waitText(page, "It identified itself with this fingerprint"), "step 3 shows the server's fingerprint");
  const fpShown = await text(page);
  pass(fpShown.includes(hostFp()), "it is the fingerprint ssh-keygen -lf prints on the server", hostFp());
  pass(await waitText(page, "Signed in as deploy with the new key"), "the connection test signs in with the new key");
  const t3 = await text(page);
  pass(t3.includes("Password sign-in is still on") && t3.includes("vCPU") && t3.includes("Access rules for this server"), "and reports the system, password sign-in and the access rules");
  pass(await page.evaluate(() => [...document.querySelectorAll("button")].find((b) => b.innerText.trim() === "Add server")?.disabled === true), "Add server waits until the fingerprint is trusted");
  await shot(page, "4-verify");
  await click(page, "It matches. Trust this server");
  pass(await waitText(page, "Trusted"), "the fingerprint is trusted");
  await sleep(500);
  await click(page, "Add server");
  await page.waitForFunction((id) => location.pathname === `/servers/${id}`, { timeout: 30000 }, serverId).catch(() => {});
  pass(page.url().includes(`/servers/${serverId}`), "Add server opens the server's page");
  pass(await waitText(page, "Connected") && !(await text(page)).includes("Not verified yet"), "the new server is Connected");

  // ── Terminal ──
  pass(await waitText(page, "Your Deploy King password"), "the terminal asks for the panel password first");
  await page.type("#ssh-pw", PW);
  await click(page, "Open terminal");
  pass(await waitText(page, "Recording"), "the terminal opens over the WebSocket, recorded");
  await sleep(800);
  await page.focus(".xterm-helper-textarea");
  await page.keyboard.type("echo dk-$((6*7)) && whoami\n");
  pass(await waitTerm(page, /dk-42\s*\n?\s*deploy/), "a command typed in the terminal runs on the server", (await termText(page)).split("\n").filter((l) => l.trim()).slice(-3).join(" / "));
  await page.evaluate(() => { const row = [...document.querySelectorAll(".attn-row")].find((r) => r.innerText.includes("Disk usage")); row?.querySelector("button")?.click(); });
  pass(await waitTerm(page, /Filesystem/), "a quick command runs in the open terminal");
  const t4 = await text(page);
  pass(["CPU", "Memory", "Disk", "Uptime", "Quick commands", "Recent sessions"].every((w) => t4.includes(w)), "the Terminal tab has CPU, memory, disk, uptime, quick commands and recent sessions");
  await shot(page, "5-terminal");
  await click(page, "End session");
  pass(await waitTerm(page, /Session ended/), "End session closes it");
  await sleep(1500);
  pass(await waitText(page, "Replay"), "the session is listed with a Replay button");
  await click(page, "Replay");
  await page.waitForFunction(() => [...document.querySelectorAll(".xterm-rows")].some((r) => /dk-42/.test(r.innerText)), { timeout: 20000 }).catch(() => {});
  pass(await page.evaluate(() => [...document.querySelectorAll(".xterm-rows")].some((r) => /dk-42/.test(r.innerText))), "Replay plays the recorded session back");
  await shot(page, "6-replay");
  await page.keyboard.press("Escape");
  await sleep(400);

  // ── Keys: rotate ──
  const before = await call("q", "servers.get", { id: serverId });
  page = await open(`/servers/${serverId}?tab=keys`, adminTok);
  pass(await waitText(page, "Rotate this key"), "the Keys tab explains rotation");
  await click(page, "Rotate");
  pass(await waitText(page, "Rotated on 1 server", 60000), "Rotate: a new key is added with the old one, tested, and the old one removed");
  const after = await call("q", "servers.get", { id: serverId });
  const ak2 = authKeys();
  pass(after.key.fingerprint !== before.key.fingerprint && ak2.includes(after.key.publicKey.split(" ")[1]) && !ak2.includes(before.key.publicKey.split(" ")[1]), "the server now holds only the new key", after.key.fingerprint);
  await sleep(800);
  await shot(page, "7-keys");

  // ── a changed host key is refused ──
  const n = starts();
  inC("rm -rf /config/ssh_host_keys /etc/ssh/ssh_host_*");
  sh("restart", C);
  pass(await waitSshd(n), "the SSH server restarted with new host keys");
  page = await open(`/servers/${serverId}?tab=overview`, adminTok);
  pass(await waitText(page, "Deploy King refused to connect", 40000), "the changed fingerprint is refused, and the page says so");
  pass((await text(page)).includes("Fingerprint changed"), "the server is marked Fingerprint changed");
  await click(page, "Review");
  pass(await waitText(page, hostFp()), "Review shows the new fingerprint without trusting it");
  await shot(page, "8-hostkey-changed");
  const tt = await open(`/servers/${serverId}`, adminTok);
  await waitText(tt, "Your Deploy King password");
  await tt.type("#ssh-pw", PW);
  await click(tt, "Open terminal");
  pass(await waitText(tt, "not the one you trusted"), "no terminal opens on the changed server");
  await tt.close();
  await click(page, "I know why it changed. Trust the new fingerprint");
  pass(await waitText(page, "New fingerprint trusted"), "trusting the new fingerprint on purpose clears the warning");

  // ── Activity, SSH keys ──
  page = await open(`/servers/${serverId}?tab=activity`, adminTok);
  await waitText(page, "opened a terminal");
  const t5 = await text(page);
  pass(["added the server", "installed the key", "trusted the fingerprint", "opened a terminal", "connection refused: the fingerprint changed"].every((w) => t5.includes(w)), "Activity lists every action, the refusal included");
  await shot(page, "9-activity");
  page = await open("/servers/keys", adminTok);
  await waitText(page, "Security defaults");
  const t6 = await text(page);
  pass(t6.includes("deploy-king@web-eu") && t6.includes("web-eu") && t6.includes("Rotating a key") && t6.includes("Refuse to connect when a server's fingerprint changes"), "SSH keys lists the key, where it is used, the security defaults and how rotation works");
  await shot(page, "10-sshkeys");

  // ── not for non-admins ──
  const bobTok = await login("bob", process.env.DK_BOB_PASSWORD || "Bob-Passw0rd-12345");
  token = adminTok;
  if (bobTok) {
    page = await open("/servers", bobTok);
    await waitText(page, "managed by admins");
    pass((await text(page)).includes("Servers are managed by admins"), "a non-admin cannot see the servers");
  } else console.log("NOTE  no user bob: the non-admin view was not checked");
  pass(errors.length === 0, "no errors in the browser", errors.join(" / "));
} catch (e) {
  failed++;
  console.log("CRASH " + (e?.stack ?? e));
} finally {
  if (serverId && adminTok) { token = adminTok; await call("m", "servers.remove", { id: serverId }); }
  if (adminTok) { token = adminTok; for (const k of (await call("q", "servers.keys")) ?? []) if (k.label === "deploy-king@web-eu" && !k.usedBy.length) await call("m", "servers.deleteKey", { id: k.id }); }
  try { sh("rm", "-f", C); } catch {}
  await browser.close();
}
console.log(failed ? `${failed} FAILED` : "servers in the panel hold");
process.exit(failed ? 1 : 0);
