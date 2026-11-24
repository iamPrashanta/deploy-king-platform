// end-to-end check of the Workflows pages: recipe -> editor -> edit step -> execute -> executions
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { call, login, PW, pass } from "/t/lib.mjs";

const out = "/tmp/shots";
fs.mkdirSync(out, { recursive: true });
const auth = await login("admin", PW);
for (const w of (await call("q", "automations.list")) ?? []) await call("m", "automations.delete", { id: w.id });
const P = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const errors = [];
async function open(theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((t, th) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", th); }, auth.token, theme);
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message).slice(0, 200)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text().slice(0, 200)));
  page.on("dialog", (d) => d.accept());
  page.on("response", (r) => r.status() === 404 && errors.push("404 " + r.url()));
  return page;
}
async function clickText(page, sel, text) {
  const ok = await page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.includes(text));
    if (el) { el.click(); return true; }
    return false;
  }, sel, text);
  if (!ok) throw new Error(`no ${sel} with "${text}"`);
}
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 80 });

try {
  // 1. list page
  let page = await open("dark");
  await page.goto(P + "/workflows", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(800);
  await shot(page, "wf-list-empty");

  // 2. create from recipe
  await clickText(page, "button", "Check a site every 5 minutes");
  await page.waitForFunction(() => /\/workflows\/[0-9a-f-]{8,}/.test(location.pathname), { timeout: 15000 });
  const id = page.url().split("/workflows/")[1].split("?")[0];
  await page.waitForSelector('.react-flow__node[data-id="get"]', { timeout: 15000 });
  await sleep(900);
  pass(true, "recipe created workflow " + id);
  await shot(page, "wf-editor");

  // 3. open the request step and point it at the API health check
  await page.click('.react-flow__node[data-id="get"]');
  await page.waitForSelector(".wf-side", { timeout: 5000 });
  const url = await page.$('.wf-side input[placeholder^="https://… or"]');
  await url.click({ clickCount: 3 });
  await url.type("http://localhost:4000/health");
  await sleep(300);
  const badge = await page.evaluate(() => document.querySelector(".wf-bar")?.textContent || "");
  pass(/Unsaved/.test(badge), "edit marks the workflow unsaved", badge.replace(/\s+/g, " ").slice(0, 80));
  await shot(page, "wf-editor-step");

  // 4. save with Ctrl+S
  await page.keyboard.down("Control"); await page.keyboard.press("s"); await page.keyboard.up("Control");
  await page.waitForFunction(() => /Saved/.test(document.querySelector(".wf-bar")?.textContent || ""), { timeout: 8000 });
  const saved = await call("q", "automations.get", { id });
  const getNode = saved.graph.nodes.find((n) => n.id === "get");
  pass(getNode?.data?.url === "http://localhost:4000/health", "Ctrl+S saved the new URL", getNode?.data?.url);

  // 5. palette
  await page.click('.react-flow__pane');
  await page.click(".wf-add");
  await sleep(400);
  await shot(page, "wf-palette");
  await page.keyboard.press("Escape");
  await page.click('.react-flow__pane').catch(() => {});

  // 6. execute
  await clickText(page, "button", "Execute workflow");
  await page.waitForFunction(() => /view=runs/.test(location.search), { timeout: 10000 });
  await page.waitForFunction(() => /Success|Failed/.test(document.querySelector(".wf-canvas .badge")?.textContent || ""), { timeout: 30000 });
  await sleep(900);
  const status = await page.evaluate(() => document.querySelector(".wf-canvas .badge")?.textContent);
  pass(status === "Success", "manual execution finished", status);
  const runs = await call("q", "automations.runs", { id, limit: 5 });
  const run = await call("q", "automations.run", { runId: runs[0].id });
  const st = Object.fromEntries(Object.entries(run.steps).map(([k, v]) => [k, v.status + (v.branch ? ":" + v.branch : "")]));
  pass(st.get === "success" && st.up?.startsWith("success") && st.tell === "skipped", "step statuses", JSON.stringify(st));
  await page.click('.react-flow__node[data-id="get"]');
  await sleep(500);
  await shot(page, "wf-runs");

  // 7. light theme versions
  const lp = await open("light");
  await lp.goto(P + "/workflows/" + id, { waitUntil: "networkidle0", timeout: 30000 });
  await lp.waitForSelector('.react-flow__node[data-id="up"]');
  await lp.click('.react-flow__node[data-id="up"]');
  await sleep(700);
  await shot(lp, "wf-editor-light");
  await lp.goto(P + "/workflows/" + id + "?view=runs", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(1200);
  await shot(lp, "wf-runs-light");
  await lp.goto(P + "/workflows", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(800);
  await shot(lp, "wf-list-light");

  // 8. active switch: schedule workflow turns on and off
  const on = await call("m", "automations.setEnabled", { id, enabled: true });
  const after = await call("q", "automations.get", { id });
  pass(after.enabled === true, "workflow can be switched on");
  await call("m", "automations.setEnabled", { id, enabled: false });
} catch (e) {
  console.log("FAIL  " + e.message);
}
console.log(errors.length ? "BROWSER ERRORS:\n" + [...new Set(errors)].join("\n") : "no browser errors");
await browser.close();
