// interactive screenshots: project check, configure, a paused deploy, sign-in, palette, gear menu
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { call, login, PW } from "/t/lib.mjs";

const out = "/tmp/shots";
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = await login("admin", PW);
const only = (process.argv[2] || "").split(",").filter(Boolean);
const want = (n) => !only.length || only.includes(n);

const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
async function open(path, theme = "dark", anon = false) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((t, th, a) => {
    if (!a) localStorage.setItem("token", t);
    localStorage.setItem("dk-theme", th);
  }, auth.token, theme, anon);
  page.on("pageerror", (e) => console.log("  pageerror:", String(e.message).slice(0, 200)));
  await page.goto("http://localhost:3000" + path, { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(800);
  return { page, ctx };
}
const shot = async (page, name) => {
  await page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 78 });
  console.log("saved", name);
};
const scrollMain = (page, y) => page.evaluate((y) => document.querySelector(".scroll")?.scrollTo(0, y), y);

if (want("login")) {
  const { page, ctx } = await open("/login", "light", true);
  await shot(page, "login-light");
  await ctx.close();
}

if (want("check")) {
  const { page, ctx } = await open("/apps/new");
  await page.click("::-p-text(Public Git URL)");
  await page.type("input.input.mono", "https://github.com/heroku/node-js-getting-started.git");
  await page.waitForSelector("::-p-text(Check project)", { timeout: 30000 });
  await sleep(2500);
  await shot(page, "new-source");
  await page.click("::-p-text(Check project)");
  await page.waitForSelector("::-p-text(What we found)", { timeout: 120000 });
  await sleep(600);
  await shot(page, "new-check");
  await scrollMain(page, 700);
  await sleep(300);
  await shot(page, "new-check-2");
  await scrollMain(page, 9999);
  await page.click("::-p-text(Continue)");
  await sleep(800);
  await shot(page, "new-configure");
  await ctx.close();
}

if (want("prompt")) {
  const old = (await call("q", "sites.list")).find((s) => s.domain === "ask.localhost");
  if (old) { await call("m", "sites.delete", { id: old.id }); await sleep(4000); }
  const site = await call("m", "sites.create", { domain: "ask.localhost", source: "image", runtime: "image", image: "traefik/whoami:latest", port: 5000, env: [], volumes: [] });
  let dep;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    dep = (await call("q", "sites.deployments", { id: site.id }))?.[0];
    if (["waiting_input", "failed", "active"].includes(dep?.status)) break;
  }
  console.log("ask.localhost deploy:", dep?.status);
  const { page, ctx } = await open(`/apps/${site.id}`);
  await sleep(1500);
  await shot(page, "prompt");
  const { page: p2, ctx: c2 } = await open(`/apps/${site.id}`, "light");
  await sleep(1500);
  await shot(p2, "prompt-light");
  // answer from the UI: click the primary "Use port 80" button
  await page.click("::-p-text(Use port 80)");
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    dep = (await call("q", "sites.deployments", { id: site.id }))?.[0];
    if (["failed", "active"].includes(dep?.status)) break;
  }
  console.log("after clicking the answer:", dep?.status);
  await sleep(2500);
  await shot(page, "prompt-answered");
  await ctx.close();
  await c2.close();
}

if (want("chrome")) {
  const { page, ctx } = await open("/");
  await page.keyboard.down("Control");
  await page.keyboard.press("k");
  await page.keyboard.up("Control");
  await sleep(500);
  await page.keyboard.type("who");
  await sleep(400);
  await shot(page, "palette");
  await page.keyboard.press("Escape");
  await page.click('button[aria-label="Appearance and settings"]');
  await sleep(300);
  await shot(page, "gear");
  await ctx.close();
}

if (want("backup")) {
  const { page, ctx } = await open("/backup-cli", "light");
  await shot(page, "backup-light");
  await scrollMain(page, 1150);
  await sleep(300);
  await shot(page, "backup-configure-light");
  await ctx.close();
}
await browser.close();
