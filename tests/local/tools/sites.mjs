// list apps with their latest deployment
import { call, login, PW } from "./lib.mjs";
await login("admin", PW);
for (const s of await call("q", "sites.list")) {
  const d = (await call("q", "sites.deployments", { id: s.id }))?.[0];
  console.log(s.domain, "|", s.status, "| port", s.port, "| last deploy:", d?.status, d?.createdAt, (d?.error || "").slice(0, 160).replace(/\n/g, " "));
}
