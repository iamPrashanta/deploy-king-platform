import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, permissionProcedure } from "../trpc";
import { db, cronJobs, cronRuns, sites, hostItems, users } from "@dbbkp/db";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { logAudit } from "@dbbkp/audit";
import { PERMISSIONS } from "../../utils/rbac";
import { requireSite, visibleSites } from "../../services/team";
import { preview, ScheduleError } from "../../services/schedule";
import { MAX_JOBS_PER_APP, applySchedule, checkJob, describeJob, removeSchedule, runNow, type JobInput } from "../../services/cronjobs";

// Scheduled jobs of an app: commands that run inside it on a schedule. Anyone who can see the app sees
// its jobs and their output; adding, changing, running and removing them needs the cron permission.

const jobFields = {
  name: z.string().trim().min(1).max(120),
  command: z.string().trim().min(1).max(2000),
  schedule: z.string().trim().min(1).max(100),
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  runIn: z.string().max(60).default("web"),
  timeoutSec: z.number().int().min(10).max(3600).default(600),
  notifyOnFailure: z.boolean().default(true),
};

const badSchedule = (e: unknown) => {
  if (e instanceof ScheduleError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
  throw e;
};

async function jobFor(ctx: any, id: string) {
  const [job] = await db.select().from(cronJobs).where(eq(cronJobs.id, id)).limit(1);
  const notFound = new TRPCError({ code: "NOT_FOUND", message: "Scheduled job not found" });
  if (!job) throw notFound;
  const site = await requireSite(ctx.user!, job.siteId).catch(() => { throw notFound; });
  return { job, site };
}

const audit = (ctx: any, action: "cron_create" | "cron_delete" | "cron_update" | "cron_run", job: { id: string; name: string; siteId: string }, metadata: Record<string, unknown> = {}) =>
  logAudit(action, { actorId: ctx.user!.sub, targetId: job.id, targetType: "cron", targetName: job.name, metadata: { siteId: job.siteId, ...metadata }, ip: ctx.ip ?? undefined });

export const cronRouter = router({
  /** Is this schedule valid, what does it mean, when would it run? For the editor, as the admin types. */
  preview: protectedProcedure.input(z.object({ schedule: z.string().max(100), timezone: z.string().max(64).default("UTC") })).query(({ input }) => preview(input.schedule, input.timezone)),

  list: protectedProcedure.input(z.object({ siteId: z.string().uuid() })).query(async ({ input, ctx }) => {
    await requireSite(ctx.user!, input.siteId);
    const rows = await db.select().from(cronJobs).where(eq(cronJobs.siteId, input.siteId)).orderBy(asc(cronJobs.createdAt));
    return rows.map(describeJob);
  }),

  runs: protectedProcedure.input(z.object({ jobId: z.string().uuid(), limit: z.number().int().min(1).max(100).default(24) })).query(async ({ input, ctx }) => {
    await jobFor(ctx, input.jobId);
    return db
      .select({ id: cronRuns.id, status: cronRuns.status, trigger: cronRuns.trigger, exitCode: cronRuns.exitCode, startedAt: cronRuns.startedAt, finishedAt: cronRuns.finishedAt, durationMs: cronRuns.durationMs, by: users.username })
      .from(cronRuns)
      .leftJoin(users, eq(users.id, cronRuns.triggeredBy))
      .where(eq(cronRuns.jobId, input.jobId))
      .orderBy(desc(cronRuns.startedAt))
      .limit(input.limit);
  }),

  /** One run, with its output. */
  run: protectedProcedure.input(z.object({ runId: z.string().uuid() })).query(async ({ input, ctx }) => {
    const [run] = await db.select().from(cronRuns).where(eq(cronRuns.id, input.runId)).limit(1);
    if (!run) throw new TRPCError({ code: "NOT_FOUND", message: "Run not found" });
    const { job } = await jobFor(ctx, run.jobId);
    const [by] = run.triggeredBy ? await db.select({ username: users.username }).from(users).where(eq(users.id, run.triggeredBy)).limit(1) : [];
    return { ...run, by: by?.username ?? null, job: describeJob(job) };
  }),

  create: permissionProcedure(PERMISSIONS.CRON_CREATE)
    .input(z.object({ siteId: z.string().uuid(), ...jobFields, runNow: z.boolean().default(false) }))
    .mutation(async ({ input, ctx }) => {
      const site = await requireSite(ctx.user!, input.siteId);
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(cronJobs).where(eq(cronJobs.siteId, site.id));
      if (n >= MAX_JOBS_PER_APP) throw new TRPCError({ code: "BAD_REQUEST", message: `An app can have at most ${MAX_JOBS_PER_APP} scheduled jobs.` });
      const { runNow: now, siteId, ...rest } = input;
      const fields = rest as JobInput;
      const schedule = await checkJob(site.id, fields).catch(badSchedule);
      const [job] = await db.insert(cronJobs).values({ ...fields, schedule: schedule!, siteId: site.id, active: true, createdBy: ctx.user!.sub }).returning();
      await applySchedule(job);
      if (now) await runNow(job.id, ctx.user!.sub);
      audit(ctx, "cron_create", job, { schedule: job.schedule, command: job.command });
      return describeJob(job);
    }),

  update: permissionProcedure(PERMISSIONS.CRON_CREATE)
    .input(z.object({ id: z.string().uuid(), ...jobFields }))
    .mutation(async ({ input, ctx }) => {
      const { job } = await jobFor(ctx, input.id);
      const { id, ...rest } = input;
      const fields = rest as JobInput;
      const schedule = await checkJob(job.siteId, fields).catch(badSchedule);
      const [next] = await db.update(cronJobs).set({ ...fields, schedule: schedule!, updatedAt: new Date() }).where(eq(cronJobs.id, job.id)).returning();
      await applySchedule(next);
      audit(ctx, "cron_update", next, { schedule: next.schedule, command: next.command, before: { schedule: job.schedule, command: job.command } });
      return describeJob(next);
    }),

  setActive: permissionProcedure(PERMISSIONS.CRON_CREATE).input(z.object({ id: z.string().uuid(), active: z.boolean() })).mutation(async ({ input, ctx }) => {
    const { job } = await jobFor(ctx, input.id);
    const [next] = await db.update(cronJobs).set({ active: input.active, updatedAt: new Date() }).where(eq(cronJobs.id, job.id)).returning();
    await applySchedule(next);
    audit(ctx, "cron_update", next, { active: input.active });
    return describeJob(next);
  }),

  runNow: permissionProcedure(PERMISSIONS.CRON_CREATE).input(z.object({ id: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    const { job } = await jobFor(ctx, input.id);
    await runNow(job.id, ctx.user!.sub);
    audit(ctx, "cron_run", job);
    return { queued: true };
  }),

  delete: permissionProcedure(PERMISSIONS.CRON_CREATE).input(z.object({ id: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    const { job } = await jobFor(ctx, input.id);
    await removeSchedule(job.id);
    await db.delete(cronJobs).where(eq(cronJobs.id, job.id));
    audit(ctx, "cron_delete", job, { schedule: job.schedule, command: job.command });
    return { success: true };
  }),

  /** Every job in the apps this user may see; for admins also the server's own, as the server watch found them. */
  all: protectedProcedure.query(async ({ ctx }) => {
    const limit = await visibleSites(ctx.user!);
    const mine = await db.select({ id: sites.id, domain: sites.domain }).from(sites).where(limit);
    const ids = mine.map((s) => s.id);
    const domain = new Map(mine.map((s) => [s.id, s.domain]));
    const jobs = ids.length ? await db.select().from(cronJobs).where(inArray(cronJobs.siteId, ids)).orderBy(asc(cronJobs.createdAt)) : [];
    const isAdmin = ctx.user!.role === "admin";
    const host = isAdmin
      ? await db
          .select({ id: hostItems.id, label: hostItems.label, detail: hostItems.detail, status: hostItems.status, severity: hostItems.severity, present: hostItems.present })
          .from(hostItems)
          .where(and(eq(hostItems.kind, "cron"), eq(hostItems.present, true)))
          .orderBy(asc(hostItems.label))
      : null;
    return {
      jobs: jobs.map((j) => ({ ...describeJob(j), domain: domain.get(j.siteId) ?? "" })),
      // null: not an admin. []: the server watch is not running or found none.
      host: host?.map((h) => ({ ...h, words: (h.detail as any)?.script ? `Every ${(h.detail as any).schedule.replace(/ly$/, "").replace("dai", "day")}` : (() => { const p = preview(String((h.detail as any)?.schedule ?? ""), "UTC"); return p.valid ? p.words : String((h.detail as any)?.schedule ?? ""); })() })) ?? null,
    };
  }),
});
