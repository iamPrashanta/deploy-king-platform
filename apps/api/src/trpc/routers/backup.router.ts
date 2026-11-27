import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db, backups, backupDestinations, backupPolicies, backupRestores, dbInstances, sites, type Backup, type BackupDestination } from "@dbbkp/db";
import { logAudit } from "@dbbkp/audit";
import {
  DESTINATION_KINDS, checkDestination, ensureLocalDestination, kindLabel, locationProblem, restoreCopyName, restoreFolderName,
} from "@dbbkp/backup";
import { router, adminProcedure, protectedProcedure, permissionProcedure } from "../trpc";
import { PERMISSIONS } from "../../utils/rbac";
import { backupQueue } from "../../queues";
import { preview } from "../../services/schedule";
import {
  applyPolicySchedule, describePolicy, queueBackup, queueRestore, removePolicySchedule, requireTarget, requireTargetKey, seesRow, targetInput, visibleSiteIds,
} from "../../services/backups";

/**
 * Backups: history, schedules, destinations and restores (panel: Data · Backups, the Restore dialog).
 * Everyone signed in sees the backups of the apps they can see. Making one needs backup.run (developers have it);
 * restoring needs backup.restore (an extra for developers). Destinations are server-wide, so only admins change them.
 */

const audit = (ctx: any, action: "backup_run" | "backup_restore" | "backup_policy" | "backup_destination", target: { id?: string | null; type: string; name: string }, metadata: Record<string, unknown> = {}) =>
  logAudit(action, { actorId: ctx.user!.sub, targetId: target.id ?? undefined, targetType: target.type, targetName: target.name, metadata, ip: ctx.ip ?? undefined });

const live = (c: { ok: boolean; removedAt?: string }) => c.ok && !c.removedAt;

/** A backup as the panel shows it. Locations at destinations stay on the server. */
function view(b: Backup) {
  return {
    id: b.id, targetKey: b.targetKey, targetType: b.targetType, targetName: b.targetName, engine: b.engine, kind: kindLabel(b.engine, b.volumeName),
    dbInstanceId: b.dbInstanceId, siteId: b.siteId, volumeName: b.volumeName, trigger: b.trigger, status: b.status, attempts: b.attempts,
    fileName: b.fileName, sizeBytes: b.sizeBytes, sha256: b.sha256, durationMs: b.durationMs, error: b.error,
    copies: b.copies.map((c) => ({ destinationId: c.destinationId, name: c.name, kind: c.kind, ok: c.ok, verified: c.verified, error: c.error ?? null, removed: !!c.removedAt })),
    restorable: (b.status === "ok" || b.status === "partial") && !!b.sha256 && b.copies.some(live),
    createdAt: b.createdAt, startedAt: b.startedAt, finishedAt: b.finishedAt,
  };
}

async function visibleBackups(ctx: any, where?: any, limit = 200) {
  const ids = await visibleSiteIds(ctx.user!);
  const rows = await db.select().from(backups).where(where).orderBy(desc(backups.createdAt)).limit(limit * 3);
  return rows.filter((b) => seesRow(ctx.user!, ids, b.siteId)).slice(0, limit);
}

const policyInput = z.object({
  target: targetInput,
  schedule: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64).default("UTC"),
  keep: z.number().int().min(1).max(365),
  destinationIds: z.array(z.string().uuid()).min(1, "Choose at least one destination.").max(10),
  enabled: z.boolean().default(true),
});

export const backupRouter = router({
  // ── Overview and history ──────────────────────────────────────────────────
  overview: protectedProcedure.query(async ({ ctx }) => {
    const ids = await visibleSiteIds(ctx.user!);
    const since = new Date(Date.now() - 24 * 3600_000);
    const recent = (await db.select().from(backups).where(gte(backups.createdAt, since))).filter((b) => seesRow(ctx.user!, ids, b.siteId) && b.status !== "queued" && b.status !== "running");
    const failed = recent.filter((b) => b.status === "failed");
    const all = (await db.select().from(backups).where(inArray(backups.status, ["ok", "partial"]))).filter((b) => seesRow(ctx.user!, ids, b.siteId));
    const copies = all.flatMap((b) => b.copies.filter(live).map((c) => ({ ...c, bytes: b.sizeBytes ?? 0 })));
    const policies = (await db.select().from(backupPolicies)).filter((p) => seesRow(ctx.user!, ids, p.siteId)).map((p) => describePolicy(p, []));
    const upcoming = policies.filter((p) => p.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt!) - Date.parse(b.nextRunAt!));
    const first = upcoming[0]?.nextRunAt ?? null;
    return {
      last24h: { done: recent.length, ok: recent.filter((b) => b.status === "ok").length, partial: recent.filter((b) => b.status === "partial").length, failed: failed.length, failedNames: [...new Set(failed.map((b) => b.targetName))] },
      storedBytes: copies.reduce((n, c) => n + c.bytes, 0),
      destinations: new Set(copies.map((c) => c.destinationId)).size,
      checksums: { copies: copies.length, verified: copies.filter((c) => c.verified).length },
      nextRun: first ? { at: first, sameDay: upcoming.filter((p) => new Date(p.nextRunAt!).toDateString() === new Date(first).toDateString()).length } : null,
    };
  }),

  history: protectedProcedure
    .input(z.object({ kind: z.enum(["all", "database", "volume"]).default("all"), targetKey: z.string().max(200).optional(), limit: z.number().int().min(1).max(200).default(50) }).default({}))
    .query(async ({ ctx, input }) => {
      const where = and(input.kind !== "all" ? eq(backups.targetType, input.kind) : undefined, input.targetKey ? eq(backups.targetKey, input.targetKey) : undefined);
      return (await visibleBackups(ctx, where, input.limit)).map(view);
    }),

  /** For the Restore dialog: the target and its backups that can be restored. */
  restorable: protectedProcedure.input(z.object({ target: targetInput })).query(async ({ ctx, input }) => {
    const t = await requireTarget(ctx.user!, input.target);
    const rows = await db.select().from(backups).where(eq(backups.targetKey, t.key)).orderBy(desc(backups.createdAt)).limit(100);
    const [site] = t.siteId ? await db.select({ domain: sites.domain }).from(sites).where(eq(sites.id, t.siteId)).limit(1) : [];
    const taken = new Set((await db.select({ name: dbInstances.name }).from(dbInstances)).map((r) => r.name));
    return {
      target: { key: t.key, type: t.type, name: t.name, engine: t.engine, kind: kindLabel(t.engine, t.volume), app: site ? { id: t.siteId, name: site.domain.split(".")[0], domain: site.domain } : null, external: !!t.external },
      newName: t.type === "database" ? restoreCopyName(t.name, new Date(), (n) => taken.has(n)) : restoreFolderName(new Date()),
      restoreAvailable: t.engine === "pgsql" || t.engine === "files",
      backups: rows.map(view).filter((b) => b.restorable).slice(0, 30),
    };
  }),

  // ── Making backups ────────────────────────────────────────────────────────
  runNow: permissionProcedure(PERMISSIONS.BACKUP_RUN).input(z.object({ target: targetInput })).mutation(async ({ ctx, input }) => {
    const t = await requireTarget(ctx.user!, input.target);
    if (t.engine === "mysql") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MySQL backups are not available yet." });
    const busy = await db.select({ id: backups.id }).from(backups).where(and(eq(backups.targetKey, t.key), inArray(backups.status, ["queued", "running"]))).limit(1);
    if (busy.length) throw new TRPCError({ code: "CONFLICT", message: `A backup of ${t.name} is already running.` });
    const b = await queueBackup(t, "manual", ctx.user!.sub);
    audit(ctx, "backup_run", { id: b.id, type: t.type, name: t.name }, { targetKey: t.key, siteId: t.siteId });
    return view(b);
  }),

  retry: permissionProcedure(PERMISSIONS.BACKUP_RUN).input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [old] = await db.select().from(backups).where(eq(backups.id, input.id)).limit(1);
    if (!old) throw new TRPCError({ code: "NOT_FOUND", message: "Backup not found" });
    const t = await requireTargetKey(ctx.user!, old.targetKey);
    const busy = await db.select({ id: backups.id }).from(backups).where(and(eq(backups.targetKey, t.key), inArray(backups.status, ["queued", "running"]))).limit(1);
    if (busy.length) throw new TRPCError({ code: "CONFLICT", message: `A backup of ${t.name} is already running.` });
    const b = await queueBackup(t, "retry", ctx.user!.sub);
    audit(ctx, "backup_run", { id: b.id, type: t.type, name: t.name }, { targetKey: t.key, retryOf: old.id });
    return view(b);
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [b] = await db.select().from(backups).where(eq(backups.id, input.id)).limit(1);
    if (!b || !seesRow(ctx.user!, await visibleSiteIds(ctx.user!), b.siteId)) throw new TRPCError({ code: "NOT_FOUND", message: "Backup not found" });
    return view(b);
  }),

  // ── Schedules ─────────────────────────────────────────────────────────────
  policies: protectedProcedure.query(async ({ ctx }) => {
    const ids = await visibleSiteIds(ctx.user!);
    const dests = new Map((await db.select().from(backupDestinations)).map((d) => [d.id, d.name]));
    const rows = (await db.select().from(backupPolicies).orderBy(backupPolicies.createdAt)).filter((p) => seesRow(ctx.user!, ids, p.siteId));
    const names = new Map<string, string>();
    const dbIds = rows.map((r) => r.dbInstanceId).filter(Boolean) as string[];
    if (dbIds.length) for (const d of await db.select({ id: dbInstances.id, name: dbInstances.name }).from(dbInstances).where(inArray(dbInstances.id, dbIds))) names.set(`db:${d.id}`, d.name);
    const siteIds = rows.map((r) => r.siteId).filter(Boolean) as string[];
    const domains = new Map(siteIds.length ? (await db.select({ id: sites.id, domain: sites.domain }).from(sites).where(inArray(sites.id, siteIds))).map((s) => [s.id, s.domain.split(".")[0]]) : []);
    return rows.map((p) => ({
      ...describePolicy(p, p.destinationIds.map((id) => dests.get(id)).filter(Boolean) as string[]),
      targetName: p.targetType === "database" ? names.get(p.targetKey) ?? "database" : `${domains.get(p.siteId!) ?? "app"} · ${p.volumeName}`,
    }));
  }),

  policyFor: protectedProcedure.input(z.object({ target: targetInput })).query(async ({ ctx, input }) => {
    const t = await requireTarget(ctx.user!, input.target);
    const [p] = await db.select().from(backupPolicies).where(eq(backupPolicies.targetKey, t.key)).limit(1);
    if (!p) return null;
    const dests = new Map((await db.select().from(backupDestinations)).map((d) => [d.id, d.name]));
    return describePolicy(p, p.destinationIds.map((id) => dests.get(id)).filter(Boolean) as string[]);
  }),

  savePolicy: permissionProcedure(PERMISSIONS.BACKUP_RUN).input(policyInput).mutation(async ({ ctx, input }) => {
    const t = await requireTarget(ctx.user!, input.target);
    if (t.engine === "mysql") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MySQL backups are not available yet." });
    const pv = preview(input.schedule, input.timezone);
    if (!pv.valid) throw new TRPCError({ code: "BAD_REQUEST", message: pv.error });
    const found = await db.select({ id: backupDestinations.id }).from(backupDestinations).where(inArray(backupDestinations.id, input.destinationIds));
    if (found.length !== new Set(input.destinationIds).size) throw new TRPCError({ code: "BAD_REQUEST", message: "One of the destinations does not exist any more." });
    const values = {
      targetKey: t.key, targetType: t.type, dbInstanceId: t.instance?.id ?? null, siteId: t.siteId, volumeName: t.volume ?? null,
      schedule: pv.cron, timezone: input.timezone, keep: input.keep, destinationIds: [...new Set(input.destinationIds)], enabled: input.enabled, updatedAt: new Date(),
    };
    const [before] = await db.select().from(backupPolicies).where(eq(backupPolicies.targetKey, t.key)).limit(1);
    const [p] = before
      ? await db.update(backupPolicies).set(values).where(eq(backupPolicies.id, before.id)).returning()
      : await db.insert(backupPolicies).values({ ...values, createdBy: ctx.user!.sub }).returning();
    await applyPolicySchedule(p!);
    audit(ctx, "backup_policy", { id: p!.id, type: t.type, name: t.name }, { schedule: p!.schedule, timezone: p!.timezone, keep: p!.keep, destinationIds: p!.destinationIds, enabled: p!.enabled, ...(before ? { before: { schedule: before.schedule, keep: before.keep, destinationIds: before.destinationIds, enabled: before.enabled } } : {}) });
    return describePolicy(p!, []);
  }),

  setPolicyEnabled: permissionProcedure(PERMISSIONS.BACKUP_RUN).input(z.object({ id: z.string().uuid(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const [p] = await db.select().from(backupPolicies).where(eq(backupPolicies.id, input.id)).limit(1);
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Schedule not found" });
    const t = await requireTargetKey(ctx.user!, p.targetKey);
    const [next] = await db.update(backupPolicies).set({ enabled: input.enabled, updatedAt: new Date() }).where(eq(backupPolicies.id, p.id)).returning();
    await applyPolicySchedule(next!);
    audit(ctx, "backup_policy", { id: p.id, type: t.type, name: t.name }, { enabled: input.enabled });
    return { ok: true };
  }),

  deletePolicy: permissionProcedure(PERMISSIONS.BACKUP_RUN).input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [p] = await db.select().from(backupPolicies).where(eq(backupPolicies.id, input.id)).limit(1);
    if (!p) throw new TRPCError({ code: "NOT_FOUND", message: "Schedule not found" });
    const t = await requireTargetKey(ctx.user!, p.targetKey);
    await removePolicySchedule(p.id);
    await db.delete(backupPolicies).where(eq(backupPolicies.id, p.id));
    audit(ctx, "backup_policy", { id: p.id, type: t.type, name: t.name }, { removed: true, schedule: p.schedule });
    return { ok: true };
  }),

  // ── Destinations ──────────────────────────────────────────────────────────
  destinations: protectedProcedure.query(async ({ ctx }) => {
    await ensureLocalDestination();
    const ids = await visibleSiteIds(ctx.user!);
    const rows = await db.select().from(backupDestinations).orderBy(desc(backupDestinations.builtIn), backupDestinations.createdAt);
    const stored = (await db.select().from(backups).where(inArray(backups.status, ["ok", "partial"]))).filter((b) => seesRow(ctx.user!, ids, b.siteId));
    const isAdmin = ctx.user!.role === "admin";
    return {
      kinds: DESTINATION_KINDS.map((k) => ({ ...k })),
      destinations: rows.map((d: BackupDestination) => ({
        id: d.id, name: d.name, kind: d.kind, builtIn: d.builtIn, keepLast: d.keepLast,
        // where it is says something about the server's set-up; members see the name only
        location: isAdmin ? d.location : null,
        usedBytes: stored.reduce((n, b) => n + (b.copies.some((c) => live(c) && c.destinationId === d.id) ? b.sizeBytes ?? 0 : 0), 0),
        lastCheckAt: d.lastCheckAt, lastCheckOk: d.lastCheckOk, lastCheckMessage: d.lastCheckMessage,
      })),
    };
  }),

  addDestination: adminProcedure
    .input(z.object({ name: z.string().trim().min(1).max(100), kind: z.string().max(20), location: z.string().trim().min(1).max(300), keepLast: z.number().int().min(1).max(365).nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      const problem = locationProblem(input.kind, input.location);
      if (problem) throw new TRPCError({ code: "BAD_REQUEST", message: problem });
      const check = await checkDestination({ id: "new", name: input.name, kind: input.kind, location: input.location, keepLast: input.keepLast });
      if (!check.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: `Could not use it: ${check.message}` });
      const [d] = await db.insert(backupDestinations).values({ name: input.name, kind: input.kind, location: input.location, keepLast: input.keepLast, createdBy: ctx.user!.sub, lastCheckAt: new Date(), lastCheckOk: true, lastCheckMessage: check.message }).returning();
      audit(ctx, "backup_destination", { id: d!.id, type: "backup_destination", name: d!.name }, { kind: d!.kind, location: d!.location, keepLast: d!.keepLast });
      return d!;
    }),

  updateDestination: adminProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().trim().min(1).max(100), keepLast: z.number().int().min(1).max(365).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const [before] = await db.select().from(backupDestinations).where(eq(backupDestinations.id, input.id)).limit(1);
      if (!before) throw new TRPCError({ code: "NOT_FOUND", message: "Destination not found" });
      const [d] = await db.update(backupDestinations).set({ name: input.name, keepLast: input.keepLast }).where(eq(backupDestinations.id, input.id)).returning();
      audit(ctx, "backup_destination", { id: d!.id, type: "backup_destination", name: d!.name }, { keepLast: d!.keepLast, before: { name: before.name, keepLast: before.keepLast } });
      return d!;
    }),

  checkDestination: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [d] = await db.select().from(backupDestinations).where(eq(backupDestinations.id, input.id)).limit(1);
    if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Destination not found" });
    const r = await checkDestination(d);
    await db.update(backupDestinations).set({ lastCheckAt: new Date(), lastCheckOk: r.ok, lastCheckMessage: r.message }).where(eq(backupDestinations.id, d.id));
    audit(ctx, "backup_destination", { id: d.id, type: "backup_destination", name: d.name }, { checked: true, ok: r.ok });
    return r;
  }),

  removeDestination: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const [d] = await db.select().from(backupDestinations).where(eq(backupDestinations.id, input.id)).limit(1);
    if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Destination not found" });
    if (d.builtIn) throw new TRPCError({ code: "BAD_REQUEST", message: "This server is always a destination; set how many it keeps instead." });
    // Schedules stop copying there; files already there are left in place.
    for (const p of await db.select().from(backupPolicies)) {
      if (p.destinationIds.includes(d.id)) await db.update(backupPolicies).set({ destinationIds: p.destinationIds.filter((x) => x !== d.id) }).where(eq(backupPolicies.id, p.id));
    }
    await db.delete(backupDestinations).where(eq(backupDestinations.id, d.id));
    audit(ctx, "backup_destination", { id: d.id, type: "backup_destination", name: d.name }, { removed: true, kind: d.kind, location: d.location });
    return { ok: true };
  }),

  // ── Restores ──────────────────────────────────────────────────────────────
  restore: permissionProcedure(PERMISSIONS.BACKUP_RESTORE)
    .input(z.object({
      backupId: z.string().uuid(),
      mode: z.enum(["full", "data"]),
      into: z.enum(["new", "replace"]),
      verifyChecksum: z.boolean().default(true),
      safetyBackup: z.boolean().default(true),
      stopApp: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const [b] = await db.select().from(backups).where(eq(backups.id, input.backupId)).limit(1);
      if (!b) throw new TRPCError({ code: "NOT_FOUND", message: "Backup not found" });
      const t = await requireTargetKey(ctx.user!, b.targetKey);
      if (!view(b).restorable) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This backup has no copy left to restore from." });
      if (t.engine === "mysql") throw new TRPCError({ code: "PRECONDITION_FAILED", message: "MySQL restores are not available yet." });
      if (input.mode === "data" && (input.into === "new" || t.type === "volume")) throw new TRPCError({ code: "BAD_REQUEST", message: t.type === "volume" ? "Files are always restored in full." : "A new copy has no schema yet, so it always gets a full restore." });
      if (input.stopApp && !t.siteId) throw new TRPCError({ code: "BAD_REQUEST", message: "This database belongs to no app, so there is no app to stop." });
      const busy = await db.select({ id: backupRestores.id }).from(backupRestores).where(and(eq(backupRestores.targetKey, t.key), inArray(backupRestores.status, ["queued", "running"]))).limit(1);
      if (busy.length) throw new TRPCError({ code: "CONFLICT", message: `A restore of ${t.name} is already running.` });
      let newName: string | null = null;
      if (input.into === "new") {
        if (t.type === "database") {
          const taken = new Set((await db.select({ name: dbInstances.name }).from(dbInstances)).map((r) => r.name));
          newName = restoreCopyName(t.name, new Date(), (n) => taken.has(n));
        } else newName = restoreFolderName(new Date());
      }
      const [r] = await db.insert(backupRestores).values({
        backupId: b.id, targetKey: t.key, targetName: t.name, mode: input.mode, into: input.into, newName,
        verifyChecksum: input.verifyChecksum, safetyBackup: input.into === "replace" && input.safetyBackup, stopApp: input.stopApp, createdBy: ctx.user!.sub,
      }).returning();
      await queueRestore(r!.id);
      audit(ctx, "backup_restore", { id: r!.id, type: t.type, name: t.name }, { backupId: b.id, backupFile: b.fileName, mode: input.mode, into: input.into, newName, verifyChecksum: input.verifyChecksum, safetyBackup: r!.safetyBackup, stopApp: input.stopApp });
      return r!;
    }),

  restoreStatus: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [r] = await db.select().from(backupRestores).where(eq(backupRestores.id, input.id)).limit(1);
    if (!r) throw new TRPCError({ code: "NOT_FOUND", message: "Restore not found" });
    await requireTargetKey(ctx.user!, r.targetKey);
    return r;
  }),

  restores: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(100).default(20) }).default({})).query(async ({ ctx, input }) => {
    const ids = await visibleSiteIds(ctx.user!);
    const rows = await db.select({ r: backupRestores, siteId: backups.siteId }).from(backupRestores).innerJoin(backups, eq(backups.id, backupRestores.backupId)).orderBy(desc(backupRestores.createdAt)).limit(input.limit * 3);
    return rows.filter((x) => seesRow(ctx.user!, ids, x.siteId)).slice(0, input.limit).map((x) => x.r);
  }),

  // ── Older procedures (the Vite UI and the dbbkp script) ───────────────────
  pgsql: adminProcedure
    .input(z.object({
      DB_HOST: z.string().default("localhost"),
      DB_USER: z.string(),
      DB_PASS: z.string(),
      DB_NAME: z.string(),
    }))
    .mutation(async ({ input }) => {
      const job = await backupQueue.add("pgsql-backup", { db: input });
      return { jobId: job.id };
    }),

  seed: adminProcedure
    .input(z.object({ engine: z.enum(["pgsql"]).default("pgsql") }))
    .mutation(async ({ input }) => {
      const job = await backupQueue.add("pgsql-seed", { engine: input.engine });
      return { jobId: job.id };
    }),
});

