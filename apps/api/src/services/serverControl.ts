import os from "node:os";
import type { PublicKey, TicketAction } from "@dbbkp/tickets";
import { desktopModeOn } from "./desktopKey";

/**
 * Server control: a server install that asks a Deploy King control server before it deploys or
 * changes anything.
 *
 * The desktop machine gets its tickets from the desktop app, which holds the user's token. A server
 * has no app in front of it: people use its panel in a browser. So here the server's own API asks
 * for the ticket, with a token the admin made for this server in the admin portal:
 *
 *   1. at start, the server registers itself as a device of that account (POST /v1/devices)
 *   2. before a deploy or a change, the API asks for a ticket (POST /v1/tickets). The control server
 *      applies the same rules as for a desktop: blocked account, revoked token or device, paused,
 *      plan limits. A refusal is passed to the panel with the control server's own message.
 *   3. the ticket is then checked like any other: signature against the control server's public
 *      keys (GET /v1/keys, kept for five minutes), made for this server, this class of request,
 *      used once.
 *
 * Off unless SERVER_CONTROL=true (and never on a desktop machine, which has tickets of its own).
 * Fails closed: when the control server cannot be reached, nothing is deployed or changed.
 *
 * Settings, in the install's .env (the installer writes them with --control-url and --control-token):
 *   SERVER_CONTROL=true
 *   CONTROL_SERVER_URL   the control server, e.g. https://control.example.com
 *   CONTROL_TOKEN        dkc_… made in the admin portal (Users → a user → Tokens)
 *   DK_SERVER_ID         this server's device id; the installer makes one and keeps it
 *   DK_SERVER_NAME       optional: the name the admin sees (default: the host name)
 */

export const serverControlOn = (env: NodeJS.ProcessEnv = process.env) => env.SERVER_CONTROL === "true" && !desktopModeOn(env);

export type ControlConfig = { url: string; token: string; device: string; name: string; version: string };

const DEVICE_ID = /^[A-Za-z0-9._:-]{8,80}$/;

/** The settings, or what is wrong with them. */
export function controlConfig(env: NodeJS.ProcessEnv = process.env): ControlConfig | { error: string } {
  const url = (env.CONTROL_SERVER_URL || "").trim().replace(/\/+$/, "");
  const token = (env.CONTROL_TOKEN || "").trim();
  const device = (env.DK_SERVER_ID || "").trim();
  if (!/^https?:\/\/[^\s/]+/.test(url)) return { error: "CONTROL_SERVER_URL is not set to an http(s) address" };
  if (!token.startsWith("dkc_")) return { error: "CONTROL_TOKEN is not a dkc_ token from the admin portal" };
  if (!DEVICE_ID.test(device)) return { error: "DK_SERVER_ID must be 8 to 80 letters, digits, dots, dashes, colons or underscores" };
  const name = (env.DK_SERVER_NAME || os.hostname() || "server").trim().slice(0, 100);
  return { url, token, device, name, version: (env.DK_VERSION || "").trim().slice(0, 40) };
}

export type ControlAnswer<T> = { ok: true; data: T } | { ok: false; status: number; code: string; message: string };

const UNREACHABLE = "The Deploy King control server could not be reached, so nothing was done. Try again in a moment, or ask your admin.";

/** For tests: a stand-in for fetch. */
let fetchImpl: typeof fetch = (input, init) => fetch(input, init);
export function setControlFetchForTests(f: typeof fetch | null) {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
  keysCache = null;
}

async function call<T>(cfg: ControlConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<ControlAnswer<T>> {
  let res: Response;
  try {
    res = await fetchImpl(cfg.url + path, {
      method,
      headers: {
        ...(path === "/v1/keys" ? {} : { authorization: `Bearer ${cfg.token}` }),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "user-agent": `deploy-king-server/${cfg.version || "unknown"}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    return { ok: false, status: 503, code: "control_unreachable", message: UNREACHABLE };
  }
  let data: any = null;
  try {
    data = await res.json();
  } catch {}
  if (res.ok && data) return { ok: true, data };
  const err = data?.error;
  if (err && typeof err.code === "string") {
    // The control server's refusal, with its own words (a blocked account, a pause message, a limit).
    return { ok: false, status: res.status >= 500 ? 503 : 403, code: err.code.slice(0, 60), message: String(err.message ?? "").slice(0, 500) || UNREACHABLE };
  }
  return { ok: false, status: 503, code: "control_unreachable", message: UNREACHABLE };
}

// ─── Public keys ─────────────────────────────────────────────────────────────
const KEYS_TTL_MS = 5 * 60_000;
let keysCache: { at: number; url: string; keys: PublicKey[] } | null = null;

/** The control server's public keys, kept for five minutes. `fresh` asks again (a ticket signed by a key not seen yet). */
export async function controlKeys(cfg: ControlConfig, fresh = false): Promise<PublicKey[]> {
  if (!fresh && keysCache && keysCache.url === cfg.url && Date.now() - keysCache.at < KEYS_TTL_MS) return keysCache.keys;
  const r = await call<{ keys: PublicKey[] }>(cfg, "GET", "/v1/keys");
  if (r.ok === false || !Array.isArray(r.data?.keys)) return keysCache?.url === cfg.url ? keysCache.keys : [];
  const keys = r.data.keys.filter((k) => !!k && typeof k.kid === "string" && k.alg === "Ed25519" && typeof k.publicKey === "string" && Buffer.from(k.publicKey, "base64").length === 32);
  keysCache = { at: Date.now(), url: cfg.url, keys };
  return keys;
}

// ─── Registration ────────────────────────────────────────────────────────────
/** Registers this server as a device of the token's account. Safe to repeat: it updates the name and version. */
export async function registerServer(cfg: ControlConfig): Promise<ControlAnswer<unknown>> {
  return call(cfg, "POST", "/v1/devices", { deviceId: cfg.device, name: cfg.name, os: `linux server (${os.release()})`.slice(0, 100), appVersion: cfg.version });
}

/** At start: register, and try again for a while when the control server does not answer yet. */
export function registerInBackground(cfg: ControlConfig) {
  let attempt = 0;
  const tryOnce = async () => {
    attempt++;
    const r = await registerServer(cfg);
    if (r.ok === true) return console.log(`[ServerControl] registered with ${cfg.url} as "${cfg.name}" (${cfg.device})`);
    console.warn(`[ServerControl] registering with ${cfg.url} failed: ${r.code}: ${r.message}`);
    if (r.code === "control_unreachable" && attempt < 20) setTimeout(tryOnce, Math.min(60_000, 3000 * attempt)).unref();
  };
  void tryOnce();
}

// ─── Tickets ─────────────────────────────────────────────────────────────────
/** A best guess at the app a request is about, for the admin's list of events. */
export function appNameOf(body: any): string {
  const pick = (o: any): string | null => {
    if (!o || typeof o !== "object") return null;
    for (const k of ["name", "appName", "siteName", "domain", "slug"]) if (typeof o[k] === "string" && o[k]) return o[k];
    return pick(o.json) ?? pick(o.input) ?? pick(o.arguments) ?? pick(o.params) ?? null;
  };
  const one = pick(body) ?? (body && typeof body === "object" ? pick(body["0"]) : null);
  return (one ?? "").slice(0, 100);
}

/**
 * Asks the control server for a ticket for this request. A device that is not registered yet (the
 * control server was down at start, or the admin removed it) is registered once, then asked again.
 */
export async function askTicket(cfg: ControlConfig, needed: { action: TicketAction; kind: string }, app: string): Promise<ControlAnswer<{ ticket: string }>> {
  const body = { device: cfg.device, action: needed.action, app, kind: needed.kind.slice(0, 60), detail: { source: "panel" } };
  let r = await call<{ ticket: string }>(cfg, "POST", "/v1/tickets", body);
  if (r.ok === false && r.code === "device_unknown") {
    const reg = await registerServer(cfg);
    if (reg.ok === false) return reg;
    r = await call<{ ticket: string }>(cfg, "POST", "/v1/tickets", body);
  }
  if (r.ok && typeof r.data?.ticket !== "string") return { ok: false, status: 503, code: "control_unreachable", message: UNREACHABLE };
  return r;
}
