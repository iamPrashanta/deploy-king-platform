import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fakeAnthropic, fakeDeployKing } from "./fakes";
import { findAttachments } from "../src/session";
import { prepareUpload } from "@dbbkp/assistant";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const bundle = path.join(root, "dist", "dk.mjs");
const TOKEN = "dk_" + "t".repeat(40);
// Shaped like a key so the CLI accepts it; it only ever goes to the local fake server.
const FAKE_KEY = "sk-ant-test-" + "k".repeat(30);

before(() => {
  execFileSync(process.execPath, ["build.mjs"], { cwd: root, stdio: "ignore" });
});

function run(args: string[], input: string, env: Record<string, string>) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, [bundle, ...args], {
      env: { PATH: process.env.PATH ?? "", HOME: env.HOME ?? os.tmpdir(), NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(input);
  });
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dk-cli-"));

test("dk login checks the token against the API and stores it readable only by the owner", async (t) => {
  const dk = await fakeDeployKing({ platform_status: () => ({ version: "0.4.0", appsGet: "<name>.localhost", you: { username: "admin", role: "admin" } }) });
  t.after(() => dk.close());
  const dir = tmp();
  const cfg = path.join(dir, "deploy-king", "config.json");
  const r = await run(["login", "--url", dk.url], `${TOKEN}\n`, { DK_CONFIG: cfg, HOME: dir });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Signed in as admin on Deploy King 0\.4\.0/);
  assert.ok(!r.out.includes(TOKEN), "the token is not echoed");
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")), { apiUrl: dk.url, token: TOKEN });

  const bad = await run(["login", "--url", dk.url, "--token", "dk_" + "w".repeat(40)], "", { DK_CONFIG: path.join(dir, "other.json"), HOME: dir });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /token was refused[\s\S]*Nothing was saved/);
  assert.ok(!fs.existsSync(path.join(dir, "other.json")));

  const key = await run(["config", "set", "anthropic-key", FAKE_KEY], "", { DK_CONFIG: cfg, HOME: dir });
  assert.equal(key.code, 0, key.out);
  assert.equal(JSON.parse(fs.readFileSync(cfg, "utf8")).anthropicKey, FAKE_KEY);
  assert.equal(fs.statSync(cfg).mode & 0o777, 0o600);
  const show = await run(["config", "show"], "", { DK_CONFIG: cfg, HOME: dir });
  assert.ok(!show.out.includes(FAKE_KEY) && !show.out.includes(TOKEN), "config show masks secrets");
});

test("a dk session: header, findings, plan, approval, steps, slash commands", async (t) => {
  const dk = await fakeDeployKing({
    platform_status: () => ({ version: "0.4.0", you: { username: "prashanta", role: "admin" } }),
    list_apps: () => ({ count: 2, apps: [{ name: "blog.localhost", status: "active", url: "http://blog.localhost" }, { name: "shop.localhost", status: "crashing", url: "http://shop.localhost" }] }),
    get_app: () => ({ name: "shop.localhost", status: "crashing", container: { restarts: 4 }, variables: ["DATABASE_URL"] }),
    set_env: (a) => ({ app: "shop.localhost", set: Object.keys(a.set) }),
    deploy_app: () => ({ app: "shop.localhost", deploymentId: "d2" }),
    wait_for_deploy: () => ({ app: "shop.localhost", url: "http://shop.localhost", result: "live", deployment: { status: "active" } }),
    get_app_logs: () => ({ app: "shop.localhost", running: true, logs: "Error: JWT_SECRET is not set\n" }),
  });
  t.after(() => dk.close());
  const ai = await fakeAnthropic([
    [{ type: "text", text: "Looking at shop." }, { type: "tool_use", name: "get_app", input: { app: "shop" } }],
    [{ type: "tool_use", name: "propose_plan", input: { app: "shop", tools: ["set_env", "deploy_app"], steps: ["Set the JWT_SECRET you gave on shop", "Restart shop"] } }],
    [{ type: "tool_use", name: "set_env", input: { app: "shop", set: { JWT_SECRET: "{{secret:JWT_SECRET}}" } } }, { type: "tool_use", name: "deploy_app", input: { app: "shop", restartOnly: true } }],
    [{ type: "tool_use", name: "wait_for_deploy", input: { app: "shop" } }],
    [{ type: "text", text: "shop is live at http://shop.localhost" }],
  ]);
  t.after(() => ai.close());
  const dir = tmp();
  const secret = "my-very-secret-jwt-value-42";
  const input = [`shop keeps crashing, use JWT_SECRET=${secret}`, "1", "/apps", "/logs shop", "/undo", "/quit", ""].join("\n");
  const r = await run([], input, { DK_CONFIG: path.join(dir, "c.json"), HOME: dir, DK_API_URL: dk.url, DK_TOKEN: TOKEN, ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: ai.url });
  const o = r.out;
  assert.equal(r.code, 0, o);
  assert.match(o, /╭─+╮/);
  assert.match(o, /♛ Deploy King 0\.4\.0 · signed in as prashanta/);
  assert.match(o, /1 app running/);
  assert.match(o, /\/help · \/apps · \/logs · \/undo · \/quit/);
  assert.match(o, /● shop\.localhost: crashing, 4 restarts/);
  assert.match(o, /Plan\n\s+1\. Set the JWT_SECRET you gave on shop\n\s+2\. Restart shop/);
  assert.match(o, /\? Apply this plan\?/);
  assert.match(o, /Yes, and don't ask again for shop/);
  assert.match(o, /✓ set JWT_SECRET\s+\d+ ms/);
  assert.match(o, /✓ shop\.localhost: deploy started/);
  assert.match(o, /✓ live at http:\/\/shop\.localhost/);
  assert.match(o, /shop is live at http:\/\/shop\.localhost/);
  assert.match(o, /● blog\.localhost\s+active/);
  assert.match(o, /Error: JWT_SECRET is not set/);
  assert.match(o, /Undo is not supported yet/);
  assert.equal(o.split(secret).length - 1, 1, "the secret shows only where the user typed it");

  // The real value went to Deploy King, never to the model.
  assert.deepEqual(dk.calls.find((c) => c.name === "set_env")!.args, { app: "shop", set: { JWT_SECRET: secret } });
  assert.ok(ai.requests.length === 5);
  assert.ok(!JSON.stringify(ai.requests.map((q) => q.body)).includes(secret));
  const first = ai.requests[0]!.body;
  assert.equal(first.model, "claude-sonnet-5-5");
  assert.equal(first.stream, true);
  assert.match(first.system[0].text, /Deploy King/);
  assert.ok(first.tools.some((t: any) => t.name === "deploy_zip"));
  const h = ai.requests[0]!.headers;
  assert.ok(h["x-api-key"] === FAKE_KEY || h.authorization === `Bearer ${FAKE_KEY}`, "the key from ANTHROPIC_API_KEY is used");
});

test("no plan is applied when the user says no", async (t) => {
  const dk = await fakeDeployKing({ platform_status: () => ({ version: "0.4.0" }), list_apps: () => ({ count: 0, apps: [] }), delete_app: () => ({ deleted: "blog.localhost" }) });
  t.after(() => dk.close());
  const ai = await fakeAnthropic([[{ type: "tool_use", name: "delete_app", input: { app: "blog", confirm: "blog.localhost" } }], [{ type: "text", text: "Kept it." }]]);
  t.after(() => ai.close());
  const dir = tmp();
  const r = await run([], ["delete blog", "3", "/quit", ""].join("\n"), { DK_CONFIG: path.join(dir, "c.json"), HOME: dir, DK_API_URL: dk.url, DK_TOKEN: TOKEN, ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: ai.url });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /1\. Delete blog\.localhost for good/);
  assert.match(r.out, /Nothing was changed/);
  assert.ok(!dk.calls.some((c) => c.name === "delete_app"));
});

test("without a token dk says how to sign in; without an Anthropic key the AI is off but /apps works", async (t) => {
  const dir = tmp();
  const a = await run([], "", { DK_CONFIG: path.join(dir, "c.json"), HOME: dir });
  assert.equal(a.code, 1);
  assert.match(a.out, /Not signed in\. Run: dk login/);
  const dk = await fakeDeployKing({ platform_status: () => ({ version: "0.4.0" }), list_apps: () => ({ count: 1, apps: [{ name: "a.localhost", status: "active", url: "http://a.localhost" }] }) });
  t.after(() => dk.close());
  const b = await run([], "hello\n/apps\n/quit\n", { DK_CONFIG: path.join(dir, "c.json"), HOME: dir, DK_API_URL: dk.url, DK_TOKEN: TOKEN });
  assert.match(b.out, /No Anthropic API key\. Set ANTHROPIC_API_KEY, or run: dk config set anthropic-key/);
  assert.match(b.out, /● a\.localhost\s+active/);
});

test("paths to ZIPs and folders in a message are attached; other words are not", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "shop-api.zip"), "PK");
  fs.mkdirSync(path.join(dir, "site"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  const got = findAttachments("deploy ./shop-api.zip and ./site, not ./notes.txt or site or missing.zip", dir);
  assert.deepEqual(got, [{ path: path.join(dir, "shop-api.zip"), name: "shop-api.zip" }, { path: path.join(dir, "site"), name: "site" }]);
  assert.deepEqual(findAttachments("deploy shop-api.zip", dir).map((a) => a.name), ["shop-api.zip"]);
});

test("deploying a ZIP from the prompt: attached, checked here, uploaded after approval; don't ask again is remembered", async (t) => {
  const dk = await fakeDeployKing({
    platform_status: () => ({ version: "0.4.0" }),
    list_apps: () => ({ count: 0, apps: [] }),
    wait_for_deploy: () => ({ app: "site.localhost", url: "http://site.localhost", result: "live" }),
    deploy_app: () => ({ app: "site.localhost" }),
  });
  t.after(() => dk.close());
  const ai = await fakeAnthropic([
    [{ type: "tool_use", name: "check_project", input: { file: "site.zip" } }],
    [{ type: "tool_use", name: "propose_plan", input: { app: "site", tools: ["deploy_zip"], steps: ["Upload site.zip and deploy it as site"] } }],
    [{ type: "tool_use", name: "deploy_zip", input: { file: "site.zip", name: "site" } }],
    [{ type: "tool_use", name: "wait_for_deploy", input: { app: "site" } }],
    [{ type: "text", text: "site is live." }],
    [{ type: "tool_use", name: "deploy_app", input: { app: "site" } }],
    [{ type: "text", text: "Redeployed." }],
  ]);
  t.after(() => ai.close());
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "src", "site"), { recursive: true });
  fs.writeFileSync(path.join(dir, "src", "site", "index.html"), "<h1>hi</h1>");
  fs.writeFileSync(path.join(dir, "site.zip"), prepareUpload(path.join(dir, "src")).zip);
  const cfg = path.join(dir, "c.json");
  const env = { DK_CONFIG: cfg, HOME: dir, DK_API_URL: dk.url, DK_TOKEN: TOKEN, ANTHROPIC_API_KEY: FAKE_KEY, ANTHROPIC_BASE_URL: ai.url };
  const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, [bundle], { cwd: dir, env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
    p.stdin.end(["deploy ./site.zip as site", "2", "redeploy site", "/quit", ""].join("\n"));
  });
  const o = r.out;
  assert.equal(r.code, 0, o);
  assert.match(o, /attached ~\/site\.zip|attached .*site\.zip/);
  assert.match(o, /● Checked site\.zip: Static HTML · static/);
  assert.match(o, /✓ x\.localhost uploaded, deploy started/);
  assert.match(o, /✓ live at http:\/\/site\.localhost/);
  assert.equal(dk.calls.filter((c) => c.name === "upload").length, 1);
  // The second plan for the same app was approved without asking.
  assert.match(o, /Approved: you chose not to be asked again for site/);
  assert.equal(o.match(/Apply this plan\?/g)!.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfg, "utf8")).trustedApps, { [dk.url]: ["site"] });
  assert.ok(dk.calls.some((c) => c.name === "deploy_app"));
});
