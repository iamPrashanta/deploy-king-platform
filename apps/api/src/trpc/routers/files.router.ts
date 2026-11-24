import { z } from "zod";
import { router, permissionProcedure } from "../trpc";
import { PERMISSIONS } from "../../utils/rbac";
import { requireSite } from "../../services/team";
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

export const filesRouter = router({
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
      
      return { success: true };
    }),
});
