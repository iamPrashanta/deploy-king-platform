// crash-loop watcher: an app that goes live and then keeps dying is flagged, shown on the Overview,
// starts "keeps crashing" workflows once, and is cleared by the next good deploy
import { execSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import { call, login, upload, pass, PW } from "/t/lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = await login("admin", PW);

fs.rmSync("/tmp/z/crashy", { recursive: true, force: true });
fs.mkdirSync("/tmp/z/crashy", { recursive: true });
fs.writeFileSync(
  "/tmp/z/crashy/Dockerfile",
  `FROM busybox:stable\nRUN mkdir /www && echo ok > /www/index.html\nEXPOSE 8080\nCMD ["sh", "-c", "httpd -p 8080 -h /www; sleep 28; echo 'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory' >&2; exit 1"]\n`
);
execSync("cd /tmp/z/crashy && rm -f ../crashy.zip && zip -qr ../crashy.zip .");

const wf = await call("m", "automations.create", { name: "Crash alert test" });
await call("m", "automations.update", {
  id: wf.id,
  graph: {
    nodes: [
      { id: "t", type: "trigger.deployment", position: { x: 0, y: 0 }, data: { event: "crashing" } },
      { id: "h", type: "action.http", position: { x: 200, y: 0 }, data: { url: "http://localhost:4000/health?app={{ trigger.app }}&restarts={{ trigger.restarts }}&oom={{ trigger.outOfMemory }}" } },
    ],
    edges: [{ id: "t-out-h", source: "t", target: "h", sourceHandle: null }],
  },
});
await call("m", "automations.setEnabled", { id: wf.id, enabled: true });
const deployWf = await call("m", "automations.create", { name: "Any deploy test" });
await call("m", "automations.update", {
  id: deployWf.id,
  graph: { nodes: [{ id: "t", type: "trigger.deployment", position: { x: 0, y: 0 }, data: { event: "any" } }], edges: [] },
});
await call("m", "automations.setEnabled", { id: deployWf.id, enabled: true });

const u = await upload("crashy.localhost", "auto", "/tmp/z/crashy.zip");
pass(u.status === 200, "uploaded the crashing app", JSON.stringify(u.body).slice(0, 80));
const site = async () => (await call("q", "sites.list")).find((s) => s.domain === "crashy.localhost");
let s;
for (let i = 0; i < 60; i++) { await sleep(3000); s = await site(); if (s && s.status !== "provisioning") break; }
pass(s?.status === "active" && s.health === "ok", "it passed its deploy checks and went live", `${s?.status} / ${s?.health}`);
const liveAt = Date.now();
for (let i = 0; i < 100; i++) { await sleep(3000); s = await site(); if (s.health === "crashing") break; }
pass(s.health === "crashing", "flagged as crashing", `${Math.round((Date.now() - liveAt) / 1000)}s after going live · ${JSON.stringify({ ...s.healthDetail, lastOutput: undefined })}`);
pass(s.healthDetail?.outOfMemory === true && s.healthDetail.restarts >= 3, "detail says out of memory and counts restarts");
pass(s.status === "active", "status stays active (no pointless redeploy of the same image)", s.status);

const o = await call("q", "system.overview");
const att = o.attention.find((a) => a.siteId === s.id);
pass(o.apps.crashing === 1 && att?.kind === "crashing" && /out of memory/i.test(att.text), "Overview lists it under Needs attention", att?.text);

await sleep(25000); // two more reconcile rounds: the event must not fire again
const runs = await call("q", "automations.runs", { id: wf.id, limit: 10 });
const run = runs[0] ? await call("q", "automations.run", { runId: runs[0].id }) : null;
pass(runs.length === 1 && run?.trigger === "app" && run.status === "success", "the crash workflow ran exactly once", `${runs.length} run(s) · ${run?.steps?.h?.output?.url}`);
const deployRuns = await call("q", "automations.runs", { id: deployWf.id, limit: 10 });
pass(deployRuns.length === 1, "an 'any deploy' workflow heard the deploy but not the crash", String(deployRuns.length));

// screenshots while it is crashing
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
for (const [path, theme, name] of [["/", "dark", "attention-dark"], ["/", "light", "attention-light"], ["/apps", "dark", "apps-crashing"]]) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((t, th) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", th); }, auth.token, theme);
  await page.goto("http://localhost:3000" + path, { waitUntil: "networkidle0" });
  await sleep(900);
  fs.mkdirSync("/tmp/shots", { recursive: true });
  await page.screenshot({ path: `/tmp/shots/${name}.jpg`, type: "jpeg", quality: 80 });
  await page.close();
}
await browser.close();

// a new deploy starts with a clean record
await call("m", "sites.redeploy", { id: s.id, restartOnly: true });
for (let i = 0; i < 40; i++) { await sleep(3000); s = await site(); if (s.status !== "provisioning") break; }
pass(s.status === "active" && s.health === "ok" && s.restartsSeen === 0, "a new deploy clears the crashing flag", `${s.status} / ${s.health} / seen ${s.restartsSeen}`);

await call("m", "sites.delete", { id: s.id });
await call("m", "automations.delete", { id: wf.id });
await call("m", "automations.delete", { id: deployWf.id });
console.log("cleaned up");
