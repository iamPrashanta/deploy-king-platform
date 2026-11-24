// screenshots of panel pages in dark and light, with a signed-in session
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { call, login, PW } from "/t/lib.mjs";

const out = "/tmp/shots";
fs.mkdirSync(out, { recursive: true });
const auth = await login("admin", PW);
const sites = await call("q", "sites.list");
const whoami = sites.find((s) => s.domain === "whoami.localhost");

const jobs = (process.argv[2] || "").split(",").filter(Boolean);
const all = {
  overview: ["/", "dark"],
  "overview-light": ["/", "light"],
  apps: ["/apps", "dark"],
  "apps-light": ["/apps", "light"],
  new: ["/apps/new", "dark"],
  app: [`/apps/${whoami?.id}`, "dark"],
  "app-light": [`/apps/${whoami?.id}`, "light"],
  templates: ["/templates", "dark"],
  backup: ["/backup-cli", "dark"],
  "backup-light": ["/backup-cli", "light"],
  settings: ["/settings", "dark"],
  server: ["/settings?tab=server", "light"],
  login: ["/login", "dark", "anon"],
};

const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
for (const name of jobs.length ? jobs : Object.keys(all)) {
  const [path, theme, anon] = all[name];
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((t, th, a) => {
    if (!a) localStorage.setItem("token", t);
    localStorage.setItem("dk-theme", th);
  }, auth.token, theme, !!anon);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message).slice(0, 200)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
  await page.goto("http://localhost:3000" + path, { waitUntil: "networkidle0", timeout: 30000 }).catch((e) => errors.push("goto: " + e.message));
  await new Promise((r) => setTimeout(r, 1200));
  await page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 78 });
  console.log(name, errors.length ? "ERRORS: " + errors.join(" | ") : "ok");
  await page.close();
}
await browser.close();
