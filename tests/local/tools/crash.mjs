// the crash banner on a crash-looping app, and fixing it from the UI
import { createRequire } from "node:module";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { call, login, PW } from "/t/lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = await login("admin", PW);
const site = (await call("q", "sites.list")).find((s) => s.domain === process.argv[2]);
const rt = await call("q", "sites.runtime", { id: site.id });
console.log("runtime:", JSON.stringify({ ...rt, lastOutput: rt?.lastOutput?.slice(-120) }));
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument((t) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", "dark"); }, auth.token);
await page.goto(`http://localhost:3000/apps/${site.id}`, { waitUntil: "networkidle0" });
await sleep(1500);
await page.screenshot({ path: "/tmp/shots/crash-banner.jpg", type: "jpeg", quality: 78 });
if (process.argv[3] === "fix") {
  await page.click("::-p-text(Restart with)");
  let dep;
  for (let i = 0; i < 60; i++) {
    await sleep(2500);
    dep = (await call("q", "sites.deployments", { id: site.id }))?.[0];
    if (["active", "failed", "waiting_input"].includes(dep?.status)) break;
  }
  console.log("restart deploy:", dep?.status, (dep?.error || "").slice(0, 160));
  await sleep(3000);
  await page.screenshot({ path: "/tmp/shots/crash-fixed.jpg", type: "jpeg", quality: 78 });
  const s2 = await call("q", "sites.get", { id: site.id });
  console.log("memory now:", s2.memoryLimit);
}
await browser.close();
