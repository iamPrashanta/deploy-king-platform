import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, permissionProcedure, type Context } from "../trpc";
import { providerWithToken } from "../../services/github";
import { db, sites, deployments, siteEnvVars } from "@dbbkp/db";
import { and, desc, eq } from "drizzle-orm";
import { hostingQueue } from "../../queues";
import crypto from "node:crypto";
import Docker from "dockerode";
import { cloudflare } from "../../services/cloudflare";
import { logAudit } from "@dbbkp/audit";
import { encrypt } from "@dbbkp/security";
import { PERMISSIONS } from "../../utils/rbac";
import { enqueueDeploy } from "../../services/deploy";
import { DEFAULT_APP_MEMORY_MB, assertFits } from "../../services/capacity";
import { visibleSite, visibleSites } from "../../services/team";
import { normalizeRootDirectory } from "@dbbkp/buildplan";
import {
  demuxLogs,
  isValidBranch,
  isValidDomain,
  isValidEnvKey,
  isValidImageRef,
  isValidRepoUrl,
  isValidVolume,
  normalizeDomain,
  siteDocRoot,
} from "../../services/validation";

const docker = new Docker();

export const RUNTIMES = ["auto", "static", "node", "python", "php", "go", "docker", "image"] as const;

const volumeInput = z.object({ name: z.string(), mountPath: z.string() });
// buildTime: also give the variable to the image build (NEXT_PUBLIC_*, VITE_* ...). Left out = keep what it was.
const envInput = z.object({ key: z.string(), value: z.string().max(32768), buildTime: z.boolean().optional() });

type Vol = { name: string; mountPath: string };
type EnvPair = { key: string; value: string; buildTime?: boolean };

function rootDir(input: string | null | undefined): string | null {
  try {
    return normalizeRootDirectory(input);
  } catch (err: any) {
    throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
}

function checkVolumes(input: Array<Partial<Vol>>): Vol[] {
  const volumes = input as Vol[];
  const names = new Set<string>();
  for (const v of volumes) {
    if (!isValidVolume(v)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid volume ${v.name} → ${v.mountPath}. Names: lowercase letters, digits, - and _; paths must be absolute.` });
    }
    if (names.has(v.name)) throw new TRPCError({ code: "BAD_REQUEST", message: `Duplicate volume name ${v.name}` });
    names.add(v.name);
  }
  return volumes as Vol[];
}

async function upsertEnv(siteId: string, input: Array<Partial<EnvPair>>) {
  const vars = input as EnvPair[];
  for (const v of vars) {
    if (!isValidEnvKey(v.key)) {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid variable name "${v.key}". Use letters, digits and _, not starting with a digit.` });
    }
  }
  for (const v of vars) {
    const enc = encrypt(v.value);
    await db
      .insert(siteEnvVars)
      .values({ siteId, key: v.key, ...enc, buildTime: !!v.buildTime })
      .onConflictDoUpdate({
        target: [siteEnvVars.siteId, siteEnvVars.key],
        set: { ...enc, ...(v.buildTime !== undefined ? { buildTime: v.buildTime } : {}), updatedAt: new Date() },
      });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Loads a site only if the caller owns it (admins may load any). */
async function ownedSite(ctx: Context, id: string) {
  // Admins see every app; a member sees their own plus the ones shared with them.
  const site = await visibleSite(ctx.user!, id);
  if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found or access denied" });
  return site;
}

const siteIdInput = z.object({ id: z.string().uuid() });

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export const sitesRouter = router({
  // ─── List Sites ────────────────────────────────────────────────────────────
  list: protectedProcedure.query(async ({ ctx }) => {
    // Admins see everything; a member sees their own apps plus the ones shared with them.
    return db.select().from(sites).where(await visibleSites(ctx.user!)).orderBy(desc(sites.createdAt));
  }),

  // ─── Create Site ───────────────────────────────────────────────────────────
  create: permissionProcedure(PERMISSIONS.SITE_CREATE)
    .input(
      z.object({
        domain: z.string().min(4).max(253),
        // "auto" inspects the repository and picks the right build for it.
        runtime: z.enum(RUNTIMES).default("auto"),
        source: z.enum(["git", "zip", "image"]),
        repoUrl: z.string().max(2000).optional(),
        branch: z.string().max(100).default("main"),
        gitProviderId: z.string().uuid().optional(),
        image: z.string().max(300).optional(),
        port: z.number().int().min(1).max(65535).optional(),
        buildCommand: z.string().max(1000).optional(),
        startCommand: z.string().max(1000).optional(),
        env: z.array(envInput).max(200).default([]),
        volumes: z.array(volumeInput).max(10).default([]),
        autoDeploy: z.boolean().default(true),
        memoryLimit: z.number().int().min(64).max(65536).optional(),
        cpuLimit: z.number().int().min(1).max(64).optional(),
        // Build from a folder inside the repository (monorepos), e.g. "apps/web".
        rootDirectory: z.string().max(255).optional(),
        // "Deploy anyway" when the app does not fit. Honoured for the server owner in the panel only.
        allowOverCapacity: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const rootDirectory = input.source === "git" ? rootDir(input.rootDirectory) : null;
      const domain = normalizeDomain(input.domain);
      if (!isValidDomain(domain)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Domain must be a valid hostname, e.g. app.example.com" });
      }
      if (!isValidBranch(input.branch)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid branch name" });
      }
      if (input.source === "git") {
        if (!input.repoUrl || !isValidRepoUrl(input.repoUrl)) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Repository URL must be an https:// or ssh git URL" });
        }
        if (input.gitProviderId) await providerWithToken(ctx.user!, input.gitProviderId); // must be the caller's
      }
      if (input.source === "image" && (!input.image || !isValidImageRef(input.image.trim()))) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Image must look like name:tag, e.g. n8nio/n8n:latest" });
      }
      const volumes = checkVolumes(input.volumes);

      const [taken] = await db.select({ id: sites.id }).from(sites).where(eq(sites.domain, domain)).limit(1);
      if (taken) throw new TRPCError({ code: "CONFLICT", message: `Domain ${domain} is already in use` });

      // Will it fit? Checked before anything is created, so a refused app leaves nothing behind.
      const fit = await assertFits(
        ctx,
        { memoryMb: input.memoryLimit ?? DEFAULT_APP_MEMORY_MB, newApp: true, builds: true },
        { override: input.allowOverCapacity }
      );

      const siteId = crypto.randomUUID();

      const [newSite] = await db
        .insert(sites)
        .values({
          id: siteId,
          userId: ctx.user!.sub,
          domain,
          type: input.source === "image" ? "image" : input.runtime,
          docRoot: siteDocRoot(siteId),
          // The container's internal port. For images the user may set it; otherwise the worker works it out.
          port: input.port ?? null, // for git apps: the port the user confirmed in the project check
          source: input.source,
          repoUrl: input.source === "git" ? input.repoUrl! : null,
          gitProviderId: input.source === "git" ? input.gitProviderId ?? null : null,
          image: input.source === "image" ? input.image!.trim() : null,
          volumes,
          autoDeploy: input.autoDeploy,
          ...(input.memoryLimit ? { memoryLimit: input.memoryLimit } : {}),
          ...(input.cpuLimit ? { cpuLimit: input.cpuLimit } : {}),
          branch: input.branch,
          rootDirectory,
          buildCommand: input.buildCommand?.trim() || null,
          startCommand: input.startCommand?.trim() || null,
          // ZIP sites wait for their upload; git sites start deploying straight away.
          status: input.source === "zip" ? "pending" : "provisioning",
        })
        .returning();

      if (input.env.length) await upsertEnv(newSite.id, input.env);

      if (input.source !== "zip") {
        await enqueueDeploy(newSite.id, { trigger: "manual", createdBy: ctx.user!.sub });
      }

      // Auto-provision DNS if Cloudflare is enabled
      if (cloudflare.isEnabled()) {
        try {
          const serverIp = process.env.SERVER_IP || "127.0.0.1";
          const records = await cloudflare.listRecords();
          if (!records.find((r) => r.name === domain)) {
            await cloudflare.createRecord("A", domain, serverIp, true);
            console.log(`[Sites:Create] DNS record created for ${domain}`);
          }
        } catch (cfErr) {
          // Non-fatal: the site still deploys, DNS can be pointed manually.
          console.error(`[Sites:Create] Cloudflare DNS provisioning failed:`, cfErr);
        }
      }

      logAudit("site_create", {
        actorId: ctx.user!.sub,
        targetId: newSite.id,
        targetType: "site",
        targetName: domain,
        metadata: { runtime: input.runtime, source: input.source },
        ip: ctx.ip ?? undefined,
      });
      if (fit.overridden) {
        logAudit("capacity_override", {
          actorId: ctx.user!.sub,
          targetId: newSite.id,
          targetType: "site",
          targetName: domain,
          metadata: { action: "create", memoryMb: fit.needMemoryMb, reasons: fit.reasons.map((r) => r.kind) },
          ip: ctx.ip ?? undefined,
        });
      }

      return newSite;
    }),

  // ─── Get Site ──────────────────────────────────────────────────────────────
  get: protectedProcedure.input(siteIdInput).query(({ input, ctx }) => ownedSite(ctx, input.id)),

  // ─── Update build settings ─────────────────────────────────────────────────
  update: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(
      z.object({
        id: z.string().uuid(),
        runtime: z.enum(RUNTIMES).optional(),
        domain: z.string().min(4).max(253).optional(),
        branch: z.string().max(100).optional(),
        port: z.number().int().min(1).max(65535).nullable().optional(),
        image: z.string().max(300).optional(),
        volumes: z.array(volumeInput).max(10).optional(),
        autoDeploy: z.boolean().optional(),
        buildCommand: z.string().max(1000).nullable().optional(),
        startCommand: z.string().max(1000).nullable().optional(),
        cpuLimit: z.number().int().min(1).max(64).optional(),
        memoryLimit: z.number().int().min(64).max(65536).optional(),
        rootDirectory: z.string().max(255).nullable().optional(),
        allowOverCapacity: z.boolean().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      // Raising the memory limit takes more of the server; lowering it never needs a check.
      if (input.memoryLimit !== undefined && input.memoryLimit > (site.memoryLimit || DEFAULT_APP_MEMORY_MB)) {
        const fit = await assertFits(
          ctx,
          { memoryMb: input.memoryLimit, newApp: false, builds: false },
          { excludeSiteId: site.id, override: input.allowOverCapacity }
        );
        if (fit.overridden) {
          logAudit("capacity_override", {
            actorId: ctx.user!.sub,
            targetId: site.id,
            targetType: "site",
            targetName: site.domain,
            metadata: { action: "raise-limit", memoryMb: input.memoryLimit, reasons: fit.reasons.map((r) => r.kind) },
            ip: ctx.ip ?? undefined,
          });
        }
      }
      const rootDirectory = input.rootDirectory !== undefined ? rootDir(input.rootDirectory) : undefined;
      if (input.branch !== undefined && !isValidBranch(input.branch)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid branch name" });
      }
      let domain: string | undefined;
      if (input.domain !== undefined) {
        domain = normalizeDomain(input.domain);
        if (!isValidDomain(domain)) throw new TRPCError({ code: "BAD_REQUEST", message: "Domain must be a valid hostname" });
        const [taken] = await db.select({ id: sites.id }).from(sites).where(eq(sites.domain, domain)).limit(1);
        if (taken && taken.id !== site.id) throw new TRPCError({ code: "CONFLICT", message: `Domain ${domain} is already in use` });
      }
      if (input.image !== undefined && !isValidImageRef(input.image.trim())) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Image must look like name:tag" });
      }
      const volumes = input.volumes ? checkVolumes(input.volumes) : undefined;
      const [updated] = await db
        .update(sites)
        .set({
          ...(input.runtime !== undefined ? { type: input.runtime } : {}),
          ...(domain !== undefined ? { domain } : {}),
          ...(input.port !== undefined ? { port: input.port } : {}),
          ...(input.image !== undefined ? { image: input.image.trim() } : {}),
          ...(volumes !== undefined ? { volumes } : {}),
          ...(input.autoDeploy !== undefined ? { autoDeploy: input.autoDeploy } : {}),
          ...(input.branch !== undefined ? { branch: input.branch } : {}),
          ...(input.buildCommand !== undefined ? { buildCommand: input.buildCommand?.trim() || null } : {}),
          ...(input.startCommand !== undefined ? { startCommand: input.startCommand?.trim() || null } : {}),
          ...(input.cpuLimit !== undefined ? { cpuLimit: input.cpuLimit } : {}),
          ...(input.memoryLimit !== undefined ? { memoryLimit: input.memoryLimit } : {}),
          ...(rootDirectory !== undefined ? { rootDirectory } : {}),
          updatedAt: new Date(),
        })
        .where(eq(sites.id, site.id))
        .returning();
      return updated;
    }),

  // ─── Delete Site ───────────────────────────────────────────────────────────
  delete: permissionProcedure(PERMISSIONS.SITE_DELETE)
    .input(siteIdInput)
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);

      // Stop reconciling it, then let the worker remove containers, images,
      // source files and finally the row itself.
      await db
        .update(sites)
        .set({ status: "deleting", desiredStatus: "deleted", active: false, updatedAt: new Date() })
        .where(eq(sites.id, site.id));
      await hostingQueue.add("delete-site", { siteId: site.id });

      if (cloudflare.isEnabled()) {
        try {
          await cloudflare.deleteRecordByName(site.domain);
        } catch (cfErr) {
          console.error(`[Sites:Delete] Cloudflare DNS cleanup failed:`, cfErr);
        }
      }

      logAudit("site_delete", {
        actorId: ctx.user!.sub,
        targetId: site.id,
        targetType: "site",
        targetName: site.domain,
        ip: ctx.ip ?? undefined,
      });

      return { success: true };
    }),

  // ─── Stats (CPU/RAM) ───────────────────────────────────────────────────────
  stats: protectedProcedure.input(siteIdInput).query(async ({ input, ctx }) => {
    const site = await ownedSite(ctx, input.id);
    if (!site.pm2Name) return null;

    try {
      const container = docker.getContainer(site.pm2Name);
      const stats = await container.stats({ stream: false });

      const cpuDelta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const systemDelta = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const cpuPercent = systemDelta > 0 ? (cpuDelta / systemDelta) * (stats.cpu_stats.online_cpus || 1) * 100 : 0;

      const usedMemory = stats.memory_stats.usage - (stats.memory_stats.stats?.cache || 0);
      const ramPercent = stats.memory_stats.limit ? (usedMemory / stats.memory_stats.limit) * 100 : 0;

      return {
        cpu: Math.min(100, Math.max(0, cpuPercent)),
        ram: Math.min(100, Math.max(0, ramPercent)),
        memoryUsed: usedMemory,
        memoryLimit: stats.memory_stats.limit,
      };
    } catch {
      return null;
    }
  }),

  // ─── Redeploy (rebuild from source) ────────────────────────────────────────
  redeploy: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    // restartOnly: start the current image again (new limits, new variables) without pulling or building
    .input(z.object({ id: z.string().uuid(), restartOnly: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      // The app already holds its memory. A rebuild still needs disk, and nobody may build on a full one.
      if (!input.restartOnly) await assertFits(ctx, { memoryMb: 0, newApp: false, builds: true });
      const deployment = await enqueueDeploy(site.id, { trigger: "manual", createdBy: ctx.user!.sub, reuseImage: !!input.restartOnly });
      logAudit("deploy", {
        actorId: ctx.user!.sub,
        targetId: site.id,
        targetType: "site",
        targetName: site.domain,
        metadata: { deploymentId: deployment.id },
        ip: ctx.ip ?? undefined,
      });
      return { deploymentId: deployment.id };
    }),

  // ─── Deployment history ────────────────────────────────────────────────────
  deployments: protectedProcedure
    .input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      return db
        .select({
          id: deployments.id,
          status: deployments.status,
          trigger: deployments.trigger,
          runtime: deployments.runtime,
          commitSha: deployments.commitSha,
          commitMessage: deployments.commitMessage,
          imageTag: deployments.imageTag,
          port: deployments.port,
          error: deployments.error,
          prompt: deployments.prompt,
          createdAt: deployments.createdAt,
          startedAt: deployments.startedAt,
          finishedAt: deployments.finishedAt,
          durationMs: deployments.durationMs,
        })
        .from(deployments)
        .where(eq(deployments.siteId, site.id))
        .orderBy(desc(deployments.createdAt))
        .limit(input.limit);
    }),

  // ─── One deployment, with its build log ────────────────────────────────────
  deployment: protectedProcedure
    .input(z.object({ deploymentId: z.string().uuid() }))
    .query(async ({ input, ctx }) => {
      const [deployment] = await db.select().from(deployments).where(eq(deployments.id, input.deploymentId)).limit(1);
      if (!deployment) throw new TRPCError({ code: "NOT_FOUND" });
      await ownedSite(ctx, deployment.siteId); // throws if the caller cannot see the site
      return deployment;
    }),

  // ─── Answer a question a running deploy is waiting on ──────────────────────
  answer: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ deploymentId: z.string().uuid(), promptId: z.string().max(100), value: z.string().max(100), allowOverCapacity: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const [deployment] = await db.select().from(deployments).where(eq(deployments.id, input.deploymentId)).limit(1);
      if (!deployment) throw new TRPCError({ code: "NOT_FOUND" });
      await ownedSite(ctx, deployment.siteId);
      const prompt = deployment.prompt;
      if (deployment.status !== "waiting_input" || !prompt || prompt.id !== input.promptId) {
        throw new TRPCError({ code: "CONFLICT", message: "This deploy is no longer waiting for that answer" });
      }
      if (prompt.options && !prompt.options.some((o) => o.value === input.value)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Not one of the offered answers" });
      }
      // "Start again with more memory" takes more of the server, so it passes the same check as raising the limit by hand.
      const moreMb = prompt.id === "memory" ? Number(input.value) : NaN;
      if (Number.isFinite(moreMb)) {
        const site = await ownedSite(ctx, deployment.siteId);
        if (moreMb > (site.memoryLimit || DEFAULT_APP_MEMORY_MB)) {
          const fit = await assertFits(ctx, { memoryMb: moreMb, newApp: false, builds: false }, { excludeSiteId: site.id, override: input.allowOverCapacity });
          if (fit.overridden) {
            logAudit("capacity_override", {
              actorId: ctx.user!.sub,
              targetId: site.id,
              targetType: "site",
              targetName: site.domain,
              metadata: { action: "more-memory-mid-deploy", memoryMb: moreMb, reasons: fit.reasons.map((r) => r.kind) },
              ip: ctx.ip ?? undefined,
            });
          }
        }
      }
      await db
        .update(deployments)
        .set({ answers: { ...(deployment.answers ?? {}), [input.promptId]: input.value } })
        .where(eq(deployments.id, deployment.id));
      return { success: true };
    }),

  // ─── Rollback to an earlier deployment ─────────────────────────────────────
  // Re-runs the image that deployment built, so there is no rebuild and no SHA to remember.
  rollback: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ id: z.string().uuid(), deploymentId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);

      const [target] = await db
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, input.deploymentId), eq(deployments.siteId, site.id)))
        .limit(1);
      if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Deployment not found for this site" });
      if (!target.imageTag) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "That deployment never produced an image to roll back to" });
      }

      const deployment = await enqueueDeploy(site.id, {
        trigger: "rollback",
        createdBy: ctx.user!.sub,
        commitSha: target.commitSha,
        commitMessage: target.commitMessage,
        rollbackToDeploymentId: target.id,
      });

      logAudit("rollback", {
        actorId: ctx.user!.sub,
        targetId: site.id,
        targetType: "site",
        targetName: site.domain,
        metadata: { toDeploymentId: target.id, imageTag: target.imageTag, deploymentId: deployment.id },
        ip: ctx.ip ?? undefined,
      });

      return { deploymentId: deployment.id };
    }),

  // ─── Environment variables ─────────────────────────────────────────────────
  // Values are write-only: the API stores them encrypted and never returns them.
  envList: protectedProcedure.input(siteIdInput).query(async ({ input, ctx }) => {
    const site = await ownedSite(ctx, input.id);
    return db
      .select({ key: siteEnvVars.key, buildTime: siteEnvVars.buildTime, updatedAt: siteEnvVars.updatedAt })
      .from(siteEnvVars)
      .where(eq(siteEnvVars.siteId, site.id))
      .orderBy(siteEnvVars.key);
  }),

  envSet: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ id: z.string().uuid(), key: z.string(), value: z.string().max(32768), buildTime: z.boolean().optional() }))
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      if (!isValidEnvKey(input.key)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Variable names may contain letters, digits and _ and cannot start with a digit" });
      }
      const enc = encrypt(input.value);
      await db
        .insert(siteEnvVars)
        .values({ siteId: site.id, key: input.key, ...enc, buildTime: !!input.buildTime })
        .onConflictDoUpdate({
          target: [siteEnvVars.siteId, siteEnvVars.key],
          set: { ...enc, ...(input.buildTime !== undefined ? { buildTime: input.buildTime } : {}), updatedAt: new Date() },
        });
      logAudit("secret_set", {
        actorId: ctx.user!.sub,
        targetId: site.id,
        targetType: "site",
        targetName: site.domain,
        metadata: { key: input.key },
        ip: ctx.ip ?? undefined,
      });
      // Takes effect on the next deploy.
      return { success: true };
    }),

  // Values are write-only, so switching "available during build" must not need the value again.
  envSetBuildTime: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ id: z.string().uuid(), key: z.string(), buildTime: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      const rows = await db
        .update(siteEnvVars)
        .set({ buildTime: input.buildTime, updatedAt: new Date() })
        .where(and(eq(siteEnvVars.siteId, site.id), eq(siteEnvVars.key, input.key)))
        .returning({ key: siteEnvVars.key });
      if (!rows.length) throw new TRPCError({ code: "NOT_FOUND", message: "Variable not found" });
      return { success: true };
    }),

  envUnset: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ id: z.string().uuid(), key: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      await db.delete(siteEnvVars).where(and(eq(siteEnvVars.siteId, site.id), eq(siteEnvVars.key, input.key)));
      return { success: true };
    }),

  envSetMany: permissionProcedure(PERMISSIONS.SITE_DEPLOY)
    .input(z.object({ id: z.string().uuid(), vars: z.array(envInput).min(1).max(200) }))
    .mutation(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      await upsertEnv(site.id, input.vars);
      logAudit("secret_set", {
        actorId: ctx.user!.sub,
        targetId: site.id,
        targetType: "site",
        targetName: site.domain,
        metadata: { keys: input.vars.map((v) => v.key) },
        ip: ctx.ip ?? undefined,
      });
      return { count: input.vars.length };
    }),

  // ─── Runtime logs of the live container ────────────────────────────────────
  // ─── How the running container is doing ────────────────────────────────────
  // Restarts after a deploy (crash loops) are invisible in the deploy history,
  // so the app page asks for this and offers a fix when the app keeps crashing.
  runtime: protectedProcedure.input(siteIdInput).query(async ({ input, ctx }) => {
    const site = await ownedSite(ctx, input.id);
    if (!site.pm2Name) return null;
    try {
      const c = docker.getContainer(site.pm2Name);
      const info: any = await c.inspect();
      const restarts = Number(info.RestartCount ?? 0);
      let lastOutput = "";
      if (restarts > 0 || !info.State?.Running) {
        const buf = (await c.logs({ stdout: true, stderr: true, tail: 60 })) as unknown as Buffer;
        lastOutput = demuxLogs(Buffer.from(buf)).map((l) => l.text).join("\n");
      }
      const outOfMemory =
        !!info.State?.OOMKilled ||
        info.State?.ExitCode === 137 ||
        /heap out of memory|Allocation failed - JavaScript heap|java\.lang\.OutOfMemoryError|MemoryError|Cannot allocate memory/i.test(lastOutput);
      return {
        container: site.pm2Name,
        running: !!info.State?.Running,
        restarting: !!info.State?.Restarting,
        restarts,
        startedAt: info.State?.StartedAt ?? null,
        exitCode: info.State?.ExitCode ?? null,
        outOfMemory,
        memoryLimitMb: site.memoryLimit ?? 512,
        lastOutput: lastOutput.split("\n").slice(-12).join("\n"),
      };
    } catch {
      return { container: site.pm2Name, running: false, restarting: false, restarts: 0, startedAt: null, exitCode: null, outOfMemory: false, memoryLimitMb: site.memoryLimit ?? 512, lastOutput: "", missing: true };
    }
  }),

  logs: protectedProcedure
    .input(z.object({ id: z.string().uuid(), tail: z.number().int().min(10).max(2000).default(300), since: z.number().int().optional() }))
    .query(async ({ input, ctx }) => {
      const site = await ownedSite(ctx, input.id);
      if (!site.pm2Name) return { container: null as string | null, running: false, lines: [] as ReturnType<typeof demuxLogs> };
      const container = docker.getContainer(site.pm2Name);
      let running = false;
      try {
        running = !!(await container.inspect()).State.Running;
      } catch {
        return { container: site.pm2Name, running: false, lines: [] as ReturnType<typeof demuxLogs> };
      }
      const buf = (await container.logs({
        follow: false,
        stdout: true,
        stderr: true,
        timestamps: true,
        ...(input.since ? { since: input.since } : { tail: input.tail }),
      })) as unknown as Buffer;
      return { container: site.pm2Name, running, lines: demuxLogs(Buffer.from(buf)) };
    }),
});
