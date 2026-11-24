// more MCP checks through the panel URL: check_repo, workflows, logging of refused calls
import { call, login, pass } from "/t/lib.mjs";
const MCP = "http://localhost:3000/mcp";
await login();
let n = 0;
async function tool(token, name, args = {}) {
  const r = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + token }, body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } }) });
  const res = (await r.json())?.result;
  let data; try { data = JSON.parse(res?.content?.[0]?.text); } catch { data = res?.content?.[0]?.text; }
  return { isError: !!res?.isError, data };
}
const dep = await call("m", "mcp.createToken", { name: "check 2", scope: "deploy", expiresInDays: 1 });

let x = await tool(dep.token, "check_repo", { repoUrl: "https://github.com/heroku/node-js-getting-started" });
pass(!x.isError && x.data.verdict, "check_repo", `${x.data?.verdict} · ${x.data?.framework} · port ${x.data?.port}`);

const a = await call("m", "automations.create", { name: "Ping API" });
await call("m", "automations.update", {
  id: a.id,
  graph: {
    nodes: [
      { id: "t", type: "trigger.manual", position: { x: 0, y: 0 }, data: {} },
      { id: "h", type: "action.http", position: { x: 200, y: 0 }, data: { label: "Ping", url: "http://localhost:4000/health?why={{ trigger.reason }}" } },
    ],
    edges: [{ id: "t-out-h", source: "t", target: "h", sourceHandle: null }],
  },
});
x = await tool(dep.token, "list_workflows");
pass(!x.isError && x.data.workflows.some((w) => w.name === "Ping API"), "list_workflows", String(x.data?.count));
x = await tool(dep.token, "run_workflow", { workflow: "ping api", input: { reason: "agent", apiKey: "should-not-be-logged" } });
pass(!x.isError && x.data.status === "success" && x.data.steps.find((s) => s.step === "Ping")?.output?.url?.endsWith("why=agent"), "run_workflow waits and returns steps", x.data?.status);
x = await tool(dep.token, "get_workflow_run", { runId: x.data.runId });
pass(!x.isError && x.data.status === "success", "get_workflow_run");

x = await tool(dep.token, "delete_app", { app: "anything", confirm: "anything.localhost" });
const act = await call("q", "mcp.activity", { limit: 10 });
const refused = act.find((c) => c.tool === "delete_app");
pass(refused && refused.args?.app === "anything" && !refused.ok, "refused calls keep their arguments in the log", JSON.stringify(refused?.args));
const run = act.find((c) => c.tool === "run_workflow");
pass(run && !JSON.stringify(run.args).includes("should-not-be-logged"), "workflow input values are not logged", JSON.stringify(run?.args));

await call("m", "automations.delete", { id: a.id });
await call("m", "mcp.revokeToken", { id: dep.id });
console.log("done");
