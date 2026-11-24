// screenshots of a long panel page, scrolling its content area: node scrollshot.mjs /agents dark name
import { createRequire } from "node:module";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { login, PW } from "/t/lib.mjs";
const [path = "/agents", theme = "dark", name = "page"] = process.argv.slice(2);
const auth = await login("admin", PW);
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
await page.evaluateOnNewDocument((t, th) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", th); }, auth.token, theme);
await page.goto("http://localhost:3000" + path, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 800));
const steps = await page.evaluate(() => {
  const el = [...document.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY));
  window.__sc = el || document.scrollingElement;
  return Math.ceil(window.__sc.scrollHeight / (window.__sc.clientHeight - 120));
});
for (let i = 0; i < Math.min(steps, 5); i++) {
  await page.evaluate((i) => { window.__sc.scrollTop = i * (window.__sc.clientHeight - 120); }, i);
  await new Promise((r) => setTimeout(r, 300));
  await page.screenshot({ path: `/tmp/shots/${name}-${i}.jpg`, type: "jpeg", quality: 80 });
}
console.log(name, "screens:", Math.min(steps, 5));
await browser.close();
