// AI agents page: make a token in the UI, use it over MCP through the panel URL, see the activity, revoke it
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire("/tmp/shot/package.json");
const puppeteer = require("puppeteer-core");
import { call, login, PW, pass } from "/t/lib.mjs";

const out = "/tmp/shots";
fs.mkdirSync(out, { recursive: true });
const auth = await login("admin", PW);
for (const t of (await call("q", "mcp.tokens")) ?? []) await call("m", "mcp.revokeToken", { id: t.id });
const P = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const browser = await puppeteer.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
async function open(theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.evaluateOnNewDocument((t, th) => { localStorage.setItem("token", t); localStorage.setItem("dk-theme", th); }, auth.token, theme);
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message).slice(0, 200)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text().slice(0, 200)));
  page.on("response", (r) => r.status() >= 400 && !r.url().includes("/mcp") && errors.push(r.status() + " " + r.url()));
  return page;
}
async function clickText(page, sel, text) {
  const ok = await page.evaluate((sel, text) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(text));
    if (el) { el.click(); return true; }
    return false;
  }, sel, text);
  if (!ok) throw new Error(`no ${sel} with "${text}"`);
}
const shot = (page, name, full = false) => page.screenshot({ path: `${out}/${name}.jpg`, type: "jpeg", quality: 80, fullPage: full });

let token;
try {
  const page = await open("dark");
  await page.goto(P + "/agents", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(600);
  await shot(page, "agents-empty");

  await clickText(page, "button", "New token");
  await page.waitForSelector("#tok-name");
  await page.type("#tok-name", "Claude Code on my laptop");
  await sleep(200);
  await shot(page, "agents-new");
  await clickText(page, ".dialog button", "Create token");
  await page.waitForFunction(() => /Copy your token/.test(document.querySelector(".dialog")?.textContent || ""), { timeout: 10000 });
  token = await page.evaluate(() => [...document.querySelectorAll(".dialog pre.code div")].map((d) => d.textContent).join("").trim());
  pass(/^dk_[A-Za-z0-9_-]{40,}$/.test(token), "UI shows the new token once", token.slice(0, 10) + "…");
  await shot(page, "agents-token");
  await clickText(page, ".dialog button", "Done");
  await sleep(500);
  const cmd = await page.evaluate(() => document.querySelector(".code-box pre")?.textContent || "");
  pass(cmd.includes(token) && cmd.includes("/mcp"), "connect command includes the token and URL", cmd.slice(0, 90));

  // use it through the panel's own address, like a real agent would
  const rpc = async (method, params) => {
    const r = await fetch(P + "/mcp", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  let r = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ui-check", version: "1" } });
  pass(r.status === 200 && r.body?.result?.serverInfo?.name === "deploy-king", "MCP works through the panel URL");
  r = await rpc("tools/list");
  pass(r.body?.result?.tools?.length === 15, "deploy token gets 15 tools", String(r.body?.result?.tools?.length));
  await rpc("tools/call", { name: "list_apps", arguments: {} });
  await rpc("tools/call", { name: "platform_status", arguments: {} });
  await rpc("tools/call", { name: "get_app", arguments: { app: "my-api" } });
  await rpc("tools/call", { name: "delete_app", arguments: { app: "my-api", confirm: "my-api.localhost" } });
  const llms = await (await fetch(P + "/llms.txt")).text();
  pass(llms.includes("http://localhost:3000/mcp") && llms.includes("`create_app`"), "llms.txt names this server and its tools");

  await page.reload({ waitUntil: "networkidle0" });
  await sleep(800);
  await shot(page, "agents-dark", true);
  const rows = await page.evaluate(() => document.querySelectorAll("table").length);
  pass(rows >= 2, "tokens and activity tables shown", String(rows));

  for (const c of ["Claude Desktop", "VS Code", "Codex"]) {
    await clickText(page, ".seg button", c);
    await sleep(150);
  }
  await shot(page, "agents-codex");

  const lp = await open("light");
  await lp.goto(P + "/agents", { waitUntil: "networkidle0", timeout: 30000 });
  await sleep(800);
  await shot(lp, "agents-light", true);

  // revoke from the UI (the first tab must be in front: a background tab never runs waitForFunction's polling)
  await lp.close();
  await page.bringToFront();
  await clickText(page, "button", "Revoke");
  await page.waitForFunction(() => /Revoke this token/.test(document.querySelector(".dialog")?.textContent || ""));
  await clickText(page, ".dialog button", "Revoke");
  await page.waitForFunction(() => !document.querySelector(".dialog"), { timeout: 8000 });
  r = await rpc("tools/list");
  pass(r.status === 401, "revoked from the UI, token stops working", String(r.status));
} catch (e) {
  console.log("FAIL  " + e.message);
}
console.log(errors.length ? "BROWSER ERRORS:\n" + [...new Set(errors)].join("\n") : "no browser errors");
await browser.close();
