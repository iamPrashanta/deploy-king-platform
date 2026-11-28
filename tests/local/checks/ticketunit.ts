// The ticket table against the API as it really is, read at test time: every tRPC mutation of the
// router, every MCP tool and every REST route that is not a read must be classified in
// packages/tickets/src/table.ts. Adding a mutation, a tool or a route without deciding whether it
// needs a ticket (and of which class) makes this fail; so does a table entry for something that is gone.
//   cd apps/api && npx tsx ../../tests/local/checks/ticketunit.ts     (no database or Redis is used)
// The format and the rules themselves: pnpm --filter @dbbkp/tickets test
import path from "node:path";
import { createRequire } from "node:module";

async function main() {
  const root = process.cwd(); // apps/api
  const from = (m: string) => createRequire(path.join(root, "package.json")).resolve(m);
  process.env.DATABASE_URL ||= "postgres://nobody:nothing@127.0.0.1:1/none"; // the router is only read, never called
  process.env.DESKTOP_MODE = "true"; // so the desktop routes can be listed too

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => {
    if (!ok) failed++;
    console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));
  };

  const queues = await import(root + "/src/queues");
  for (const q of Object.values(queues) as any[]) q?.on?.("error", () => {}); // no Redis here
  const T = await import(from("@dbbkp/tickets"));
  const { appRouter } = await import(root + "/src/trpc");
  const { TOOLS } = await import(root + "/src/mcp/tools");
  const actionOf = (c: any) => (c.ticket ? c.action : "exempt");

  // ── tRPC: the router's own list of procedures ──
  const procedures = Object.entries((appRouter as any)._def.procedures as Record<string, any>);
  const mutations = procedures.filter(([, p]) => p._def.mutation).map(([n]) => n).sort();
  const queries = procedures.filter(([, p]) => p._def.query).map(([n]) => n);
  const listed = Object.keys(T.TRPC_MUTATIONS);
  const unlisted = mutations.filter((m) => !listed.includes(m));
  const stale = listed.filter((m) => !mutations.includes(m));
  pass(mutations.length > 100 && unlisted.length === 0, `every tRPC mutation of the API is in the ticket table (${mutations.length} mutations)`, unlisted.length ? `NOT CLASSIFIED: ${unlisted.join(", ")}. Add them to packages/tickets/src/table.ts` : "");
  pass(stale.length === 0, "the table lists no mutation that is gone", stale.join(", "));
  pass(queries.every((q) => !listed.includes(q)), "no query is in the table (queries never need a ticket)", queries.filter((q) => listed.includes(q)).join(", "));
  pass(procedures.every(([, p]) => p._def.mutation || p._def.query), "the API has only queries and mutations (a subscription would need a rule of its own)");
  const wrong = mutations.filter((m) => {
    const e = T.TRPC_MUTATIONS[m];
    return e && actionOf(T.classify({ method: "POST", path: `/trpc/${m}` })) !== (e === "exempt" ? "exempt" : e.action);
  });
  pass(wrong.length === 0, "classify() gives each of them the class of the table", wrong.join(", "));
  const count = (a: string) => mutations.filter((m) => actionOf(T.classify({ method: "POST", path: `/trpc/${m}` })) === a).length;
  console.log(`      deploy ${count("deploy")}, change ${count("change")}, delete ${count("delete")}, exempt ${count("exempt")}`);
  // Names say a lot: a mutation called delete or remove that is not `delete`, or one that is exempt, was decided by hand.
  const exempt = mutations.filter((m) => T.TRPC_MUTATIONS[m] === "exempt");
  pass(
    exempt.every((m) => /^(auth|twoFactor)\./.test(m) || ["team.accept", "team.requestAccess", "git.inspect"].includes(m)),
    "the only mutations without a ticket are sign-in, one's own 2-step sign-in, joining, and the project check",
    exempt.join(", ")
  );
  const deleteLike = mutations.filter((m) => /\.(delete|remove)/i.test(m) && actionOf(T.classify({ method: "POST", path: `/trpc/${m}` })) !== "delete");
  pass(deleteLike.length === 0, "every mutation named delete… or remove… is of the class delete", deleteLike.join(", "));

  // ── MCP tools ──
  const toolNames: string[] = TOOLS.map((t: any) => t.name);
  const toolsListed = Object.keys(T.MCP_TOOLS);
  const toolsMissing = toolNames.filter((n) => !toolsListed.includes(n));
  pass(toolNames.length >= 25 && toolsMissing.length === 0, `every MCP tool is in the ticket table (${toolNames.length} tools)`, toolsMissing.length ? `NOT CLASSIFIED: ${toolsMissing.join(", ")}. Add them to packages/tickets/src/table.ts` : "");
  pass(toolsListed.every((n) => toolNames.includes(n)), "the table lists no tool that is gone", toolsListed.filter((n) => !toolNames.includes(n)).join(", "));
  const call = (name: string) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: {} } });
  const toolWrong = TOOLS.filter((t: any) => {
    const free = !T.classify({ method: "POST", path: "/mcp", body: call(t.name) }).ticket;
    // A tool that only looks says so itself (readOnlyHint, and a "read" token may use it).
    return free !== (t.annotations.readOnlyHint === true && t.scope === "read");
  }).map((t: any) => t.name);
  pass(toolWrong.length === 0, "a tool needs no ticket exactly when it only looks (readOnlyHint, read access)", toolWrong.join(", "));
  pass(actionOf(T.classify({ method: "POST", path: "/mcp", body: call("delete_app") })) === "delete" && TOOLS.filter((t: any) => t.scope === "full").every((t: any) => actionOf(T.classify({ method: "POST", path: "/mcp", body: call(t.name) })) === "delete"), "the tools that need full access are of the class delete");

  // ── REST: every route of the API's routers that is not a read ──
  // Where index.ts mounts each router. A new router has to be added here, and its routes below.
  const mounts: Array<[string, any]> = [
    ["/api/auth", (await import(root + "/src/routes/auth")).default],
    ["/api/desktop", (await import(root + "/src/routes/desktop")).desktopRouter()],
    ["/api/sites", (await import(root + "/src/routes/sites")).default],
    ["/api/files", (await import(root + "/src/routes/files")).default],
    ["/webhooks", (await import(root + "/src/routes/webhooks")).default],
    ["/hooks", (await import(root + "/src/routes/hooks")).default],
    ["/mcp", (await import(root + "/src/routes/mcp")).default],
    ["/internal/security", (await import(root + "/src/routes/security")).default],
    ["/internal/nodes", (await import(root + "/src/routes/nodes")).default],
    ["/api/backup", (await import(root + "/src/routes/backup")).default],
    ["/api/infra", (await import(root + "/src/routes/infra")).default],
  ];
  const found: string[] = [];
  for (const [mount, router] of mounts) {
    for (const layer of router.stack ?? []) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods)) {
        if (method === "get" || method === "head" || method === "options") continue;
        found.push(`${method.toUpperCase()} ${(mount + layer.route.path).replace(/\/$/, "")}`);
      }
    }
  }
  // What each one is, decided here by hand. "exempt" routes are the areas of EXEMPT_PREFIXES.
  const expected: Record<string, string> = {
    "POST /api/auth/login": "exempt",
    "POST /api/auth/register": "exempt",
    "POST /api/desktop/session": "exempt",
    "POST /api/desktop/agent-token": "exempt",
    "POST /api/sites/upload": "deploy",
    "POST /api/files/upload": "change",
    "POST /webhooks/github": "exempt",
    "POST /hooks/automations/:token": "exempt",
    "POST /mcp": "exempt", // by the tool inside the message; a message that calls none needs no ticket
    "POST /mcp/upload": "deploy",
    "DELETE /mcp": "exempt", // answers 405
    "POST /internal/security/host-posture": "exempt",
    "POST /internal/security/fim-telemetry": "exempt",
    "POST /internal/security/network-telemetry": "exempt",
    "POST /internal/security/processes": "exempt",
    "POST /internal/security/report": "exempt",
    "POST /internal/nodes/register": "exempt",
    "POST /internal/nodes/heartbeat": "exempt",
    "POST /internal/nodes/metrics": "exempt",
    "POST /internal/nodes/events": "exempt",
    "POST /api/backup/pgsql": "change",
    "POST /api/backup/seed/pgsql": "change",
    "POST /api/infra/health-check": "change",
    "POST /api/infra/disk": "change",
    "POST /api/infra/network": "change",
    "POST /api/infra/scan": "change",
  };
  const newRoutes = found.filter((r) => !(r in expected));
  pass(found.length >= 26 && newRoutes.length === 0, `every REST route that is not a read is known here (${found.length} routes)`, newRoutes.length ? `NOT CLASSIFIED: ${newRoutes.join(", ")}. Decide in packages/tickets/src/table.ts and add it to this check` : "");
  pass(Object.keys(expected).every((r) => found.includes(r)), "and none of the known ones is gone", Object.keys(expected).filter((r) => !found.includes(r)).join(", "));
  const restWrong = Object.entries(expected).filter(([r, want]) => {
    const [method, p] = r.split(" ") as [string, string];
    const d = T.classifyDetail({ method, path: p.replace(":token", "abcdefghijklmnopqrstuvwx") });
    // decided by a rule for that route or area, never by the catch-all for unknown requests
    return actionOf(d.class) !== want || d.rule === "other";
  });
  pass(restWrong.length === 0, "classify() gives each of them its class, by a rule of its own", restWrong.map(([r]) => r).join(", "));
  const zips = T.REST_ROUTES.filter((r: any) => r.zip).map((r: any) => `${r.method} ${r.path}`);
  pass(JSON.stringify(zips) === JSON.stringify(["POST /api/sites/upload", "POST /mcp/upload"]), "the two routes that take a project ZIP are marked, so the file can be checked against the ticket");

  console.log(failed ? `${failed} FAILED` : "the ticket table holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});
