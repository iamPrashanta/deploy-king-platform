import { TRPCError } from "@trpc/server";

/**
 * Failed sign-in attempts per address, in memory (one API process). On top of the per-account lock in
 * services/twofactor.ts: that one stops guessing one account's code, this one stops one address from
 * guessing passwords or codes across many accounts. Only failures count, so people who sign in normally
 * never notice it.
 */

type Bucket = { count: number; resetAt: number };
const buckets = new Map<string, Bucket>();

export const LIMITS = {
  password: { max: 20, windowMs: 15 * 60_000 },
  code: { max: 20, windowMs: 15 * 60_000 },
} as const;
export type LimitKind = keyof typeof LIMITS;

const keyOf = (kind: LimitKind, ip: string | null | undefined) => `${kind}:${ip || "unknown"}`;

function prune(now: number) {
  if (buckets.size < 5000) return;
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}

/** Throws TOO_MANY_REQUESTS while this address has used up its failed attempts. */
export function checkLimit(kind: LimitKind, ip: string | null | undefined, now = Date.now()) {
  const b = buckets.get(keyOf(kind, ip));
  if (!b || b.resetAt <= now || b.count < LIMITS[kind].max) return;
  const min = Math.max(1, Math.ceil((b.resetAt - now) / 60_000));
  throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `Too many failed attempts from this address. Try again in ${min} minute${min === 1 ? "" : "s"}.` });
}

export function noteFailure(kind: LimitKind, ip: string | null | undefined, now = Date.now()) {
  prune(now);
  const k = keyOf(kind, ip);
  const b = buckets.get(k);
  if (!b || b.resetAt <= now) buckets.set(k, { count: 1, resetAt: now + LIMITS[kind].windowMs });
  else b.count += 1;
}

/** Runs `fn`; a TRPC UNAUTHORIZED or TOO_MANY_REQUESTS from it counts as a failed attempt for this address. */
export async function limited<T>(kind: LimitKind, ip: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  checkLimit(kind, ip);
  try {
    return await fn();
  } catch (e) {
    if (e instanceof TRPCError && (e.code === "UNAUTHORIZED" || e.code === "TOO_MANY_REQUESTS")) noteFailure(kind, ip);
    throw e;
  }
}

/** Tests only. */
export function resetLimitsForTests() {
  buckets.clear();
}
