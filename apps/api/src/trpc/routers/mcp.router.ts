import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { db, apiTokens, mcpCalls } from "@dbbkp/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { logAudit } from "@dbbkp/audit";
import { router, protectedProcedure, permissionProcedure, type Context } from "../trpc";
import { PERMISSIONS } from "../../utils/rbac";
import { TOKEN_SCOPES, newToken } from "../../services/apiTokens";
import { TOOLS } from "../../mcp/tools";

const MAX_TOKENS = 20;

/** Token management happens in the panel only: an agent's own token must not mint or revoke tokens. */
function panelOnly(ctx: Context) {
  if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "Tokens can only be managed from the panel" });
}

export const mcpRouter = router({
  tokens: protectedProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    return db
      .select({
        id: apiTokens.id,
        name: apiTokens.name,
        scope: apiTokens.scope,
        prefix: apiTokens.prefix,
        expiresAt: apiTokens.expiresAt,
        lastUsedAt: apiTokens.lastUsedAt,
        lastUsedIp: apiTokens.lastUsedIp,
        createdAt: apiTokens.createdAt,
      })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, ctx.user!.sub), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt));
  }),

  createToken: permissionProcedure(PERMISSIONS.AGENT_TOKENS)
    .input(
      z.object({
        name: z.string().trim().min(1).max(100),
        scope: z.enum(TOKEN_SCOPES),
        expiresInDays: z.number().int().min(1).max(365).nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      panelOnly(ctx);
      const active = await db
        .select({ id: apiTokens.id })
        .from(apiTokens)
        .where(and(eq(apiTokens.userId, ctx.user!.sub), isNull(apiTokens.revokedAt)));
      if (active.length >= MAX_TOKENS) throw new TRPCError({ code: "BAD_REQUEST", message: `You have ${MAX_TOKENS} tokens. Revoke one first.` });
      const t = newToken();
      const expiresAt = input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86400_000) : null;
      const [row] = await db
        .insert(apiTokens)
        .values({ userId: ctx.user!.sub, name: input.name, scope: input.scope, tokenHash: t.hash, prefix: t.prefix, expiresAt })
        .returning({ id: apiTokens.id, name: apiTokens.name, scope: apiTokens.scope, prefix: apiTokens.prefix, expiresAt: apiTokens.expiresAt });
      logAudit("api_token_create", {
        actorId: ctx.user!.sub,
        targetId: row.id,
        targetType: "api_token",
        targetName: input.name,
        metadata: { scope: input.scope, expiresAt },
        ip: ctx.ip ?? undefined,
      });
      // The only time the token itself leaves the server.
      return { ...row, token: t.raw };
    }),

  revokeToken: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const [row] = await db
      .update(apiTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(apiTokens.id, input.id), eq(apiTokens.userId, ctx.user!.sub), isNull(apiTokens.revokedAt)))
      .returning({ id: apiTokens.id, name: apiTokens.name });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Token not found" });
    logAudit("api_token_revoke", { actorId: ctx.user!.sub, targetId: row.id, targetType: "api_token", targetName: row.name, ip: ctx.ip ?? undefined });
    return { success: true };
  }),

  activity: protectedProcedure.input(z.object({ limit: z.number().int().min(1).max(200).default(50) })).query(async ({ ctx, input }) => {
    panelOnly(ctx);
    return db
      .select({
        id: mcpCalls.id,
        tool: mcpCalls.tool,
        args: mcpCalls.args,
        ok: mcpCalls.ok,
        error: mcpCalls.error,
        durationMs: mcpCalls.durationMs,
        createdAt: mcpCalls.createdAt,
        tokenName: apiTokens.name,
      })
      .from(mcpCalls)
      .leftJoin(apiTokens, eq(mcpCalls.tokenId, apiTokens.id))
      .where(eq(mcpCalls.userId, ctx.user!.sub))
      .orderBy(desc(mcpCalls.createdAt))
      .limit(input.limit);
  }),

  /** What agents can do, for the page (the same list tools/list serves). */
  tools: protectedProcedure.query(() =>
    TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, scope: t.scope, readOnly: !!t.annotations.readOnlyHint, destructive: !!t.annotations.destructiveHint }))
  ),
});
