import { call, login, PW } from "./lib.mjs";
await login("admin", PW);
console.log(JSON.stringify(await call("q", "system.info")));
