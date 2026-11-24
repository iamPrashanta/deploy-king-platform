import { z } from "zod";
import Docker from "dockerode";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, permissionProcedure } from "../trpc";
import { db, siteWorkers, cronJobs } from "@dbbkp/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { logAudit } from "@dbbkp/audit";
import { PERMISSIONS } from "../../utils/rbac";
import { requireSite } from "../../services/team";
import { assertFits, canOverrideCapacity, capacity, evaluateFit } from "../../services/capacity";
import { hostingQueue } from "../../queues";
import { demuxLogs } from "../../services/validation";

// Workers: background processes of an app, from the same image and with the same variables, without web
// traffic. Each copy holds its memory limit in the capacity ledger, like an app.

const docker = new Docker();
const MAX_WORKERS = 10;
const NAME = /^[a-z][a-z0-9-]{0,29}$/;

const fields = {
  command: z.string().trim().min(1).max(2000),
  copies: z.number().int().min(1).max(8).default(1),
  memoryLimit: z.number().int().min(64).max(16384).default(256),
  restart: z.boolean().default(true),
  gracefulStop: z.boolean().default(true),
  enabled: z.boolean().default(true),
};

const sync = (siteId: string) => hostingQueue.add("sync-workers", { siteId }, { removeOnComplete: true, removeOnFail: 50 });

type Live = { id: string; name: string; copy: number; state: string; running: boolean; crashing: boolean; outOfMemory: boolean; restarts: number; startedAt: string | null; memoryMb: number | null; spec: string | null };

const within = <T>(p: Promise<T>, ms: number, fallback: T) => Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** The worker containers of an app, with how they are doing. */
async function liveWorkers(siteId: string): Promise<Live[]> {
  const list = await docker.listContainers({ all: true, filters: { label: [`dbbkp.site=${siteId}`, "dbbkp.role=worker"] } }).catch(() => []);
  return Promise.all(
    list.map(async (c) => {
      const ct = docker.getContainer(c.Id);
      const info: any = await within(ct.inspect(), 3000, null);
      const stats: any = c.State === "running" ? await within(ct.stats({ stream: false }) as Promise<any>, 3000, null) : null;
      const restarts = Number(info?.RestartCount ?? 0);
      const started = info?.State?.StartedAt ? Date.parse(info.State.StartedAt) : NaN;
      const cache = stats?.memory_stats?.stats?.inactive_file ?? stats?.memory_stats?.stats?.cache ?? 0;
      return {
        id: c.Id,
        name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""),
        worker: c.Labels?.["dbbkp.worker"] ?? "",
        copy: Number(c.Labels?.["dbbkp.copy"] ?? 0),
        state: c.State,
        running: c.State === "running",
        // Restarting right now, or restarted three times in its last ten minutes of life.
        crashing: c.State === "restarting" || (restarts >= 3 && Number.isFinite(started) && Date.now() - started < 10 * 60_000),
        outOfMemory: !!info?.State?.OOMKilled,
        restarts,
        startedAt: info?.State?.StartedAt ?? null,
        memoryMb: stats?.memory_stats?.usage ? Math.round((stats.memory_stats.usage - cache) / 1024 / 1024) : null,
        spec: c.Labels?.["dbbkp.spec"] ?? null,
      } as Live & { worker: string };
    })
  );
}

async function workerFor(ctx: any, id: string) {
  const [w] = await db.select().from(siteWorkers).where(eq(siteWorkers.id, id)).limit(1);
  const notFound = new TRPCError({ code: "NOT_FOUND", message: "Worker not found" });
  if (!w) throw notFound;
  const site = await requireSite(ctx.user!, w.siteId).catch(() => { throw notFound; });
  return { w, site };
}

const audit = (ctx: any, what: string, w: { id: string; name: string; siteId: string }, metadata: Record<string, unknown> = {}) =>
  logAudit("worker_change", { actorId: ctx.user!.sub, targetId: w.id, targetType: "worker", targetName: w.name, metadata: { what, siteId: w.siteId, ...metadata }, ip: ctx.ip ?? undefined });

/** The fit check for a worker's memory (copies x limit), as the dialog and the save both see it. */
async function fitFor(memoryMb: number, excludeWorkerId?: string) {
  return evaluateFit(await capacity({ excludeWorkerId }), { memoryMb, newApp: false, builds: false });
}

export const workersRouter = router({
  list: protectedProcedure.input(z.object({ siteId: z.string().uuid() })).query(async ({ input, ctx }) => {
    const site = await requireSite(ctx.user!, input.siteId);
    const defs = await db.select().from(siteWorkers).where(eq(siteWorkers.siteId, site.id)).orderBy(asc(siteWorkers.createdAt));
    const live = (await liveWorkers(site.id)) as Array<Live & { worker: string }>;
    // The server's own numbers are for admins, as on the Overview.
    const cap = ctx.user!.role === "admin" ? await capacity().catch(() => null) : null;
    return {
      deployed: !!site.currentTag,
      release: site.currentTag,
      appWorkersMb: defs.filter((d) => d.enabled).reduce((n, d) => n + d.copies * d.memoryLimit, 0),
      freeToPromiseMb: cap?.memory.freeToPromiseMb ?? null,
      workers: defs.map((d) => {
        const copies = live.filter((l) => l.worker === d.name).sort((a, b) => a.copy - b.copy);
        const status = !d.enabled ? "off" : !site.currentTag ? "waiting" : copies.some((c) => c.crashing) ? "crashing" : copies.length < d.copies ? "starting" : copies.every((c) => c.running) ? "running" : "stopped";
        return { ...d, status, copiesLive: copies };
      }),
    };
  }),

  /** Would this much worker memory fit? For the dialog, before saving. */
  fit: protectedProcedure
    .input(z.object({ siteId: z.string().uuid(), copies: z.number().int().min(1).max(8), memoryLimit: z.number().int().min(64).max(16384), workerId: z.string().uuid().optional() }))
    .query(async ({ input, ctx }) => {
      await requireSite(ctx.user!, input.siteId);
      const fit = await fitFor(input.copies * input.memoryLimit, input.workerId);
      return { ...fit, canOverride: fit.verdict === "blocked" && fit.overridable && canOverrideCapacity(ctx) };
    }),

  create: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ siteId: z.string().uuid(), name: z.string().trim(), ...fields, allowOverCapacity: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const site = await requireSite(ctx.user!, input.siteId);
      if (!NAME.test(input.name)) throw new TRPCError({ code: "BAD_REQUEST", message: "A worker's name is lowercase letters, numbers and dashes, starting with a letter (at most 30)." });
      const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(siteWorkers).where(eq(siteWorkers.siteId, site.id));
      if (n >= MAX_WORKERS) throw new TRPCError({ code: "BAD_REQUEST", message: `An app can have at most ${MAX_WORKERS} workers.` });
      const [taken] = await db.select({ id: siteWorkers.id }).from(siteWorkers).where(and(eq(siteWorkers.siteId, site.id), eq(siteWorkers.name, input.name))).limit(1);
      if (taken) throw new TRPCError({ code: "CONFLICT", message: `This app already has a worker called ${input.name}.` });
      const { allowOverCapacity, siteId, ...rest } = input;
      if (rest.enabled !== false) await assertFits(ctx, { memoryMb: (rest.copies ?? 1) * (rest.memoryLimit ?? 256), newApp: false, builds: false }, { override: allowOverCapacity });
      const [w] = await db.insert(siteWorkers).values({ ...(rest as any), siteId: site.id, createdBy: ctx.user!.sub }).returning();
      await sync(site.id);
      audit(ctx, "create", w, { command: w.command, copies: w.copies, memoryLimit: w.memoryLimit });
      return w;
    }),

  update: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ id: z.string().uuid(), ...fields, allowOverCapacity: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const { w } = await workerFor(ctx, input.id);
      const { allowOverCapacity, id, ...rest } = input;
      const before = w.enabled ? w.copies * w.memoryLimit : 0;
      const after = rest.enabled === false ? 0 : (rest.copies ?? w.copies) * (rest.memoryLimit ?? w.memoryLimit);
      // More memory than it holds now needs room; less never does.
      if (after > before) await assertFits(ctx, { memoryMb: after, newApp: false, builds: false }, { excludeWorkerId: w.id, override: allowOverCapacity });
      const [next] = await db.update(siteWorkers).set({ ...(rest as any), updatedAt: new Date() }).where(eq(siteWorkers.id, w.id)).returning();
      await sync(w.siteId);
      audit(ctx, "update", next, { before: { command: w.command, copies: w.copies, memoryLimit: w.memoryLimit, enabled: w.enabled }, after: { command: next.command, copies: next.copies, memoryLimit: next.memoryLimit, enabled: next.enabled } });
      return next;
    }),

  /** Starts its copies again from the same release (a new container each). */
  restart: permissionProcedure(PERMISSIONS.SITE_DEPLOY).input(z.object({ id: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    const { w } = await workerFor(ctx, input.id);
    for (const c of await docker.listContainers({ all: true, filters: { label: [`dbbkp.site=${w.siteId}`, `dbbkp.worker=${w.name}`] } })) {
      const ct = docker.getContainer(c.Id);
      await ct.stop({ t: w.gracefulStop ? 30 : 5 }).catch(() => {});
      await ct.remove({ force: true }).catch(() => {});
    }
    await sync(w.siteId);
    audit(ctx, "restart", w);
    return { ok: true };
  }),

  delete: permissionProcedure(PERMISSIONS.SITE_DEPLOY).input(z.object({ id: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    const { w } = await workerFor(ctx, input.id);
    // Scheduled jobs that ran in this worker run in the web container from now on.
    const moved = await db.update(cronJobs).set({ runIn: "web", updatedAt: new Date() }).where(and(eq(cronJobs.siteId, w.siteId), eq(cronJobs.runIn, `worker:${w.name}`))).returning({ id: cronJobs.id });
    await db.delete(siteWorkers).where(eq(siteWorkers.id, w.id));
    await sync(w.siteId);
    audit(ctx, "delete", w, { jobsMoved: moved.length });
    return { success: true, jobsMoved: moved.length };
  }),

  logs: protectedProcedure
    .input(z.object({ siteId: z.string().uuid(), container: z.string().regex(/^[0-9a-f]{12,64}$/), tail: z.number().int().min(10).max(2000).default(300) }))
    .query(async ({ input, ctx }) => {
      const site = await requireSite(ctx.user!, input.siteId);
      const ct = docker.getContainer(input.container);
      const info: any = await ct.inspect().catch(() => null);
      // The container must be one of this app's workers: an id from the browser is not trusted.
      if (!info || info.Config?.Labels?.["dbbkp.site"] !== site.id || info.Config?.Labels?.["dbbkp.role"] !== "worker") throw new TRPCError({ code: "NOT_FOUND", message: "Worker not found" });
      const buf = (await ct.logs({ follow: false, stdout: true, stderr: true, timestamps: true, tail: input.tail })) as unknown as Buffer;
      return { running: !!info.State?.Running, lines: demuxLogs(Buffer.from(buf)) };
    }),
});
