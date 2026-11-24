// screenshots of the landing page (the separate deploy-king project, served on :3100 inside the check container)
// usage: node /t/landing-shots.mjs            -> full page at 1440, 834 and 390 in both themes, plus the open menus
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
const out = "/tmp/shots";
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = process.env.LANDING_URL || "http://localhost:3100";
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const errors = [];
const results = [];
for (const theme of ["dark", "light"]) {
  for (const [name, width, height] of [["desk", 1440, 900], ["tab", 834, 1100], ["mob", 390, 844]]) {
    const page = await browser.newPage();
    await page.setViewport({ width, height });
    await page.evaluateOnNewDocument((t) => localStorage.setItem("dk-theme", t), theme);
    page.on("pageerror", (e) => errors.push(`${theme}/${name}: ${String(e.message).slice(0, 200)}`));
    page.on("console", (m) => m.type() === "error" && errors.push(`${theme}/${name} console: ${m.text().slice(0, 200)}`));
    await page.goto(URL, { waitUntil: "networkidle0" });
    await sleep(9500); // let the hero preview reach "Live"
    const info = await page.evaluate(() => ({
      theme: document.documentElement.dataset.theme,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      height: document.documentElement.scrollHeight,
      font: getComputedStyle(document.querySelector("h1")).fontFamily.slice(0, 40),
    }));
    results.push({ shot: `${theme}-${name}`, ...info });
    await page.screenshot({ path: `${out}/lp-${theme}-${name}-top.jpg`, type: "jpeg", quality: 82 });
    await page.screenshot({ path: `${out}/lp-${theme}-${name}-full.jpg`, type: "jpeg", quality: 72, fullPage: true });
    if (name === "desk") {
      await page.click(".nav button.nav-link");
      await sleep(400);
      await page.screenshot({ path: `${out}/lp-${theme}-desk-menu.jpg`, type: "jpeg", quality: 82 });
      await page.keyboard.press("Escape");
      // the toggle flips the theme and remembers it
      await page.click('button[aria-label^="Switch to"]');
      await sleep(200);
      const after = await page.evaluate(() => [document.documentElement.dataset.theme, localStorage.getItem("dk-theme")]);
      results.push({ toggle: `${theme} -> ${after[0]}`, stored: after[1] });
    }
    if (name === "mob") {
      await page.click(".hdr-burger");
      await sleep(400);
      await page.screenshot({ path: `${out}/lp-${theme}-mob-menu.jpg`, type: "jpeg", quality: 82 });
    }
    await page.close();
  }
}
await browser.close();
console.log(JSON.stringify(results, null, 1));
console.log(errors.length ? "ERRORS\n" + errors.join("\n") : "no page errors");
