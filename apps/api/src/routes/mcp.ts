import { Router, type NextFunction, type Request, type Response } from "express";
import { TRPCError } from "@trpc/server";
import multer from "multer";
import os from "os";
import path from "path";
import fs from "fs-extra";
import { db, mcpCalls, sites } from "@dbbkp/db";
import { eq, lt } from "drizzle-orm";
import { appRouter } from "../trpc";
import { scopeAllows, verifyApiToken, type TokenAuth } from "../services/apiTokens";
import { TOOLS, TOOL_BY_NAME, ToolError, appUrl, type Tool } from "../mcp/tools";
import { BASE_DOMAIN } from "../config";
import { enqueueDeploy } from "../services/deploy";
import { siteDocRoot } from "../services/validation";
import { extractProjectZip, UnsafeArchiveError } from "../services/zipsite";
import { ticketFileCheck } from "../services/tickets";
import { ArgError, checkArgs } from "../mcp/schema";

/**
 * Model Context Protocol server for AI agents (Streamable HTTP, stateless, JSON responses).
 *   POST /mcp   Authorization: Bearer dk_…   body: a JSON-RPC message
 * Tools run through the same tRPC procedures as the panel, as the token's user,
 * so ownership and permission checks are the panel's own.
 */
const router = Router();

const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION = process.env.DBBKP_VERSION || "0.4.0";
const INSTRUCTIONS = `Deploy King runs web apps in containers on the user's own server.
To deploy a repository: check_repo, then create_app with the port and variables it reports, then wait_for_deploy.
If wait_for_deploy says the deploy needs an answer, pick one of the offered answers (ask the user when unsure) with answer_deploy_question and wait again.
To debug: get_app, get_deploy_log (build and start), get_app_logs (the running app).
Ask the user before delete_app, before rollback_app on a live app, and before changing variables of a live app.
Never put secrets in app names, workflow input or logs.`;

// ─── Limits ──────────────────────────────────────────────────────────────────
const PER_MINUTE = Number(process.env.MCP_CALLS_PER_MINUTE || 120);
const recent = new Map<string, number[]>();
function overLimit(tokenId: string) {
  const now = Date.now();
  const list = (recent.get(tokenId) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  recent.set(tokenId, list);
  return list.length > PER_MINUTE;
}
// Keep 30 days of activity.
setInterval(() => {
  db.delete(mcpCalls).where(lt(mcpCalls.createdAt, new Date(Date.now() - 30 * 86400_000))).catch(() => {});
  for (const [k, v] of recent) if (!v.some((t) => Date.now() - t < 60_000)) recent.delete(k);
}, 6 * 3600_000).unref();

// ─── Helpers ─────────────────────────────────────────────────────────────────
const clientIp = (req: Request) => String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() || req.socket.remoteAddress || null;

/** DNS-rebinding guard from the MCP spec: browsers send Origin, and only this host (or allowed ones) may call. */
function originOk(req: Request) {
  const origin = req.headers.origin;
  if (!origin) return true; // command-line and desktop agents send none
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const allowed = new Set([req.headers.host, req.headers["x-forwarded-host"]].flat().filter(Boolean).map(String));
  for (const o of (process.env.MCP_ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean)) {
    try {
      allowed.add(new URL(o).host);
    } catch {}
  }
  return allowed.has(host);
}

const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });

const listing = (t: Tool) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { title: t.title, ...t.annotations } });

function readable(err: unknown): string {
  if (err instanceof ToolError || err instanceof ArgError) return err.message;
  if (err instanceof TRPCError) {
    if (err.message === "PASSWORD_ROTATION_REQUIRED") return "The user must change their password in the panel before agents can act for them.";
    if (err.code === "FORBIDDEN") return `Not allowed: ${err.message}`;
    if (err.cause && (err.cause as any).issues) return `Invalid input: ${(err.cause as any).issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ")}`;
    return err.message;
  }
  console.error("[MCP] tool failed:", err);
  return "Something went wrong on the server. Try again, or check the panel.";
}

async function callTool(auth: TokenAuth, ip: string | null, name: string, rawArgs: unknown) {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) return null;
  const started = Date.now();
  let args: Record<string, any> = {};
  let ok = false;
  let text: string;
  try {
    if (!scopeAllows(auth.scope, tool.scope)) {
      throw new ToolError(`This token can only ${auth.scope === "read" ? "look" : "deploy"}. ${tool.name} needs a "${tool.scope}" token; ask the user to create one on the AI agents page.`);
    }
    args = checkArgs(tool.inputSchema, rawArgs);
    const caller = appRouter.createCaller({
      user: { sub: auth.user.sub, sid: `token:${auth.tokenId}`, username: auth.user.username, role: auth.user.role, mustChangePassword: false },
      ip,
      apiToken: { id: auth.tokenId, scope: auth.scope },
    });
    const result = await tool.run(args, { caller, user: auth.user });
    text = JSON.stringify(result, null, 2);
    ok = true;
  } catch (err) {
    text = readable(err);
  }
  const durationMs = Date.now() - started;
  // Log what was asked even when it was refused before the arguments were checked.
  const asked = ok || Object.keys(args).length ? args : rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? (rawArgs as Record<string, any>) : {};
  let logged: Record<string, any>;
  try {
    logged = JSON.parse(JSON.stringify(tool.logArgs ? tool.logArgs(asked) : asked));
    if (JSON.stringify(logged).length > 4000) logged = { note: "arguments too long to log" };
  } catch {
    logged = {};
  }
  db.insert(mcpCalls)
    .values({ tokenId: auth.tokenId, userId: auth.user.sub, tool: tool.name, args: logged, ok, error: ok ? null : text.slice(0, 1000), durationMs, ip: ip?.slice(0, 64) ?? null })
    .catch((e) => console.error("[MCP] activity log failed:", e.message));
  return { content: [{ type: "text", text }], isError: !ok };
}

async function handle(msg: any, auth: TokenAuth, ip: string | null) {
  if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return rpcError(msg?.id, -32600, "Invalid request");
  const isNotification = msg.id === undefined;
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "deploy-king", title: "Deploy King", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS.filter((t) => scopeAllows(auth.scope, t.scope)).map(listing) });
    case "tools/call": {
      const name = params?.name;
      if (typeof name !== "string") return rpcError(id, -32602, "Missing tool name");
      if (overLimit(auth.tokenId)) return rpcError(id, -32000, `Too many calls: the limit is ${PER_MINUTE} a minute per token`);
      const result = await callTool(auth, ip, name, params?.arguments);
      if (!result) return rpcError(id, -32602, `Unknown tool: ${name}`);
      return rpcResult(id, result);
    }
    case "resources/list":
      return rpcResult(id, { resources: [] });
    case "prompts/list":
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────
router.post("/", async (req: Request, res: Response) => {
  if (!originOk(req)) return res.status(403).json(rpcError(null, -32000, "Origin not allowed"));
  const header = req.headers.authorization ?? "";
  const raw = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  const ip = clientIp(req);
  const auth = await verifyApiToken(raw, ip);
  if (!auth) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="Deploy King", error="invalid_token"');
    return res.status(401).json(rpcError(null, -32001, "Missing, expired or revoked token. Create one on the AI agents page of the Deploy King panel."));
  }
  const body = req.body;
  if (body === undefined || body === null || (typeof body === "object" && !Object.keys(body).length && !Array.isArray(body))) {
    return res.status(400).json(rpcError(null, -32700, "Send a JSON-RPC message with Content-Type: application/json"));
  }
  const batch = Array.isArray(body);
  const msgs = batch ? body.slice(0, 20) : [body];
  const out = [];
  for (const m of msgs) {
    const r = await handle(m, auth, ip);
    if (r) out.push(r);
  }
  if (!out.length) return res.status(202).end();
  res.json(batch ? out : out[0]);
});

// ─── ZIP upload for agents (the terminal and desktop assistants) ──────────────
//   POST /mcp/upload   Authorization: Bearer dk_… (deploy scope)   multipart/form-data:
//     project  the ZIP file          name       app name or full domain
//     port     optional              memoryMb   optional
//     variables  optional JSON object of environment variables (stored encrypted, never returned)
// Creates the app through the same tRPC procedure as the panel (permissions, fit check, audit), unpacks
// the ZIP into it and starts the first deploy. JSON-RPC cannot carry a large file, hence this route.
const BUILD_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_|GATSBY_|EXPO_PUBLIC_|PUBLIC_|VUE_APP_)/;
const zipUpload = multer({ dest: path.join(os.tmpdir(), "dbbkp-uploads"), limits: { fileSize: 500 * 1024 * 1024, files: 1, fields: 20, fieldSize: 256 * 1024 } });

async function tokenFor(req: Request, res: Response, next: NextFunction) {
  if (!originOk(req)) return res.status(403).json({ error: "Origin not allowed" });
  const header = req.headers.authorization ?? "";
  const auth = await verifyApiToken(header.startsWith("Bearer ") ? header.slice(7).trim() : null, clientIp(req));
  if (!auth) return res.status(401).json({ error: "Missing, expired or revoked token. Create one on the AI agents page of the Deploy King panel." });
  if (!scopeAllows(auth.scope, "deploy")) return res.status(403).json({ error: 'Uploading an app needs a "deploy" token.' });
  if (overLimit(auth.tokenId)) return res.status(429).json({ error: `Too many calls: the limit is ${PER_MINUTE} a minute per token` });
  (req as any).tokenAuth = auth;
  next();
}

// ticketFileCheck: on a desktop machine that requires tickets, the ZIP must be the one the ticket names.
router.post("/upload", tokenFor, zipUpload.single("project"), ticketFileCheck, async (req: Request, res: Response) => {
  const auth: TokenAuth = (req as any).tokenAuth;
  const file = (req as any).file as { path: string; size: number } | undefined;
  const ip = clientIp(req);
  const started = Date.now();
  const body = req.body ?? {};
  let siteId: string | null = null;
  let status = 200;
  let out: any;
  try {
    if (!file) throw new ToolError('Send the ZIP as the "project" field');
    const name = String(body.name ?? "").trim().toLowerCase();
    if (!name) throw new ToolError("name is required");
    let variables: Record<string, unknown> = {};
    if (body.variables) {
      try {
        variables = JSON.parse(String(body.variables));
      } catch {
        throw new ToolError("variables must be a JSON object");
      }
      if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new ToolError("variables must be a JSON object");
    }
    const num = (v: unknown) => (v === undefined || v === "" ? undefined : Number(v));
    const caller = appRouter.createCaller({
      user: { sub: auth.user.sub, sid: `token:${auth.tokenId}`, username: auth.user.username, role: auth.user.role, mustChangePassword: false },
      ip,
      apiToken: { id: auth.tokenId, scope: auth.scope },
    });
    const site: any = await caller.sites.create({
      domain: name.includes(".") ? name : `${name}.${BASE_DOMAIN}`,
      source: "zip",
      runtime: "auto",
      port: num(body.port),
      memoryLimit: num(body.memoryMb),
      env: Object.entries(variables).map(([key, value]) => ({ key, value: String(value), buildTime: BUILD_PREFIX.test(key) })),
      volumes: [],
      autoDeploy: false,
    } as any);
    siteId = site.id;
    await extractProjectZip(file.path, siteDocRoot(site.id));
    await db.update(sites).set({ status: "provisioning" }).where(eq(sites.id, site.id));
    const deployment = await enqueueDeploy(site.id, { trigger: "manual", createdBy: auth.user.sub });
    siteId = null; // keep it
    out = { id: site.id, name: site.domain, url: appUrl(site.domain), deploymentId: deployment.id, hint: `Deploy started. Call wait_for_deploy with app "${site.domain}".` };
  } catch (err) {
    status = err instanceof UnsafeArchiveError || err instanceof ToolError ? 400 : err instanceof TRPCError ? (err.code === "FORBIDDEN" ? 403 : err.code === "CONFLICT" ? 409 : 400) : 500;
    out = { error: err instanceof UnsafeArchiveError ? err.message : readable(err) };
  } finally {
    if (file?.path) await fs.remove(file.path).catch(() => {});
    // An app that was created but could not be unpacked or queued is taken away again.
    if (siteId) {
      await db.delete(sites).where(eq(sites.id, siteId)).catch(() => {});
      await fs.remove(siteDocRoot(siteId)).catch(() => {});
    }
  }
  db.insert(mcpCalls)
    .values({
      tokenId: auth.tokenId, userId: auth.user.sub, tool: "upload_zip",
      args: { name: body.name, port: body.port, memoryMb: body.memoryMb, bytes: file?.size },
      ok: status === 200, error: status === 200 ? null : String(out.error).slice(0, 1000), durationMs: Date.now() - started, ip: ip?.slice(0, 64) ?? null,
    })
    .catch((e) => console.error("[MCP] activity log failed:", e.message));
  res.status(status).json(out);
});

// No server-to-client stream and no sessions in this server.
const notAllowed = (_req: Request, res: Response) => res.status(405).set("Allow", "POST").json(rpcError(null, -32000, "Use POST"));
router.get("/", notAllowed);
router.delete("/", notAllowed);

export default router;
