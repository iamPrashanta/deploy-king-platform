import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import * as OTPAuth from "otpauth";
import QRCode from "qrcode";
import { TRPCError } from "@trpc/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db, platformSettings, userTwoFactor, users } from "@dbbkp/db";
import { decrypt, encrypt } from "@dbbkp/security";
import { JWT_SECRET } from "../config";

/**
 * 2-step sign-in with an authenticator app (TOTP, RFC 6238: 6 digits, 30 seconds, SHA-1, which every app supports).
 *
 * - The secret is stored encrypted with MASTER_KEY. It is shown once, as a QR code and as a key to type in.
 * - Ten recovery codes are shown once; only their SHA-256 is stored, and each works one time.
 * - A code is accepted for the 30 seconds before and after its own, and never twice (lastStep).
 * - Five wrong codes in a row lock code entry for 15 minutes.
 */

export const ISSUER = "Deploy King";
export const MAX_FAILURES = 5;
export const LOCK_MS = 15 * 60 * 1000;
export const RECOVERY_CODES = 10;
const PERIOD = 30;

// ─── Pure helpers (tested on fixed inputs) ───────────────────────────────────

export function newSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function totpFor(secret: string, label = "") {
  return new OTPAuth.TOTP({ issuer: ISSUER, label, algorithm: "SHA1", digits: 6, period: PERIOD, secret: OTPAuth.Secret.fromBase32(secret) });
}

/** The code an authenticator app shows at this moment. Used by tests. */
export function codeAt(secret: string, timestamp = Date.now()) {
  return totpFor(secret).generate({ timestamp });
}

/** Whether `code` is right for `secret` now, and is not a code that was already used. */
export function checkCode(secret: string, code: string, lastStep: number | null, timestamp = Date.now()): { ok: boolean; step: number | null } {
  const clean = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(clean)) return { ok: false, step: null };
  const delta = totpFor(secret).validate({ token: clean, timestamp, window: 1 });
  if (delta === null) return { ok: false, step: null };
  const step = Math.floor(timestamp / 1000 / PERIOD) + delta;
  if (lastStep !== null && step <= lastStep) return { ok: false, step: null };
  return { ok: true, step };
}

/** Recovery codes look like "k7qp-2mzd": easy to read, about 40 bits each. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
export const normalizeRecovery = (c: string) => c.toLowerCase().replace(/[^a-z0-9]/g, "");
export const hashRecovery = (c: string) => crypto.createHash("sha256").update("dk-recovery:" + normalizeRecovery(c)).digest("hex");
export function newRecoveryCodes(n = RECOVERY_CODES) {
  const codes: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    for (let j = 0; j < 8; j++) s += ALPHABET[crypto.randomInt(ALPHABET.length)];
    codes.push(`${s.slice(0, 4)}-${s.slice(4)}`);
  }
  return { codes, hashes: codes.map(hashRecovery) };
}

/** A six-digit code, or something shaped like a recovery code. */
export const looksLikeRecovery = (c: string) => normalizeRecovery(c).length === 8 && !/^\d+$/.test(normalizeRecovery(c));

// ─── Sign-in challenges ──────────────────────────────────────────────────────
// After the password is right, the panel gets a short-lived challenge instead of a session: either "enter your
// code" or "set up 2-step sign-in first". They are signed with a key derived from JWT_SECRET, so they can never
// pass as a session token.

const CHALLENGE_KEY = crypto.createHmac("sha256", JWT_SECRET).update("dk-two-step-challenge").digest("hex");
export type ChallengePurpose = "code" | "setup";

export function signChallenge(userId: string, purpose: ChallengePurpose) {
  return jwt.sign({ sub: userId, p: purpose }, CHALLENGE_KEY, { expiresIn: purpose === "code" ? "10m" : "30m" } as jwt.SignOptions);
}

export function readChallenge(token: string, purpose: ChallengePurpose): string {
  try {
    const p = jwt.verify(token, CHALLENGE_KEY) as any;
    if (p?.p === purpose && typeof p.sub === "string") return p.sub;
  } catch {}
  throw new TRPCError({ code: "UNAUTHORIZED", message: "This sign-in has expired. Sign in again." });
}

// ─── Team rule ───────────────────────────────────────────────────────────────

const RULES_KEY = "team_rules";
export type TeamRules = { requireTwoFactor: boolean };

export async function teamRules(): Promise<TeamRules> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, RULES_KEY)).limit(1);
  const v = (row?.value ?? {}) as Partial<TeamRules>;
  return { requireTwoFactor: v.requireTwoFactor === true };
}

export async function saveTeamRules(rules: TeamRules, userId: string) {
  const value = { requireTwoFactor: !!rules.requireTwoFactor };
  await db.insert(platformSettings).values({ key: RULES_KEY, value, updatedBy: userId }).onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  return value;
}

// ─── Stored state ────────────────────────────────────────────────────────────

async function row(userId: string) {
  const [r] = await db.select().from(userTwoFactor).where(eq(userTwoFactor.userId, userId)).limit(1);
  return r ?? null;
}

export async function isEnabled(userId: string) {
  return !!(await row(userId))?.enabledAt;
}

export async function enabledUserIds(): Promise<Set<string>> {
  const rows = await db.select({ userId: userTwoFactor.userId }).from(userTwoFactor).where(isNotNull(userTwoFactor.enabledAt));
  return new Set(rows.map((r) => r.userId));
}

export async function status(userId: string) {
  const r = await row(userId);
  return { enabled: !!r?.enabledAt, enabledAt: r?.enabledAt ?? null, recoveryLeft: r?.enabledAt ? r.recoveryHashes.length : 0, locked: !!(r?.lockedUntil && r.lockedUntil > new Date()) };
}

const secretOf = (r: { secretEnc: string; iv: string; authTag: string }) => decrypt({ encryptedValue: r.secretEnc, iv: r.iv, authTag: r.authTag });

function lockedMessage(until: Date) {
  const min = Math.max(1, Math.ceil((until.getTime() - Date.now()) / 60_000));
  return `Too many wrong codes. Try again in ${min} minute${min === 1 ? "" : "s"}.`;
}

/** Throws while code entry is locked. */
function guard(r: { lockedUntil: Date | null }) {
  if (r.lockedUntil && r.lockedUntil > new Date()) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: lockedMessage(r.lockedUntil) });
}

/** Counts a wrong code; the fifth in a row locks code entry. Atomic, so parallel guesses all count. */
async function fail(userId: string): Promise<never> {
  const [r] = await db.update(userTwoFactor).set({ failures: sql`${userTwoFactor.failures} + 1` }).where(eq(userTwoFactor.userId, userId)).returning({ failures: userTwoFactor.failures });
  if (r && r.failures >= MAX_FAILURES) {
    const until = new Date(Date.now() + LOCK_MS);
    await db.update(userTwoFactor).set({ failures: 0, lockedUntil: until }).where(eq(userTwoFactor.userId, userId));
    throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: lockedMessage(until) });
  }
  throw new TRPCError({ code: "UNAUTHORIZED", message: "That code is not right. Check the time on your phone and try the newest code." });
}

/** Starts (or restarts) setting up: a new secret, not active until a code from it is confirmed. */
export async function startSetup(user: { id: string; username: string }) {
  const r = await row(user.id);
  if (r?.enabledAt) throw new TRPCError({ code: "CONFLICT", message: "2-step sign-in is already on." });
  if (r) guard(r);
  const secret = newSecret();
  const enc = encrypt(secret);
  await db
    .insert(userTwoFactor)
    .values({ userId: user.id, secretEnc: enc.encryptedValue, iv: enc.iv, authTag: enc.authTag, enabledAt: null, recoveryHashes: [], lastStep: null })
    .onConflictDoUpdate({ target: userTwoFactor.userId, set: { secretEnc: enc.encryptedValue, iv: enc.iv, authTag: enc.authTag, enabledAt: null, recoveryHashes: [], lastStep: null } });
  const uri = totpFor(secret, user.username).toString();
  const qr = await QRCode.toDataURL(uri, { errorCorrectionLevel: "M", margin: 1, width: 220 });
  return { secret, uri, qr };
}

/** Confirms setup with a code from the app. Returns the recovery codes, shown once. */
export async function confirmSetup(userId: string, code: string) {
  const r = await row(userId);
  if (!r) throw new TRPCError({ code: "BAD_REQUEST", message: "Start setting up 2-step sign-in first." });
  if (r.enabledAt) throw new TRPCError({ code: "CONFLICT", message: "2-step sign-in is already on." });
  guard(r);
  const check = checkCode(secretOf(r), code, r.lastStep ?? null);
  if (!check.ok) await fail(userId);
  const { codes, hashes } = newRecoveryCodes();
  await db.update(userTwoFactor).set({ enabledAt: new Date(), recoveryHashes: hashes, lastStep: check.step, failures: 0, lockedUntil: null, resetBy: null }).where(and(eq(userTwoFactor.userId, userId), sql`${userTwoFactor.enabledAt} is null`));
  return { recoveryCodes: codes };
}

/**
 * Checks a code at sign-in, or before a change that needs one. Takes a six-digit code or a recovery code;
 * a recovery code is used up. Throws when it is wrong or code entry is locked.
 */
export async function verify(userId: string, code: string): Promise<{ method: "2-step" | "recovery code"; recoveryLeft: number }> {
  const r = await row(userId);
  if (!r?.enabledAt) throw new TRPCError({ code: "BAD_REQUEST", message: "2-step sign-in is not on for this account." });
  guard(r);
  if (looksLikeRecovery(code)) {
    const h = hashRecovery(code);
    if (!r.recoveryHashes.includes(h)) return fail(userId);
    // Lock the row while the code is taken out, so one code cannot be used by two requests at once.
    const used = await db.transaction(async (tx) => {
      const [cur] = await tx.select({ hashes: userTwoFactor.recoveryHashes }).from(userTwoFactor).where(eq(userTwoFactor.userId, userId)).for("update");
      if (!cur || !cur.hashes.includes(h)) return null;
      const left = cur.hashes.filter((x) => x !== h);
      await tx.update(userTwoFactor).set({ recoveryHashes: left, failures: 0, lockedUntil: null }).where(eq(userTwoFactor.userId, userId));
      return { left };
    });
    if (!used) return fail(userId);
    return { method: "recovery code", recoveryLeft: used.left.length };
  }
  const check = checkCode(secretOf(r), code, r.lastStep ?? null);
  if (!check.ok) return fail(userId);
  // Only move lastStep forward, so the same code cannot be accepted by two requests at once.
  const [ok] = await db
    .update(userTwoFactor)
    .set({ lastStep: check.step, failures: 0, lockedUntil: null })
    .where(and(eq(userTwoFactor.userId, userId), sql`(${userTwoFactor.lastStep} is null or ${userTwoFactor.lastStep} < ${check.step})`))
    .returning({ left: userTwoFactor.recoveryHashes });
  if (!ok) return fail(userId);
  return { method: "2-step", recoveryLeft: ok.left.length };
}

export async function newRecovery(userId: string) {
  const { codes, hashes } = newRecoveryCodes();
  await db.update(userTwoFactor).set({ recoveryHashes: hashes }).where(eq(userTwoFactor.userId, userId));
  return { recoveryCodes: codes };
}

/** Turns it off (the user, with a code) or resets it (an admin, for a member who lost their phone). */
export async function remove(userId: string) {
  const out = await db.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId)).returning({ userId: userTwoFactor.userId });
  return out.length > 0;
}

/** What sign-in should do after the password was right. */
export async function nextStep(user: { id: string }): Promise<"code" | "setup" | "none"> {
  if (await isEnabled(user.id)) return "code";
  if ((await teamRules()).requireTwoFactor) return "setup";
  return "none";
}

/** The user, for a challenge: must still exist and not be suspended. */
export async function challengeUser(userId: string) {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.suspendedAt) throw new TRPCError({ code: "UNAUTHORIZED", message: "This sign-in has expired. Sign in again." });
  return u;
}
