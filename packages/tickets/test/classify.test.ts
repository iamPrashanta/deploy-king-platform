// classify(): every tRPC mutation, every MCP tool and every REST route of the table, the batch rule,
// and the addresses that must not slip through.
//   pnpm --filter @dbbkp/tickets test
// That the table lists every mutation and tool the API really has is checked against the API's own
// router in tests/local/checks/ticketunit.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, classifyDetail, classifyWs, strongest, EXEMPT_PREFIXES, MCP_TOOLS, REST_ROUTES, TRPC_MUTATIONS, WS_MESSAGES, type RequestClass, type TicketAction } from "../src/index";

const NONE: RequestClass = { ticket: false };
const post = (path: string, body?: unknown) => classify({ method: "POST", path, body });
const actionOf = (c: RequestClass) => (c.ticket ? c.action : "exempt");
const call = (name: unknown, id: number | undefined = 1) => ({ jsonrpc: "2.0", ...(id === undefined ? {} : { id }), method: "tools/call", params: { name, arguments: {} } });

// The classes, written out a second time on purpose: changing the class of a mutation in the table
// has to be done here too, so it cannot happen by accident. Everything not named here is `change`.
const TRPC_DEPLOY = ["sites.create", "sites.redeploy", "sites.rollback", "pipeline.run"];
const TRPC_DELETE = [
  "automations.delete", "backup.deletePolicy", "backup.removeDestination", "cron.delete", "database.delete", "files.delete", "files.remove",
  "git.appRemove", "git.disconnect", "host.remove", "nodes.delete", "pipeline.delete", "secrets.delete", "servers.deleteKey", "servers.remove",
  "sites.delete", "system.cleanup", "system.cleanupRemove", "team.remove", "workers.delete",
];
const TRPC_EXEMPT = [
  "auth.login", "auth.loginCode", "auth.setupStart", "auth.setupConfirm", "auth.changePassword",
  "twoFactor.start", "twoFactor.confirm", "twoFactor.disable", "twoFactor.newRecoveryCodes",
  "team.accept", "team.requestAccess", "git.inspect",
];
const TOOLS_DEPLOY = ["create_app", "deploy_app", "rollback_app"];
const TOOLS_DELETE = ["delete_app"];
const TOOLS_CHANGE = ["answer_deploy_question", "set_env", "run_workflow", "add_scheduled_job", "add_worker", "create_database"];

function expectedTrpc(name: string): TicketAction | "exempt" {
  if (TRPC_DEPLOY.includes(name)) return "deploy";
  if (TRPC_DELETE.includes(name)) return "delete";
  if (TRPC_EXEMPT.includes(name)) return "exempt";
  return "change";
}

test("every tRPC mutation in the table has the class written here, alone and in a batch", () => {
  const names = Object.keys(TRPC_MUTATIONS);
  for (const name of [...TRPC_DEPLOY, ...TRPC_DELETE, ...TRPC_EXEMPT]) assert.ok(names.includes(name), `${name} is in the table`);
  for (const name of names) {
    const want = expectedTrpc(name);
    assert.equal(actionOf(post(`/trpc/${name}`)), want, name);
    assert.equal(actionOf(post(`/trpc/${name}?batch=1`)), want, `${name} as a batch of one`);
    assert.equal(actionOf(classify({ method: "POST", path: `http://127.0.0.1:13900/trpc/${name}?batch=1&input=%7B%7D` })), want, `${name} as a whole address`);
    const entry = TRPC_MUTATIONS[name]!;
    if (entry !== "exempt") {
      assert.deepEqual(post(`/trpc/${name}`), { ticket: true, action: entry.action, kind: entry.kind }, name);
      assert.match(entry.kind, /^[a-z0-9-]{3,60}$/, `${name}: a short label`);
    }
  }
});

test("how many of each class (a new mutation changes these numbers on purpose)", () => {
  const count = (a: string) => Object.keys(TRPC_MUTATIONS).filter((n) => expectedTrpc(n) === a).length;
  assert.deepEqual({ total: Object.keys(TRPC_MUTATIONS).length, deploy: count("deploy"), change: count("change"), delete: count("delete"), exempt: count("exempt") }, { total: 125, deploy: 4, change: 89, delete: 20, exempt: 12 });
  assert.equal(Object.keys(MCP_TOOLS).length, 25);
  assert.equal(Object.values(MCP_TOOLS).filter((e) => e === "exempt").length, 15);
});

test("a first deploy of a new app is labelled create-app on every path (the plan's running-apps limit looks at it)", () => {
  assert.deepEqual(post("/trpc/sites.create"), { ticket: true, action: "deploy", kind: "create-app" });
  assert.deepEqual(post("/mcp", call("create_app")), { ticket: true, action: "deploy", kind: "create-app" });
  assert.deepEqual(post("/api/sites/upload"), { ticket: true, action: "deploy", kind: "create-app", zip: true });
  assert.deepEqual(post("/mcp/upload"), { ticket: true, action: "deploy", kind: "create-app", zip: true });
});

test("GET, HEAD and OPTIONS never need a ticket", () => {
  for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
    for (const path of ["/trpc/sites.delete", "/trpc/sites.list,sites.delete?batch=1", "/mcp", "/api/sites/upload", "/api/files/download?siteId=x", "/ws?token=x", "/health", "/anything"]) {
      assert.deepEqual(classify({ method, path }), NONE, `${method} ${path}`);
    }
  }
});

test("a batch takes the strongest class: delete > deploy > change", () => {
  assert.equal(strongest(["change", "deploy", "change"]), "deploy");
  assert.equal(strongest(["deploy", "delete", "change"]), "delete");
  assert.equal(strongest(["change"]), "change");
  assert.equal(strongest([]), null);
  assert.deepEqual(post("/trpc/sites.envSet,sites.redeploy?batch=1"), { ticket: true, action: "deploy", kind: "redeploy" });
  assert.deepEqual(post("/trpc/sites.redeploy,sites.envSet,sites.delete?batch=1"), { ticket: true, action: "delete", kind: "delete-app" });
  assert.deepEqual(post("/trpc/sites.delete,sites.redeploy?batch=1"), { ticket: true, action: "delete", kind: "delete-app" });
  assert.deepEqual(post("/trpc/sites.envSet,cron.create?batch=1"), { ticket: true, action: "change", kind: "env-change" });
  // exempt names add nothing, and a batch of only exempt names needs no ticket
  assert.deepEqual(post("/trpc/auth.login,git.inspect?batch=1"), NONE);
  assert.deepEqual(post("/trpc/auth.login,sites.envSet?batch=1"), { ticket: true, action: "change", kind: "env-change" });
  // the comma may arrive percent-encoded: tRPC decodes the path of a batch
  assert.equal(actionOf(post("/trpc/auth.login%2Csites.delete?batch=1")), "delete");
  assert.equal(actionOf(post("/trpc/sites%2Edelete?batch=1")), "delete");
});

test("a tRPC name that is not in the table is `change`, never free", () => {
  assert.deepEqual(post("/trpc/sites.somethingNew"), { ticket: true, action: "change", kind: "sites.somethingNew" });
  assert.deepEqual(post("/trpc/auth.login,sites.somethingNew?batch=1"), { ticket: true, action: "change", kind: "sites.somethingNew" });
  assert.equal(actionOf(post("/trpc")), "change");
  assert.equal(actionOf(post("/trpc/")), "change");
  assert.equal(actionOf(post("/trpc/sites.list")), "change"); // a query sent as POST: tRPC refuses it, and it is not free here
  assert.equal(actionOf(post("/trpc/%E0%A4%A")), "change"); // cannot be decoded
  // names that exist on every JavaScript object are not in the table either
  for (const n of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.equal(actionOf(post(`/trpc/${n}`)), "change", n);
    assert.equal(actionOf(post("/mcp", call(n))), "change", n);
    assert.equal(actionOf(classifyWs({ type: n })), "change", n);
  }
  const long = post("/trpc/" + "x".repeat(200));
  assert.ok(long.ticket && long.kind.length === 60);
  assert.deepEqual(post('/trpc/<script>"'), { ticket: true, action: "change", kind: "script" });
});

test("the address is matched the way Express matches it", () => {
  assert.equal(actionOf(post("/TRPC/sites.delete")), "delete"); // mounts ignore letter case
  assert.equal(actionOf(post("/trpc/sites.Delete")), "change"); // procedure names do not: this one does not exist
  assert.equal(actionOf(post("/API/Sites/Upload/")), "deploy");
  assert.equal(actionOf(post("/mcp/")), "exempt"); // POST /mcp/ with no body
  assert.equal(actionOf(post("/mcp/", call("delete_app"))), "delete");
  assert.equal(actionOf(post("/Mcp/Upload?x=1")), "deploy");
  assert.equal(actionOf(post("/api/files/upload?siteId=1&volume=data&path=%2F")), "change");
  assert.equal(actionOf(post("/trpc/sites.delete#x")), "delete");
  // not the same routes, so not their class; and not free
  assert.equal(actionOf(post("/trpcx/auth.login")), "change");
  assert.equal(actionOf(post("//trpc/auth.login")), "change");
  assert.equal(actionOf(post("/api/authx/login")), "change");
  assert.equal(actionOf(post("/mcp/upload/more")), "change");
});

test("every MCP tool: tools that only look need no ticket, the others their class", () => {
  for (const name of Object.keys(MCP_TOOLS)) {
    const want = TOOLS_DEPLOY.includes(name) ? "deploy" : TOOLS_DELETE.includes(name) ? "delete" : TOOLS_CHANGE.includes(name) ? "change" : "exempt";
    assert.equal(actionOf(post("/mcp", call(name))), want, name);
    assert.equal(actionOf(post("/mcp", JSON.stringify(call(name)))), want, `${name} as JSON text`);
    assert.equal(actionOf(post("/mcp", Buffer.from(JSON.stringify(call(name))))), want, `${name} as bytes`);
    assert.equal(actionOf(post("/mcp", new TextEncoder().encode(JSON.stringify(call(name))))), want, `${name} as a Uint8Array`);
  }
  for (const name of [...TOOLS_DEPLOY, ...TOOLS_DELETE, ...TOOLS_CHANGE]) assert.ok(name in MCP_TOOLS, name);
  assert.deepEqual(post("/mcp", call("set_env")), { ticket: true, action: "change", kind: "env-change" });
  assert.deepEqual(post("/mcp", call("delete_app")), { ticket: true, action: "delete", kind: "delete-app" });
});

test("MCP: other messages need no ticket; a batch takes the strongest; unknown tools are `change`", () => {
  for (const method of ["initialize", "ping", "tools/list", "resources/list", "prompts/list", "notifications/initialized"]) {
    assert.deepEqual(post("/mcp", { jsonrpc: "2.0", id: 1, method }), NONE, method);
  }
  assert.deepEqual(post("/mcp"), NONE);
  assert.deepEqual(post("/mcp", {}), NONE);
  assert.deepEqual(post("/mcp", "not json"), NONE);
  assert.deepEqual(post("/mcp", [call("list_apps"), { jsonrpc: "2.0", id: 2, method: "tools/list" }]), NONE);
  assert.equal(actionOf(post("/mcp", [call("list_apps"), call("set_env", 2), call("deploy_app", 3)])), "deploy");
  assert.equal(actionOf(post("/mcp", [call("deploy_app"), call("delete_app", 2), call("set_env", 3)])), "delete");
  assert.deepEqual(post("/mcp", call("brand_new_tool")), { ticket: true, action: "change", kind: "brand_new_tool" });
  assert.equal(actionOf(post("/mcp", call(undefined))), "change");
  assert.equal(actionOf(post("/mcp", call(["delete_app"]))), "change");
  assert.equal(actionOf(post("/mcp", call("delete_app", undefined))), "delete"); // a notification: the API runs nothing, and it is not free
  // the 21st message of a batch is dropped by the API; here it still counts
  assert.equal(actionOf(post("/mcp", [...Array.from({ length: 20 }, (_, i) => call("list_apps", i)), call("delete_app", 99)])), "delete");
  // only POST does anything on /mcp
  assert.deepEqual(classify({ method: "DELETE", path: "/mcp", body: call("delete_app") }), NONE);
});

test("the REST routes of the table", () => {
  for (const r of REST_ROUTES) {
    const c = classify({ method: r.method, path: r.path });
    assert.equal(actionOf(c), r.entry === "exempt" ? "exempt" : r.entry.action, `${r.method} ${r.path}`);
    assert.equal(classifyDetail({ method: r.method, path: r.path }).rule, "rest");
  }
  assert.deepEqual(post("/api/files/upload"), { ticket: true, action: "change", kind: "upload-files" });
  assert.deepEqual(REST_ROUTES.filter((r) => r.zip).map((r) => r.path), ["/api/sites/upload", "/mcp/upload"]);
});

test("sign-in, the app's key routes, webhooks and internal calls never need a ticket", () => {
  assert.deepEqual([...EXEMPT_PREFIXES], ["/api/auth", "/api/desktop", "/webhooks", "/hooks", "/internal"]);
  for (const path of [
    "/api/auth/login", "/api/auth/register", "/api/desktop/session", "/api/desktop/agent-token", "/webhooks/github", "/hooks/automations/abcdefghijklmnopqrstuvwx",
    "/internal/log", "/internal/nodes/heartbeat", "/internal/security/report", "/API/Auth/Login/",
  ]) {
    assert.deepEqual(post(path), NONE, path);
    assert.equal(classifyDetail({ method: "POST", path }).rule, "exempt");
  }
});

test("anything else that is not a read is `change`", () => {
  for (const [method, path] of [["POST", "/api/sites"], ["PUT", "/api/sites/upload"], ["DELETE", "/api/files/upload"], ["PATCH", "/x"], ["POST", "/"], ["POST", ""], ["POST", "/health"], ["post", "/api/new-route"]] as const) {
    assert.deepEqual(classify({ method, path }), { ticket: true, action: "change", kind: "other" }, `${method} ${path}`);
    assert.equal(classifyDetail({ method, path }).rule, "other");
  }
  // tRPC answers every method but GET and POST with an error, so those run nothing
  assert.deepEqual(classify({ method: "PUT", path: "/trpc/sites.delete" }), NONE);
});

test("WebSocket messages: opening a terminal is a change; the rest of a terminal's life and reading are free", () => {
  assert.deepEqual(classifyWs({ type: "terminal.open" }), { ticket: true, action: "change", kind: "open-terminal" });
  assert.deepEqual(classifyWs({ type: "ssh.open" }), { ticket: true, action: "change", kind: "open-server-terminal" });
  for (const type of Object.keys(WS_MESSAGES).filter((t) => !t.endsWith(".open"))) assert.deepEqual(classifyWs({ type }), NONE, type);
  assert.equal(actionOf(classifyWs({ type: "ssh.exec" })), "change");
  assert.equal(actionOf(classifyWs({})), "change");
  assert.equal(actionOf(classifyWs(null)), "change");
  assert.equal(actionOf(classifyWs({ type: 7 })), "change");
});
