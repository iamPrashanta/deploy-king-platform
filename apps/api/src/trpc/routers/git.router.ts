import { z } from "zod";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import execa from "execa";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc";
import { db, gitProviders } from "@dbbkp/db";
import { desc, eq } from "drizzle-orm";
import { encrypt } from "@dbbkp/security";
import { analyzeProject, appFolders, gitAuthArgs, normalizeRootDirectory, redactToken, resolveBuildRoot, slugify } from "@dbbkp/buildplan";
import { githubRepos, githubUser, providerWithToken } from "../../services/github";
import { isValidBranch, isValidRepoUrl } from "../../services/validation";

async function tokenFor(ctx: any, providerId?: string | null) {
  if (!providerId) return null;
  return (await providerWithToken(ctx.user, providerId)).token;
}

export const gitRouter = router({
  providers: protectedProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({
        id: gitProviders.id,
        type: gitProviders.type,
        name: gitProviders.name,
        login: gitProviders.login,
        avatarUrl: gitProviders.avatarUrl,
        userId: gitProviders.userId,
        createdAt: gitProviders.createdAt,
      })
      .from(gitProviders)
      .orderBy(desc(gitProviders.createdAt));
    return ctx.user!.role === "admin" ? rows : rows.filter((r) => r.userId === ctx.user!.sub);
  }),

  connectGithub: protectedProcedure
    .input(z.object({ token: z.string().min(10).max(500), name: z.string().max(100).optional() }))
    .mutation(async ({ ctx, input }) => {
      const token = input.token.trim();
      const me = await githubUser(token); // verifies the token before storing it
      const enc = encrypt(token);
      const [row] = await db
        .insert(gitProviders)
        .values({
          userId: ctx.user!.sub,
          type: "github",
          name: input.name?.trim() || `GitHub (${me.login})`,
          login: me.login,
          avatarUrl: me.avatarUrl,
          encryptedToken: enc.encryptedValue,
          iv: enc.iv,
          authTag: enc.authTag,
        })
        .returning({ id: gitProviders.id, name: gitProviders.name, login: gitProviders.login });
      return row;
    }),

  disconnect: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const { provider } = await providerWithToken(ctx.user!, input.id);
    await db.delete(gitProviders).where(eq(gitProviders.id, provider.id));
    return { success: true };
  }),

  repos: protectedProcedure.input(z.object({ providerId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const { token } = await providerWithToken(ctx.user!, input.providerId);
    return githubRepos(token);
  }),

  /** Branches of any git URL (works for public repos without a provider). */
  branches: protectedProcedure
    .input(z.object({ repoUrl: z.string().max(2000), providerId: z.string().uuid().nullish() }))
    .query(async ({ ctx, input }) => {
      if (!isValidRepoUrl(input.repoUrl)) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a valid git URL" });
      const token = await tokenFor(ctx, input.providerId);
      try {
        const { stdout } = await execa(
          "git",
          [...gitAuthArgs(input.repoUrl, token), "ls-remote", "--symref", "--", input.repoUrl, "HEAD", "refs/heads/*"],
          { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 20_000 }
        );
        let defaultBranch: string | null = null;
        const branches: string[] = [];
        for (const line of stdout.split("\n")) {
          const sym = line.match(/^ref: refs\/heads\/(\S+)\s+HEAD$/);
          if (sym) defaultBranch = sym[1];
          const head = line.match(/\trefs\/heads\/(.+)$/);
          if (head) branches.push(head[1]);
        }
        return { defaultBranch: defaultBranch ?? branches[0] ?? "main", branches };
      } catch (err: any) {
        const msg = redactToken(String(err.stderr || err.shortMessage || err.message), token);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: /could not read Username|Authentication failed|not found/i.test(msg)
            ? "Repository not found or private. Connect GitHub in Settings to deploy private repositories."
            : `Could not reach the repository: ${msg.split("\n").slice(-2).join(" ").slice(0, 200)}`,
        });
      }
    }),

  /**
   * Project check: clones the branch into a scratch directory and analyses it
   * with the same planner the worker uses, so the user sees what was found,
   * whether it can run, and what is still needed before anything is built.
   */
  inspect: protectedProcedure
    .input(
      z.object({
        repoUrl: z.string().max(2000),
        branch: z.string().max(100),
        providerId: z.string().uuid().nullish(),
        type: z.enum(["auto", "static", "node", "python", "php", "go", "docker"]).optional(),
        port: z.number().int().min(1).max(65535).nullish(),
        rootDirectory: z.string().max(255).nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (!isValidRepoUrl(input.repoUrl)) throw new TRPCError({ code: "BAD_REQUEST", message: "Not a valid git URL" });
      if (!isValidBranch(input.branch)) throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid branch" });
      const token = await tokenFor(ctx, input.providerId);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dbbkp-inspect-"));
      try {
        try {
          await execa(
            "git",
            [...gitAuthArgs(input.repoUrl, token), "clone", "--depth=1", "--single-branch", "--branch", input.branch, "--", input.repoUrl, dir],
            { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 120_000 }
          );
        } catch (err: any) {
          const msg = redactToken(String(err.stderr || err.message), token);
          throw new TRPCError({ code: "BAD_REQUEST", message: `Clone failed: ${msg.split("\n").slice(-2).join(" ").slice(0, 200)}` });
        }
        const { stdout } = await execa("git", ["log", "-1", "--format=%H%n%an%n%cI%n%s"], { cwd: dir });
        const [sha, author, date, ...subject] = stdout.split("\n");
        const files = (await fs.readdir(dir, { withFileTypes: true }))
          .filter((f) => f.name !== ".git")
          .map((f) => ({ name: f.name, dir: f.isDirectory() }))
          .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
          .slice(0, 60);
        // The check looks at the folder that will be built, which is not always the repository root.
        let buildRoot: string;
        let rootDirectory: string | null;
        try {
          rootDirectory = normalizeRootDirectory(input.rootDirectory);
          buildRoot = resolveBuildRoot(dir, rootDirectory);
        } catch (err: any) {
          throw new TRPCError({ code: "BAD_REQUEST", message: err.message });
        }
        const report = analyzeProject(buildRoot, { type: input.type ?? "auto", port: input.port ?? null });
        return {
          rootDirectory,
          folders: appFolders(dir),
          name: slugify(input.repoUrl.split("/").pop() || "app"),
          branch: input.branch,
          commit: {
            sha: sha?.trim() || null,
            author: author?.trim() || null,
            date: date?.trim() || null,
            message: subject.join(" ").trim() || null,
          },
          files,
          report,
        };
      } finally {
        await fs.remove(dir).catch(() => {});
      }
    }),
});
