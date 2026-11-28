// Tickets in the machine's API (DESKTOP_MODE=true with DESKTOP_REQUIRE_TICKETS=true), over HTTP and the
// WebSocket, against a real EMPTY database and a real Redis, with a locally made Ed25519 key standing in
// for the control server: no ticket, a valid one (once), a second use, expired, wrong device, wrong class,
// unknown key, changed fields, the keys file rewritten while running, ZIP uploads whose bytes do and do not
// match the ticket (the panel's upload with the app's session, and the assistant's with its token), MCP
// tools, terminals, the audit log, what needs no ticket (queries, sign-in), and both flags off.
//   run by freshdb.sh (cwd apps/api). Needs Redis: the one in .env, or REDIS_URL=redis://127.0.0.1:6379.
//   Job queues are replaced by in-memory stand-ins; no container engine is needed.
//   CHECK_TMP: another place for the apps' folders, when the temp disk looks full to the capacity check.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";

async function main() {
  const root = process.cwd(); // apps/api
  const from = (m: string) => createRequire(path.join(root, "package.json")).resolve(m);
  const dir = fs.mkdtempSync(path.join(process.env.CHECK_TMP || os.tmpdir(), "dk-ticketflow-"));
  const tmp = path.join(dir, "tmp");
  fs.mkdirSync(tmp);
  process.env.TMPDIR = tmp; // uploads land in <tmp>/dbbkp-uploads, where this check can look
  process.env.SITES_ROOT = path.join(dir, "sites");
  process.env.MASTER_KEY ||= "11".repeat(32); // test key, for a run outside the test container
  process.env.DBBKP_BASE_DOMAIN = "localhost";
  const keyFile = path.join(dir, "desktop.key");
  const keysFile = path.join(dir, "ticket-keys.json");
  const deviceFile = path.join(dir, "device-id");
  const DESKTOP_KEY = "t".repeat(43);
  fs.writeFileSync(keyFile, DESKTOP_KEY, { mode: 0o600 });
  process.env.DESKTOP_KEY_FILE = keyFile;
  process.env.DESKTOP_TICKET_KEYS_FILE = keysFile;
  process.env.DESKTOP_DEVICE_FILE = deviceFile;
  process.env.DESKTOP_MODE = "true";
  process.env.DESKTOP_REQUIRE_TICKETS = "true";

  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => {
    if (!ok) failed++;
    console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + String(extra).slice(0, 300) : ""));
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ── The job queues: adding a job is recorded here; their Redis connection is the real one ──
  const queues = await import(root + "/src/queues");
  const added: Array<{ queue: string; name: string; data: any }> = [];
  for (const [queue, q] of Object.entries(queues) as Array<[string, any]>) {
    if (!q || typeof q.add !== "function") continue;
    q.on?.("error", () => {});
    Object.assign(q, {
      add: async (name: string, data: any) => (added.push({ queue, name, data }), {}),
      getRepeatableJobs: async () => [],
      removeRepeatableByKey: async () => true,
    });
  }
  const redis: any = await Promise.race([queues.hostingQueue.client, sleep(5000).then(() => null)]);
  if (!redis || (await Promise.race([redis.ping(), sleep(3000).then(() => null)])) !== "PONG") {
    console.log("FAIL  Redis does not answer: this check needs one (REDIS_URL=redis://127.0.0.1:6379)");
    process.exit(1);
  }

  const express = (await import(from("express"))).default;
  const { createExpressMiddleware } = await import(from("@trpc/server/adapters/express"));
  const AdmZip = (await import(from("adm-zip"))).default;
  const WebSocket = (await import(from("ws"))).default;
  const bcrypt = (await import(from("bcryptjs"))).default;
  const { db, users, sites, siteEnvVars, auditLogs, deployments } = await import(from("@dbbkp/db"));
  const { eq, and, desc, inArray } = await import(from("drizzle-orm"));
  const T = await import(from("@dbbkp/tickets"));
  const { appRouter } = await import(root + "/src/trpc");
  const { createContext } = await import(root + "/src/trpc/trpc");
  const { mountDesktop } = await import(root + "/src/routes/desktop");
  const tickets = await import(root + "/src/services/tickets");
  const authRouter = (await import(root + "/src/routes/auth")).default;
  const sitesRouter = (await import(root + "/src/routes/sites")).default;
  const filesRest = (await import(root + "/src/routes/files")).default;
  const mcpRouter = (await import(root + "/src/routes/mcp")).default;
  const { requireAuth } = await import(root + "/src/middleware/requireAuth");
  const { setupWebSocketGateway } = await import(root + "/src/ws/gateway");
  const uploads = () => fs.readdirSync(path.join(tmp, "dbbkp-uploads"));

  // The same order as apps/api/src/index.ts: JSON body, tickets, then every route.
  const build = async () => {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    const layers = app._router.stack.length;
    const mounted = tickets.mountTickets(app);
    const addedLayers = app._router.stack.length - layers;
    mountDesktop(app);
    app.use("/api/auth", authRouter);
    app.use("/api/sites", requireAuth, sitesRouter);
    app.use("/api/files", filesRest);
    app.use("/mcp", mcpRouter);
    app.use("/trpc", createExpressMiddleware({ router: appRouter, createContext }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, mounted, addedLayers, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  };

  // ── index.ts puts the gate before every route ──
  const src = fs.readFileSync(root + "/src/index.ts", "utf8");
  const gateAt = src.indexOf("\nmountTickets(app);");
  const routesAt = [...src.matchAll(/\n(?:mountDesktop\(app\)|app\.(?:use|get|post|put|delete|all)\(\s*"\/)/g)].map((m) => m.index!);
  pass(gateAt > src.indexOf("app.use(express.json(") && routesAt.length >= 12 && routesAt.every((i) => i > gateAt), "the API mounts the ticket check after the JSON body and before every route", `${routesAt.length} routes`);

  // ── The control server's side: a signing key, and what the app writes into the machine ──
  const pair = crypto.generateKeyPairSync("ed25519");
  const KID = "2026-11";
  const publicKeys = [{ kid: KID, alg: "Ed25519", publicKey: T.rawPublicKey(pair.publicKey) }];
  fs.writeFileSync(keysFile, JSON.stringify(publicKeys));
  const DEVICE = "check-" + crypto.randomUUID();
  fs.writeFileSync(deviceFile, DEVICE + "\n");
  const now = () => Math.floor(Date.now() / 1000);
  const fieldsFor = (action: string, over: Record<string, unknown> = {}) => ({ v: 1, kid: KID, account: "acc_check", device: DEVICE, action, app: "", sha256: "", nonce: T.newNonce(), iat: now(), exp: now() + 300, ...over });
  const ticket = (action: string, over: Record<string, unknown> = {}, key: crypto.KeyObject = pair.privateKey) => T.encodeTicket(T.signTicket(fieldsFor(action, over) as any, key));

  const on = await build();
  let base = on.base;
  pass(on.mounted === true && on.addedLayers === 1, "with DESKTOP_MODE and DESKTOP_REQUIRE_TICKETS the check is mounted, as one middleware");

  type Opts = { auth?: string; ticket?: string; body?: unknown; form?: FormData };
  const call = async (method: string, p: string, o: Opts = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(o.auth ? { Authorization: o.auth } : {}), ...(o.ticket ? { "x-dk-ticket": o.ticket } : {}), ...(o.form || o.body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: o.form ?? (o.body === undefined ? undefined : JSON.stringify(o.body)),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { status: res.status, json, text };
  };
  const mutate = (name: string, input: unknown, o: Opts = {}) => call("POST", `/trpc/${name}`, { ...o, body: input });
  /** The refusal code of a REST or MCP answer, or of a tRPC one. */
  const code = (r: { status: number; json: any }) => r.json?.error?.code ?? null;
  const trpcCode = (r: { status: number; json: any }) => (r.json?.error?.data?.code === "FORBIDDEN" && String(r.json.error.message).startsWith(r.json.error.data.ticketCode + ": ") ? r.json.error.data.ticketCode : null);
  const refused = (r: { status: number; json: any }, c: string) => r.status === 403 && trpcCode(r) === c;
  const show = (r: { status: number; json: any }) => `${r.status} ${JSON.stringify(r.json)}`;

  // ── Signing in needs no ticket ──
  const s1 = await call("POST", "/api/desktop/session", { auth: `Desktop ${DESKTOP_KEY}` });
  const session = `Bearer ${s1.json?.token}`;
  const a1 = await call("POST", "/api/desktop/agent-token", { auth: `Desktop ${DESKTOP_KEY}` });
  const agent = `Bearer ${a1.json?.token}`;
  pass(s1.status === 200 && !!s1.json?.token && a1.status === 200 && String(a1.json?.token).startsWith("dk_"), "the app's key gives the session and the assistant's token without a ticket", `${s1.status} ${a1.status}`);
  const [admin] = await db.select().from(users);
  const mkSite = async (domain: string) =>
    (await db.insert(sites).values({ userId: admin.id, domain, type: "node", docRoot: `${process.env.SITES_ROOT}/x`, source: "image", image: "x:y", status: "active", currentTag: "dbbkp-site-x:1", port: 3000 }).returning())[0];
  const shop = await mkSite("shop.localhost");
  const envKeys = async (siteId: string) => (await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, siteId))).map((r: any) => r.key).sort().join(",");
  const setVar = (key: string) => ({ id: shop.id, key, value: "1" });

  // ── No ticket ──
  const n1 = await mutate("sites.envSet", setVar("NO_TICKET"), { auth: session });
  pass(refused(n1, "ticket_required") && n1.json.error.data.httpStatus === 403 && n1.json.error.data.path === "sites.envSet" && (await envKeys(shop.id)) === "", "a tRPC mutation without a ticket is refused: FORBIDDEN, the message starts with ticket_required, nothing is changed", show(n1));
  const n2 = await call("POST", "/trpc/sites.envSet,sites.envSet?batch=1", { auth: session, body: { 0: setVar("B1"), 1: setVar("B2") } });
  pass(n2.status === 403 && Array.isArray(n2.json) && n2.json.length === 2 && n2.json.every((e: any) => e.error?.data?.ticketCode === "ticket_required") && (await envKeys(shop.id)) === "", "a batch without a ticket gets one refusal for each call", show(n2));
  try {
    const client = await import(createRequire(root + "/../panel/package.json").resolve("@trpc/client"));
    const trpc: any = client.createTRPCProxyClient({ links: [client.httpBatchLink({ url: base + "/trpc", headers: () => ({ authorization: session }) })] });
    const err: any = await trpc.sites.envSet.mutate(setVar("CLIENT")).then(() => null, (e: any) => e);
    pass(err?.data?.code === "FORBIDDEN" && String(err?.message).startsWith("ticket_required: ") && err.data.ticketCode === "ticket_required", "the panel's own tRPC client reads the refusal as a FORBIDDEN error", `${err?.data?.code} ${err?.message}`);
    const list = await trpc.sites.list.query();
    pass(Array.isArray(list) && list.length === 1, "and its queries go through without a ticket");
  } catch (e: any) {
    console.log("NOTE  @trpc/client is not installed here; the refusal's shape was checked by hand above (" + String(e?.message).slice(0, 80) + ")");
  }
  const toolCall = (name: string, args: unknown, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  const toolText = (r: { json: any }) => (Array.isArray(r.json) ? r.json : [r.json]).map((m: any) => (m?.result?.isError ? "ERROR " : "") + (m?.result?.content?.[0]?.text ?? JSON.stringify(m?.error ?? null))).join(" | ");
  const n3 = await call("POST", "/mcp", { auth: agent, body: toolCall("set_env", { app: "shop", set: { MCP_NO_TICKET: "1" } }) });
  pass(n3.status === 403 && code(n3) === "ticket_required" && typeof n3.json.error.message === "string" && (await envKeys(shop.id)) === "", "an MCP tool that changes something is refused without a ticket: 403 { error: { code, message } }", show(n3));
  const n4 = await call("POST", `/api/files/upload?siteId=${shop.id}&volume=data&path=/`, { auth: session, form: (() => { const f = new FormData(); f.append("files", new Blob(["x"]), "a.txt"); return f; })() });
  pass(n4.status === 403 && code(n4) === "ticket_required", "a file upload into a volume is refused without a ticket", show(n4));
  const n5 = await call("POST", "/api/sites/upload", { form: new FormData() });
  pass(n5.status === 403 && code(n5) === "ticket_required", "the ticket is asked for before the sign-in is even looked at", show(n5));

  // ── A valid ticket works once ──
  const t1 = ticket("change", { app: "shop" });
  const v1 = await mutate("sites.envSet", setVar("FIRST"), { auth: session, ticket: t1 });
  pass(v1.status === 200 && v1.json?.result?.data?.success === true && (await envKeys(shop.id)) === "FIRST", "with a valid ticket the mutation runs", show(v1));
  const v2 = await mutate("sites.envSet", setVar("SECOND"), { auth: session, ticket: t1 });
  pass(refused(v2, "ticket_used") && (await envKeys(shop.id)) === "FIRST", "the same ticket a second time is refused: ticket_used", show(v2));
  const ttl = await redis.ttl(`dk:ticket:nonce:${T.decodeTicket(t1).nonce}`);
  pass(ttl > 300 && ttl <= 430, "its nonce is kept in Redis until the ticket can no longer be accepted", String(ttl));
  const v3 = await mutate("sites.envSet", setVar("SECOND"), { auth: session, ticket: ticket("change") });
  pass(v3.status === 200 && (await envKeys(shop.id)) === "FIRST,SECOND", "a new ticket works again");
  const tq = ticket("change");
  const q0 = await call("GET", "/trpc/sites.list", { auth: session, ticket: tq });
  const q1 = await mutate("sites.envSetBuildTime", { id: shop.id, key: "FIRST", buildTime: true }, { auth: session, ticket: tq });
  pass(q0.status === 200 && q1.status === 200, "a ticket sent with a request that needs none is not used up");

  // ── Expired ──
  const e1 = await mutate("sites.envSet", setVar("EXPIRED"), { auth: session, ticket: ticket("change", { iat: now() - 400, exp: now() - 100 }) });
  pass(refused(e1, "ticket_expired"), "an expired ticket is refused: ticket_expired", show(e1));
  const e2 = await mutate("sites.envSet", setVar("JUST_IN_TIME"), { auth: session, ticket: ticket("change", { iat: now() - 320, exp: now() - 20 }) });
  pass(e2.status === 200, "20 seconds past exp is still inside the 60 seconds of clock tolerance", show(e2));

  // ── Wrong device ──
  const d1 = await mutate("sites.envSet", setVar("OTHER_PC"), { auth: session, ticket: ticket("change", { device: "check-" + crypto.randomUUID() }) });
  pass(refused(d1, "ticket_wrong_device"), "a ticket made for another computer is refused: ticket_wrong_device", show(d1));
  fs.rmSync(deviceFile);
  const d2 = await mutate("sites.envSet", setVar("NO_DEVICE_FILE"), { auth: session, ticket: ticket("change") });
  pass(refused(d2, "ticket_wrong_device") && /sign in again/.test(d2.json.error.message), "without a device file nothing is accepted, and the message says what to do", d2.json?.error?.message);
  const DEVICE2 = "check-" + crypto.randomUUID();
  fs.writeFileSync(deviceFile, DEVICE2);
  const d3 = await mutate("sites.envSet", setVar("NEW_DEVICE"), { auth: session, ticket: ticket("change", { device: DEVICE2 }) });
  const d4 = await mutate("sites.envSet", setVar("OLD_DEVICE"), { auth: session, ticket: ticket("change") });
  pass(d3.status === 200 && refused(d4, "ticket_wrong_device"), "the device file is read on every call: a new id counts at once, the old one stops");
  fs.writeFileSync(deviceFile, DEVICE + "\n");

  // ── Wrong class ──
  const td = ticket("deploy", { app: "shop" });
  const w1 = await mutate("sites.envSet", setVar("WRONG_CLASS"), { auth: session, ticket: td });
  pass(refused(w1, "ticket_wrong_action"), "a deploy ticket on a change is refused: ticket_wrong_action", show(w1));
  const queued = () => added.filter((a) => a.name === "deploy-site").length;
  const before1 = queued();
  const w2 = await mutate("sites.redeploy", { id: shop.id }, { auth: session, ticket: td });
  pass(w2.status === 200 && !!w2.json?.result?.data?.deploymentId && queued() === before1 + 1, "that refusal did not use the ticket up: it still works for the deploy it was made for", show(w2));
  const w3 = await mutate("sites.redeploy", { id: shop.id }, { auth: session, ticket: ticket("change") });
  const w4 = await mutate("sites.redeploy", { id: shop.id }, { auth: session, ticket: ticket("delete") });
  pass(refused(w3, "ticket_wrong_action") && refused(w4, "ticket_wrong_action") && queued() === before1 + 1, "a change ticket, or a delete ticket, on a deploy is refused");
  // A batch is one request with one ticket of the strongest class.
  const batchBody = { 0: setVar("IN_BATCH"), 1: { id: shop.id } };
  const b1 = await call("POST", "/trpc/sites.envSet,sites.redeploy?batch=1", { auth: session, ticket: ticket("change"), body: batchBody });
  const b2 = await call("POST", "/trpc/sites.envSet,sites.redeploy?batch=1", { auth: session, ticket: ticket("deploy"), body: batchBody });
  pass(b1.status === 403 && b1.json?.[1]?.error?.data?.ticketCode === "ticket_wrong_action" && b2.status === 200 && b2.json?.[0]?.result?.data?.success === true && !!b2.json?.[1]?.result?.data?.deploymentId, "a batch of a change and a deploy needs one deploy ticket, and then both run", `${show(b1).slice(0, 90)} / ${b2.status}`);
  const gone = await mkSite("gone.localhost");
  const x1 = await mutate("sites.delete", { id: gone.id }, { auth: session, ticket: ticket("change") });
  const x2 = await mutate("sites.delete", { id: gone.id }, { auth: session, ticket: ticket("delete", { app: "gone" }) });
  pass(refused(x1, "ticket_wrong_action") && x2.status === 200 && added.some((a) => a.name === "delete-site" && a.data.siteId === gone.id), "deleting an app needs a delete ticket");

  // ── Unknown key, changed fields, things that are not tickets ──
  const other = crypto.generateKeyPairSync("ed25519");
  const k1 = await mutate("sites.envSet", setVar("UNKNOWN_KID"), { auth: session, ticket: ticket("change", { kid: "2031-01" }, other.privateKey) });
  const k2 = await mutate("sites.envSet", setVar("WRONG_KEY"), { auth: session, ticket: ticket("change", {}, other.privateKey) });
  pass(refused(k1, "ticket_invalid") && refused(k2, "ticket_invalid"), "a ticket under an unknown kid, or signed by another key under a known kid, is refused: ticket_invalid", show(k1));
  const good = T.decodeTicket(ticket("deploy", { app: "shop" }));
  const rewire = (t: object) => Buffer.from(JSON.stringify(t)).toString("base64url");
  const changedFields: Array<[string, unknown]> = [["action", "change"], ["device", DEVICE2], ["exp", good.exp + 86400], ["nonce", T.newNonce()], ["account", "acc_other"], ["app", "other"], ["sha256", "ab".repeat(32)]];
  const tampered: string[] = [];
  for (const [k, v] of changedFields) {
    const r = await mutate(k === "action" ? "sites.envSet" : "sites.redeploy", k === "action" ? setVar("TAMPERED") : { id: shop.id }, { auth: session, ticket: rewire({ ...good, [k]: v }) });
    if (!refused(r, "ticket_invalid")) tampered.push(`${k}: ${show(r)}`);
  }
  pass(tampered.length === 0, "changing any field of a signed ticket makes it ticket_invalid (action, device, exp, nonce, account, app, sha256)", tampered.join("; "));
  const junk: string[] = [];
  for (const h of ["not-a-ticket", "e30", rewire({ ...good, sig: "AAAA" }), "x".repeat(6000)]) {
    const r = await mutate("sites.envSet", setVar("JUNK"), { auth: session, ticket: h });
    if (!refused(r, "ticket_invalid")) junk.push(show(r));
  }
  pass(junk.length === 0 && !(await envKeys(shop.id)).includes("JUNK"), "a header that is not a ticket is ticket_invalid", junk.join("; "));

  // ── The keys file is read on every call ──
  const next = crypto.generateKeyPairSync("ed25519");
  const bothKeys = [...publicKeys, { kid: "2026-11-2", alg: "Ed25519", publicKey: T.rawPublicKey(next.publicKey) }];
  const r0 = await mutate("sites.envSet", setVar("NEXT_KEY"), { auth: session, ticket: ticket("change", { kid: "2026-11-2" }, next.privateKey) });
  fs.writeFileSync(keysFile, JSON.stringify(bothKeys));
  const r1 = await mutate("sites.envSet", setVar("NEXT_KEY"), { auth: session, ticket: ticket("change", { kid: "2026-11-2" }, next.privateKey) });
  const r2 = await mutate("sites.envSet", setVar("OLD_KEY"), { auth: session, ticket: ticket("change") });
  pass(refused(r0, "ticket_invalid") && r1.status === 200 && r2.status === 200, "after a rotation the app rewrites the keys file: the new key works at once, the old one too while it is listed");
  fs.writeFileSync(keysFile, JSON.stringify(bothKeys).slice(0, 60)); // caught half-written
  const r3 = await mutate("sites.envSet", setVar("HALF"), { auth: session, ticket: ticket("change") });
  fs.writeFileSync(keysFile, "");
  const r4 = await mutate("sites.envSet", setVar("EMPTY"), { auth: session, ticket: ticket("change") });
  fs.rmSync(keysFile);
  const r5 = await mutate("sites.envSet", setVar("MISSING"), { auth: session, ticket: ticket("change") });
  pass(refused(r3, "ticket_invalid") && refused(r4, "ticket_invalid") && refused(r5, "ticket_invalid"), "a keys file that is half-written, empty or missing: no ticket is accepted, and nothing crashes", `${r3.status} ${r4.status} ${r5.status}`);
  fs.writeFileSync(keysFile, JSON.stringify({ keys: [bothKeys[1]] })); // the control server's own answer, and only the new key
  const r6 = await mutate("sites.envSet", setVar("AS_ANSWER"), { auth: session, ticket: ticket("change", { kid: "2026-11-2" }, next.privateKey) });
  const r7 = await mutate("sites.envSet", setVar("DROPPED_KEY"), { auth: session, ticket: ticket("change") });
  pass(r6.status === 200 && refused(r7, "ticket_invalid"), "once the old key is no longer in the file, its tickets stop");
  fs.writeFileSync(keysFile, JSON.stringify(publicKeys));

  // ── ZIP uploads: the bytes must be the ones the ticket names ──
  const zipOf = (text: string) => {
    const z = new AdmZip();
    z.addFile("site/index.html", Buffer.from(`<h1>${text}</h1>`));
    return z.toBuffer() as Buffer;
  };
  const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
  const panelForm = (zip: Buffer, domain: string) => {
    const f = new FormData();
    f.append("project", new Blob([zip], { type: "application/zip" }), "site.zip");
    f.append("domain", domain);
    f.append("type", "static");
    return f;
  };
  const agentForm = (zip: Buffer, name: string) => {
    const f = new FormData();
    f.append("project", new Blob([zip], { type: "application/zip" }), "site.zip");
    f.append("name", name);
    return f;
  };
  const siteNamed = async (domain: string) => (await db.select().from(sites).where(eq(sites.domain, domain)))[0];
  const zipA = zipOf("a"), zipB = zipOf("b");

  // The panel's upload, with the app's session.
  const u0 = await call("POST", "/api/sites/upload", { auth: session, form: panelForm(zipA, "zip-none.localhost") });
  pass(u0.status === 403 && code(u0) === "ticket_required" && uploads().length === 0 && !(await siteNamed("zip-none.localhost")), "a ZIP upload without a ticket is refused before the file is read", show(u0));
  const u1 = await call("POST", "/api/sites/upload", { auth: session, ticket: ticket("deploy", { app: "zip-ok", sha256: sha(zipA) }), form: panelForm(zipA, "zip-ok.localhost") });
  const made1 = await siteNamed("zip-ok.localhost");
  pass(u1.status === 200 && made1?.source === "zip" && fs.existsSync(path.join(process.env.SITES_ROOT!, made1.id, "index.html")) && added.some((a) => a.name === "deploy-site" && a.data.siteId === made1.id), "the panel's upload with a ticket that names exactly these bytes: the app is made and its deploy queued", show(u1));
  tickets.resetTicketAuditLimitForTests();
  const tWrong = ticket("deploy", { app: "zip-bad", sha256: sha(zipA) });
  const u2 = await call("POST", "/api/sites/upload", { auth: session, ticket: tWrong, form: panelForm(zipB, "zip-bad.localhost") });
  pass(u2.status === 403 && code(u2) === "ticket_wrong_file" && !(await siteNamed("zip-bad.localhost")) && uploads().length === 0, "other bytes than the ticket names: refused with ticket_wrong_file, the upload deleted, no app made", show(u2));
  const u3 = await call("POST", "/api/sites/upload", { auth: session, ticket: tWrong, form: panelForm(zipA, "zip-bad.localhost") });
  pass(u3.status === 403 && code(u3) === "ticket_used" && !(await siteNamed("zip-bad.localhost")), "and that ticket is spent: sending the right file afterwards does not help", show(u3));
  await sleep(400);
  const [wf] = await db.select().from(auditLogs).where(eq(auditLogs.action, "ticket_wrong_file")).orderBy(desc(auditLogs.createdAt)).limit(1);
  pass(wf?.metadata?.approvedSha256 === sha(zipA) && wf.metadata.uploadedSha256 === sha(zipB) && wf.metadata.path === "/api/sites/upload" && wf.actorId === admin.id && wf.metadata.ticket?.account === "acc_check", "the audit log has the refused upload with both checksums, who sent it and the account of the ticket", JSON.stringify(wf?.metadata));
  const u4 = await call("POST", "/api/sites/upload", { auth: session, ticket: ticket("deploy"), form: panelForm(zipB, "zip-free.localhost") });
  pass(u4.status === 200 && !!(await siteNamed("zip-free.localhost")), "a deploy ticket that names no file is accepted for an upload (the file is then not checked)", show(u4));
  const u5 = await call("POST", "/api/sites/upload", { auth: session, ticket: ticket("change"), form: panelForm(zipA, "zip-change.localhost") });
  pass(u5.status === 403 && code(u5) === "ticket_wrong_action" && uploads().length === 0, "a change ticket is not enough for an upload", show(u5));
  const u6 = await call("POST", "/api/sites/upload", { auth: session, ticket: ticket("deploy", { sha256: sha(zipA).toUpperCase() }), form: panelForm(zipA, "zip-upper.localhost") });
  pass(u6.status === 200, "the checksum is compared without regard to letter case", show(u6));

  // The assistant's upload, with its token.
  const m0 = await call("POST", "/mcp/upload", { auth: agent, form: agentForm(zipA, "agent-none") });
  pass(m0.status === 403 && code(m0) === "ticket_required" && uploads().length === 0 && !(await siteNamed("agent-none.localhost")), "the assistant's ZIP upload without a ticket is refused before the file is read", show(m0));
  const m1 = await call("POST", "/mcp/upload", { auth: agent, ticket: ticket("deploy", { app: "agent-ok", sha256: sha(zipB) }), form: agentForm(zipB, "agent-ok") });
  const made2 = await siteNamed("agent-ok.localhost");
  pass(m1.status === 200 && m1.json?.name === "agent-ok.localhost" && made2?.source === "zip" && fs.existsSync(path.join(process.env.SITES_ROOT!, made2.id, "index.html")), "the assistant's upload with a ticket that names exactly these bytes: the app is made", show(m1));
  const m2 = await call("POST", "/mcp/upload", { auth: agent, ticket: ticket("deploy", { app: "agent-bad", sha256: sha(zipB) }), form: agentForm(zipA, "agent-bad") });
  pass(m2.status === 403 && code(m2) === "ticket_wrong_file" && !(await siteNamed("agent-bad.localhost")) && uploads().length === 0, "other bytes than the ticket names: refused with ticket_wrong_file, the upload deleted, no app made", show(m2));
  const m3 = await call("POST", "/mcp/upload", { auth: "Bearer dk_wrong", ticket: ticket("deploy", { sha256: sha(zipA) }), form: agentForm(zipA, "agent-no-token") });
  pass(m3.status === 401 && uploads().length === 0, "a valid ticket does not replace the token: the upload still needs the assistant's token", show(m3));
  // A ticket for a file is only good with that file.
  const f1 = await mutate("sites.redeploy", { id: shop.id }, { auth: session, ticket: ticket("deploy", { sha256: sha(zipA) }) });
  const f2 = await call("POST", "/mcp", { auth: agent, ticket: ticket("deploy", { sha256: sha(zipA) }), body: toolCall("deploy_app", { app: "shop" }) });
  pass(refused(f1, "ticket_wrong_file") && f2.status === 403 && code(f2) === "ticket_wrong_file", "a ticket that names a ZIP cannot be used for a deploy without that ZIP", `${show(f1).slice(0, 120)} / ${show(f2)}`);

  // ── MCP tools ──
  const before2 = queued();
  const c1 = await call("POST", "/mcp", { auth: agent, ticket: ticket("change", { app: "shop" }), body: toolCall("set_env", { app: "shop", set: { FROM_AGENT: "1" } }) });
  pass(c1.status === 200 && !c1.json?.result?.isError && (await envKeys(shop.id)).includes("FROM_AGENT"), "an MCP tool with the right ticket runs (set_env: change)", toolText(c1));
  const c2 = await call("POST", "/mcp", { auth: agent, ticket: ticket("change"), body: toolCall("deploy_app", { app: "shop" }) });
  const c3 = await call("POST", "/mcp", { auth: agent, ticket: ticket("deploy", { app: "shop" }), body: toolCall("deploy_app", { app: "shop" }) });
  pass(c2.status === 403 && code(c2) === "ticket_wrong_action" && c3.status === 200 && !c3.json?.result?.isError && queued() === before2 + 1, "deploy_app needs a deploy ticket", `${show(c2)} / ${toolText(c3)}`);
  const c4 = await call("POST", "/mcp", { auth: agent, body: toolCall("list_apps", {}) });
  const c5 = await call("POST", "/mcp", { auth: agent, body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
  const c6 = await call("POST", "/mcp", { auth: agent, body: { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } } });
  pass(c4.status === 200 && !c4.json?.result?.isError && /shop\.localhost/.test(toolText(c4)) && c5.json?.result?.tools?.length > 10 && !!c6.json?.result?.serverInfo, "tools that only look, tools/list and initialize need no ticket");
  const mixed = [toolCall("list_apps", {}, 1), toolCall("set_env", { app: "shop", set: { FROM_BATCH: "1" } }, 2)];
  const c7 = await call("POST", "/mcp", { auth: agent, body: mixed });
  const c8 = await call("POST", "/mcp", { auth: agent, ticket: ticket("change"), body: mixed });
  pass(c7.status === 403 && code(c7) === "ticket_required" && c8.status === 200 && Array.isArray(c8.json) && c8.json.length === 2 && (await envKeys(shop.id)).includes("FROM_BATCH"), "a JSON-RPC batch with one changing tool needs one ticket, and then all of it runs", `${c7.status} / ${toolText(c8).slice(0, 80)}`);
  const c9 = await call("POST", "/mcp", { auth: agent, ticket: ticket("change"), body: toolCall("delete_app", { app: "shop" }) });
  const c10 = await call("POST", "/mcp", { auth: agent, ticket: ticket("delete"), body: toolCall("delete_app", { app: "shop" }) });
  pass(code(c9) === "ticket_wrong_action" && c10.status === 200 && c10.json?.result?.isError === true && /full/.test(toolText(c10)) && !!(await siteNamed("shop.localhost")), "delete_app needs a delete ticket, and a ticket does not widen the token: the assistant's token still may not delete", toolText(c10));

  // ── What needs no ticket ──
  const g1 = await call("GET", "/trpc/sites.list", { auth: session });
  const g2 = await call("GET", `/trpc/sites.get?input=${encodeURIComponent(JSON.stringify({ id: shop.id }))}`, { auth: session });
  const g3 = await call("GET", "/api/sites", { auth: session });
  const g4 = await call("GET", "/trpc/sites.delete?input=" + encodeURIComponent(JSON.stringify({ id: shop.id })), { auth: session });
  pass(g1.status === 200 && g1.json?.result?.data?.length >= 5 && g2.json?.result?.data?.domain === "shop.localhost" && g3.status === 200 && Array.isArray(g3.json), "queries and other reads work without a ticket");
  pass(g4.status >= 400 && trpcCode(g4) === null && !!(await siteNamed("shop.localhost")), "and a mutation cannot be run as a read: tRPC itself refuses it on GET", String(g4.status));
  await db.insert(users).values({ email: "pat@t.local", username: "pat", passwordHash: await bcrypt.hash("Pat-Passw0rd-12345", 4), role: "user", teamRole: "developer" });
  const l1 = await mutate("auth.login", { username: "pat", password: "Pat-Passw0rd-12345" });
  const l2 = await mutate("auth.login", { username: "pat", password: "wrong" });
  const l3 = await call("POST", "/api/auth/login", { body: { username: "pat", password: "Pat-Passw0rd-12345" } });
  pass(l1.status === 200 && !!l1.json?.result?.data?.token && l2.status === 401 && l3.status === 200 && !!l3.json?.token, "signing in with a password works without a ticket (and a wrong password is still a wrong password)", `${l1.status} ${l2.status} ${l3.status}`);
  const i1 = await mutate("git.inspect", { repoUrl: "not a url", branch: "main" }, { auth: session });
  pass(i1.status === 400 && /git URL/.test(i1.json?.error?.message ?? ""), "the project check, which changes nothing, is not held up", show(i1));
  const pat = `Bearer ${l1.json?.result?.data?.token}`;
  const p1 = await mutate("sites.delete", { id: shop.id }, { auth: pat, ticket: ticket("delete") });
  pass(p1.status === 403 && trpcCode(p1) === null && /permission/i.test(p1.json?.error?.message ?? "") && !!(await siteNamed("shop.localhost")), "a ticket does not replace permissions: a member who may not delete apps still cannot", show(p1));

  // ── The audit log ──
  tickets.resetTicketAuditLimitForTests();
  const marked = T.decodeTicket(ticket("deploy", { app: "audited" }));
  const markedWire = T.encodeTicket(marked);
  await mutate("sites.envSet", setVar("AUDITED"), { auth: session, ticket: markedWire });
  await call("POST", "/mcp", { auth: agent, body: toolCall("add_worker", { app: "shop", name: "w", command: "x" }) });
  await sleep(400);
  const rows = await db.select().from(auditLogs).where(eq(auditLogs.action, "ticket_refused")).orderBy(desc(auditLogs.createdAt)).limit(2);
  const byCode = (c: string) => rows.find((r: any) => r.metadata?.code === c);
  const ra = byCode("ticket_wrong_action"), rb = byCode("ticket_required");
  pass(
    ra?.actorId === admin.id && ra.targetType === "ticket" && ra.targetName === "env-change" && ra.metadata.needs === "change" && ra.metadata.path === "/trpc/sites.envSet" && ra.metadata.ticket?.nonce === marked.nonce && ra.metadata.ticket.action === "deploy" && ra.metadata.ticket.verified === true,
    "a refusal is in the audit log: who, what was asked, why, and which ticket",
    JSON.stringify(ra?.metadata)
  );
  pass(rb?.metadata?.kind === "add-worker" && rb.metadata.auth === "agent token" && rb.metadata.path === "/mcp" && !rb.metadata.ticket, "a refusal of the assistant is there too", JSON.stringify(rb?.metadata));
  const all = JSON.stringify(await db.select().from(auditLogs).where(inArray(auditLogs.action, ["ticket_refused", "ticket_wrong_file"])));
  pass(!all.includes(marked.sig) && !all.includes(markedWire) && !/"sig"/.test(all), "the audit log never holds a ticket's signature");
  tickets.resetTicketAuditLimitForTests();
  const countRefused = async () => (await db.select({ id: auditLogs.id }).from(auditLogs).where(eq(auditLogs.action, "ticket_refused"))).length;
  const rowsBefore = await countRefused();
  for (let i = 0; i < 36; i++) await mutate("sites.envSet", setVar("FLOOD"), { auth: session });
  await sleep(500);
  const flood = (await countRefused()) - rowsBefore;
  tickets.resetTicketAuditLimitForTests();
  pass(flood === 30, "a program that keeps asking without a ticket cannot fill the audit log: 30 rows a minute at most", String(flood));

  // ── Terminals over the WebSocket ──
  setupWebSocketGateway(on.server);
  const wsUrl = base.replace("http", "ws") + "/ws?token=" + encodeURIComponent(s1.json.token);
  const socket = async () => {
    const s = new WebSocket(wsUrl);
    const inbox: any[] = [];
    s.on("message", (m: any) => inbox.push(JSON.parse(m.toString())));
    await new Promise((res, rej) => (s.once("open", res), s.once("error", rej)));
    const got = async (pred: (m: any) => boolean, ms = 5000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
        const i = inbox.findIndex(pred);
        if (i >= 0) return inbox.splice(i, 1)[0];
      }
      return null;
    };
    await got((m) => m.type === "connected");
    const ask = async (msg: object) => (s.send(JSON.stringify(msg)), got((m) => m.type !== "subscribed" || (msg as any).type === "subscribe"));
    return { s, ask };
  };
  const ws1 = await socket();
  const serverId = crypto.randomUUID();
  const o1 = await ws1.ask({ type: "terminal.open", id: "no-such-container" });
  pass(o1?.type === "ticket.refused" && o1.code === "ticket_required" && o1.for === "terminal.open" && typeof o1.error === "string", "opening a terminal in an app's container without a ticket is refused", JSON.stringify(o1));
  const o2 = await ws1.ask({ type: "ssh.open", serverId });
  pass(o2?.type === "ssh.error" && o2.code === "ticket_required" && o2.serverId === serverId, "opening a terminal on a connected server without a ticket is refused, in the form the panel shows", JSON.stringify(o2));
  const o3 = await ws1.ask({ type: "terminal.open", id: "no-such-container", ticket: ticket("deploy") });
  pass(o3?.code === "ticket_wrong_action", "a deploy ticket does not open a terminal", JSON.stringify(o3));
  const tw = ticket("change");
  const o4 = await ws1.ask({ type: "terminal.open", id: "no-such-container", ticket: tw });
  pass(o4 && !o4.code && /container/i.test(o4.error ?? ""), "with a change ticket in the message the terminal is let through to the usual checks (here: no such container)", JSON.stringify(o4));
  const o5 = await ws1.ask({ type: "terminal.open", id: "no-such-container", ticket: tw });
  pass(o5?.code === "ticket_used", "one ticket opens one terminal", JSON.stringify(o5));
  const o6 = await ws1.ask({ type: "ssh.open", serverId, ticket: ticket("change") });
  pass(o6?.type === "ssh.error" && o6.code === "NOT_FOUND", "the same for a server's terminal (here: no such server)", JSON.stringify(o6));
  const o7 = await ws1.ask({ type: "subscribe", channel: "logs", id: "job-1" });
  pass(o7?.type === "subscribed", "following logs needs no ticket", JSON.stringify(o7));
  const o8 = await ws1.ask({ type: "ssh.exec", serverId });
  pass(o8?.code === "ticket_required", "a message type nobody listed is not free either", JSON.stringify(o8));

  // ── Tickets not required: the flag off, and outside desktop mode ──
  delete process.env.DESKTOP_REQUIRE_TICKETS;
  const o9 = await ws1.ask({ type: "terminal.open", id: "no-such-container" });
  pass(o9 && !o9.code && /container/i.test(o9.error ?? ""), "with the flag off a terminal needs no ticket", JSON.stringify(o9));
  ws1.s.close();
  const off = await build();
  base = off.base;
  const z1 = await mutate("sites.envSet", setVar("FLAG_OFF"), { auth: session });
  const z2 = await call("POST", "/api/sites/upload", { auth: session, form: panelForm(zipA, "zip-flag-off.localhost") });
  const z3 = await call("POST", "/mcp", { auth: agent, body: toolCall("set_env", { app: "shop", set: { FLAG_OFF_AGENT: "1" } }) });
  const z4 = await call("POST", "/mcp/upload", { auth: agent, ticket: "anything", form: agentForm(zipB, "agent-flag-off") });
  pass(off.mounted === false && off.addedLayers === 0, "DESKTOP_MODE without DESKTOP_REQUIRE_TICKETS: the check is not mounted at all");
  pass(z1.status === 200 && z2.status === 200 && z3.status === 200 && !z3.json?.result?.isError && z4.status === 200 && (await envKeys(shop.id)).includes("FLAG_OFF"), "and mutations, MCP tools and both ZIP uploads work without a ticket, as before", `${z1.status} ${z2.status} ${z3.status} ${z4.status}`);
  off.server.close();

  delete process.env.DESKTOP_MODE;
  process.env.DESKTOP_REQUIRE_TICKETS = "true";
  const server2 = await build();
  base = server2.base;
  const y1 = await mutate("sites.envSet", setVar("NOT_DESKTOP"), { auth: session });
  const y2 = await call("POST", "/api/sites/upload", { auth: session, form: panelForm(zipA, "zip-not-desktop.localhost") });
  const y3 = await call("POST", "/api/desktop/session", { auth: `Desktop ${DESKTOP_KEY}` });
  pass(server2.mounted === false && server2.addedLayers === 0 && tickets.ticketsRequired() === false, "outside desktop mode DESKTOP_REQUIRE_TICKETS alone does nothing: the check is not mounted");
  pass(y1.status === 200 && y2.status === 200 && y3.status === 404, "a server that is not a desktop machine works exactly as before", `${y1.status} ${y2.status} ${y3.status}`);
  server2.server.close();
  pass(tickets.ticketsRequired({ DESKTOP_MODE: "true", DESKTOP_REQUIRE_TICKETS: "true" }) && !tickets.ticketsRequired({ DESKTOP_MODE: "true", DESKTOP_REQUIRE_TICKETS: "1" }) && !tickets.ticketsRequired({ DESKTOP_MODE: "true" }) && !tickets.ticketsRequired({ DESKTOP_REQUIRE_TICKETS: "true" }) && !tickets.ticketsRequired({}), "tickets are required only with both DESKTOP_MODE=true and DESKTOP_REQUIRE_TICKETS=true");

  await db.select().from(deployments).limit(1); // the pool is still fine
  on.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed ? `${failed} FAILED` : "the ticket check holds");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => {
  console.error("CRASH", e);
  process.exit(1);
});
