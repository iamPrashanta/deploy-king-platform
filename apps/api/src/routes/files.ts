import { Router, type Request, type Response } from "express";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import multer from "multer";
import AdmZip from "adm-zip";
import { TRPCError } from "@trpc/server";
import { db, users } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { logAudit } from "@dbbkp/audit";
import { verifyToken } from "../middleware/requireAuth";
import { hasPermission, PERMISSIONS } from "../utils/rbac";
import { inside, rootFor } from "../trpc/routers/files.router";

/**
 * Data · Files: downloads and uploads, which do not fit in tRPC calls.
 *   GET  /api/files/download?siteId&volume&path   a file as it is, or a folder as .zip
 *   POST /api/files/upload?siteId&volume&path     multipart "files" into that folder of a volume
 * Same rules as the files router: the right to deploy, on an app this user may see; the source is read only.
 */

const router = Router();
const ZIP_MAX_BYTES = 256 * 1024 * 1024; // built in memory; larger folders: "Back up volume" makes a .tar.gz
const UPLOAD_MAX_BYTES = 512 * 1024 * 1024;
const upload = multer({ dest: path.join(os.tmpdir(), "dk-uploads"), limits: { fileSize: UPLOAD_MAX_BYTES, files: 50 } });

const STATUS: Record<string, number> = { NOT_FOUND: 404, FORBIDDEN: 403, BAD_REQUEST: 400, CONFLICT: 409, PRECONDITION_FAILED: 412, UNAUTHORIZED: 401 };

async function allowed(req: Request, res: Response) {
  const header = req.headers.authorization;
  const user = await verifyToken(header?.startsWith("Bearer ") ? header.slice(7) : null);
  if (!user) return void res.status(401).json({ error: "Sign in again." });
  const [u] = await db.select({ suspendedAt: users.suspendedAt, mustChangePassword: users.mustChangePassword }).from(users).where(eq(users.id, user.sub)).limit(1);
  if (!u || u.suspendedAt || u.mustChangePassword) return void res.status(401).json({ error: "Sign in again." });
  if (!(await hasPermission(user.sub, PERMISSIONS.SITE_DEPLOY))) return void res.status(403).json({ error: `Missing required permission: ${PERMISSIONS.SITE_DEPLOY}` });
  return user;
}

const fail = (res: Response, e: any) => {
  if (e instanceof TRPCError) return res.status(STATUS[e.code] ?? 500).json({ error: e.message });
  console.error("[files]", e);
  return res.status(500).json({ error: e?.message ?? "Something went wrong" });
};

const q = (v: unknown) => (typeof v === "string" ? v : "");

/** Files under a folder, links left out (they could point anywhere on the server). */
async function walk(dir: string, base: string, out: Array<{ full: string; rel: string; size: number }>, budget: { bytes: number }) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).split(path.sep).join("/");
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) await walk(full, base, out, budget);
    else if (e.isFile()) {
      const size = (await fs.lstat(full)).size;
      budget.bytes += size;
      if (budget.bytes > ZIP_MAX_BYTES) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "This folder is over 256 MB. Use Back up volume to get it as one .tar.gz file." });
      out.push({ full, rel, size });
    }
  }
}

router.get("/download", async (req, res) => {
  try {
    const user = await allowed(req, res);
    if (!user) return;
    const r = await rootFor(user, q(req.query.siteId), q(req.query.volume) || null);
    const full = await inside(r.root, q(req.query.path) || "/");
    const st = await fs.lstat(full).catch(() => null);
    if (!st) return res.status(404).json({ error: "It is not there any more." });
    const label = full === path.resolve(r.root) ? `${r.site.domain.split(".")[0]}-${q(req.query.volume) || "source"}` : path.basename(full);
    if (st.isFile()) {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(label)}"`);
      res.setHeader("Content-Length", String(st.size));
      return fs.createReadStream(full).pipe(res);
    }
    if (!st.isDirectory()) return res.status(400).json({ error: "Only files and folders can be downloaded." });
    const files: Array<{ full: string; rel: string; size: number }> = [];
    await walk(full, full, files, { bytes: 0 });
    const zip = new AdmZip();
    for (const f of files) zip.addFile(f.rel, await fs.readFile(f.full));
    const buf = zip.toBuffer();
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${encodeURIComponent(label)}.zip"`);
    res.setHeader("Content-Length", String(buf.length));
    return res.end(buf);
  } catch (e) {
    return fail(res, e);
  }
});

router.post("/upload", (req, res, next) => {
  allowed(req, res).then((user) => {
    if (!user) return;
    (req as any).user = user;
    upload.array("files", 50)(req, res, (err: any) => {
      if (err) return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "A file is over 512 MB." : err.message });
      next();
    });
  }, (e) => fail(res, e));
}, async (req, res) => {
  const files = ((req as any).files ?? []) as Express.Multer.File[];
  try {
    const user = (req as any).user;
    const volume = q(req.query.volume) || null;
    const r = await rootFor(user, q(req.query.siteId), volume);
    if (r.readOnly) return res.status(403).json({ error: "The app's source is read only here. It changes with each deploy." });
    const dir = await inside(r.root, q(req.query.path) || "/");
    if (!(await fs.stat(dir).catch(() => null))?.isDirectory()) return res.status(404).json({ error: "That folder is not there any more." });
    const overwrite = req.query.overwrite === "1";
    const saved: string[] = [];
    for (const f of files) {
      const name = path.basename(f.originalname.replace(/\\/g, "/"));
      if (!name || name === "." || name === ".." || name.includes("\0")) return res.status(400).json({ error: `"${f.originalname}" is not a file name that can be used.` });
      const to = await inside(r.root, path.posix.join(q(req.query.path) || "/", name));
      if (!overwrite && (await fs.pathExists(to))) return res.status(409).json({ error: `${name} is already there.`, exists: name });
    }
    for (const f of files) {
      const name = path.basename(f.originalname.replace(/\\/g, "/"));
      const to = await inside(r.root, path.posix.join(q(req.query.path) || "/", name));
      await fs.move(f.path, to, { overwrite: true });
      saved.push(name);
    }
    logAudit("file_upload", { actorId: user.sub, targetId: r.site.id, targetType: "site", targetName: r.site.domain, metadata: { volume, path: q(req.query.path) || "/", files: saved, bytes: files.reduce((n, f) => n + f.size, 0) }, ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress || undefined });
    return res.json({ saved });
  } catch (e) {
    return fail(res, e);
  } finally {
    for (const f of files) await fs.remove(f.path).catch(() => {});
  }
});

export default router;
