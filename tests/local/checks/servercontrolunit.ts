// Server control (apps/api/src/services/serverControl.ts) against a stand-in control server that
// signs real tickets. No database, Redis or network is used.
//   cd apps/api && npx tsx ../../tests/local/checks/servercontrolunit.ts
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { createRequire } from "node:module";

async function main() {
  const root = process.cwd(); // apps/api
  const from = (m: string) => createRequire(path.join(root, "package.json")).resolve(m);
  process.env.DATABASE_URL ||= "postgres://nobody:nothing@127.0.0.1:1/none"; // audit rows fail quietly
  delete process.env.DESKTOP_MODE;
  const setEnv = (e: Record<string, string | undefined>) => {
    for (const [k, v] of Object.entries(e)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  const GOOD = { SERVER_CONTROL: "true", CONTROL_SERVER_URL: "https://control.test", CONTROL_TOKEN: "dkc_test", DK_SERVER_ID: "srv-test-0001", DK_SERVER_NAME: "test server", DK_VERSION: "3.0.0" };
  setEnv(GOOD);

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => {
    if (!ok) failed++;
    console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : ""));
  };

  const queues = await import(root + "/src/queues");
  for (const q of Object.values(queues) as any[]) q?.on?.("error", () => {});
  const T = await import(from("@dbbkp/tickets"));
  const SC = await import(root + "/src/services/serverControl");
  const TK = await import(root + "/src/services/tickets");
  const express = (await import(from("express"))).default;

  // Used nonces in memory instead of Redis.
  const used = new Set<string>();
  TK.setNonceTakerForTests(async (n: string) => (used.has(n) ? false : (used.add(n), true)));

  // ── the stand-in control server ──
  let key = crypto.generateKeyPairSync("ed25519");
  let kid = "2026-11";
  const published = () => [{ kid, alg: "Ed25519", publicKey: T.rawPublicKey(key.publicKey) }];
  const calls: { path: string; body: any; auth: string | null }[] = [];
  let mode: "ok" | "blocked" | "down" | "unknown-once" | "other-device" | "same-ticket" | "unpublished-key" = "ok";
  let registered = false;
  let lastTicket = "";
  const sign = (body: any, device = body.device, k = key) => {
    const iat = Math.floor(Date.now() / 1000);
    return T.encodeTicket(T.signTicket({ v: 1, kid, account: "acc_test", device, action: body.action, app: body.app ?? "", sha256: "", nonce: T.newNonce(), iat, exp: iat + 300 }, k.privateKey));
  };
  const json = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  SC.setControlFetchForTests((async (url: any, init: any) => {
    const p = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ path: p, body, auth: init?.headers?.authorization ?? null });
    if (mode === "down") throw new Error("connect ECONNREFUSED");
    if (p === "/v1/keys") return json(200, { keys: published() });
    if (p === "/v1/devices") return (registered = true), json(200, { device: { id: body.deviceId, name: body.name } });
    if (p !== "/v1/tickets") return json(404, { error: { code: "not_found", message: "no" } });
    if (mode === "blocked") return json(403, { error: { code: "account_blocked", message: "Your account is blocked. Contact your admin." } });
    if (mode === "unknown-once" && !registered) return json(403, { error: { code: "device_unknown", message: "unknown" } });
    if (mode === "other-device") return json(200, { ticket: sign(body, "someone-else-01") });
    if (mode === "same-ticket" && lastTicket) return json(200, { ticket: lastTicket });
    if (mode === "unpublished-key") {
      // The control server rotated its key: the new one is published only now.
      key = crypto.generateKeyPairSync("ed25519");
      kid = "2026-12";
    }
    lastTicket = sign(body);
    return json(200, { ticket: lastTicket });
  }) as any);

  // ── an API with the gate in front of two routes ──
  const app = express();
  app.use(express.json());
  pass(TK.mountTickets(app) === true, "SERVER_CONTROL=true mounts the gate on a server install");
  let reached = 0;
  app.post("/trpc/sites.create", (_q: any, r: any) => (reached++, r.json({ ok: true })));
  app.get("/trpc/sites.list", (_q: any, r: any) => r.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const create = (name = "riya-shop") =>
    fetch(`${base}/trpc/sites.create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const codeOf = (b: any) => b?.error?.data?.ticketCode ?? b?.error?.code;
  const tickets = () => calls.filter((c) => c.path === "/v1/tickets");
  await new Promise((r) => setTimeout(r, 50)); // the registration at start

  pass(calls.some((c) => c.path === "/v1/devices" && c.body.deviceId === "srv-test-0001" && c.body.name === "test server" && c.body.appVersion === "3.0.0"), "at start the server registers itself with its id, name and version");

  // reads never ask
  const before = calls.length;
  const read = await fetch(`${base}/trpc/sites.list`);
  pass(read.status === 200 && calls.length === before, "a read passes without asking the control server");

  // approved
  let r = await create();
  const asked = tickets().at(-1);
  pass(r.status === 200 && reached === 1, "approved: the deploy goes through", JSON.stringify(r.body));
  pass(asked?.auth === "Bearer dkc_test" && asked?.body.device === "srv-test-0001" && asked?.body.action === "deploy" && asked?.body.kind === "create-app", "it asked with the server's token, its id, and the request's class", JSON.stringify(asked?.body));
  pass(asked?.body.app === "riya-shop" && asked?.body.detail?.source === "panel", "the admin sees which app, and that it came from the panel");

  // blocked
  mode = "blocked";
  r = await create();
  pass(r.status === 403 && codeOf(r.body) === "account_blocked" && /blocked/.test(r.body.error.message) && reached === 1, "blocked: refused with the control server's own code and words", JSON.stringify(r.body));

  // down
  mode = "down";
  r = await create();
  pass(r.status === 503 && codeOf(r.body) === "control_unreachable" && reached === 1, "control server down: nothing is done (fails closed)", JSON.stringify(r.body));

  // a ticket for someone else
  mode = "other-device";
  r = await create();
  pass(r.status === 403 && codeOf(r.body) === "ticket_wrong_device" && reached === 1, "a ticket made for another device is refused");

  // the same ticket twice
  mode = "same-ticket";
  lastTicket = "";
  r = await create();
  const r2 = await create();
  pass(r.status === 200 && r2.status === 403 && codeOf(r2.body) === "ticket_used" && reached === 2, "a ticket is good once only", `${r.status} ${r2.status} ${codeOf(r2.body)}`);

  // the control server rotated its key
  mode = "unpublished-key";
  const keysAsked = calls.filter((c) => c.path === "/v1/keys").length;
  r = await create();
  pass(r.status === 200 && reached === 3 && calls.filter((c) => c.path === "/v1/keys").length === keysAsked + 1, "a new signing key is fetched once and the deploy goes through", JSON.stringify(r.body));

  // not registered yet (the control server was down at start)
  mode = "unknown-once";
  registered = false;
  r = await create();
  pass(r.status === 200 && registered && reached === 4, "a server the control server does not know registers itself and is asked again");

  // wrong settings
  mode = "ok";
  setEnv({ CONTROL_TOKEN: "not-a-token" });
  r = await create();
  pass(r.status === 503 && codeOf(r.body) === "control_not_configured" && reached === 4, "wrong settings refuse everything", JSON.stringify(r.body));
  setEnv(GOOD);

  // WebSocket: opening a terminal asks too
  mode = "blocked";
  const ws = await TK.checkWsTicket({ type: "terminal.open", appId: "x" }, { userId: null, ip: null });
  pass(ws.ok === false && (ws as any).code === "account_blocked", "opening a terminal is refused for a blocked account too", JSON.stringify(ws));
  mode = "ok";
  const ws2 = await TK.checkWsTicket({ type: "terminal.open", appId: "x" }, { userId: null, ip: null });
  pass(ws2.ok === true, "and allowed when approved", JSON.stringify(ws2));

  // never on a desktop machine, and off by default
  setEnv({ DESKTOP_MODE: "true" });
  pass(SC.serverControlOn() === false, "a desktop machine never uses server control (it has tickets of its own)");
  setEnv({ DESKTOP_MODE: undefined, SERVER_CONTROL: undefined });
  pass(SC.serverControlOn() === false && TK.mountTickets(express()) === false, "without SERVER_CONTROL nothing is mounted");

  // app names from the shapes the panel and MCP send
  pass(SC.appNameOf({ "0": { json: { name: "a1" } } }) === "a1" && SC.appNameOf({ params: { arguments: { name: "m1" } } }) === "m1" && SC.appNameOf(null) === "", "the app's name is found in tRPC batches and MCP calls");

  server.close();
  console.log(failed ? `\n${failed} failed` : "\nall passed");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
