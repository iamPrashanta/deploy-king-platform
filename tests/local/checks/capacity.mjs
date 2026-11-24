// capacity ledger and "will it fit?" against the running API: numbers, blocks, the owner's override, settings, agents
import { createRequire } from "node:module";
import { call, login, upload, waitDeploys, pass, PW } from "/t/lib.mjs";
const postgres = createRequire("/work/packages/db/package.json")("postgres");
const Docker = createRequire("/work/apps/worker/package.json")("dockerode");
const docker = new Docker();
const sql = postgres("postgres://postgres:postgres@dbbkp-check-pg:5432/dbbkp_panel");
const MCP = "http://localhost:4000/mcp";
const DOMAIN = "fitcheck.localhost";
const HUGE = 60000;
let n = 0;
async function tool(token, name, args = {}) {
  const r = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json())?.result;
  let data; try { data = JSON.parse(res?.content?.[0]?.text); } catch { data = res?.content?.[0]?.text; }
  return { isError: !!res?.isError, data };
}
const adminAuth = await login("admin", PW);
const DEFAULTS = { hostReservePct: 15, overcommitPct: 150, diskReserveGb: null };
await call("m", "system.setCapacity", DEFAULTS);
for (const s of (await call("q", "sites.list")).filter((s) => s.domain === DOMAIN)) await call("m", "sites.delete", { id: s.id });

// 1. the ledger
let sites = await call("q", "sites.list");
let cap = await call("q", "system.capacity");
const sum = sites.reduce((t, s) => t + (s.memoryLimit || 512), 0);
pass(cap.memory.reservedMb === sum && cap.apps.count === sites.length, "reserved memory is the sum of every app's limit", `${cap.memory.reservedMb} MB over ${cap.apps.count} apps`);
const m = cap.memory;
pass(m.hostReserveMb === Math.max(512, Math.round(m.totalMb * 0.15)) && m.promiseLimitMb === Math.floor((m.totalMb - m.hostReserveMb) * 1.5), "host reserve 15%, apps may hold 150% of the rest", `total ${m.totalMb} · reserve ${m.hostReserveMb} · promise ${m.promiseLimitMb} · free now ${m.freeNowMb}`);
pass(cap.disk && cap.disk.reserveMb >= 2048 && cap.disk.reserveMb <= 10240 && cap.apps.roomFor > 0, "disk reserve is automatic (2 to 10 GB), and the server reports room for more apps", `disk free ${cap.disk?.freeMb} MB · reserve ${cap.disk?.reserveMb} MB · room for ${cap.apps.roomFor}`);
const ov = await call("q", "system.overview");
pass(ov.capacity?.memory?.promiseLimitMb === m.promiseLimitMb, "the owner's Overview carries the same numbers");

// 2. the check
let fit = await call("q", "system.fit", { memoryMb: 512 });
pass(fit.verdict !== "blocked" && fit.needMemoryMb === 512, "a 512 MB app fits here", `${fit.verdict}: ${fit.note}`);
fit = await call("q", "system.fit", { memoryMb: HUGE });
pass(fit.verdict === "blocked" && fit.reasons.length === 2 && fit.canOverride === true, "a 60 GB app is blocked for two reasons, and the owner may override", fit.reasons.map((r) => r.kind).join(" + "));
let r = await call("m", "sites.create", { domain: DOMAIN, source: "image", image: "docker.io/traefik/whoami:latest", port: 80, memoryLimit: HUGE }, true);
pass(r.error === "PRECONDITION_FAILED" && /does not fit/.test(r.message), "creating it is refused, in words", String(r.message).slice(0, 150));
pass(!(await call("q", "sites.list")).some((s) => s.domain === DOMAIN), "a refused app leaves nothing behind");

// 3. other users cannot see the server or override
await login("bob", "Bob-Passw0rd-12345");
r = await call("q", "system.capacity", undefined, true);
pass(r.error === "FORBIDDEN", "a normal user cannot read the server's capacity");
r = await call("m", "system.setCapacity", { overcommitPct: 200 }, true);
pass(r.error === "FORBIDDEN", "or change the capacity settings");
fit = await call("q", "system.fit", { memoryMb: HUGE });
pass(fit.verdict === "blocked" && fit.canOverride === false, "they get the verdict, without the override");
r = await call("m", "sites.create", { domain: "bob-" + DOMAIN, source: "image", image: "docker.io/traefik/whoami:latest", port: 80, memoryLimit: HUGE, allowOverCapacity: true }, true);
pass(!!r.error && !(await call("q", "sites.list")).length, "asking to deploy anyway gets them nothing", String(r.message).slice(0, 70));
pass(!(await call("q", "system.overview")).capacity, "their Overview has no server numbers");

// 4. a real app: counted, limited, and marked to be stopped first
await login("admin", PW);
const app = await call("m", "sites.create", { domain: DOMAIN, source: "image", image: "docker.io/traefik/whoami:latest", port: 80, memoryLimit: 256 });
pass(!!app?.id, "a 256 MB app is accepted");
sites = await waitDeploys(240000);
const live = sites.find((s) => s.domain === DOMAIN);
pass(live?.status === "active", "and goes live", live?.status);
cap = await call("q", "system.capacity");
pass(cap.memory.reservedMb === sum + 256, "the ledger now holds 256 MB more", `${cap.memory.reservedMb} MB`);
const rt = await call("q", "sites.runtime", { id: app.id });
const insp = rt?.container ? await docker.getContainer(rt.container).inspect().catch(() => null) : null;
pass(insp?.HostConfig?.OomScoreAdj === 500 && insp?.HostConfig?.Memory === 256 * 1024 * 1024, "its container is limited to 256 MB and is stopped before the platform if memory runs out", `${rt?.container} · oom ${insp?.HostConfig?.OomScoreAdj} · log ${JSON.stringify(insp?.HostConfig?.LogConfig)}`);

// 5. raising a limit is checked; lowering is not; the override is recorded
r = await call("m", "sites.update", { id: app.id, memoryLimit: HUGE }, true);
pass(r.error === "PRECONDITION_FAILED", "raising the limit to 60 GB is refused");
fit = await call("q", "system.fit", { memoryMb: HUGE, siteId: app.id });
pass(fit.verdict === "blocked" && fit.canOverride, "the check for an existing app agrees");
r = await call("m", "sites.update", { id: app.id, memoryLimit: HUGE, allowOverCapacity: true });
pass(r?.memoryLimit === HUGE, "the owner can raise it anyway");
const audits = await sql`select metadata from audit_logs where action = 'capacity_override' and target_id = ${app.id}`;
const meta = typeof audits[0]?.metadata === "string" ? JSON.parse(audits[0].metadata) : audits[0]?.metadata;
pass(audits.length === 1 && meta?.action === "raise-limit", "and that is written to the audit log", JSON.stringify(meta));
fit = await call("q", "system.fit", { memoryMb: 512 });
pass(fit.verdict === "blocked" && fit.reasons.some((x) => x.kind === "promised"), "with 60 GB promised, the next 512 MB app no longer fits", fit.reasons[0]?.text.slice(0, 120));
r = await call("m", "sites.redeploy", { id: app.id, restartOnly: true });
pass(!r?.error, "the app itself can still restart: it already holds its memory");
await waitDeploys(120000);

// 6. uploads and agents follow the same rule
const up = await upload("fit-upload.localhost", "go", "/tmp/z/go.zip").catch((e) => ({ status: 0, body: { error: String(e.message) } }));
pass(up.status === 409 && /does not fit/.test(up.body?.error || ""), "a ZIP upload is refused too", `${up.status} ${String(up.body?.error).slice(0, 80)}`);
const tok = await call("m", "mcp.createToken", { name: "fit check", scope: "full", expiresInDays: 1 });
let x = await tool(tok.token, "check_fit", {});
pass(!x.isError && x.data.verdict === "blocked" && x.data.reasons.length > 0, "an agent's check_fit says blocked, with reasons", x.data?.reasons?.[0]?.slice(0, 90));
x = await tool(tok.token, "create_app", { name: "fit-agent", image: "docker.io/traefik/whoami:latest", port: 80 });
pass(x.isError && /does not fit/.test(JSON.stringify(x.data)), "an agent's create_app is refused, even with a full token", JSON.stringify(x.data).slice(0, 110));
x = await tool(tok.token, "get_capacity", {});
pass(!x.isError && x.data.memoryMb?.reservedMb === sum + HUGE, "get_capacity shows the ledger to the owner's token", `${x.data?.memoryMb?.reservedMb} MB reserved`);
r = await call("m", "sites.update", { id: app.id, memoryLimit: 256 });
pass(r?.memoryLimit === 256, "lowering the limit needs no check");

// 7. settings
cap = await call("m", "system.setCapacity", { hostReservePct: 40, overcommitPct: 100, diskReserveGb: 3 });
pass(cap.memory.hostReserveMb === Math.round(cap.memory.totalMb * 0.4) && cap.memory.promiseLimitMb === cap.memory.totalMb - cap.memory.hostReserveMb && cap.disk.reserveMb === 3072, "strict settings change the numbers at once", `reserve ${cap.memory.hostReserveMb} · promise ${cap.memory.promiseLimitMb} · disk reserve ${cap.disk.reserveMb}`);
r = await call("m", "system.setCapacity", { overcommitPct: 500 }, true);
pass(r.error === "BAD_REQUEST", "values outside the allowed range are refused");
x = await fetch("http://localhost:4000/trpc/system.setCapacity", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + tok.token }, body: JSON.stringify({ overcommitPct: 200 }) }).then((q) => q.json());
pass(x.error?.data?.code === "UNAUTHORIZED", "an agent token is not accepted for settings at all", x.error?.data?.code);
const set = await sql`select count(*)::int as n from audit_logs where action = 'capacity_settings'`;
pass(set[0].n >= 1, "setting changes are in the audit log", String(set[0].n));

// clean up
await call("m", "system.setCapacity", DEFAULTS);
await call("m", "mcp.revokeToken", { id: tok.id });
await call("m", "sites.delete", { id: app.id });
await sql.end();
console.log("done");
