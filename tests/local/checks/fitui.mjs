// the fit check in the panel: Room left on the Overview, the capacity settings, a template that does not fit, a new app that does
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { call, login, PW, pass, waitDeploys } from "/t/lib.mjs";
const out = "/tmp/shots";
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const auth = await login("admin", PW);
const DEFAULTS = { hostReservePct: 15, overcommitPct: 150, diskReserveGb: null };
await call("m", "system.setCapacity", DEFAULTS);
const errors = [];
let holder = null;
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
async function open(path, theme = "dark") {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.evaluateOnNewDocument((t, th) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", th); }, auth.token, theme);
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  await page.goto("http://localhost:3000" + path, { waitUntil: "networkidle0", timeout: 30000 });
  await page.bringToFront();
  return page;
}
const text = (page) => page.evaluate(() => document.body.innerText);
const shot = (page, name) => page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 82 });
try {
  // Overview
  let page = await open("/");
  await page.waitForSelector("::-p-text(Room left)", { timeout: 15000 });
  let t = await text(page);
  pass(/New apps that fit/.test(t) && /Memory promised to apps/.test(t) && /Disk free/.test(t), "the Overview shows Room left to the owner");
  await shot(page, "fit-overview");
  await page.close();
  page = await open("/", "light");
  await page.waitForSelector("::-p-text(Room left)", { timeout: 15000 });
  await shot(page, "fit-overview-light");
  await page.close();

  // Settings
  page = await open("/settings?tab=server");
  await page.waitForSelector("#cap-over", { timeout: 15000 });
  const val = await page.$eval("#cap-over", (el) => el.value);
  pass(val === "150", "the capacity settings show the current values", val);
  await page.click("#cap-over", { clickCount: 3 });
  await page.type("#cap-over", "500");
  const off = await page.evaluate(() => [...document.querySelectorAll(".card")].find((c) => /Capacity/.test(c.querySelector("h3")?.textContent || "")).querySelector("button.btn-primary").disabled);
  pass(off, "a value outside the range cannot be saved");
  await page.click("#cap-reserve", { clickCount: 3 });
  await page.type("#cap-reserve", "60");
  await page.click("#cap-over", { clickCount: 3 });
  await page.type("#cap-over", "100");
  await page.evaluate(() => [...document.querySelectorAll(".card")].find((c) => /Capacity/.test(c.querySelector("h3")?.textContent || "")).querySelector("button.btn-primary").click());
  await page.waitForSelector("::-p-text(Capacity settings saved)", { timeout: 10000 });
  const cap = await call("q", "system.capacity");
  pass(cap.settings.hostReservePct === 60 && cap.settings.overcommitPct === 100, "saving from the panel changes the server's settings", JSON.stringify(cap.settings));
  await page.evaluate(() => document.querySelector(".scroll")?.scrollTo(0, 9999));
  await sleep(300);
  await shot(page, "fit-settings");
  await page.close();

  // One app holding 1.5 GB of the 3 GB that strict settings leave: a 2 GB template no longer fits, a 512 MB app still does
  for (const old of (await call("q", "sites.list")).filter((x) => x.domain === "fitholder.localhost")) await call("m", "sites.delete", { id: old.id });
  holder = await call("m", "sites.create", { domain: "fitholder.localhost", source: "image", image: "docker.io/traefik/whoami:latest", port: 80, memoryLimit: 256 });
  await waitDeploys(240000);
  const raised = await call("m", "sites.update", { id: holder.id, memoryLimit: 1500 });
  pass(raised?.memoryLimit === 1500, "an app holds 1.5 GB");

  page = await open("/templates");
  await page.waitForSelector("::-p-text(Open WebUI)", { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll("button.card")].find((b) => /Open WebUI/.test(b.textContent)).click());
  await page.waitForSelector("::-p-text(This does not fit on the server)", { timeout: 15000 });
  t = await text(page);
  pass(/can still be promised/.test(t) && /What you can do/.test(t), "the template dialog explains why it does not fit, and what to do");
  const btn = () => page.evaluate(() => [...document.querySelectorAll("button.btn-primary")].find((b) => /Deploy/.test(b.textContent)).disabled);
  pass((await btn()) === true, "Deploy is off while it does not fit");
  await shot(page, "fit-template-blocked");
  await page.evaluate(() => document.querySelector(".notice.bad input[type=checkbox]").click());
  await sleep(200);
  pass((await btn()) === false, "the owner can tick Deploy anyway, which turns Deploy back on");
  await page.close();
  page = await open("/templates", "light");
  await page.waitForSelector("::-p-text(Open WebUI)", { timeout: 15000 });
  await page.evaluate(() => [...document.querySelectorAll("button.card")].find((b) => /Open WebUI/.test(b.textContent)).click());
  await page.waitForSelector("::-p-text(This does not fit on the server)", { timeout: 15000 });
  await shot(page, "fit-template-blocked-light");
  await page.close();

  // A new app with the default 512 MB still fits
  page = await open("/apps/new");
  await page.click("::-p-text(Docker image)");
  await page.type("input.input.mono", "traefik/whoami:latest");
  await page.evaluate(() => [...document.querySelectorAll("button.btn-primary")].find((b) => /Continue/.test(b.textContent)).click());
  await page.waitForFunction(() => /It fits/.test(document.body.innerText), { timeout: 15000 });
  t = await text(page);
  pass(/It fits/.test(t), "the Configure step of a new app says it fits", (t.match(/It fits[^\n]*/) || [""])[0]);
  await page.evaluate(() => document.querySelector(".scroll")?.scrollTo(0, 9999));
  await sleep(300);
  await shot(page, "fit-new-app");
  await page.close();
} catch (e) {
  pass(false, "panel flow", String(e.message).slice(0, 200));
  const pages = await browser.pages();
  const last = pages[pages.length - 1];
  await last.screenshot({ path: `${out}/fit-failure.jpg`, type: "jpeg", quality: 80 }).catch(() => {});
  console.log("  at failure:", JSON.stringify(await call("q", "system.fit", { memoryMb: 2048 })).slice(0, 300));
  console.log("  page says:", (await last.evaluate(() => document.querySelector("[role=dialog]")?.innerText || document.body.innerText.slice(0, 300)).catch(() => "")).replace(/\n+/g, " | ").slice(0, 400));
}
await browser.close();
await call("m", "system.setCapacity", DEFAULTS);
if (holder?.id) await call("m", "sites.delete", { id: holder.id });
console.log(errors.length ? "PAGE ERRORS\n" + [...new Set(errors)].join("\n") : "no page errors");
