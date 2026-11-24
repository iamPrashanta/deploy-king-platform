// MCP server checks: protocol, auth, scopes, and a full deploy done only through tools
import { call, login, pass } from "/t/lib.mjs";
const BASE = process.argv[2] || "http://localhost:4000";
const URL_ = BASE + "/mcp";
await login();

let n = 0;
async function rpc(token, method, params, extra = {}) {
  const r = await fetch(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: "Bearer " + token } : {}), ...extra },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, ...(params ? { params } : {}) }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
async function tool(token, name, args = {}) {
  const r = await rpc(token, "tools/call", { name, arguments: args });
  const res = r.body?.result;
  let data; try { data = JSON.parse(res?.content?.[0]?.text); } catch { data = res?.content?.[0]?.text; }
  return { isError: !!res?.isError, data, raw: r };
}

// tokens
const read = await call("m", "mcp.createToken", { name: "check read", scope: "read", expiresInDays: 30 });
const dep = await call("m", "mcp.createToken", { name: "check deploy", scope: "deploy", expiresInDays: null });
const full = await call("m", "mcp.createToken", { name: "check full", scope: "full", expiresInDays: 1 });
pass(/^dk_/.test(read?.token) && read.token.length > 40, "token created and shown once", read?.prefix);
const listed = await call("q", "mcp.tokens");
pass(listed.length >= 3 && !JSON.stringify(listed).includes(read.token), "token list never contains the token");

// protocol
let r = await rpc(null, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } });
pass(r.status === 401, "no token is 401", r.status + " " + JSON.stringify(r.body).slice(0, 90));
r = await rpc("dk_" + "x".repeat(43), "initialize", {});
pass(r.status === 401, "unknown token is 401");
r = await rpc(read.token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "check", version: "1" } });
pass(r.status === 200 && r.body.result?.protocolVersion === "2025-06-18" && r.body.result?.serverInfo?.name === "deploy-king", "initialize", JSON.stringify(r.body.result?.serverInfo));
r = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + read.token }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
pass(r.status === 202, "notification is 202", String(r.status));
r = await fetch(URL_, { headers: { authorization: "Bearer " + read.token } });
pass(r.status === 405, "GET is 405", String(r.status));
r = await rpc(read.token, "tools/list", {}, { origin: "https://evil.example" });
pass(r.status === 403, "foreign Origin is 403", String(r.status));
r = await rpc(read.token, "tools/list");
const readTools = r.body.result.tools.map((t) => t.name);
pass(!readTools.includes("create_app") && readTools.includes("list_apps"), "read token lists read tools only", readTools.join(","));
r = await rpc(full.token, "tools/list");
pass(r.body.result.tools.length === 19, "full token lists every tool", String(r.body.result.tools.length));
r = await rpc(read.token, "nope/method");
pass(r.body.error?.code === -32601, "unknown method is -32601");

// scopes and arguments
let x = await tool(read.token, "create_app", { name: "mcp-nope", image: "nginx:alpine" });
pass(x.isError && /only look/.test(x.data), "read token cannot create", String(x.data).slice(0, 80));
x = await tool(read.token, "list_apps", { bogus: 1 });
pass(x.isError && /Unknown argument/.test(x.data), "unknown argument rejected", x.data);
x = await tool(read.token, "get_app", { app: "does-not-exist" });
pass(x.isError && /no app called/.test(x.data), "missing app is a readable error", x.data);
x = await tool(read.token, "platform_status");
pass(!x.isError && x.data.version, "platform_status", JSON.stringify(x.data).slice(0, 120));

// a deploy done only through tools
x = await tool(dep.token, "create_app", { name: "mcp-hello", image: "nginx:alpine", port: 80, variables: { GREETING: "hi", SECRET_TOKEN: "s3cr3t-value" } });
pass(!x.isError && x.data.name === "mcp-hello.localhost", "create_app", JSON.stringify(x.data).slice(0, 140));
let w;
for (let i = 0; i < 6; i++) {
  w = await tool(dep.token, "wait_for_deploy", { app: "mcp-hello", timeoutSeconds: 60 });
  if (w.data?.done || w.data?.result === "needs_answer") break;
}
if (w.data?.result === "needs_answer") {
  const q = w.data.deployment.question;
  console.log("  question:", q.question, q.answers.map((a) => a.answer).join("|"));
  const a = await tool(dep.token, "answer_deploy_question", { app: "mcp-hello", answer: q.defaultAnswer });
  pass(!a.isError, "answer_deploy_question", JSON.stringify(a.data).slice(0, 100));
  w = await tool(dep.token, "wait_for_deploy", { app: "mcp-hello", timeoutSeconds: 90 });
}
pass(w.data?.result === "live", "wait_for_deploy reaches live", JSON.stringify(w.data).slice(0, 160));
x = await tool(read.token, "get_app", { app: "mcp-hello" });
pass(!x.isError && x.data.variables.includes("SECRET_TOKEN") && !JSON.stringify(x.data).includes("s3cr3t-value"), "get_app shows variable names, never values", x.data.variables?.join(","));
x = await tool(read.token, "get_app_logs", { app: "mcp-hello", lines: 20 });
pass(!x.isError && typeof x.data.logs === "string", "get_app_logs", String(x.data.logs).split("\n").slice(-1)[0]?.slice(0, 80));
x = await tool(read.token, "get_deploy_log", { app: "mcp-hello", lines: 10 });
pass(!x.isError && x.data.log.length > 0, "get_deploy_log", x.data.deployment?.status);
x = await tool(dep.token, "set_env", { app: "mcp-hello", set: { GREETING: "hello" }, remove: ["SECRET_TOKEN"], restart: true });
pass(!x.isError && x.data.deploymentId, "set_env with restart", JSON.stringify(x.data).slice(0, 120));
w = await tool(dep.token, "wait_for_deploy", { app: "mcp-hello", timeoutSeconds: 90 });
pass(w.data?.result === "live", "restart is live", w.data?.result);
x = await tool(dep.token, "rollback_app", { app: "mcp-hello" });
pass(!x.isError && x.data.deploymentId, "rollback_app to the previous release", JSON.stringify(x.data).slice(0, 120));
w = await tool(dep.token, "wait_for_deploy", { app: "mcp-hello", timeoutSeconds: 90 });
pass(w.data?.result === "live", "rollback is live", w.data?.result);

// deleting needs a full token and the domain typed again
x = await tool(dep.token, "delete_app", { app: "mcp-hello", confirm: "mcp-hello.localhost" });
pass(x.isError && /needs a "full" token/.test(x.data), "deploy token cannot delete", String(x.data).slice(0, 80));
x = await tool(full.token, "delete_app", { app: "mcp-hello", confirm: "mcp-hello" });
pass(x.isError && /confirm must be/.test(x.data), "delete needs the full domain", x.data);
x = await tool(full.token, "delete_app", { app: "mcp-hello", confirm: "mcp-hello.localhost" });
pass(!x.isError && x.data.deleted === "mcp-hello.localhost", "full token deletes with confirmation");

// activity and redaction
const act = await call("q", "mcp.activity", { limit: 100 });
const created = act.find((a) => a.tool === "create_app" && a.ok);
pass(created && !JSON.stringify(act).includes("s3cr3t-value"), "activity logged without secret values", JSON.stringify(created?.args));

// revoke
await call("m", "mcp.revokeToken", { id: read.id });
r = await rpc(read.token, "tools/list");
pass(r.status === 401, "revoked token stops working", String(r.status));
for (const t of [dep, full]) await call("m", "mcp.revokeToken", { id: t.id });
console.log("tokens left:", (await call("q", "mcp.tokens")).length);
