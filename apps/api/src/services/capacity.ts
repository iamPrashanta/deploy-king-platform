import os from "node:os";
import fs from "fs-extra";
import { TRPCError } from "@trpc/server";
import { db, platformSettings, sites, siteWorkers } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { SITES_ROOT } from "../config";

/**
 * Capacity ledger and "will it fit?".
 *
 * An app owns its memory limit from the moment it exists, running or not, so the ledger counts limits
 * ("reserved"), not what apps happen to use right now. A new app must pass two memory checks:
 *   promised - all limits together stay inside what the server may give out (usable memory x over-promise %)
 *   free now - the server has the app's full limit free at this moment, on top of the host reserve
 * and one disk check. Disk is never over-promised, and nothing builds on a disk that is 95% full.
 */

export const DEFAULT_APP_MEMORY_MB = 512;
/** A rough allowance for one new app's image and build cache until real sizes are measured. */
const NEW_APP_DISK_MB = 1024;
const DISK_FULL_PCT = 95;
const MB = 1024 * 1024;

export type CapacitySettings = {
  /** Share of memory kept for the platform itself (never less than 512 MB). */
  hostReservePct: number;
  /** How far app limits may add up, as a share of usable memory. 100 = strict. */
  overcommitPct: number;
  /** Disk kept free. null = automatic: 15% of the disk, between 2 and 10 GB. */
  diskReserveGb: number | null;
};

export const CAPACITY_DEFAULTS: CapacitySettings = { hostReservePct: 15, overcommitPct: 150, diskReserveGb: null };
export const CAPACITY_RANGE = { hostReservePct: [5, 60], overcommitPct: [100, 200], diskReserveGb: [1, 500] } as const;
const SETTINGS_KEY = "capacity";

const clamp = (n: unknown, [lo, hi]: readonly [number, number], fallback: number) => {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : fallback;
  return Math.min(hi, Math.max(lo, v));
};

function normalize(raw: Partial<CapacitySettings> | null | undefined): CapacitySettings {
  return {
    hostReservePct: clamp(raw?.hostReservePct, CAPACITY_RANGE.hostReservePct, CAPACITY_DEFAULTS.hostReservePct),
    overcommitPct: clamp(raw?.overcommitPct, CAPACITY_RANGE.overcommitPct, CAPACITY_DEFAULTS.overcommitPct),
    diskReserveGb: raw?.diskReserveGb == null ? null : clamp(raw.diskReserveGb, CAPACITY_RANGE.diskReserveGb, 10),
  };
}

export async function getCapacitySettings(): Promise<CapacitySettings> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, SETTINGS_KEY)).limit(1);
  return normalize(row?.value as Partial<CapacitySettings> | undefined);
}

export async function setCapacitySettings(patch: Partial<CapacitySettings>, userId: string): Promise<CapacitySettings> {
  const next = normalize({ ...(await getCapacitySettings()), ...patch });
  await db
    .insert(platformSettings)
    .values({ key: SETTINGS_KEY, value: next, updatedBy: userId })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value: next, updatedBy: userId, updatedAt: new Date() } });
  return next;
}

/** Memory the system could hand to a new program right now. Linux reports it directly; elsewhere fall back to "free". */
async function availableMemoryBytes(): Promise<number> {
  try {
    const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(await fs.readFile("/proc/meminfo", "utf8"));
    if (m) return Number(m[1]) * 1024;
  } catch {}
  return os.freemem();
}

async function diskOf(dir: string) {
  try {
    const st = await (fs as any).statfs(dir);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return null;
  }
}

export type Capacity = {
  memory: {
    totalMb: number;
    hostReserveMb: number;
    /** The most that app limits may add up to. */
    promiseLimitMb: number;
    /** Sum of the limits of every app that exists, and of their workers. */
    reservedMb: number;
    /** The part of reservedMb that workers hold. */
    workersMb: number;
    freeToPromiseMb: number;
    /** Free at this moment, after the host reserve. */
    freeNowMb: number;
  };
  disk: { totalMb: number; freeMb: number; reserveMb: number; usedPct: number } | null;
  apps: { count: number; typicalMb: number; roomFor: number };
  settings: CapacitySettings;
};

/**
 * `excludeSiteId` leaves one app out of the ledger (its workers stay), to ask "would this app fit with a new limit?".
 * `excludeWorkerId` leaves one worker out, to ask the same about a worker.
 */
export async function capacity(opts: { excludeSiteId?: string; excludeWorkerId?: string } = {}): Promise<Capacity> {
  const settings = await getCapacitySettings();
  const rows = await db.select({ id: sites.id, memoryLimit: sites.memoryLimit, active: sites.active, desiredStatus: sites.desiredStatus }).from(sites);
  // Everything that exists counts, except apps being deleted.
  const counted = rows.filter((s) => s.id !== opts.excludeSiteId && s.active !== false && s.desiredStatus !== "deleted");
  const countedIds = new Set(rows.filter((s) => s.active !== false && s.desiredStatus !== "deleted").map((s) => s.id));
  // Each copy of a worker holds its own limit, running or not, like an app.
  const workers = await db.select({ id: siteWorkers.id, siteId: siteWorkers.siteId, copies: siteWorkers.copies, memoryLimit: siteWorkers.memoryLimit }).from(siteWorkers).where(eq(siteWorkers.enabled, true));
  const workersMb = workers.filter((w) => w.id !== opts.excludeWorkerId && countedIds.has(w.siteId)).reduce((sum, w) => sum + Math.max(1, w.copies) * w.memoryLimit, 0);
  const reservedMb = counted.reduce((sum, s) => sum + (s.memoryLimit || DEFAULT_APP_MEMORY_MB), 0) + workersMb;

  const totalMb = Math.floor(os.totalmem() / MB);
  // The chosen share, and never less than 512 MB (or half of a very small server).
  const hostReserveMb = Math.max(Math.round((totalMb * settings.hostReservePct) / 100), Math.min(512, Math.floor(totalMb / 2)));
  const promiseLimitMb = Math.floor(((totalMb - hostReserveMb) * settings.overcommitPct) / 100);
  const freeNowMb = Math.floor((await availableMemoryBytes()) / MB) - hostReserveMb;

  const d = await diskOf(SITES_ROOT);
  let disk: Capacity["disk"] = null;
  if (d && d.total > 0) {
    const diskTotalMb = Math.floor(d.total / MB);
    const auto = Math.min(10 * 1024, Math.max(2 * 1024, Math.round(diskTotalMb * 0.15)));
    const reserveMb = Math.min(Math.floor(diskTotalMb / 2), settings.diskReserveGb == null ? auto : settings.diskReserveGb * 1024);
    disk = { totalMb: diskTotalMb, freeMb: Math.floor(d.free / MB), reserveMb, usedPct: Math.round(((d.total - d.free) / d.total) * 100) };
  }

  // "Room for N more" is always counted in default-sized apps, so the number means the same on every server.
  const typicalMb = DEFAULT_APP_MEMORY_MB;
  const freeToPromiseMb = promiseLimitMb - reservedMb;
  const byMemory = Math.floor(Math.min(freeToPromiseMb, freeNowMb) / typicalMb);
  const byDisk = disk ? Math.floor((disk.freeMb - disk.reserveMb) / NEW_APP_DISK_MB) : byMemory;

  return {
    memory: { totalMb, hostReserveMb, promiseLimitMb, reservedMb, workersMb, freeToPromiseMb, freeNowMb },
    disk,
    apps: { count: counted.length, typicalMb, roomFor: Math.max(0, Math.min(byMemory, byDisk)) },
    settings,
  };
}

/** 1536 -> "1.5 GB", 2048 -> "2 GB", 512 -> "512 MB" */
export const mem = (mb: number) => (Math.abs(mb) >= 1024 ? `${parseFloat((mb / 1024).toFixed(1))} GB` : `${Math.round(mb)} MB`);

export type FitNeed = {
  /** Memory limit the app will hold. 0 = it already holds its limit (a redeploy). */
  memoryMb: number;
  /** true for a brand-new app, which also needs room for its image. */
  newApp: boolean;
  /** true when the deploy will build or pull an image. */
  builds: boolean;
};

export type FitReason = { kind: "promised" | "free-now" | "disk" | "disk-full"; text: string };

export type Fit = {
  verdict: "fits" | "tight" | "blocked";
  /** false when nobody may deploy anyway (a full disk). */
  overridable: boolean;
  needMemoryMb: number;
  reasons: FitReason[];
  /** One line for the "tight" and "fits" cases. */
  note: string;
  suggestions: string[];
  after: { freeToPromiseMb: number; freeNowMb: number };
};

/** Pure: the same numbers always give the same verdict. */
export function evaluateFit(cap: Capacity, need: FitNeed): Fit {
  const reasons: FitReason[] = [];
  const suggestions: string[] = [];
  const { memory: m, disk } = cap;

  if (disk && need.builds && disk.usedPct >= DISK_FULL_PCT) {
    reasons.push({ kind: "disk-full", text: `The disk is ${disk.usedPct}% full. Nothing is deployed until space is freed, because a full disk breaks the database and every running app.` });
  } else if (disk && need.newApp && disk.freeMb - NEW_APP_DISK_MB < disk.reserveMb) {
    reasons.push({ kind: "disk", text: `Only ${mem(disk.freeMb)} of disk is free, and ${mem(disk.reserveMb)} is kept in reserve. A new app needs about ${mem(NEW_APP_DISK_MB)}.` });
  }
  if (reasons.length) suggestions.push("Free disk space: delete apps, storage or images you no longer need.");

  if (need.memoryMb > 0) {
    if (need.memoryMb > m.freeToPromiseMb) {
      reasons.push({
        kind: "promised",
        text: `It needs ${mem(need.memoryMb)}, but only ${mem(Math.max(0, m.freeToPromiseMb))} can still be promised: apps already hold ${mem(m.reservedMb)} of the ${mem(m.promiseLimitMb)} this server gives out.`,
      });
    }
    if (need.memoryMb > m.freeNowMb) {
      reasons.push({
        kind: "free-now",
        text: `It needs ${mem(need.memoryMb)} free right now, but the server has ${mem(Math.max(0, m.freeNowMb))} to spare after its own reserve of ${mem(m.hostReserveMb)}.`,
      });
    }
    if (reasons.some((r) => r.kind === "promised" || r.kind === "free-now")) {
      const room = Math.floor(Math.min(m.freeToPromiseMb, m.freeNowMb) / 64) * 64;
      if (room >= 64) suggestions.push(`Give this app a memory limit of ${mem(room)} or less.`);
      suggestions.push("Stop or delete an app you no longer need, or lower the limit of one that never reaches it.");
    }
  }

  const after = { freeToPromiseMb: m.freeToPromiseMb - need.memoryMb, freeNowMb: m.freeNowMb - need.memoryMb };
  const base = { needMemoryMb: need.memoryMb, suggestions, after };
  if (reasons.length) {
    return { ...base, verdict: "blocked", overridable: !reasons.some((r) => r.kind === "disk-full"), reasons, note: "" };
  }
  const left = Math.min(after.freeToPromiseMb, after.freeNowMb);
  if (need.memoryMb > 0 && left < cap.apps.typicalMb) {
    return { ...base, verdict: "tight", overridable: true, reasons, note: `It fits, but only ${mem(Math.max(0, left))} is left for other apps afterwards.` };
  }
  return { ...base, verdict: "fits", overridable: true, reasons, note: need.memoryMb > 0 ? `It fits. ${mem(left)} stays free for other apps.` : "" };
}

type Actor = { user?: { sub: string; role: string } | null; apiToken?: unknown };

/** The server owner, signed in to the panel. Other users and AI agent tokens can never deploy past a block. */
export const canOverrideCapacity = (ctx: Actor) => ctx.user?.role === "admin" && !ctx.apiToken;

/**
 * Throws unless the app fits, or the owner chose to deploy anyway.
 * Returns the fit, with `overridden: true` when a block was passed on purpose (the caller writes the audit entry).
 */
export async function assertFits(ctx: Actor, need: FitNeed, opts: { excludeSiteId?: string; excludeWorkerId?: string; override?: boolean } = {}): Promise<Fit & { overridden: boolean }> {
  const fit = evaluateFit(await capacity({ excludeSiteId: opts.excludeSiteId, excludeWorkerId: opts.excludeWorkerId }), need);
  if (fit.verdict !== "blocked") return { ...fit, overridden: false };
  if (opts.override && fit.overridable && canOverrideCapacity(ctx)) return { ...fit, overridden: true };
  const tail = opts.override && !canOverrideCapacity(ctx) ? " Only the server owner can deploy anyway, from the panel." : "";
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `This does not fit on the server. ${fit.reasons.map((r) => r.text).join(" ")}${fit.suggestions.length ? " " + fit.suggestions[0] : ""}${tail}`,
  });
}
