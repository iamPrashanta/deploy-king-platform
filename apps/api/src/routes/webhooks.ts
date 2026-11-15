import { Router } from "express";
import crypto from "node:crypto";
import { db, sites, pipelines } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { hostingQueue } from "../queues";
import { enqueueDeploy } from "../services/deploy";
import { enqueuePipelineRun } from "../services/pipelines";
import { normalizeRepoUrl, isValidBranch, siteDocRoot } from "../services/validation";

const router = Router();

const PREVIEW_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * GitHub signs the exact bytes it sent. We compare against the raw request
 * body captured by express.json({ verify }) - never a re-serialised object.
 */
function verifyGitHubSignature(rawBody: Buffer, signature: string, secret: string): boolean {
  const expected = Buffer.from(`sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`);
  const provided = Buffer.from(signature);
  // timingSafeEqual throws on length mismatch; a malformed header is a 401, not a 500.
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

router.post("/github", async (req, res) => {
  try {
    const signature = req.headers["x-hub-signature-256"];
    const event = req.headers["x-github-event"];
    const secret = process.env.GITHUB_WEBHOOK_SECRET;

    if (typeof event !== "string") {
      res.status(400).json({ error: "Missing x-github-event header" });
      return;
    }

    // Signature verification is mandatory. An unsigned endpoint lets anyone who
    // knows a repository URL trigger deployments.
    const allowUnsigned = process.env.ALLOW_UNSIGNED_WEBHOOKS === "true" && process.env.NODE_ENV !== "production";
    if (!secret) {
      if (!allowUnsigned) {
        res.status(503).json({ error: "Webhooks are disabled: GITHUB_WEBHOOK_SECRET is not configured" });
        return;
      }
      console.warn("[Webhook] ALLOW_UNSIGNED_WEBHOOKS=true - accepting an unsigned webhook (development only).");
    } else {
      const rawBody: Buffer | undefined = (req as any).rawBody;
      if (typeof signature !== "string" || !rawBody || !verifyGitHubSignature(rawBody, signature, secret)) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }

    if (event === "ping") {
      res.json({ ok: true, pong: true });
      return;
    }

    const payload = req.body ?? {};
    const repoKey = normalizeRepoUrl(payload.repository?.clone_url || payload.repository?.html_url);
    if (!repoKey) {
      res.status(400).json({ error: "No repository URL found in payload" });
      return;
    }

    const triggered = { pipelines: 0, sites: 0, previews: 0 };

    if (event === "push") {
      // Branch deletions also arrive as push events; there is nothing to deploy.
      if (payload.deleted) {
        res.json({ ok: true, skipped: "branch deleted" });
        return;
      }
      const branch = String(payload.ref || "").replace("refs/heads/", "") || "main";
      const commitSha: string | null = payload.after || payload.head_commit?.id || null;
      const commitMessage: string | null = payload.head_commit?.message || null;

      // 1. Pipelines linked to this repository + branch
      const allPipelines = await db.select().from(pipelines).where(eq(pipelines.enabled, true));
      for (const pipeline of allPipelines) {
        if (normalizeRepoUrl(pipeline.repoUrl) !== repoKey || (pipeline.branch ?? "main") !== branch) continue;
        console.log(`[Webhook] Triggering pipeline ${pipeline.name} (${branch})`);
        await enqueuePipelineRun(pipeline, { commitSha });
        triggered.pipelines += 1;
      }

      // 2. Sites linked to this repository + branch
      const gitSites = await db.select().from(sites).where(eq(sites.source, "git"));
      for (const site of gitSites) {
        if (normalizeRepoUrl(site.repoUrl) !== repoKey) continue;
        if ((site.branch ?? "main") !== branch || !site.active || site.isPreview || site.autoDeploy === false) continue;
        console.log(`[Webhook] Auto-deploying ${site.domain} (${branch} @ ${commitSha?.slice(0, 7) ?? "?"})`);
        await enqueueDeploy(site.id, { trigger: "webhook", commitSha, commitMessage, createdBy: site.userId });
        triggered.sites += 1;
      }
    } else if (event === "pull_request") {
      const action = payload.action;
      const prNumber = Number(payload.pull_request?.number);
      const branch = payload.pull_request?.head?.ref;

      if (!Number.isInteger(prNumber) || typeof branch !== "string" || !isValidBranch(branch)) {
        res.status(400).json({ error: "Invalid PR payload" });
        return;
      }

      const gitSites = await db.select().from(sites).where(eq(sites.source, "git"));
      const parentSite = gitSites.find((s) => !s.isPreview && normalizeRepoUrl(s.repoUrl) === repoKey);

      if (parentSite) {
        const previewDomain = `pr-${prNumber}-${parentSite.domain}`;
        const [existingPreview] = await db.select().from(sites).where(eq(sites.domain, previewDomain)).limit(1);

        if (action === "opened" || action === "synchronize" || action === "reopened") {
          let previewSiteId = existingPreview?.id;
          const expiresAt = new Date(Date.now() + PREVIEW_TTL_MS);

          if (!existingPreview) {
            const id = crypto.randomUUID();
            await db.insert(sites).values({
              id,
              userId: parentSite.userId, // previews belong to the owner of the parent site
              domain: previewDomain,
              type: parentSite.type,
              docRoot: siteDocRoot(id),
              source: "git",
              repoUrl: parentSite.repoUrl,
              branch,
              buildCommand: parentSite.buildCommand,
              startCommand: parentSite.startCommand,
              isPreview: true,
              isTemporary: true,
              expiresAt,
              parentSiteId: parentSite.id,
              active: true,
              status: "provisioning",
            });
            previewSiteId = id;
          } else {
            await db.update(sites).set({ branch, expiresAt, active: true }).where(eq(sites.id, existingPreview.id));
          }

          console.log(`[Webhook] Deploying preview environment ${previewDomain}`);
          await enqueueDeploy(previewSiteId!, {
            trigger: "preview",
            commitSha: payload.pull_request?.head?.sha ?? null,
            commitMessage: payload.pull_request?.title ?? null,
            createdBy: parentSite.userId,
          });
          triggered.previews += 1;
        } else if (action === "closed" && existingPreview?.isPreview) {
          // Actually tear the preview down (containers, images, source), not just flag it.
          console.log(`[Webhook] Tearing down preview environment ${previewDomain}`);
          await db.update(sites).set({ active: false, desiredStatus: "deleted" }).where(eq(sites.id, existingPreview.id));
          await hostingQueue.add("delete-site", { siteId: existingPreview.id });
        }
      }
    }

    res.json({ ok: true, triggered });
  } catch (err: any) {
    console.error("[Webhook Error]:", err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

export default router;
