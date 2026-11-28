/**
 * classify(): does this request need a ticket, and of which class?
 *
 * The machine's API and the desktop app both call this one function, so they always agree. The rules:
 *
 *  - GET, HEAD and OPTIONS never need a ticket (tRPC runs only queries on GET).
 *  - Sign-in, the app's own key routes, webhooks and internal calls never need one (EXEMPT_PREFIXES).
 *  - POST /trpc/<names>: each name is looked up in TRPC_MUTATIONS. A batch
 *    (`/trpc/a.b,c.d?batch=1`) is one request and needs one ticket of the strongest class:
 *    delete > deploy > change. Exempt names add nothing; a batch of only exempt names needs none.
 *  - POST /mcp: a JSON-RPC "tools/call" is classed by the tool's name (MCP_TOOLS); a JSON-RPC batch
 *    takes the strongest. Everything else on /mcp (initialize, tools/list, ping) needs none.
 *  - The REST routes in REST_ROUTES have their own class.
 *  - Anything else that is not a read is `change`: unknown is never free.
 */
import { EXEMPT_PREFIXES, MCP_TOOLS, REST_ROUTES, TRPC_MUTATIONS, WS_MESSAGES, type Entry } from "./table";
import type { RequestClass, TicketAction } from "./types";

const STRENGTH: Record<TicketAction, number> = { change: 1, deploy: 2, delete: 3 };
const NONE: RequestClass = { ticket: false };

// Names come from addresses and message bodies, so they are looked up in maps, never on an object
// (where "constructor" or "__proto__" would find something).
const trpc = new Map(Object.entries(TRPC_MUTATIONS));
const tools = new Map(Object.entries(MCP_TOOLS));
const wsMessages = new Map(Object.entries(WS_MESSAGES));

/** delete > deploy > change */
export function strongest(actions: TicketAction[]): TicketAction | null {
  let best: TicketAction | null = null;
  for (const a of actions) if (!best || STRENGTH[a] > STRENGTH[best]) best = a;
  return best;
}

/** A label for the control server's event list: short, and safe to show. */
function label(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 60) || "other";
}

/** The strongest of several entries; names that are not in the table count as `change`. */
function combine(names: string[], table: Map<string, Entry>): RequestClass {
  let best: { action: TicketAction; kind: string } | null = null;
  for (const name of names) {
    const entry = table.get(name) ?? { action: "change" as const, kind: label(name) };
    if (entry === "exempt") continue;
    if (!best || STRENGTH[entry.action] > STRENGTH[best.action]) best = entry;
  }
  return best ? { ticket: true, action: best.action, kind: best.kind } : NONE;
}

/** The path of an address: without the origin, the query and a trailing slash. */
function pathOf(input: string): string {
  let p = String(input ?? "");
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(p);
  if (origin) p = p.slice(origin[0].length) || "/";
  p = p.split(/[?#]/, 1)[0] ?? "";
  if (!p.startsWith("/")) p = "/" + p;
  return p;
}

const under = (lowerPath: string, prefix: string) => lowerPath === prefix || lowerPath.startsWith(prefix + "/");

/** tRPC takes the names from the path: `a.b` or, in a batch, `a.b,c.d` (percent-decoded). */
function trpcNames(rest: string): string[] {
  let decoded = rest;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    // tRPC refuses a path it cannot decode; whatever it is, it is not free
  }
  return decoded.split(",");
}

/** A request body as the caller has it: already parsed, or the JSON text, or its bytes. */
function parsed(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      return JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  if (body instanceof Uint8Array) return parsed(Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8"));
  if (body instanceof ArrayBuffer) return parsed(Buffer.from(body).toString("utf8"));
  return body;
}

/** The names of the tools a JSON-RPC message, or a batch of them, calls. */
function calledTools(body: unknown): string[] {
  const msgs = Array.isArray(body) ? body : [body];
  const names: string[] = [];
  for (const m of msgs) {
    if (!m || typeof m !== "object" || (m as any).method !== "tools/call") continue;
    const name = (m as any).params?.name;
    // A call without a usable name does nothing in the API. It still is not free.
    names.push(typeof name === "string" ? name : "");
  }
  return names;
}

export type Classified = { class: RequestClass; rule: "read" | "exempt" | "trpc" | "mcp" | "rest" | "other" };

/** classify(), with the rule that decided. For tests and for explaining a refusal. */
export function classifyDetail(req: { method: string; path: string; body?: unknown }): Classified {
  const method = String(req.method ?? "").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return { class: NONE, rule: "read" };

  const path = pathOf(req.path);
  const lower = path.toLowerCase().replace(/\/+$/, "") || "/";

  if (EXEMPT_PREFIXES.some((p) => under(lower, p))) return { class: NONE, rule: "exempt" };

  if (under(lower, "/trpc")) {
    // Only POST runs mutations; tRPC answers every other method with an error.
    if (method !== "POST") return { class: NONE, rule: "trpc" };
    const rest = path.replace(/^\/trpc\/?/i, "");
    return { class: combine(trpcNames(rest), trpc), rule: "trpc" };
  }

  if (lower === "/mcp") {
    // The MCP endpoint answers POST only (405 for the rest).
    if (method !== "POST") return { class: NONE, rule: "mcp" };
    return { class: combine(calledTools(parsed(req.body)), tools), rule: "mcp" };
  }

  for (const r of REST_ROUTES) {
    if (r.method !== method || r.path !== lower) continue;
    if (r.entry === "exempt") return { class: NONE, rule: "rest" };
    return { class: { ticket: true, action: r.entry.action, kind: r.entry.kind, ...(r.zip ? { zip: true as const } : {}) }, rule: "rest" };
  }

  return { class: { ticket: true, action: "change", kind: "other" }, rule: "other" };
}

/**
 * Does this request need a ticket, and of which class?
 * `path` may carry a query string or be a whole address; `body` is only looked at for POST /mcp
 * (parsed JSON, JSON text or its bytes).
 */
export function classify(req: { method: string; path: string; body?: unknown }): RequestClass {
  return classifyDetail(req).class;
}

/**
 * The same question for a message on the WebSocket (/ws): `{ type: "terminal.open", ... }`.
 * A message type that is not in WS_MESSAGES counts as `change`.
 */
export function classifyWs(msg: { type?: unknown } | null | undefined): RequestClass {
  const type = typeof msg?.type === "string" ? msg.type : "";
  return combine([type], wsMessages);
}
