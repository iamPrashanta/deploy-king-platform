// n8n with the old 512 MB limit: the deploy must catch the crash, ask for more memory, and finish
import crypto from "node:crypto";
import { call, login, pass, viaTraefik, PW } from "./lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await login("admin", PW);
for (const s of (await call("q", "sites.list")).filter((s) => s.domain === "n8n-oom.localhost")) await call("m", "sites.delete", { id: s.id });
await sleep(5000);
const site = await call("m", "sites.create", {
  domain: "n8n-oom.localhost", source: "image", runtime: "image", image: "n8nio/n8n:latest", port: 5678,
  volumes: [{ name: "data", mountPath: "/home/node/.n8n" }],
  env: [
    { key: "N8N_ENCRYPTION_KEY", value: crypto.randomBytes(32).toString("hex") },
    { key: "WEBHOOK_URL", value: "http://n8n-oom.localhost:8088" },
    { key: "N8N_PROXY_HOPS", value: "1" },
    { key: "N8N_SECURE_COOKIE", value: "false" },
  ],
});
pass(!!site?.id, "created n8n with the default 512 MB");
let dep;
const wait = async (states, secs) => {
  for (let i = 0; i < secs / 2; i++) {
    await sleep(2000);
    dep = (await call("q", "sites.deployments", { id: site.id }))?.[0];
    if (states.includes(dep?.status)) return;
  }
};
await wait(["waiting_input", "failed", "active"], 160);
pass(dep?.status === "waiting_input", "deploy paused instead of going live with a crashing app", dep?.status + " " + (dep?.error || "").slice(0, 160));
if (dep?.status === "waiting_input") {
  const full = await call("q", "sites.deployment", { deploymentId: dep.id });
  pass(full.prompt?.id === "memory", "asks for more memory", full.prompt?.title + " | " + full.prompt?.options?.map((o) => o.label).join(", "));
  await call("m", "sites.answer", { deploymentId: dep.id, promptId: "memory", value: "2048" });
  await wait(["failed", "active"], 120);
  pass(dep?.status === "active", "deploy finished with 2 GB", dep?.status + " " + (dep?.error || "").slice(0, 160));
  const s = await call("q", "sites.get", { id: site.id });
  pass(s.memoryLimit === 2048, "memory choice saved on the app", String(s.memoryLimit));
  await sleep(20000);
  const web = await viaTraefik("n8n-oom.localhost", "/healthz");
  pass(web.status === 200, "n8n still answering 20s later", web.status + " " + web.snippet);
}
