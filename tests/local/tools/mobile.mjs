// phone-width screenshots: overview, and the sidebar opened from the menu button
import { createRequire } from "node:module";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { login, PW } from "/t/lib.mjs";
const auth = await login("admin", PW);
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu"] });
const page = await browser.newPage();
await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true });
await page.evaluateOnNewDocument((t) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", "dark"); }, auth.token);
await page.goto("http://localhost:3000/apps", { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1000));
await page.screenshot({ path: "/tmp/shots/m-apps.jpg", type: "jpeg", quality: 75 });
await page.click('button[aria-label="Menu"]');
await new Promise((r) => setTimeout(r, 500));
await page.screenshot({ path: "/tmp/shots/m-menu.jpg", type: "jpeg", quality: 75 });
await browser.close();
console.log("ok");
