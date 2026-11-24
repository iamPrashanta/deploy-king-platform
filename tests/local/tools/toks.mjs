// list active tokens and recent agent calls
import { call, login } from "/t/lib.mjs";
await login();
console.log("tokens:", JSON.stringify((await call("q", "mcp.tokens")).map((t) => [t.name, t.scope, t.prefix])));
console.log("calls:", JSON.stringify((await call("q", "mcp.activity", { limit: 5 })).map((a) => [a.tool, a.ok, a.error?.slice(0, 60)])));
