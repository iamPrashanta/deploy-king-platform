import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { B, call, login, waitDeploys, viaTraefik, pass, setToken, getToken } from "./lib.mjs";
const require = createRequire("/work/apps/api/package.json");
const WebSocket = require("ws");
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await login();
const byDomain = async () => Object.fromEntries((await call("q", "sites.list")).map((s) => [s.domain, s]));
let S = await byDomain();
const latest = async (id) => (await call("q", "sites.deployments", { id }))[0];

console.log("\n== environment variables");
await call("m", "sites.envSet", { id: S["go.test.local"].id, key: "FOO", value: "bar-123" });
let r = await call("m", "sites.envSet", { id: S["go.test.local"].id, key: "1BAD KEY", value: "x" }, true);
pass(r?.error === "BAD_REQUEST", "invalid env var name rejected");
const envList = await call("q", "sites.envList", { id: S["go.test.local"].id });
pass(envList.length === 1 && envList[0].key === "FOO" && !("value" in envList[0]), "env list returns names only, never values");
const stored = sh(`psql "postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel" -Atc "select encrypted_value from site_env_vars" 2>/dev/null || echo NOPSQL`);
await call("m", "sites.redeploy", { id: S["go.test.local"].id });
await waitDeploys();
let web = await viaTraefik("go.test.local");
pass(web.status === 200 && web.snippet.includes("FOO=bar-123"), "env var reaches the running app after redeploy", web.snippet);

console.log("\n== a broken release must not take a working site down");
const node = S["node.test.local"];
const before = await latest(node.id);
await call("m", "sites.update", { id: node.id, startCommand: "node -e \"console.error('bad release'); process.exit(1)\"" });
await call("m", "sites.redeploy", { id: node.id });
// keep hitting the site while the bad release is being built and started
let hits = 0, bad = 0;
const hammer = (async () => { for (let i = 0; i < 40; i++) { const w = await viaTraefik("node.test.local"); hits++; if (w.status !== 200) bad++; await sleep(500); } })();
await waitDeploys(); await hammer;
S = await byDomain();
let dep = await latest(node.id);
web = await viaTraefik("node.test.local");
pass(dep.status === "failed" && S["node.test.local"].status === "active" && web.status === 200, "failed deploy recorded, site still active and serving", `deploy=${dep.status} site=${S["node.test.local"].status} http=${web.status}`);
pass(bad === 0, `no failed requests during the bad release (${hits} requests, ${bad} errors)`);
pass(S["node.test.local"].currentTag === before.imageTag, "site still points at the previous image");
await call("m", "sites.update", { id: node.id, startCommand: null });

console.log("\n== rollback");
r = await call("m", "sites.rollback", { id: node.id, deploymentId: before.id });
await waitDeploys();
dep = await call("q", "sites.deployment", { deploymentId: r.deploymentId });
web = await viaTraefik("node.test.local");
pass(dep.status === "active" && dep.trigger === "rollback" && dep.imageTag === before.imageTag && /no rebuild/.test(dep.log) && web.status === 200, "rollback re-ran the earlier image without rebuilding", `${Math.round(dep.durationMs / 1000)}s, http=${web.status}`);
r = await call("m", "sites.rollback", { id: S["go.test.local"].id, deploymentId: before.id }, true);
pass(r?.error === "NOT_FOUND", "cannot roll a site back to another site's deployment");

console.log("\n== GitHub webhook");
const body = JSON.stringify({ ref: "refs/heads/main", after: "d".repeat(40), head_commit: { message: "webhook test commit" }, repository: { clone_url: "https://github.com/heroku/node-js-getting-started.git" } });
const post = (headers) => fetch(B + "/webhooks/github", { method: "POST", headers: { "content-type": "application/json", "x-github-event": "push", ...headers }, body });
let w = await post({});
pass(w.status === 401, "unsigned webhook rejected", "status " + w.status);
w = await post({ "x-hub-signature-256": "sha256=forged" });
pass(w.status === 401, "forged signature rejected (and no 500 on bad length)", "status " + w.status);
const sig = "sha256=" + crypto.createHmac("sha256", "check-webhook-secret").update(body).digest("hex");
w = await post({ "x-hub-signature-256": sig });
const wj = await w.json();
pass(w.status === 200 && wj.triggered?.sites === 1, "correctly signed push accepted and triggers the linked site", JSON.stringify(wj));
await waitDeploys();
dep = await latest(node.id);
pass(dep.trigger === "webhook" && dep.status === "active", "webhook deploy went live", `trigger=${dep.trigger} status=${dep.status}`);

console.log("\n== pipeline");
const p = await call("m", "pipeline.create", { name: "check", repoUrl: "https://github.com/heroku/node-js-getting-started.git", branch: "main", buildCommand: "echo building && node -v", deployCommand: "echo deploying" });
const run = await call("m", "pipeline.run", { id: p.id });
let pr;
for (let i = 0; i < 60; i++) { pr = await call("q", "pipeline.runById", { id: run.runId }, true); if (pr?.error) pr = await call("q", "pipeline.runById", { runId: run.runId }, true); if (["completed", "failed"].includes(pr?.status)) break; await sleep(3000); }
pass(pr?.status === "completed", "pipeline run completes", `status=${pr?.status} ${pr?.error ? String(pr.error).slice(0, 200) : ""}`);

console.log("\n== legacy REST routes now require a session");
const saved = getToken();
for (const [m, path] of [["GET", "/api/sites"], ["POST", "/api/infra/scan"], ["POST", "/api/backup/pgsql"], ["GET", "/api/backup/jobs"]]) {
  const x = await fetch(B + path, { method: m, headers: { "content-type": "application/json" }, body: m === "POST" ? "{}" : undefined });
  pass(x.status === 401, `${m} ${path} without a token`, "status " + x.status);
}

console.log("\n== tenant isolation (non-admin user)");
await login("bob", "Bob-Passw0rd-12345");
const bobToken = getToken();
r = await call("q", "sites.list");
pass(Array.isArray(r) && r.length === 0, "non-admin sees only their own sites (none)", JSON.stringify(r).slice(0, 80));
r = await call("q", "sites.get", { id: node.id }, true);
pass(r?.error === "NOT_FOUND", "non-admin cannot read another user's site");
r = await call("q", "sites.deployments", { id: node.id }, true);
pass(r?.error === "NOT_FOUND", "non-admin cannot read another user's deployments");
r = await call("m", "sites.redeploy", { id: node.id }, true);
pass(r?.error === "FORBIDDEN" || r?.error === "NOT_FOUND", "non-admin cannot redeploy another user's site", r?.error);
r = await call("q", "sites.envList", { id: S["go.test.local"].id }, true);
pass(r?.error === "NOT_FOUND", "non-admin cannot list another user's env vars");
const x = await fetch(B + "/api/infra/scan", { method: "POST", headers: { authorization: "Bearer " + bobToken, "content-type": "application/json" }, body: "{}" });
pass(x.status === 403, "non-admin cannot enqueue host-level infra jobs", "status " + x.status);

console.log("\n== WebSocket gateway");
S = await byDomain();
const containerName = S["node.test.local"].pm2Name;
const wsTry = (token, msg) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:4000/ws?token=${encodeURIComponent(token)}`);
  const out = []; let done = false;
  const finish = (v) => { if (!done) { done = true; try { ws.close(); } catch {} resolve(v); } };
  ws.on("open", () => { if (msg) ws.send(JSON.stringify(msg)); });
  ws.on("message", (m) => { const j = JSON.parse(m.toString()); out.push(j); if (j.type === "subscribed" || j.error) finish(j); });
  ws.on("close", (code) => finish({ closed: code }));
  ws.on("error", () => finish({ closed: "error" }));
  setTimeout(() => finish({ timeout: true, out }), 5000);
});
r = await wsTry("not-a-token");
pass(r.closed === 4001, "socket with an invalid token is closed", JSON.stringify(r));
r = await wsTry(bobToken, { type: "subscribe", channel: "containers", id: containerName });
pass(!!r.error && /Unauthorized/.test(r.error), "non-admin cannot stream another user's container logs", JSON.stringify(r).slice(0, 90));
r = await wsTry(bobToken, { type: "subscribe", channel: "containers", id: "dbbkp-check-pg" });
pass(!!r.error, "nobody can stream a container the platform does not manage", JSON.stringify(r).slice(0, 90));
r = await wsTry(saved, { type: "subscribe", channel: "containers", id: "dbbkp-check-pg" });
pass(!!r.error, "...not even an admin", JSON.stringify(r).slice(0, 90));
r = await wsTry(saved, { type: "subscribe", channel: "containers", id: containerName });
pass(r.type === "subscribed", "owner/admin can stream their site's container logs", JSON.stringify(r).slice(0, 90));
setToken(saved);
await call("m", "auth.changePassword", { newPassword: "Check-Passw0rd-12345" }); // revokes every session
r = await wsTry(saved);
pass(r.closed === 4001, "a revoked session can no longer open a socket", JSON.stringify(r));
await login();

console.log("\n== self-healing");
const go = (await byDomain())["go.test.local"];
sh(`docker rm -f ${go.pm2Name}`);
let healed = false;
for (let i = 0; i < 30; i++) { await sleep(3000); const s = (await byDomain())["go.test.local"]; if (s.status === "active" && s.pm2Name !== go.pm2Name) { healed = true; break; } }
dep = await latest(go.id);
web = await viaTraefik("go.test.local");
pass(healed && dep.trigger === "reconcile" && /no rebuild/.test((await call("q", "sites.deployment", { deploymentId: dep.id })).log) && web.status === 200, "killed container detected and restarted from its image", `trigger=${dep.trigger} ${Math.round((dep.durationMs || 0) / 1000)}s http=${web.status}`);

console.log("\n== delete");
const php = (await byDomain())["php.test.local"];
await call("m", "sites.delete", { id: php.id });
let gone = false;
for (let i = 0; i < 20; i++) { await sleep(2000); if (!(await byDomain())["php.test.local"]) { gone = true; break; } }
const left = sh(`docker ps -a --filter label=dbbkp.site=${php.id} -q | wc -l; docker images --format '{{.Repository}}' | grep -c dbbkp-site-${php.id.slice(0, 8)} || true; ls /var/www/sites | grep -c ${php.id} || true`).split(/\s+/).join(",");
pass(gone && left === "0,0,0", "delete removes the row, containers, images and source", "containers,images,dirs left = " + left);
web = await viaTraefik("php.test.local");
pass(web.status === 404, "deleted site no longer routes", "http=" + web.status);

console.log("\n== final state");
for (const s of Object.values(await byDomain())) { const w2 = s.status === "active" ? await viaTraefik(s.domain) : { status: "-" }; console.log(`  ${s.domain.padEnd(20)} ${s.status.padEnd(8)} http=${w2.status} container=${s.pm2Name}`); }