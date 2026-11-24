// print the latest deployment of a domain: status, error and log tail
import { call, login, PW } from "./lib.mjs";
await login("admin", PW);
const domain = process.argv[2];
const s = (await call("q", "sites.list")).find((x) => x.domain === domain);
const d = (await call("q", "sites.deployments", { id: s.id }))[0];
const full = await call("q", "sites.deployment", { deploymentId: d.id });
console.log(full.status, "|", (full.error || "").slice(0, 600));
console.log((full.log || "").split("\n").slice(-25).join("\n"));
