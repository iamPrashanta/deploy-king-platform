import fs from "node:fs";
import crypto from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { logAudit } from "@dbbkp/audit";
import {
  CLOCK_TOLERANCE_SECONDS,
  TICKET_HEADER,
  classify,
  classifyWs,
  decodeTicket,
  ticketMessage,
  verifyTicket,
  type PublicKey,
  type RequestClass,
  type TicketAction,
  type TicketCode,
  type TicketFields,
} from "@dbbkp/tickets";
import { hostingQueue } from "../queues";
import { verifyToken } from "../middleware/requireAuth";
import { desktopModeOn } from "./desktopKey";

/**
 * Tickets in the machine's API (Deploy King Desktop with a Deploy King account).
 *
 * With DESKTOP_MODE=true and DESKTOP_REQUIRE_TICKETS=true, every request that deploys or changes
 * something must carry a ticket: the control server's signed, one-time approval, in the
 * `x-dk-ticket` header. Which requests, and of which class, comes from classify() in @dbbkp/tickets,
 * the same function the app uses. For each ticket this checks:
 *
 *   1. signed by a key in the keys file, and not expired (60 seconds of clock tolerance)
 *   2. made for this machine: `device` equals the device file
 *   3. made for this class of request: `action` equals the request's class
 *   4. a ticket that names a ZIP's SHA-256 is only good on a request that carries a ZIP
 *   5. not used before: the nonce is taken in Redis (SET NX EX)
 *   6. for a ZIP upload: the bytes on disk have that SHA-256 (ticketFileCheck, after the upload)
 *
 * The keys file and the device file are read on every call, so the app can rewrite them (a new
 * signing key, a new sign-in) without a restart. Outside desktop mode nothing here is mounted.
 */
export const DEFAULT_TICKET_KEYS_FILE = "/etc/deploy-king/ticket-keys.json";
export const DEFAULT_DEVICE_FILE = "/etc/deploy-king/device-id";

export const ticketKeysFile = () => process.env.DESKTOP_TICKET_KEYS_FILE || DEFAULT_TICKET_KEYS_FILE;
export const deviceFile = () => process.env.DESKTOP_DEVICE_FILE || DEFAULT_DEVICE_FILE;

/** Tickets are required only on a desktop machine that was told to require them. */
export const ticketsRequired = (env: NodeJS.ProcessEnv = process.env) => desktopModeOn(env) && env.DESKTOP_REQUIRE_TICKETS === "true";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseKeys(text: string): PublicKey[] | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  // The file is a list of keys. The control server's own answer ({ keys: [...] }) is read too.
  const list = Array.isArray(data) ? data : Array.isArray((data as any)?.keys) ? (data as any).keys : null;
  if (!list) return null;
  return list.filter(
    (k: any): k is PublicKey => !!k && typeof k.kid === "string" && !!k.kid && k.alg === "Ed25519" && typeof k.publicKey === "string" && Buffer.from(k.publicKey, "base64").length === 32
  );
}

/**
 * The control server's public keys, as the app last wrote them. No file, an empty file or one that
 * is not JSON: no keys, so no ticket is accepted. The app rewrites the file while the API runs, so a
 * file caught half-written is read once more a moment later.
 */
export async function readTicketKeys(file = ticketKeysFile()): Promise<PublicKey[]> {
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf8");
    } catch {
      return [];
    }
    const keys = parseKeys(text);
    if (keys) return keys;
    if (attempt === 0) await sleep(50);
  }
  return [];
}

/** This machine's device id, as the app wrote it. No file or an empty one: null, and no ticket is accepted. */
export function readDeviceId(file = deviceFile()): string | null {
  try {
    const id = fs.readFileSync(file, "utf8").trim();
    return id && id.length <= 200 ? id : null;
  } catch {
    return null;
  }
}

/**
 * Marks a nonce as used, on the Redis connection the job queues already hold. True when this was
 * its first use. The mark lives a little longer than the ticket can be accepted.
 */
async function takeNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
  const client = await hostingQueue.client;
  return (await client.set(`dk:ticket:nonce:${nonce}`, "1", "EX", ttlSeconds, "NX")) === "OK";
}

function within<T>(ms: number, p: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e))
    );
  });
}

export type Needed = { action: TicketAction; kind: string; zip?: true };
export type Refusal = {
  ok: false;
  /** 403 for every refusal of the contract; 503 when the check itself could not be done. */
  status: 403 | 503;
  code: TicketCode | "ticket_check_failed";
  message: string;
  /** What the ticket said about itself, for the audit log. Not trusted unless `verified`. */
  ticket?: Partial<TicketFields>;
  verified?: boolean;
};
export type TicketCheck = { ok: true; fields: TicketFields } | Refusal;

const refusal = (code: TicketCode, extra: Partial<Refusal> = {}): Refusal => ({ ok: false, status: 403, code, message: ticketMessage(code), ...extra });

/** What a ticket says about itself, without its signature. */
function claimed(wire: string): Partial<TicketFields> | undefined {
  try {
    const { sig: _sig, ...fields } = decodeTicket(wire);
    return fields;
  } catch {
    return undefined;
  }
}

/** Checks 1 to 5 of the list at the top. `now` is in unix seconds. */
export async function checkTicket(wire: unknown, needed: Needed, now: number = Math.floor(Date.now() / 1000)): Promise<TicketCheck> {
  if (wire === undefined || wire === null || wire === "") return refusal("ticket_required");
  if (typeof wire !== "string") return refusal("ticket_invalid");

  const v = verifyTicket(wire, await readTicketKeys(), now);
  if (v.ok === false) return refusal(v.code, { ticket: claimed(wire) });
  const f = v.fields;
  const seen = { ticket: f, verified: true };

  const device = readDeviceId();
  if (!device) {
    return refusal("ticket_wrong_device", { ...seen, message: "This Deploy King machine does not know yet which computer it runs on. Open the Deploy King app and sign in again." });
  }
  if (f.device !== device) return refusal("ticket_wrong_device", seen);
  if (f.action !== needed.action) return refusal("ticket_wrong_action", seen);
  if (f.sha256 && !needed.zip) {
    return refusal("ticket_wrong_file", { ...seen, message: "This approval is for an uploaded ZIP file, and this request does not carry one." });
  }

  let first: boolean;
  try {
    // Kept until the ticket can no longer be accepted, and a minute more.
    first = await within(5000, takeNonce(f.nonce, Math.max(60, f.exp + CLOCK_TOLERANCE_SECONDS - now + 60)));
  } catch (e: any) {
    console.error("[Tickets] the used-ticket list (Redis) did not answer:", e?.message ?? e);
    return { ok: false, status: 503, code: "ticket_check_failed", message: "The approval could not be checked right now, so nothing was done. Try again in a moment.", ...seen };
  }
  if (!first) return refusal("ticket_used", seen);
  return { ok: true, fields: f };
}

// ─── The audit log ───────────────────────────────────────────────────────────
// Refusals are written down. A program that keeps asking without a ticket must not fill the log, so
// a minute holds at most this many rows; the next row says how many were left out.
const AUDIT_PER_MINUTE = 30;
let auditWindow = { start: 0, rows: 0, leftOut: 0 };

/** Tests only. */
export function resetTicketAuditLimitForTests() {
  auditWindow = { start: 0, rows: 0, leftOut: 0 };
}

type Where = { method?: string; path: string; ip?: string | null; userAgent?: string | null; actorId?: string | null; auth?: string | null };

function auditRefusal(kind: "ticket_refused" | "ticket_wrong_file", needed: Needed, r: Refusal, where: Where, more: Record<string, unknown> = {}) {
  const now = Date.now();
  if (now - auditWindow.start > 60_000) auditWindow = { start: now, rows: 0, leftOut: auditWindow.leftOut };
  if (auditWindow.rows >= AUDIT_PER_MINUTE) {
    auditWindow.leftOut++;
    return;
  }
  auditWindow.rows++;
  const leftOut = auditWindow.leftOut;
  auditWindow.leftOut = 0;
  const t = r.ticket;
  void logAudit(kind, {
    ...(where.actorId ? { actorId: where.actorId } : {}),
    targetType: "ticket",
    targetName: needed.kind.slice(0, 255),
    metadata: {
      code: r.code,
      needs: needed.action,
      kind: needed.kind,
      // The machine's own clock, in unix seconds: an "expired" that is really a wrong clock shows here.
      machineTime: Math.floor(now / 1000),
      ...(where.method ? { method: where.method } : {}),
      path: where.path.slice(0, 300),
      ...(where.auth ? { auth: where.auth } : {}),
      // Never the signature: a refused ticket may still be good for something else.
      ...(t ? { ticket: { kid: t.kid, account: t.account, device: t.device, action: t.action, app: t.app, nonce: t.nonce, exp: t.exp, verified: !!r.verified } } : {}),
      ...more,
      ...(leftOut ? { refusalsNotLogged: leftOut } : {}),
    },
    ...(where.ip ? { ip: where.ip.slice(0, 50) } : {}),
    ...(where.userAgent ? { userAgent: where.userAgent.slice(0, 500) } : {}),
  });
}

/** Who sent the request, for the audit log only. The route itself checks the sign-in afterwards. */
async function whoSent(req: Request): Promise<{ actorId: string | null; auth: string | null }> {
  const header = typeof req.headers.authorization === "string" ? req.headers.authorization : "";
  if (!header.startsWith("Bearer ")) return { actorId: null, auth: header ? "other" : "none" };
  const token = header.slice(7).trim();
  if (token.startsWith("dk_")) return { actorId: null, auth: "agent token" };
  const user = await verifyToken(token).catch(() => null);
  return { actorId: user?.sub ?? null, auth: user ? "session" : "session not valid" };
}

// ─── HTTP ────────────────────────────────────────────────────────────────────
/** The whole path, also inside a mounted router (where req.path is only the part after the mount). */
const fullPath = (req: Request) => (req.baseUrl || "") + req.path;

const TRPC_CODES = { 403: { code: "FORBIDDEN", number: -32003 }, 503: { code: "INTERNAL_SERVER_ERROR", number: -32603 } } as const;

/**
 * The refusal as the caller expects it. REST and MCP: `{ error: { code, message } }`. tRPC: the
 * error shape of the tRPC client, FORBIDDEN, with a message that starts with the code; one entry for
 * each call of a batch.
 */
function sendRefusal(req: Request, res: Response, r: Refusal) {
  if (res.headersSent) return;
  const path = fullPath(req);
  if (!/^\/trpc(\/|$)/i.test(path)) {
    res.status(r.status).json({ error: { code: r.code, message: r.message } });
    return;
  }
  const rest = path.replace(/^\/trpc\/?/i, "");
  const batch = !!new URLSearchParams(req.originalUrl.split("?")[1] ?? "").get("batch");
  let names = [rest];
  if (batch) {
    try {
      names = decodeURIComponent(rest).split(",");
    } catch {}
  }
  const kind = TRPC_CODES[r.status];
  const one = (path: string) => ({
    error: { message: `${r.code}: ${r.message}`, code: kind.number, data: { code: kind.code, httpStatus: r.status, path: path.slice(0, 200), ticketCode: r.code } },
  });
  res.status(r.status).json(batch ? names.map(one) : one(rest));
}

async function refuse(req: Request, res: Response, needed: Needed, r: Refusal, kind: "ticket_refused" | "ticket_wrong_file" = "ticket_refused", more: Record<string, unknown> = {}) {
  const who = await whoSent(req).catch(() => ({ actorId: null, auth: null }));
  auditRefusal(kind, needed, r, { method: req.method, path: fullPath(req), ip: req.ip ?? null, userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null, ...who }, more);
  sendRefusal(req, res, r);
}

/**
 * The gate in front of the tRPC, REST and MCP handlers. It runs after the JSON body is parsed (an
 * MCP tool call is classed by the tool's name) and before any route, so a refused upload is never
 * read from the network: multipart bodies are only read later, by the route's own upload handler.
 */
export function ticketGate(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    let cls: RequestClass;
    try {
      cls = classify({ method: req.method, path: req.path, body: req.body });
    } catch {
      cls = { ticket: true, action: "change", kind: "other" }; // unknown is never free
    }
    if (!cls.ticket) return next();
    const needed: Needed = cls;
    checkTicket(req.headers[TICKET_HEADER], needed)
      .then((r) => {
        if (r.ok === false) return refuse(req, res, needed, r);
        (req as any).dkTicket = r.fields;
        next();
      })
      .catch((e) => {
        console.error("[Tickets] check failed:", e);
        sendRefusal(req, res, { ok: false, status: 503, code: "ticket_check_failed", message: "The approval could not be checked right now, so nothing was done. Try again in a moment." });
      });
  };
}

function sha256OfFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * For the two ZIP upload routes, after the upload is on disk and before anything is unpacked: a
 * ticket that names a SHA-256 is only good for exactly those bytes. Otherwise the upload is deleted
 * and the request refused. Does nothing when the request came without a ticket check (tickets not
 * required) or when the ticket names no file.
 */
export function ticketFileCheck(req: Request, res: Response, next: NextFunction) {
  const t: TicketFields | undefined = (req as any).dkTicket;
  const file: { path?: string; size?: number } | undefined = (req as any).file;
  if (!t || !t.sha256 || !file?.path) return next();
  const path = file.path;
  sha256OfFile(path)
    .catch(() => null)
    .then(async (actual) => {
      if (actual && actual === t.sha256.toLowerCase()) return next();
      await fs.promises.rm(path, { force: true }).catch(() => {});
      await refuse(req, res, { action: t.action, kind: "create-app", zip: true }, { ok: false, status: 403, code: "ticket_wrong_file", message: ticketMessage("ticket_wrong_file"), ticket: t, verified: true }, "ticket_wrong_file", {
        approvedSha256: t.sha256,
        uploadedSha256: actual,
        bytes: file.size ?? null,
      });
    })
    .catch(next);
}

/**
 * Called once from index.ts, before every route. Mounts nothing unless DESKTOP_MODE=true and
 * DESKTOP_REQUIRE_TICKETS=true, so outside desktop mode the API is exactly what it was.
 */
export function mountTickets(app: Express): boolean {
  if (!ticketsRequired()) {
    if (process.env.DESKTOP_REQUIRE_TICKETS === "true") console.warn("[Tickets] DESKTOP_REQUIRE_TICKETS is set without DESKTOP_MODE=true: tickets are NOT checked.");
    return false;
  }
  app.use(ticketGate());
  console.log(`[Tickets] every deploy and change needs a ticket (keys: ${ticketKeysFile()}, device: ${deviceFile()})`);
  return true;
}

// ─── WebSocket ───────────────────────────────────────────────────────────────
/**
 * The same check for a message on /ws. Opening a terminal (to an app's container or to a connected
 * server) gives a shell, so that message carries a `change` ticket as `ticket`; without one it is
 * refused. Messages for a terminal that is already open, and subscriptions, pass.
 */
export async function checkWsTicket(msg: any, who: { userId?: string | null; ip?: string | null }): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  if (!ticketsRequired()) return { ok: true };
  const cls = classifyWs(msg);
  if (!cls.ticket) return { ok: true };
  const r = await checkTicket(msg?.ticket, cls).catch(
    (): Refusal => ({ ok: false, status: 503, code: "ticket_check_failed", message: "The approval could not be checked right now, so nothing was done. Try again in a moment." })
  );
  if (r.ok === true) return { ok: true };
  auditRefusal("ticket_refused", cls, r, { path: `/ws ${typeof msg?.type === "string" ? msg.type.slice(0, 60) : ""}`.trim(), ip: who.ip ?? null, actorId: who.userId ?? null, auth: "session" });
  return { ok: false, code: r.code, message: r.message };
}
