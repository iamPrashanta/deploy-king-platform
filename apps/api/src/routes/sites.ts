import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs-extra";
import crypto from "node:crypto";
import os from "os";
import { db, sites } from "@dbbkp/db";
import { desc, eq } from "drizzle-orm";
import { enqueueDeploy } from "../services/deploy";
import { DEFAULT_APP_MEMORY_MB, capacity, evaluateFit } from "../services/capacity";
import { visibleSites } from "../services/team";
import { hasPermission, PERMISSIONS } from "../utils/rbac";
import { isValidDomain, normalizeDomain, siteDocRoot } from "../services/validation";
import { extractProjectZip, UnsafeArchiveError } from "../services/zipsite";
import { ticketFileCheck } from "../services/tickets";
import type { AuthedUser } from "../middleware/requireAuth";

const router = express.Router();
const upload = multer({
  dest: path.join(os.tmpdir(), "dbbkp-uploads"),
  limits: { fileSize: 500 * 1024 * 1024, files: 1 },
});

const RUNTIMES = new Set(["auto", "static", "node", "python", "php", "go", "docker"]);

// ─── POST /api/sites/upload ──────────────────────────────────────────────────
// ZIP deployments. This router is mounted behind requireAuth.
// ticketFileCheck: on a desktop machine that requires tickets, the ZIP must be the one the ticket names.
router.post("/upload", upload.single("project"), ticketFileCheck, async (req: any, res) => {
  const user: AuthedUser = req.user;
  const file = req.file;

  try {
    if (!(await hasPermission(user.sub, PERMISSIONS.SITE_CREATE))) {
      return res.status(403).json({ error: `Missing required permission: ${PERMISSIONS.SITE_CREATE}` });
    }

    const domain = normalizeDomain(String(req.body.domain || ""));
    const type = String(req.body.type || "auto");

    if (!isValidDomain(domain)) return res.status(400).json({ error: "Domain must be a valid hostname" });
    if (!RUNTIMES.has(type)) return res.status(400).json({ error: "Unknown runtime" });
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    const [taken] = await db.select({ id: sites.id }).from(sites).where(eq(sites.domain, domain)).limit(1);
    if (taken) return res.status(409).json({ error: `Domain ${domain} is already in use` });

    // Will it fit? Same rule as apps created from a repository or an image.
    const fit = evaluateFit(await capacity(), { memoryMb: DEFAULT_APP_MEMORY_MB, newApp: true, builds: true });
    const deployAnyway = fit.overridable && user.role === "admin" && String(req.body.allowOverCapacity || "") === "true";
    if (fit.verdict === "blocked" && !deployAnyway) {
      return res.status(409).json({ error: `This does not fit on the server. ${fit.reasons.map((r) => r.text).join(" ")}`, fit });
    }

    const siteId = crypto.randomUUID();
    const sitePath = siteDocRoot(siteId);
    try {
      await extractProjectZip(file.path, sitePath);
    } catch (e) {
      if (e instanceof UnsafeArchiveError) return res.status(400).json({ error: e.message });
      throw e;
    }

    const [newSite] = await db
      .insert(sites)
      .values({
        id: siteId,
        userId: user.sub,
        domain,
        type,
        docRoot: sitePath,
        port: null,
        source: "zip",
        status: "provisioning",
      })
      .returning();

    const deployment = await enqueueDeploy(newSite.id, { trigger: "manual", createdBy: user.sub });

    return res.json({ success: true, siteId: newSite.id, deploymentId: deployment.id, domain, runtime: type });
  } catch (err: any) {
    console.error("[Sites:Upload] FAILED:", err);
    return res.status(500).json({ error: "Upload failed" });
  } finally {
    if (file?.path) await fs.remove(file.path).catch(() => {});
  }
});

// ─── GET /api/sites ──────────────────────────────────────────────────────────
router.get("/", async (req: any, res) => {
  try {
    const user: AuthedUser = req.user;
    const rows = await db.select().from(sites).where(await visibleSites(user)).orderBy(desc(sites.createdAt));
    return res.json(rows);
  } catch (err) {
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
