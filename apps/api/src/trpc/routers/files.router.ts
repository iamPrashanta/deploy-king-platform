import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { router, permissionProcedure } from "../trpc";
import { PERMISSIONS } from "../../utils/rbac";
import { requireSite, visibleSites } from "../../services/team";
import { db, backups, deployments, sites, type Site } from "@dbbkp/db";
import { logAudit } from "@dbbkp/audit";
import { VolumeError, folderBytes, realInsideRoot, volumeDir } from "@dbbkp/backup";
import fs from "fs-extra";
import path from "path";

// Utility to ensure we don't traverse out of the docRoot
function getSafePath(docRoot: string, requestPath: string): string {
  const root = path.resolve(docRoot);
  const safePath = path.resolve(root, "." + path.posix.normalize("/" + requestPath.replace(/\\/g, "/")));
  // "startsWith(root)" alone would also accept a sibling folder such as <root>-other.
  if (safePath !== root && !safePath.startsWith(root + path.sep)) {
    throw new Error("Path traversal blocked");
  }
  return safePath;
}

// Source files can hold secrets and writing them changes the app, so every call needs the right to deploy
// (viewers do not have it) on an app this user may see.
const fileProcedure = permissionProcedure(PERMISSIONS.SITE_DEPLOY);

/** Files the editor opens: text up to 1 MB. */
export const EDIT_MAX_BYTES = 1024 * 1024;

const volumeRule = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,40}$/);
const where = z.object({ siteId: z.string().uuid(), volume: volumeRule.nullable().default(null), path: z.string().max(1000).default("/") });

/**
 * The folder a request works in: one of the app's volumes, or (volume = null) the app's source, which is read only here.
 * Throws "not found" for an app the user cannot see or a volume the app does not have.
 */
export async function rootFor(user: { sub: string; role: string }, siteId: string, volume: string | null): Promise<{ site: Site; root: string; readOnly: boolean }> {
  const site = await requireSite(user, siteId);
  if (volume === null) {
    if (!(await fs.pathExists(site.docRoot))) throw new TRPCError({ code: "NOT_FOUND", message: "The app's source is not on this server yet." });
    return { site, root: site.docRoot, readOnly: true };
  }
  if (!(site.volumes ?? []).some((v) => v.name === volume)) throw new TRPCError({ code: "NOT_FOUND", message: "The app has no such volume." });
  try {
    return { site, root: await volumeDir(site.id, volume), readOnly: false };
  } catch (e) {
    if (e instanceof VolumeError) throw new TRPCError({ code: "PRECONDITION_FAILED", message: e.message });
    throw e;
  }
}

/** A path inside the root, after links. "Bad request" for anything that would leave it. */
export async function inside(root: string, rel: string) {
  try {
    return await realInsideRoot(root, rel);
  } catch (e) {
    if (e instanceof VolumeError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
    throw e;
  }
}

const relOf = (root: string, full: string) => "/" + path.relative(root, full).split(path.sep).join("/");
const okName = (n: string) => n.length > 0 && n.length <= 255 && n !== "." && n !== ".." && !/[/\\\0]/.test(n);

function writable(r: { readOnly: boolean }) {
  if (r.readOnly) throw new TRPCError({ code: "FORBIDDEN", message: "The app's source is read only here. It changes with each deploy." });
}

const audit = (ctx: any, action: "file_edit" | "file_delete" | "folder_create", site: Site, volume: string | null, file: string, metadata: Record<string, unknown> = {}) =>
  logAudit(action, { actorId: ctx.user!.sub, targetId: site.id, targetType: "site", targetName: site.domain, metadata: { volume, path: file, ...metadata }, ip: ctx.ip ?? undefined });

export const filesRouter = router({
  // ── Volumes and the source, for Data · Files ──────────────────────────────
  /** Every app volume and app source this user can open. */
  roots: fileProcedure.query(async ({ ctx }) => {
    const limit = await visibleSites(ctx.user!);
    const rows = (await db.select().from(sites).where(limit)).filter((s) => !s.isPreview).sort((a, b) => a.domain.localeCompare(b.domain));
    const ids = rows.map((s) => s.id);
    const latest = new Map<string, string | null>();
    if (ids.length) {
      for (const d of await db.select({ siteId: deployments.siteId, sha: deployments.commitSha, status: deployments.status }).from(deployments).where(and(inArray(deployments.siteId, ids), eq(deployments.status, "active"))).orderBy(desc(deployments.createdAt))) {
        if (!latest.has(d.siteId)) latest.set(d.siteId, d.sha);
      }
    }
    const volumes = await Promise.all(rows.flatMap((s) => (s.volumes ?? []).map(async (v) => {
      const reach = await volumeDir(s.id, v.name).then(() => null, (e) => (e instanceof VolumeError ? e.message : String(e?.message ?? e)));
      return { siteId: s.id, app: s.domain.split(".")[0], domain: s.domain, volume: v.name, mountPath: v.mountPath, reachable: !reach, problem: reach };
    })));
    const sources = await Promise.all(rows.map(async (s) => ({ siteId: s.id, app: s.domain.split(".")[0], domain: s.domain, commit: latest.get(s.id)?.slice(0, 7) ?? null, present: await fs.pathExists(s.docRoot) })));
    return { volumes, sources: sources.filter((s) => s.present) };
  }),

  browse: fileProcedure.input(where).query(async ({ ctx, input }) => {
    const r = await rootFor(ctx.user!, input.siteId, input.volume);
    const dir = await inside(r.root, input.path);
    const stat = await fs.stat(dir).catch(() => null);
    if (!stat?.isDirectory()) throw new TRPCError({ code: "NOT_FOUND", message: "That folder is not there any more." });
    const names = await fs.readdir(dir, { withFileTypes: true });
    const entries = (await Promise.all(names.map(async (e) => {
      const full = path.join(dir, e.name);
      const st = await fs.lstat(full).catch(() => null);
      return { name: e.name, path: relOf(r.root, full), isDirectory: e.isDirectory(), isLink: e.isSymbolicLink(), size: e.isFile() ? st?.size ?? 0 : null, modifiedAt: st?.mtime ?? null };
    }))).sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
    let lastBackup: { at: Date | null; status: string } | null = null;
    if (input.volume) {
      const [b] = await db.select().from(backups).where(and(eq(backups.targetKey, `vol:${r.site.id}:${input.volume}`), inArray(backups.status, ["ok", "partial"]))).orderBy(desc(backups.createdAt)).limit(1);
      if (b) lastBackup = { at: b.finishedAt ?? b.createdAt, status: b.status };
    }
    return { path: relOf(r.root, dir), readOnly: r.readOnly, entries, filesBytes: entries.reduce((n, e) => n + (e.size ?? 0), 0), lastBackup };
  }),

  /** Total size of a volume (stops counting after 200,000 entries). */
  usage: fileProcedure.input(z.object({ siteId: z.string().uuid(), volume: volumeRule.nullable().default(null) })).query(async ({ ctx, input }) => {
    const r = await rootFor(ctx.user!, input.siteId, input.volume);
    return folderBytes(r.root);
  }),

  read: fileProcedure.input(where).query(async ({ ctx, input }) => {
    const r = await rootFor(ctx.user!, input.siteId, input.volume);
    const file = await inside(r.root, input.path);
    const st = await fs.stat(file).catch(() => null);
    if (!st?.isFile()) throw new TRPCError({ code: "NOT_FOUND", message: "That file is not there any more." });
    const base = { path: relOf(r.root, file), size: st.size, modifiedAt: st.mtime, readOnly: r.readOnly };
    if (st.size > EDIT_MAX_BYTES) return { ...base, content: null, reason: "Too large to open here (over 1 MB). Download it instead." };
    const buf = await fs.readFile(file);
    if (buf.subarray(0, 8000).includes(0)) return { ...base, content: null, reason: "Not a text file. Download it instead." };
    return { ...base, content: buf.toString("utf8"), reason: null };
  }),

  write: fileProcedure
    .input(where.extend({ content: z.string().max(EDIT_MAX_BYTES), expectedModifiedAt: z.string().datetime().nullable().default(null) }))
    .mutation(async ({ ctx, input }) => {
      const r = await rootFor(ctx.user!, input.siteId, input.volume);
      writable(r);
      const file = await inside(r.root, input.path);
      if (file === path.resolve(r.root)) throw new TRPCError({ code: "BAD_REQUEST", message: "Choose a file." });
      const st = await fs.stat(file).catch(() => null);
      if (st?.isDirectory()) throw new TRPCError({ code: "BAD_REQUEST", message: "That is a folder." });
      // someone (or the app) changed it after it was opened
      if (st && input.expectedModifiedAt && Math.abs(st.mtime.getTime() - Date.parse(input.expectedModifiedAt)) > 1000) {
        throw new TRPCError({ code: "CONFLICT", message: "The file changed since you opened it. Open it again to see the new version." });
      }
      await fs.ensureDir(path.dirname(file));
      await fs.writeFile(file + ".dk-part", input.content);
      await fs.rename(file + ".dk-part", file);
      const after = await fs.stat(file);
      audit(ctx, "file_edit", r.site, input.volume, relOf(r.root, file), { bytes: after.size, created: !st });
      return { size: after.size, modifiedAt: after.mtime };
    }),

  mkdir: fileProcedure.input(where.extend({ name: z.string() })).mutation(async ({ ctx, input }) => {
    const r = await rootFor(ctx.user!, input.siteId, input.volume);
    writable(r);
    if (!okName(input.name)) throw new TRPCError({ code: "BAD_REQUEST", message: "A folder name cannot contain / or \\." });
    const dir = await inside(r.root, path.posix.join(input.path, input.name));
    if (await fs.pathExists(dir)) throw new TRPCError({ code: "CONFLICT", message: `${input.name} is already there.` });
    await fs.ensureDir(dir);
    audit(ctx, "folder_create", r.site, input.volume, relOf(r.root, dir));
    return { path: relOf(r.root, dir) };
  }),

  remove: fileProcedure.input(where).mutation(async ({ ctx, input }) => {
    const r = await rootFor(ctx.user!, input.siteId, input.volume);
    writable(r);
    const full = await inside(r.root, input.path);
    if (full === path.resolve(r.root)) throw new TRPCError({ code: "BAD_REQUEST", message: "The volume itself cannot be removed here." });
    const st = await fs.lstat(full).catch(() => null);
    if (!st) throw new TRPCError({ code: "NOT_FOUND", message: "It is not there any more." });
    await fs.remove(full);
    audit(ctx, "file_delete", r.site, input.volume, relOf(r.root, full), { folder: st.isDirectory(), bytes: st.isFile() ? st.size : null });
    return { ok: true };
  }),

  // ── The app's source folder (older procedures) ────────────────────────────
  list: fileProcedure
    .input(z.object({ siteId: z.string().uuid(), directory: z.string().default("/") }))
    .query(async ({ input, ctx }) => {
      const site = await requireSite(ctx.user!, input.siteId);

      const targetPath = getSafePath(site.docRoot, input.directory);

      if (!await fs.pathExists(targetPath)) {
        throw new Error("Directory does not exist");
      }

      const items = await fs.readdir(targetPath, { withFileTypes: true });

      return items.map(item => ({
        name: item.name,
        isDirectory: item.isDirectory(),
        path: path.posix.join(input.directory, item.name),
      })).sort((a, b) => {
        // Sort directories first
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
      });
    }),

  readFile: fileProcedure
    .input(z.object({ siteId: z.string().uuid(), filePath: z.string() }))
    .query(async ({ input, ctx }) => {
      const site = await requireSite(ctx.user!, input.siteId);

      const targetPath = getSafePath(site.docRoot, input.filePath);

      if (!await fs.pathExists(targetPath)) {
        throw new Error("File does not exist");
      }

      const stat = await fs.stat(targetPath);
      if (stat.size > 5 * 1024 * 1024) { // 5MB limit for inline viewing
        throw new Error("File too large to view in editor (max 5MB).");
      }

      const content = await fs.readFile(targetPath, "utf-8");
      return content;
    }),

  writeFile: fileProcedure
    .input(z.object({ siteId: z.string().uuid(), filePath: z.string(), content: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const site = await requireSite(ctx.user!, input.siteId);

      const targetPath = getSafePath(site.docRoot, input.filePath);

      await fs.ensureDir(path.dirname(targetPath));
      await fs.writeFile(targetPath, input.content);
      logAudit("file_edit", { actorId: ctx.user!.sub, targetId: site.id, targetType: "site", targetName: site.domain, metadata: { volume: null, path: input.filePath, source: true }, ip: ctx.ip ?? undefined });

      return { success: true };
    }),

  delete: fileProcedure
    .input(z.object({ siteId: z.string().uuid(), targetPath: z.string() }))
    .mutation(async ({ input, ctx }) => {
      const site = await requireSite(ctx.user!, input.siteId);

      const absPath = getSafePath(site.docRoot, input.targetPath);

      // Prevent deleting the root document root itself
      if (absPath === path.resolve(site.docRoot)) {
        throw new Error("Cannot delete document root");
      }

      await fs.remove(absPath);
      logAudit("file_delete", { actorId: ctx.user!.sub, targetId: site.id, targetType: "site", targetName: site.domain, metadata: { volume: null, path: input.targetPath, source: true }, ip: ctx.ip ?? undefined });

      return { success: true };
    }),
});
