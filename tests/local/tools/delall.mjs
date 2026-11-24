// delete every app through the API (removes containers, images and volumes)
import { call, login, PW } from "./lib.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await login("admin", PW);
for (const s of await call("q", "sites.list")) {
  const r = await call("m", "sites.delete", { id: s.id });
  console.log("delete", s.domain, r?.success ? "ok" : JSON.stringify(r));
}
for (let i = 0; i < 20; i++) {
  await sleep(2000);
  const left = await call("q", "sites.list");
  if (!left.length) { console.log("all apps gone"); break; }
  if (i === 19) console.log("still there:", left.map((s) => s.domain + ":" + s.status).join(", "));
}
