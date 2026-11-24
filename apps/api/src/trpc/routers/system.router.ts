import os from "node:os";
import fs from "fs-extra";
import execa from "execa";
import Docker from "dockerode";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, adminProcedure } from "../trpc";
import { db, sites, deployments, automations, automationRuns, cronJobs } from "@dbbkp/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { hostingQueue } from "../../queues";
import { z } from "zod";
import { logAudit } from "@dbbkp/audit";
import { CAPACITY_RANGE, DEFAULT_APP_MEMORY_MB, canOverrideCapacity, capacity, evaluateFit, setCapacitySettings } from "../../services/capacity";
import { requireSite, visibleSites } from "../../services/team";
import { summary as hostSummary } from "../../services/hostwatch";
import { SAFE_KINDS, getCleanupSettings, lastRuns, planCleanup, removeOrphan, runCleanup, setCleanupSettings, snapshot, usage } from "../../services/cleanup";
import { BASE_DOMAIN, NETWORK, PUBLIC_API_URL, PUBLIC_HTTP_PORT, SITES_ROOT, TLS_ENABLED } from "../../config";

const docker = new Docker();

type Check = { key: string; label: string; status: "ok" | "warn" | "bad"; value: string; fix?: "network" };

async function diskFree(dir: string) {
  try {
    const st = await (fs as any).statfs(dir);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return null;
  }
}

const gb = (n: number) => `${(n / 1024 ** 3).toFixed(n < 10 * 1024 ** 3 ? 1 : 0)} GB`;

export const systemRouter = router({
  info: protectedProcedure.query(() => ({
    baseDomain: BASE_DOMAIN,
    publicHttpPort: PUBLIC_HTTP_PORT,
    tls: TLS_ENABLED,
    webhookUrl: `${PUBLIC_API_URL || ""}/webhooks/github`,
    webhookSecretSet: !!process.env.GITHUB_WEBHOOK_SECRET,
    version: process.env.DBBKP_VERSION || "0.4.0",
  })),

  overview: protectedProcedure.query(async ({ ctx }) => {
    const isAdmin = ctx.user!.role === "admin";
    const mySites = await db.select().from(sites).where(await visibleSites(ctx.user!));
    const ids = mySites.map((s) => s.id);
    const domainById = new Map(mySites.map((s) => [s.id, s.domain]));

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const recent = ids.length
      ? await db
          .select({
            id: deployments.id,
            siteId: deployments.siteId,
            status: deployments.status,
            trigger: deployments.trigger,
            commitSha: deployments.commitSha,
            commitMessage: deployments.commitMessage,
            durationMs: deployments.durationMs,
            createdAt: deployments.createdAt,
          })
          .from(deployments)
          .where(inArray(deployments.siteId, ids))
          .orderBy(desc(deployments.createdAt))
          .limit(8)
      : [];

    const today = ids.length
      ? await db
          .select({ status: deployments.status, durationMs: deployments.durationMs })
          .from(deployments)
          .where(and(inArray(deployments.siteId, ids), gte(deployments.createdAt, startOfDay)))
      : [];

    const autos = isAdmin ? await db.select().from(automations) : await db.select().from(automations).where(eq(automations.userId, ctx.user!.sub));
    const runs = autos.length
      ? await db
          .select({ id: automationRuns.id, automationId: automationRuns.automationId, status: automationRuns.status, createdAt: automationRuns.createdAt })
          .from(automationRuns)
          .where(inArray(automationRuns.automationId, autos.map((a) => a.id)))
          .orderBy(desc(automationRuns.createdAt))
          .limit(5)
      : [];
    const autoName = new Map(autos.map((a) => [a.id, a.name]));

    // What needs a person: apps that keep crashing, failed apps, and deploys waiting for an answer.
    const waiting = ids.length
      ? await db
          .select({ id: deployments.id, siteId: deployments.siteId, prompt: deployments.prompt })
          .from(deployments)
          .where(and(inArray(deployments.siteId, ids), eq(deployments.status, "waiting_input")))
      : [];
    const watch = isAdmin ? await hostSummary().catch(() => null) : null;
    const failingJobs = ids.length
      ? await db.select({ id: cronJobs.id, siteId: cronJobs.siteId, name: cronJobs.name, failStreak: cronJobs.failStreak, lastStatus: cronJobs.lastStatus }).from(cronJobs)
          .where(and(inArray(cronJobs.siteId, ids), eq(cronJobs.active, true), eq(cronJobs.notifyOnFailure, true), sql`${cronJobs.failStreak} > 0`))
      : [];
    const crashingWorkers = ids.length
      ? (await docker.listContainers({ filters: { label: ["dbbkp.role=worker"], status: ["restarting"] } }).catch(() => []))
          .filter((c) => domainById.has(c.Labels?.["dbbkp.site"] ?? ""))
      : [];
    const attention = [
      ...(watch?.silent ? [{ kind: "security" as const, siteId: "", domain: "Server", text: "The server watch has stopped reporting. Check that it is still running.", href: "/security" }] : []),
      ...(watch?.urgent ? [{ kind: "security" as const, siteId: "", domain: "Server", text: `${watch.urgent} urgent change${watch.urgent === 1 ? "" : "s"} on the server (users, keys, scheduled jobs or services)`, href: "/security" }] : []),
      ...(watch?.check ? [{ kind: "security-check" as const, siteId: "", domain: "Server", text: `${watch.check} change${watch.check === 1 ? "" : "s"} on the server to look at`, href: "/security" }] : []),
      ...(watch?.toReview ? [{ kind: "security-check" as const, siteId: "", domain: "Server", text: `Review what was found on this server (${watch.toReview} things), so later changes stand out`, href: "/security" }] : []),
      ...waiting.map((w) => ({ kind: "question" as const, siteId: w.siteId, domain: domainById.get(w.siteId) ?? "", text: w.prompt?.title ?? "A deploy is waiting for your answer", href: `/apps/${w.siteId}?deployment=${w.id}` })),
      ...mySites
        .filter((s) => s.status === "active" && s.health === "crashing")
        .map((s) => ({
          kind: "crashing" as const,
          siteId: s.id,
          domain: s.domain,
          text: s.healthDetail?.outOfMemory
            ? `Ran out of memory (limit ${s.memoryLimit ?? 512} MB) and restarted ${s.healthDetail.restarts} times`
            : `Restarted ${s.healthDetail?.restarts ?? "several"} times since it went live`,
          href: `/apps/${s.id}`,
        })),
      ...failingJobs.map((j) => ({
        kind: "job-failed" as const,
        siteId: j.siteId,
        domain: domainById.get(j.siteId) ?? "",
        text: `Scheduled job "${j.name || "unnamed"}" ${j.lastStatus === "timeout" ? "ran past its time limit" : "failed"}${j.failStreak > 1 ? ` ${j.failStreak} times in a row` : ""}`,
        href: `/apps/${j.siteId}?tab=jobs&job=${j.id}`,
      })),
      ...[...new Map(crashingWorkers.map((c) => [`${c.Labels?.["dbbkp.site"]}:${c.Labels?.["dbbkp.worker"]}`, c])).values()].map((c) => ({
        kind: "worker-crashing" as const,
        siteId: c.Labels?.["dbbkp.site"] ?? "",
        domain: domainById.get(c.Labels?.["dbbkp.site"] ?? "") ?? "",
        text: `Worker "${c.Labels?.["dbbkp.worker"]}" keeps crashing`,
        href: `/apps/${c.Labels?.["dbbkp.site"]}?tab=workers`,
      })),
      ...mySites.filter((s) => s.status === "failed").map((s) => ({ kind: "failed" as const, siteId: s.id, domain: s.domain, text: "The last deploy failed", href: `/apps/${s.id}` })),
    ];

    const cpus = os.cpus().length || 1;
    const disk = await diskFree(SITES_ROOT);
    const durations = today.map((d) => d.durationMs).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);

    return {
      apps: {
        total: mySites.length,
        running: mySites.filter((s) => s.status === "active" && s.health !== "crashing").length,
        failed: mySites.filter((s) => s.status === "failed").length,
        crashing: mySites.filter((s) => s.status === "active" && s.health === "crashing").length,
        building: mySites.filter((s) => s.status === "provisioning").length,
      },
      deploysToday: {
        total: today.length,
        succeeded: today.filter((d) => d.status === "active" || d.status === "superseded").length,
        medianMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
      },
      workflows: { total: autos.length, active: autos.filter((a) => a.enabled).length },
      server: {
        hostname: os.hostname(),
        cpuPct: Math.min(100, Math.round((os.loadavg()[0] / cpus) * 100)),
        cores: cpus,
        memUsed: os.totalmem() - os.freemem(),
        memTotal: os.totalmem(),
        diskUsed: disk ? disk.total - disk.free : null,
        diskTotal: disk ? disk.total : null,
      },
      // Room left on the server. Only the owner sees the server's own numbers.
      capacity: isAdmin ? await capacity().catch(() => null) : null,
      attention,
      recentDeployments: recent.map((d) => ({ ...d, domain: domainById.get(d.siteId) ?? "" })),
      recentRuns: runs.map((r) => ({ ...r, name: autoName.get(r.automationId) ?? "" })),
    };
  }),

  /** What each app uses: memory and CPU now, and disk for its images, storage and source. */
  usage: adminProcedure.query(() => usage()),

  /** What can be freed, and what the last runs freed. Nothing is removed by reading this. */
  cleanupPlan: adminProcedure.query(async () => {
    const [plan, settings, runs] = await Promise.all([snapshot().then(planCleanup), getCleanupSettings(), lastRuns(10)]);
    return { ...plan, settings, runs };
  }),

  cleanup: adminProcedure.input(z.object({ kinds: z.array(z.enum(SAFE_KINDS)).min(1) })).mutation(async ({ input, ctx }) => {
    if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "Cleanup can only be started in the panel." });
    const run = await runCleanup(input.kinds, "manual", ctx.user!.sub).catch((e) => {
      throw new TRPCError({ code: "CONFLICT", message: e.message });
    });
    logAudit("cleanup_run", { actorId: ctx.user!.sub, targetType: "platform", targetName: "cleanup", metadata: { kinds: input.kinds, freedBytes: run.freedBytes }, ip: ctx.ip ?? undefined });
    return run;
  }),

  /** A volume or folder that belongs to no app. It may hold data, so its name must be typed. */
  cleanupRemove: adminProcedure
    .input(z.object({ kind: z.enum(["orphan-volume", "orphan-folder"]), target: z.string().min(1).max(255), confirm: z.string().max(255) }))
    .mutation(async ({ input, ctx }) => {
      if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "This can only be done in the panel." });
      if (input.confirm !== input.target) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the name exactly to confirm." });
      const run = await removeOrphan(input.kind, input.target, ctx.user!.sub).catch((e) => {
        throw new TRPCError({ code: "CONFLICT", message: e.message });
      });
      logAudit("cleanup_remove", { actorId: ctx.user!.sub, targetType: "platform", targetName: input.target, metadata: { kind: input.kind, freedBytes: run.freedBytes }, ip: ctx.ip ?? undefined });
      return run;
    }),

  setAutoCleanup: adminProcedure.input(z.object({ auto: z.boolean() })).mutation(async ({ input, ctx }) => {
    if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "Cleanup settings can only be changed in the panel." });
    const settings = await setCleanupSettings({ auto: !!input.auto }, ctx.user!.sub);
    logAudit("cleanup_settings", { actorId: ctx.user!.sub, targetType: "platform", targetName: "cleanup", metadata: settings, ip: ctx.ip ?? undefined });
    return settings;
  }),

  /** The capacity ledger: what the server has, what apps hold, what can still be promised. */
  capacity: adminProcedure.query(() => capacity()),

  /**
   * "Will it fit?" for a new app, or for an existing app with a different memory limit.
   * Any signed-in user may ask; the answer says in words why something does not fit.
   */
  fit: protectedProcedure
    .input(z.object({ memoryMb: z.number().int().min(64).max(65536).optional(), siteId: z.string().uuid().optional() }).optional())
    .query(async ({ input, ctx }) => {
      let excludeSiteId: string | undefined;
      if (input?.siteId) {
        excludeSiteId = (await requireSite(ctx.user!, input.siteId)).id;
      }
      const fit = evaluateFit(await capacity({ excludeSiteId }), { memoryMb: input?.memoryMb ?? DEFAULT_APP_MEMORY_MB, newApp: !excludeSiteId, builds: !excludeSiteId });
      return { ...fit, canOverride: fit.verdict === "blocked" && fit.overridable && canOverrideCapacity(ctx) };
    }),

  setCapacity: adminProcedure
    .input(
      z.object({
        hostReservePct: z.number().int().min(CAPACITY_RANGE.hostReservePct[0]).max(CAPACITY_RANGE.hostReservePct[1]).optional(),
        overcommitPct: z.number().int().min(CAPACITY_RANGE.overcommitPct[0]).max(CAPACITY_RANGE.overcommitPct[1]).optional(),
        diskReserveGb: z.number().int().min(CAPACITY_RANGE.diskReserveGb[0]).max(CAPACITY_RANGE.diskReserveGb[1]).nullable().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "Capacity settings can only be changed in the panel." });
      const settings = await setCapacitySettings(input, ctx.user!.sub);
      logAudit("capacity_settings", { actorId: ctx.user!.sub, targetType: "platform", targetName: "capacity", metadata: settings, ip: ctx.ip ?? undefined });
      return capacity();
    }),

  /** Server readiness checks, Dokploy style: each line says what was found and, where it can, how to fix it. */
  checks: protectedProcedure.query(async () => {
    const out: Check[] = [];

    try {
      const v: any = await docker.version();
      const engine = (v.Components || []).find((c: any) => /engine/i.test(c.Name))?.Name || "Docker Engine";
      out.push({ key: "engine", label: "Container engine", status: "ok", value: `${engine} ${v.Version} · API ${v.ApiVersion}` });
    } catch (err: any) {
      out.push({ key: "engine", label: "Container engine", status: "bad", value: `unreachable: ${String(err.message).slice(0, 80)}` });
    }

    try {
      const nets = await docker.listNetworks({ filters: { name: [NETWORK] } });
      const found = nets.find((n) => n.Name === NETWORK);
      out.push(found
        ? { key: "network", label: "Platform network", status: "ok", value: `${NETWORK} · ${found.Driver}` }
        : { key: "network", label: "Platform network", status: "bad", value: `${NETWORK} missing`, fix: "network" });
    } catch {
      out.push({ key: "network", label: "Platform network", status: "bad", value: "could not list networks" });
    }

    try {
      const running = await docker.listContainers();
      const proxy = running.find((c) => /traefik/i.test(c.Image));
      if (!proxy) out.push({ key: "proxy", label: "Reverse proxy", status: "bad", value: "no Traefik container running" });
      else {
        const onNet = Object.keys(proxy.NetworkSettings?.Networks ?? {}).includes(NETWORK);
        out.push({ key: "proxy", label: "Reverse proxy", status: onNet ? "ok" : "warn", value: `${proxy.Image}${onNet ? " · on network" : ` · not on ${NETWORK}`}` });
      }
    } catch {
      out.push({ key: "proxy", label: "Reverse proxy", status: "bad", value: "could not list containers" });
    }

    out.push(TLS_ENABLED
      ? { key: "tls", label: "HTTPS certificates", status: "ok", value: "Let's Encrypt via Traefik" }
      : { key: "tls", label: "HTTPS certificates", status: "warn", value: "off (DBBKP_TLS=false)" });

    try {
      await fs.ensureDir(SITES_ROOT);
      await fs.access(SITES_ROOT, fs.constants.W_OK);
      out.push({ key: "sites", label: "Sites directory", status: "ok", value: `${SITES_ROOT} · writable` });
    } catch {
      out.push({ key: "sites", label: "Sites directory", status: "bad", value: `${SITES_ROOT} not writable` });
    }

    try {
      const { stdout } = await execa("git", ["--version"]);
      out.push({ key: "git", label: "Git", status: "ok", value: stdout.replace("git version ", "") });
    } catch {
      out.push({ key: "git", label: "Git", status: "bad", value: "not installed" });
    }

    try {
      const client = await hostingQueue.client;
      const info = await client.info("server");
      const ver = info.match(/redis_version:(\S+)/)?.[1] ?? "?";
      const counts = await hostingQueue.getJobCounts("active", "waiting");
      out.push({ key: "queue", label: "Job queue", status: "ok", value: `Redis ${ver} · ${counts.active} active · ${counts.waiting} waiting` });
    } catch {
      out.push({ key: "queue", label: "Job queue", status: "bad", value: "Redis unreachable" });
    }

    try {
      const rows: any = await db.execute(sql`select current_setting('server_version') as v`);
      const v = (rows?.[0]?.v ?? rows?.rows?.[0]?.v ?? "").toString();
      out.push({ key: "db", label: "Database", status: "ok", value: `PostgreSQL ${v}` });
    } catch {
      out.push({ key: "db", label: "Database", status: "bad", value: "unreachable" });
    }

    const disk = await diskFree(SITES_ROOT);
    if (disk) {
      const low = disk.free < 10 * 1024 ** 3;
      out.push({ key: "disk", label: "Disk space", status: low ? "warn" : "ok", value: `${gb(disk.free)} free of ${gb(disk.total)}` });
    }

    out.push(process.env.GITHUB_WEBHOOK_SECRET
      ? { key: "webhook", label: "Webhook secret", status: "ok", value: "set" }
      : { key: "webhook", label: "Webhook secret", status: "bad", value: "not set (GITHUB_WEBHOOK_SECRET)" });

    const mk = process.env.MASTER_KEY || "";
    out.push(/^[0-9a-f]{64}$/i.test(mk) && !/^0+$/.test(mk)
      ? { key: "masterkey", label: "Secrets encryption key", status: "ok", value: "MASTER_KEY set" }
      : { key: "masterkey", label: "Secrets encryption key", status: "bad", value: "MASTER_KEY missing or default" });

    return out;
  }),

  fixNetwork: adminProcedure.mutation(async () => {
    const nets = await docker.listNetworks({ filters: { name: [NETWORK] } });
    if (nets.some((n) => n.Name === NETWORK)) return { created: false };
    try {
      await docker.createNetwork({ Name: NETWORK, Driver: "bridge", Labels: { "dbbkp.managed": "true" } });
    } catch (err: any) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Could not create network: ${err.message}` });
    }
    return { created: true };
  }),
});
