import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { B, call, login, waitDeploys, viaTraefik, pass, getToken } from "./lib.mjs";
const require = createRequire("/work/apps/api/package.json");
const WebSocket = require("ws");
const sh = (c) => execSync(c, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await login();
const byDomain = async () => Object.fromEntries((await call("q", "sites.list")).map((s) => [s.domain, s]));
let S = await byDomain();

console.log("== WebSocket: owner can stream logs");
const got = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:4000/ws?token=${encodeURIComponent(getToken())}`);
  const seen = { subscribed: false, lines: 0 };
  ws.on("open", () => ws.send(JSON.stringify({ type: "subscribe", channel: "containers", id: S["node.test.local"].pm2Name })));
  ws.on("message", (m) => { const j = JSON.parse(m.toString()); if (j.type === "subscribed") seen.subscribed = true; if (j.channel === "containers") seen.lines++; if (j.error) seen.error = j.error; });
  setTimeout(() => { ws.close(); resolve(seen); }, 4000);
});
pass(got.subscribed && got.lines > 0, "admin subscribes to a site container and receives log lines", JSON.stringify(got));

console.log("== delete cleans up images");
const dk = S["docker.test.local"];
await call("m", "sites.delete", { id: dk.id });
for (let i = 0; i < 20; i++) { await sleep(2000); if (!(await byDomain())["docker.test.local"]) break; }
const left = sh(`docker ps -a --filter label=dbbkp.site=${dk.id} -q | wc -l; docker images --format '{{.Repository}}' | grep -c dbbkp-site-${dk.id.slice(0, 8)} || true; ls /var/www/sites | grep -c ${dk.id} || true`).split(/\s+/).join(",");
pass(left === "0,0,0", "containers, images and source all removed", "left = " + left);

console.log("== pull-request preview environments");
const send = async (payload, event) => {
  const body = JSON.stringify(payload);
  const sig = "sha256=" + crypto.createHmac("sha256", "check-webhook-secret").update(body).digest("hex");
  const r = await fetch(B + "/webhooks/github", { method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": sig }, body });
  return { status: r.status, body: await r.json() };
};
const repo = { clone_url: "https://github.com/cloudacademy/static-website-example.git" };
let w = await send({ action: "opened", pull_request: { number: 7, title: "Try a new hero", head: { ref: "master", sha: "a".repeat(40) } }, repository: repo }, "pull_request");
pass(w.status === 200 && w.body.triggered?.previews === 1, "PR opened creates a preview deployment", JSON.stringify(w.body));
await sleep(2000); await waitDeploys();
S = await byDomain();
const pv = S["pr-7-static.test.local"];
const web = await viaTraefik("pr-7-static.test.local");
pass(pv?.status === "active" && pv.isPreview && pv.userId === S["static.test.local"].userId && web.status === 200, "preview is live at pr-7-<domain> and owned by the parent site's owner", `status=${pv?.status} http=${web.status} expires=${pv?.expiresAt}`);
w = await send({ action: "closed", pull_request: { number: 7, head: { ref: "master" } }, repository: repo }, "pull_request");
let gone = false;
for (let i = 0; i < 20; i++) { await sleep(2000); if (!(await byDomain())["pr-7-static.test.local"]) { gone = true; break; } }
const left2 = sh(`docker ps -a --filter label=dbbkp.site=${pv.id} -q | wc -l`);
pass(gone && left2 === "0" && (await viaTraefik("pr-7-static.test.local")).status === 404, "PR closed tears the preview down completely", `row gone=${gone}, containers left=${left2}`);
w = await send({ zen: "hi" }, "ping");
pass(w.status === 200 && w.body.pong, "ping event acknowledged");