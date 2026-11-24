// n8n squeezed into 256 MB: it crashes while booting, so the deploy must ask for more memory
import crypto from "node:crypto";
import { call, login, pass, viaTraefik, PW } from "./lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await login("admin", PW);
for (const s of (await call("q", "sites.list")).filter((s) => s.domain === "oom.localhost")) await call("m", "sites.delete", { id: s.id });
await sleep(5000);
const site = await call("m", "sites.create", {
  domain: "oom.localhost", source: "image", runtime: "image", image: "n8nio/n8n:latest", port: 5678, memoryLimit: 256,
  env: [{ key: "N8N_ENCRYPTION_KEY", value: crypto.randomBytes(32).toString("hex") }, { key: "N8N_SECURE_COOKIE", value: "false" }],
});
let dep;
const wait = async (states, secs) => {
  for (let i = 0; i < secs / 2; i++) {
    await sleep(2000);
    dep = (await call("q", "sites.deployments", { id: site.id }))?.[0];
    if (states.includes(dep?.status)) return;
  }
};
await wait(["waiting_input", "failed", "active"], 150);
const full = dep ? await call("q", "sites.deployment", { deploymentId: dep.id }) : null;
pass(dep?.status === "waiting_input" && full?.prompt?.id === "memory", "deploy paused and asks for memory", `${dep?.status} | ${full?.prompt?.title ?? ""} | ${full?.prompt?.options?.map((o) => o.label).join(", ") ?? ""} ${(dep?.error || "").slice(0, 120)}`);
if (full?.prompt?.id === "memory") {
  await call("m", "sites.answer", { deploymentId: dep.id, promptId: "memory", value: "1024" });
  await wait(["failed", "active"], 120);
  pass(dep?.status === "active", "deploy finished after choosing 1 GB", dep?.status);
  const s = await call("q", "sites.get", { id: site.id });
  pass(s.memoryLimit === 1024, "1 GB saved on the app", String(s.memoryLimit));
}
await call("m", "sites.delete", { id: site.id });
