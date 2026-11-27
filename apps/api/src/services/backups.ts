import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { inArray } from "drizzle-orm";
import { db, backupPolicies, sites, type BackupPolicy } from "@dbbkp/db";
import { createBackup, describeTarget, parseTargetKey, TargetGone, type Target, type TargetRef } from "@dbbkp/backup";
import { backupQueue } from "../queues";
import { requireSite, visibleSites } from "./team";
import { describe, nextRuns, parseCron } from "./schedule";

/**
 * Backups as the API sees them: who may reach which database or volume, and putting work on the "backup" queue.
 * The work itself is done by the worker with @dbbkp/backup (apps/worker/src/index.ts).
 * Schedules live in BullMQ as repeatable jobs with the id backup-policy-<id>.
 */

type Viewer = { sub: string; role: string };

export const targetInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("database"), id: z.string().uuid() }),
  z.object({ type: z.literal("volume"), siteId: z.string().uuid(), volume: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/) }),
]);

/** The database or volume, if this user may see it. "Not found" otherwise, so nobody learns which ids exist. */
export async function requireTarget(user: Viewer, input: z.infer<typeof targetInput> | TargetRef): Promise<Target> {
  const ref = input as TargetRef;
  let t: Target;
  try {
    t = await describeTarget(ref);
  } catch (e) {
    if (e instanceof TargetGone) throw new TRPCError({ code: "NOT_FOUND", message: e.message });
    throw e;
  }
  if (user.role === "admin") return t;
  // A database that belongs to no app is the admins' alone.
  if (!t.siteId) throw new TRPCError({ code: "NOT_FOUND", message: ref.type === "database" ? "Database not found" : "Volume not found" });
  await requireSite(user, t.siteId);
  return t;
}

export async function requireTargetKey(user: Viewer, key: string) {
  const ref = parseTargetKey(key);
  if (!ref) throw new TRPCError({ code: "NOT_FOUND", message: "Not found" });
  return requireTarget(user, ref);
}

/** The apps this user may see; null means every app (admins, and members given every app). */
export async function visibleSiteIds(user: Viewer): Promise<string[] | null> {
  if (user.role === "admin") return null;
  const limit = await visibleSites(user);
  if (!limit) return null;
  return (await db.select({ id: sites.id }).from(sites).where(limit)).map((s) => s.id);
}

/** Whether a row that belongs to `siteId` (null: no app) may be shown to this user. */
export function seesRow(user: Viewer, ids: string[] | null, siteId: string | null | undefined) {
  if (user.role === "admin") return true;
  if (!siteId) return false;
  return ids === null || ids.includes(siteId);
}

export async function queueBackup(target: Target, trigger: "manual" | "retry", userId: string) {
  const b = await createBackup(target, trigger, userId);
  await backupQueue.add("run-backup", { backupId: b.id }, { removeOnComplete: 200, removeOnFail: 200 });
  return b;
}

export async function queueRestore(restoreId: string) {
  await backupQueue.add("run-restore", { restoreId }, { removeOnComplete: 200, removeOnFail: 200 });
}

// ─── Schedules ────────────────────────────────────────────────────────────────

const repeatId = (id: string) => `backup-policy-${id}`;

async function dropPolicySchedule(id: string) {
  for (const r of await backupQueue.getRepeatableJobs()) if (r.id === repeatId(id)) await backupQueue.removeRepeatableByKey(r.key);
}
export const removePolicySchedule = dropPolicySchedule;

export async function applyPolicySchedule(p: Pick<BackupPolicy, "id" | "schedule" | "timezone" | "enabled">) {
  await dropPolicySchedule(p.id);
  if (!p.enabled) return;
  await backupQueue.add("scheduled-backup", { policyId: p.id }, { repeat: { pattern: p.schedule, tz: p.timezone || "UTC" }, jobId: repeatId(p.id), removeOnComplete: 50, removeOnFail: 50 });
}

/** At start-up: every enabled schedule is in the queue, and nothing else is. */
export async function syncBackupSchedules() {
  const rows = await db.select().from(backupPolicies);
  const want = new Map(rows.filter((p) => p.enabled).map((p) => [repeatId(p.id), p]));
  for (const r of await backupQueue.getRepeatableJobs()) {
    if (r.name !== "scheduled-backup") continue;
    const p = r.id ? want.get(r.id) : undefined;
    if (!p || r.pattern !== p.schedule || (r.tz || "UTC") !== (p.timezone || "UTC")) await backupQueue.removeRepeatableByKey(r.key);
  }
  const left = new Set((await backupQueue.getRepeatableJobs()).map((r) => r.id));
  let added = 0;
  for (const [rid, p] of want) {
    if (left.has(rid)) continue;
    try {
      parseCron(p.schedule);
      await applyPolicySchedule(p);
      added++;
    } catch {
      // a schedule this version refuses stays off until someone edits it
    }
  }
  return { policies: rows.length, added };
}

/** "Every day at 02:00 · keep 14", and when it runs next. */
export function describePolicy(p: BackupPolicy, destinationNames: string[]) {
  let words = "Custom schedule";
  let nextRunAt: string | null = null;
  try {
    const c = parseCron(p.schedule);
    words = describe(c);
    const n = nextRuns(c, p.timezone || "UTC", Date.now(), 1)[0];
    nextRunAt = n ? new Date(n).toISOString() : null;
  } catch {
    // shown as a custom schedule
  }
  return {
    id: p.id, targetKey: p.targetKey, targetType: p.targetType, dbInstanceId: p.dbInstanceId, siteId: p.siteId, volumeName: p.volumeName,
    schedule: p.schedule, timezone: p.timezone, keep: p.keep, destinationIds: p.destinationIds, enabled: p.enabled,
    words, nextRunAt: p.enabled ? nextRunAt : null, destinations: destinationNames,
  };
}

export async function policiesByKey(keys: string[]) {
  if (!keys.length) return new Map<string, BackupPolicy>();
  const rows = await db.select().from(backupPolicies).where(inArray(backupPolicies.targetKey, keys));
  return new Map(rows.map((p) => [p.targetKey, p]));
}
