/**
 * Signing, sending and checking a ticket.
 *
 *   signed bytes = UTF-8 of JSON.stringify([v, kid, account, device, action, app, sha256, nonce, iat, exp])
 *   wire form    = base64url (no padding) of JSON.stringify(ticket), keys in the order
 *                  v, kid, account, device, action, app, sha256, nonce, iat, exp, sig
 *   public key   = base64 of the raw 32-byte Ed25519 key
 *
 * A checker never depends on the key order of the wire JSON: it rebuilds the signed bytes from the fields.
 * test/vectors.json holds fixed examples made by the control server.
 */
import crypto, { type KeyObject } from "node:crypto";
import { CLOCK_TOLERANCE_SECONDS, type PublicKey, type Ticket, type TicketAction, type TicketFields } from "./types";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const ACTIONS: readonly TicketAction[] = ["deploy", "change", "delete"];
/** A real ticket is about 500 characters. Anything much longer is not one. */
const MAX_WIRE_LENGTH = 4096;

const text = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
const seconds = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The exact bytes the control server signs. */
export function signedBytes(f: TicketFields): Buffer {
  return Buffer.from(JSON.stringify([f.v, f.kid, f.account, f.device, f.action, f.app, f.sha256, f.nonce, f.iat, f.exp]), "utf8");
}

/** The ten fields in their fixed order, and nothing else that the object may carry. */
function fieldsOf(t: TicketFields): TicketFields {
  return { v: t.v, kid: t.kid, account: t.account, device: t.device, action: t.action, app: t.app, sha256: t.sha256, nonce: t.nonce, iat: t.iat, exp: t.exp };
}

function isTicket(t: any): t is Ticket {
  return (
    !!t &&
    typeof t === "object" &&
    !Array.isArray(t) &&
    t.v === 1 &&
    text(t.kid, 100) &&
    t.kid.length > 0 &&
    text(t.account, 200) &&
    text(t.device, 200) &&
    ACTIONS.includes(t.action) &&
    text(t.app, 300) &&
    text(t.sha256, 128) &&
    typeof t.nonce === "string" &&
    /^[0-9a-f]{32}$/.test(t.nonce) &&
    seconds(t.iat) &&
    seconds(t.exp) &&
    text(t.sig, 200) &&
    /^[A-Za-z0-9_-]+$/.test(t.sig)
  );
}

/** Used by the control server and by tests. */
export function signTicket(fields: TicketFields, privateKey: KeyObject): Ticket {
  const f = fieldsOf(fields);
  return { ...f, sig: crypto.sign(null, signedBytes(f), privateKey).toString("base64url") };
}

/** The wire form: what goes into the `x-dk-ticket` header. The key order is fixed, so the string is the same everywhere. */
export function encodeTicket(t: Ticket): string {
  return Buffer.from(JSON.stringify({ ...fieldsOf(t), sig: t.sig }), "utf8").toString("base64url");
}

/** Reads a wire string. Throws when it is not a ticket; says nothing about whether the signature is good. */
export function decodeTicket(wire: string): Ticket {
  if (typeof wire !== "string" || !wire || wire.length > MAX_WIRE_LENGTH || !/^[A-Za-z0-9_-]+$/.test(wire)) throw new Error("not a ticket");
  let t: unknown;
  try {
    t = JSON.parse(Buffer.from(wire, "base64url").toString("utf8"));
  } catch {
    throw new Error("not a ticket");
  }
  if (!isTicket(t)) throw new Error("not a ticket");
  return { ...fieldsOf(t), sig: t.sig };
}

/** A key object from the base64 of the raw 32 bytes, as the control server publishes it. */
export function publicKeyObject(key: PublicKey | string): KeyObject {
  const raw = Buffer.from(typeof key === "string" ? key : key.publicKey, "base64");
  if (raw.length !== 32) throw new Error("an Ed25519 public key is 32 bytes");
  return crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** The published form of a key: base64 of its raw 32 bytes. Works for a private key too. */
export function rawPublicKey(key: KeyObject): string {
  const pub = key.type === "public" ? key : crypto.createPublicKey(key);
  const spki = pub.export({ format: "der", type: "spki" });
  return spki.subarray(spki.length - 32).toString("base64");
}

export type VerifyResult = { ok: true; fields: TicketFields } | { ok: false; code: "ticket_invalid" | "ticket_expired" };

/**
 * Is this a ticket the control server signed, and is it still in time?
 * `now` is in unix seconds. A ticket is accepted until 60 seconds after `exp`.
 *
 * This is the part every checker shares. The machine's API checks more, because only it can: that
 * `device` is this machine, that `action` is the class of the request, that the nonce was not used
 * before, and for a ZIP upload that `sha256` matches the bytes.
 */
export function verifyTicket(wire: string, keys: PublicKey[], now: number = Math.floor(Date.now() / 1000)): VerifyResult {
  let t: Ticket;
  try {
    t = decodeTicket(wire);
  } catch {
    return { ok: false, code: "ticket_invalid" };
  }
  const key = Array.isArray(keys) ? keys.find((k) => !!k && k.kid === t.kid && k.alg === "Ed25519") : undefined;
  if (!key) return { ok: false, code: "ticket_invalid" };
  const fields = fieldsOf(t);
  let good = false;
  try {
    good = crypto.verify(null, signedBytes(fields), publicKeyObject(key), Buffer.from(t.sig, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, code: "ticket_invalid" };
  if (now > fields.exp + CLOCK_TOLERANCE_SECONDS) return { ok: false, code: "ticket_expired" };
  return { ok: true, fields };
}

/** 32 hex characters. */
export function newNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}
