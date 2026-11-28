// Signing, the wire form and verifyTicket, on a locally made key and on the control server's
// published test vectors (test/vectors.json, copied from deploy-king-cloud).
//   pnpm --filter @dbbkp/tickets test
import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  decodeTicket,
  encodeTicket,
  newNonce,
  publicKeyObject,
  rawPublicKey,
  signTicket,
  signedBytes,
  ticketMessage,
  verifyTicket,
  TICKET_CODES,
  type PublicKey,
  type Ticket,
  type TicketFields,
} from "../src/index";

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, "vectors.json"), "utf8"));

const pair = crypto.generateKeyPairSync("ed25519");
const keys: PublicKey[] = [{ kid: "2026-11", alg: "Ed25519", publicKey: rawPublicKey(pair.publicKey) }];
const NOW = 1_800_000_000;
const fields = (over: Partial<TicketFields> = {}): TicketFields => ({
  v: 1,
  kid: "2026-11",
  account: "acc_1",
  device: "device-0001",
  action: "deploy",
  app: "shop",
  sha256: "",
  nonce: newNonce(),
  iat: NOW,
  exp: NOW + 300,
  ...over,
});
const wireOf = (t: unknown) => Buffer.from(JSON.stringify(t), "utf8").toString("base64url");

test("the control server's vectors: same signed bytes, same signature, same wire string, accepted", () => {
  const priv = crypto.createPrivateKey({ key: Buffer.from(vectors.key.privateKeyPkcs8Base64, "base64"), format: "der", type: "pkcs8" });
  assert.equal(rawPublicKey(priv), vectors.key.publicKey);
  assert.equal(vectors.vectors.length, 4);
  for (const v of vectors.vectors) {
    assert.equal(signedBytes(v.fields).toString("utf8"), v.signedText, v.name);
    assert.equal(signedBytes(v.fields).toString("hex"), v.signedHex, v.name);
    // Ed25519 signatures are deterministic: the same key and bytes give the same signature everywhere.
    const signed = signTicket(v.fields, priv);
    assert.equal(signed.sig, v.sig, v.name);
    assert.deepEqual(signed, v.ticket, v.name);
    assert.equal(encodeTicket(signed), v.wire, v.name);
    assert.deepEqual(decodeTicket(v.wire), v.ticket, v.name);
    const r = verifyTicket(v.wire, vectors.publicKeys, vectors.validAt);
    assert.deepEqual(r, { ok: true, fields: v.fields }, v.name);
  }
});

test("the vectors stop being accepted 60 seconds after exp, and with another key", () => {
  const v = vectors.vectors[0];
  assert.equal(verifyTicket(v.wire, vectors.publicKeys, v.fields.exp + 60).ok, true);
  assert.deepEqual(verifyTicket(v.wire, vectors.publicKeys, v.fields.exp + 61), { ok: false, code: "ticket_expired" });
  assert.deepEqual(verifyTicket(v.wire, keys, vectors.validAt), { ok: false, code: "ticket_invalid" });
});

test("a signed ticket verifies, and gives back exactly its fields", () => {
  const f = fields({ sha256: "ab".repeat(32) });
  const t = signTicket(f, pair.privateKey);
  assert.deepEqual(Object.keys(t), ["v", "kid", "account", "device", "action", "app", "sha256", "nonce", "iat", "exp", "sig"]);
  const r = verifyTicket(encodeTicket(t), keys, NOW + 10);
  assert.deepEqual(r, { ok: true, fields: f });
});

test("the key order of the wire JSON does not matter", () => {
  const t = signTicket(fields(), pair.privateKey);
  const shuffled: Record<string, unknown> = {};
  for (const k of Object.keys(t).reverse()) shuffled[k] = (t as any)[k];
  const r = verifyTicket(wireOf(shuffled), keys, NOW);
  assert.equal(r.ok, true);
  // and encodeTicket puts them back in the fixed order
  assert.equal(encodeTicket(shuffled as unknown as Ticket), encodeTicket(t));
});

test("the wire form is base64url without padding", () => {
  const w = encodeTicket(signTicket(fields({ app: "a" }), pair.privateKey));
  assert.match(w, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeTicket(w), signTicket(decodeTicket(w), pair.privateKey));
});

test("expiry: accepted until 60 seconds after exp, then ticket_expired", () => {
  const w = encodeTicket(signTicket(fields(), pair.privateKey));
  assert.equal(verifyTicket(w, keys, NOW + 300).ok, true);
  assert.equal(verifyTicket(w, keys, NOW + 360).ok, true);
  assert.deepEqual(verifyTicket(w, keys, NOW + 361), { ok: false, code: "ticket_expired" });
  // a machine whose clock is behind still accepts a ticket "from the future"
  assert.equal(verifyTicket(w, keys, NOW - 3600).ok, true);
});

test("an unknown kid is ticket_invalid, also when it is signed with a known key", () => {
  const w = encodeTicket(signTicket(fields({ kid: "2031-01" }), pair.privateKey));
  assert.deepEqual(verifyTicket(w, keys, NOW), { ok: false, code: "ticket_invalid" });
  assert.deepEqual(verifyTicket(w, [], NOW), { ok: false, code: "ticket_invalid" });
  assert.deepEqual(verifyTicket(w, null as any, NOW), { ok: false, code: "ticket_invalid" });
});

test("several keys: the one named by kid is used (two are valid for a while after a rotation)", () => {
  const next = crypto.generateKeyPairSync("ed25519");
  const both: PublicKey[] = [...keys, { kid: "2026-11-2", alg: "Ed25519", publicKey: rawPublicKey(next.publicKey) }];
  assert.equal(verifyTicket(encodeTicket(signTicket(fields(), pair.privateKey)), both, NOW).ok, true);
  assert.equal(verifyTicket(encodeTicket(signTicket(fields({ kid: "2026-11-2" }), next.privateKey)), both, NOW).ok, true);
  // the new key under the old name is not accepted
  assert.equal(verifyTicket(encodeTicket(signTicket(fields(), next.privateKey)), both, NOW).ok, false);
});

test("changing any field after signing is ticket_invalid", () => {
  const t = signTicket(fields({ sha256: "cd".repeat(32) }), pair.privateKey);
  const changes: Array<[keyof TicketFields, unknown]> = [
    ["account", "acc_2"],
    ["device", "device-0002"],
    ["action", "delete"],
    ["app", "other"],
    ["sha256", "ef".repeat(32)],
    ["nonce", newNonce()],
    ["iat", t.iat + 1],
    ["exp", t.exp + 1000],
  ];
  for (const [k, v] of changes) {
    const r = verifyTicket(wireOf({ ...t, [k]: v }), keys, NOW);
    assert.deepEqual(r, { ok: false, code: "ticket_invalid" }, String(k));
  }
  const sig = Buffer.from(t.sig, "base64url");
  sig[5] = sig[5]! ^ 1;
  assert.deepEqual(verifyTicket(wireOf({ ...t, sig: sig.toString("base64url") }), keys, NOW), { ok: false, code: "ticket_invalid" });
});

test("things that are not tickets are ticket_invalid, and never throw", () => {
  const good = signTicket(fields(), pair.privateKey);
  const bad: unknown[] = [
    "",
    "not a ticket",
    "e30", // {}
    wireOf([1, 2, 3]),
    wireOf("text"),
    wireOf(null),
    wireOf({ ...good, v: 2 }),
    wireOf({ ...good, action: "read" }),
    wireOf({ ...good, nonce: "short" }),
    wireOf({ ...good, nonce: "Z".repeat(32) }),
    wireOf({ ...good, exp: "soon" }),
    wireOf({ ...good, exp: 1.5 }),
    wireOf({ ...good, sig: "" }),
    wireOf({ ...good, sig: undefined }),
    wireOf({ ...good, kid: "" }),
    encodeTicket(good) + "=", // padding is not part of the wire form
    encodeTicket(good).replace(/-/g, "+").replace(/_/g, "/") + "+", // plain base64 is not the wire form
    "A".repeat(5000),
    undefined,
    null,
    42,
    {},
  ];
  for (const w of bad) assert.deepEqual(verifyTicket(w as string, keys, NOW), { ok: false, code: "ticket_invalid" }, String(w).slice(0, 40));
  assert.throws(() => decodeTicket("e30"));
  assert.throws(() => decodeTicket(undefined as any));
});

test("extra properties in the wire JSON are ignored and not returned", () => {
  const t = signTicket(fields(), pair.privateKey);
  const json = '{"__proto__":{"action":"delete"},"role":"admin",' + JSON.stringify(t).slice(1);
  const r = verifyTicket(Buffer.from(json, "utf8").toString("base64url"), keys, NOW);
  assert.equal(r.ok, true);
  if (r.ok) assert.deepEqual(Object.keys(r.fields), ["v", "kid", "account", "device", "action", "app", "sha256", "nonce", "iat", "exp"]);
});

test("a key in the list that is not a key does not crash the check", () => {
  const w = encodeTicket(signTicket(fields(), pair.privateKey));
  const broken = [{ kid: "2026-11", alg: "Ed25519", publicKey: "AAAA" } as PublicKey];
  assert.deepEqual(verifyTicket(w, broken, NOW), { ok: false, code: "ticket_invalid" });
  assert.deepEqual(verifyTicket(w, [null as any, { kid: "2026-11", alg: "RSA" } as any], NOW), { ok: false, code: "ticket_invalid" });
  assert.throws(() => publicKeyObject("AAAA"));
});

test("every refusal code has a message in plain English", () => {
  assert.equal(TICKET_CODES.length, 7);
  for (const c of TICKET_CODES) assert.ok(ticketMessage(c).length > 20 && !ticketMessage(c).includes("_"), c);
});
