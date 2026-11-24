// workflow triggers end to end: webhook (through the panel origin), after-a-deploy, deploy step, loop guard
import { call, login, pass } from "/t/lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await login();

const n = (id, type, x, data = {}) => ({ id, type, position: { x, y: 120 }, data });
const e = (s, t, h = null) => ({ id: `${s}-${h ?? "out"}-${t}`, source: s, target: t, sourceHandle: h });
async function make(name, nodes, edges) {
  const a = await call("m", "automations.create", { name });
  await call("m", "automations.update", { id: a.id, graph: { nodes, edges } });
  return call("q", "automations.get", { id: a.id });
}
async function runs(id) { return (await call("q", "automations.runs", { id, limit: 20 })) ?? []; }
async function waitRun(runId, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const r = await call("q", "automations.run", { runId });
    if (r && !["queued", "running"].includes(r.status)) return r;
    if (Date.now() > end) return r;
    await sleep(1000);
  }
}
const made = [];

// 1. webhook trigger, called through the panel (Next rewrite /hooks -> api)
const hook = await make("hook test", [n("t", "trigger.webhook", 0), n("h", "action.http", 200, { label: "Echo", url: "http://localhost:4000/health?who={{ trigger.body.name }}" })], [e("t", "h")]);
made.push(hook.id);
const path = new URL(hook.webhookUrl, "http://x").pathname;
pass(/^\/hooks\/automations\/[A-Za-z0-9_-]{20,}$/.test(path), "webhook URL issued", path.slice(0, 40) + "…");
let res = await fetch("http://localhost:3000" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ci" }) });
pass(res.status === 409, "inactive workflow refuses its webhook", String(res.status));
await call("m", "automations.setEnabled", { id: hook.id, enabled: true });
res = await fetch("http://localhost:3000" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ci" }) });
const body = await res.json().catch(() => ({}));
pass(res.status === 202 && body.runId, "active webhook starts a run", res.status + " " + JSON.stringify(body));
if (body.runId) {
  const r = await waitRun(body.runId);
  pass(r.status === "success" && r.steps.h?.output?.url?.endsWith("who=ci"), "webhook body reaches the steps", r.status + " " + r.steps.h?.output?.url);
}
res = await fetch("http://localhost:3000/hooks/automations/not-a-real-token-123456789", { method: "POST" });
pass(res.status === 404, "unknown webhook token is 404", String(res.status));

// 2. after-a-deploy trigger
const after = await make("after deploy test", [n("t", "trigger.deployment", 0, { event: "success" }), n("h", "action.http", 200, { url: "http://localhost:4000/health?app={{ trigger.app }}" })], [e("t", "h")]);
made.push(after.id);
await call("m", "automations.setEnabled", { id: after.id, enabled: true });
const site = await call("m", "sites.create", { domain: "wfhello.localhost", source: "image", runtime: "image", image: "nginx:alpine", port: 80, env: [], volumes: [] });
pass(!!site?.id, "created wfhello.localhost");
let fired = [];
for (let i = 0; i < 60 && fired.length === 0; i++) { await sleep(3000); fired = await runs(after.id); }
if (fired[0]) {
  const r = await waitRun(fired[0].id);
  pass(r.status === "success", "deploy fired the workflow", `${fired[0].trigger} · ${r.steps.h?.output?.url}`);
} else pass(false, "deploy fired the workflow", "no run after 3 minutes");

// 3. deploy step from a workflow, and the loop guard
const dep = await make("deploy step test", [n("t", "trigger.manual", 0), n("d", "action.deploy", 200, { siteId: site.id })], [e("t", "d")]);
made.push(dep.id);
const before = (await runs(after.id)).length;
const x = await call("m", "automations.execute", { id: dep.id });
const r = await waitRun(x.runId, 400000);
pass(r.status === "success", "Deploy app step waited for the deploy", r.status + " " + JSON.stringify(r.steps.d?.output ?? r.steps.d?.error).slice(0, 140));
await sleep(5000);
const later = (await runs(after.id)).length;
pass(later === before, "a deploy started by a workflow does not fire deploy workflows", `${before} -> ${later}`);

// clean up
for (const id of made) await call("m", "automations.delete", { id });
const del = await call("m", "sites.delete", { id: site.id }, true);
console.log("cleanup:", del?.error ? del.message : "ok");
