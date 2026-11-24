// remove every workflow (test clean-up) and report what is left
import { call, login } from "/t/lib.mjs";
await login();
for (const w of (await call("q", "automations.list")) ?? []) await call("m", "automations.delete", { id: w.id });
console.log("workflows left:", ((await call("q", "automations.list")) ?? []).length, "apps left:", ((await call("q", "sites.list")) ?? []).length);
