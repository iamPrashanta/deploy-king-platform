// delete a test app by domain
import { call, login, PW } from "./lib.mjs";
await login("admin", PW);
const s = (await call("q", "sites.list")).find((x) => x.domain === process.argv[2]);
if (s) console.log("delete", s.domain, JSON.stringify(await call("m", "sites.delete", { id: s.id })));
