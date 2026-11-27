import { z } from "zod";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import execa from "execa";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, adminProcedure, type Context } from "../trpc";
import { db, gitProviders, githubAppInstallations } from "@dbbkp/db";
import { logAudit } from "@dbbkp/audit";
import * as ghApp from "@dbbkp/github";
import { JWT_SECRET, PUBLIC_API_URL } from "../../config";
import { desc, eq } from "drizzle-orm";
import { encrypt } from "@dbbkp/security";
import { analyzeProject, appFolders, gitAuthArgs, normalizeRootDirectory, redactToken, resolveBuildRoot, slugify } from "@dbbkp/buildplan";
import { githubUser, providerRepos, providerWithToken } from "../../services/github";
import { isValidBranch, isValidRepoUrl } from "../../services/validation";

async function tokenFor(ctx: any, providerId?: string | null) {
  if (!providerId) return null;
  return (await providerWithToken(ctx.user, providerId)).token;
}

/** The GitHub App holds keys for every repository it can see: only people in the panel may manage it, never agent tokens. */
function panelOnly(ctx: Context) {
  if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "The GitHub App can only be managed in the panel." });
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
    const [provider] = await db.select().from(gitProviders).where(eq(gitProviders.id, input.id)).limit(1);
    if (!provider || (ctx.user!.role !== "admin" && provider.userId !== ctx.user!.sub)) throw new TRPCError({ code: "NOT_FOUND", message: "Git provider not found" });
    if (provider.type === "github_app") throw new TRPCError({ code: "BAD_REQUEST", message: "This is a GitHub App installation. Uninstall it on GitHub, then press Refresh on the Connect GitHub page." });
    await db.delete(gitProviders).where(eq(gitProviders.id, provider.id));
    return { success: true };
  }),

  repos: protectedProcedure.input(z.object({ providerId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const { provider, token } = await providerWithToken(ctx.user!, input.providerId);
    return providerRepos(provider, token);
  }),

  // ── The GitHub App (Settings › GitHub › Connect GitHub) ────────────────────

  /** The app, if it was created, and where it is installed. */
  app: adminProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    const app = await ghApp.getApp();
    const installs = await db.select().from(githubAppInstallations).orderBy(desc(githubAppInstallations.createdAt));
    return {
      app: app ? { appId: app.appId, slug: app.slug, name: app.name, owner: app.owner, htmlUrl: app.htmlUrl, createdAt: app.createdAt } : null,
      installUrl: app ? `https://github.com/apps/${app.slug}/installations/new` : null,
      installations: installs.map((i) => ({ installationId: i.installationId, providerId: i.providerId, account: i.account, accountType: i.accountType, repositorySelection: i.repositorySelection, suspended: !!i.suspendedAt, settingsUrl: i.accountType === "Organization" ? `https://github.com/organizations/${i.account}/settings/installations/${i.installationId}` : `https://github.com/settings/installations/${i.installationId}` })),
      webhookFromEnv: !!process.env.GITHUB_WEBHOOK_SECRET,
    };
  }),

  /** Step 1: what the panel posts to GitHub to create the app. `origin` is the panel's address as the browser sees it. */
  appManifest: adminProcedure
    .input(z.object({ origin: z.string().trim().max(300).regex(/^https?:\/\/[^\s/]+$/i, "The panel's address, such as https://panel.example.com"), organization: z.string().trim().regex(/^[A-Za-z0-9-]{1,39}$/).optional() }))
    .mutation(async ({ ctx, input }) => {
      panelOnly(ctx);
      if (await ghApp.getApp()) throw new TRPCError({ code: "CONFLICT", message: "The GitHub App is already created. Remove it first to make a new one." });
      const host = new URL(input.origin).hostname;
      const webhookUrl = `${PUBLIC_API_URL || input.origin}/webhooks/github`;
      const manifest = ghApp.appManifest({ name: `Deploy King (${host})`, panelUrl: input.origin, webhookUrl });
      const state = ghApp.signState(ctx.user!.sub, JWT_SECRET);
      const base = input.organization ? `https://github.com/organizations/${input.organization}/settings/apps/new` : "https://github.com/settings/apps/new";
      return { postUrl: `${base}?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(manifest), webhookUrl, public: !/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host) };
    }),

  /** GitHub sent the admin back with a one-time code: keep the app's keys, encrypted. */
  appComplete: adminProcedure.input(z.object({ code: z.string().trim().min(1).max(100), state: z.string().trim().min(10).max(500) })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    if (!ghApp.checkState(input.state, ctx.user!.sub, JWT_SECRET)) throw new TRPCError({ code: "BAD_REQUEST", message: "This link from GitHub has expired or was started by someone else. Start again." });
    if (await ghApp.getApp()) throw new TRPCError({ code: "CONFLICT", message: "The GitHub App is already created." });
    try {
      const app = await ghApp.completeManifest(input.code, ctx.user!.sub);
      logAudit("github_app_create", { actorId: ctx.user!.sub, targetType: "github_app", targetName: app.slug, metadata: { appId: app.appId, owner: app.owner }, ip: ctx.ip ?? undefined });
      return { name: app.name, slug: app.slug, installUrl: `https://github.com/apps/${app.slug}/installations/new` };
    } catch (e: any) {
      throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "GitHub did not create the app" });
    }
  }),

  /** After installing (GitHub sends the admin back with installation_id), or by hand with Refresh. */
  appSync: adminProcedure.mutation(async ({ ctx }) => {
    panelOnly(ctx);
    if (!(await ghApp.getApp())) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Create the GitHub App first." });
    try {
      const out = await ghApp.syncInstallations(ctx.user!.sub);
      logAudit("github_app_install", { actorId: ctx.user!.sub, targetType: "github_app", metadata: out, ip: ctx.ip ?? undefined });
      return out;
    } catch (e: any) {
      throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "Could not read the installations from GitHub" });
    }
  }),

  /** Repositories one installation can see, for the Connect GitHub page. */
  appRepos: adminProcedure.input(z.object({ installationId: z.number().int().positive() })).query(async ({ ctx, input }) => {
    panelOnly(ctx);
    const [inst] = await db.select().from(githubAppInstallations).where(eq(githubAppInstallations.installationId, input.installationId)).limit(1);
    if (!inst) throw new TRPCError({ code: "NOT_FOUND", message: "Installation not found" });
    try {
      const repos = await ghApp.installationRepos(inst.installationId);
      return repos.map((r: any) => ({ fullName: String(r.full_name), name: String(r.name), private: !!r.private }));
    } catch (e: any) {
      throw new TRPCError({ code: "BAD_REQUEST", message: e?.message ?? "GitHub did not answer" });
    }
  }),

  /** Forget the app here. Delete it on GitHub too (its page has the button). */
  appRemove: adminProcedure.input(z.object({ confirm: z.literal("remove") })).mutation(async ({ ctx }) => {
    panelOnly(ctx);
    const app = await ghApp.getApp();
    if (!app) throw new TRPCError({ code: "NOT_FOUND", message: "There is no GitHub App to remove." });
    const out = await ghApp.removeApp();
    logAudit("github_app_remove", { actorId: ctx.user!.sub, targetType: "github_app", targetName: app.slug, metadata: out, ip: ctx.ip ?? undefined });
    return { ...out, htmlUrl: app.htmlUrl };
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
