// deploy n8n from the Templates page like a user would, then check it
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { call, login, PW } from "/t/lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync("/tmp/shots", { recursive: true });
const auth = await login("admin", PW);
const old = (await call("q", "sites.list")).find((s) => s.domain === "n8n.localhost");
if (old) { await call("m", "sites.delete", { id: old.id }); await sleep(5000); }

const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument((t) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", "light"); }, auth.token);
await page.goto("http://localhost:3000/templates", { waitUntil: "networkidle0" });
await page.click("::-p-text(Workflow automation with)");
await sleep(700);
await page.screenshot({ path: "/tmp/shots/n8n-dialog.jpg", type: "jpeg", quality: 78 });
const envKeys = await page.$$eval(".dialog input.input.mono", (els) => els.map((e) => e.value).filter((v) => /^[A-Z0-9_]+$/.test(v)));
console.log("env in dialog:", envKeys.join(", "));
await page.click(".dialog .df .btn-primary");
await page.waitForFunction(() => /\/apps\/[0-9a-f-]{36}/.test(location.pathname), { timeout: 20000 });
const id = (await page.evaluate(() => location.pathname)).split("/").pop();
let dep;
for (let i = 0; i < 80; i++) {
  await sleep(3000);
  dep = (await call("q", "sites.deployments", { id }))?.[0];
  if (["active", "failed", "waiting_input"].includes(dep?.status)) break;
}
console.log("n8n deploy:", dep?.status, (dep?.error || "").slice(0, 200));
await sleep(2500);
await page.screenshot({ path: "/tmp/shots/n8n-app.jpg", type: "jpeg", quality: 78 });
await page.goto("http://localhost:3000/apps", { waitUntil: "networkidle0" });
await sleep(800);
await page.screenshot({ path: "/tmp/shots/sidebar-light.jpg", type: "jpeg", quality: 78 });
await browser.close();
