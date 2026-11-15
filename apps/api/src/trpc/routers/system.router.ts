import os from "node:os";
import fs from "fs-extra";
import execa from "execa";
import Docker from "dockerode";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, adminProcedure } from "../trpc";
import { db, sites, deployments, automations, automationRuns } from "@dbbkp/db";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { hostingQueue } from "../../queues";
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
    const mySites = isAdmin ? await db.select().from(sites) : await db.select().from(sites).where(eq(sites.userId, ctx.user!.sub));
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

    const cpus = os.cpus().length || 1;
    const disk = await diskFree(SITES_ROOT);
    const durations = today.map((d) => d.durationMs).filter((n): n is number => typeof n === "number").sort((a, b) => a - b);

    return {
      apps: {
        total: mySites.length,
        running: mySites.filter((s) => s.status === "active").length,
        failed: mySites.filter((s) => s.status === "failed").length,
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
      recentDeployments: recent.map((d) => ({ ...d, domain: domainById.get(d.siteId) ?? "" })),
      recentRuns: runs.map((r) => ({ ...r, name: autoName.get(r.automationId) ?? "" })),
    };
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
