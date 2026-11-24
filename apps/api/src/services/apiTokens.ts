import crypto from "node:crypto";
import { db, apiTokens, users } from "@dbbkp/db";
import { eq } from "drizzle-orm";

/**
 * Tokens for AI agents (MCP). A token acts as the user who made it, limited by its scope:
 *   read   — look at apps, logs, deploys and workflows
 *   deploy — also create apps, deploy, restart, roll back, change variables, run workflows
 *   full   — also delete apps
 * Tokens only work on /mcp, never on the panel's own API.
 */
export const TOKEN_SCOPES = ["read", "deploy", "full"] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];
const RANK: Record<TokenScope, number> = { read: 0, deploy: 1, full: 2 };
export const scopeAllows = (have: string, need: TokenScope) => (RANK[have as TokenScope] ?? -1) >= RANK[need];

export const hashToken = (raw: string) => crypto.createHash("sha256").update(raw).digest("hex");

export function newToken() {
  const raw = "dk_" + crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw), prefix: raw.slice(0, 10) };
}

export type TokenAuth = {
  tokenId: string;
  name: string;
  scope: TokenScope;
  user: { sub: string; username: string; role: string };
};

/** Checks a bearer token; null when it is unknown, revoked or expired. */
export async function verifyApiToken(raw: string | null | undefined, ip?: string | null): Promise<TokenAuth | null> {
  if (!raw || !/^dk_[A-Za-z0-9_-]{30,60}$/.test(raw)) return null;
  const [row] = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      scope: apiTokens.scope,
      expiresAt: apiTokens.expiresAt,
      revokedAt: apiTokens.revokedAt,
      lastUsedAt: apiTokens.lastUsedAt,
      userId: users.id,
      username: users.username,
      role: users.role,
    })
    .from(apiTokens)
    .innerJoin(users, eq(apiTokens.userId, users.id))
    .where(eq(apiTokens.tokenHash, hashToken(raw)))
    .limit(1);
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt < new Date())) return null;
  if (!(TOKEN_SCOPES as readonly string[]).includes(row.scope)) return null;
  // "Last used" is for people, so a minute of precision is enough and saves a write per call.
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(apiTokens).set({ lastUsedAt: new Date(), lastUsedIp: ip?.slice(0, 64) ?? null }).where(eq(apiTokens.id, row.id));
  }
  return { tokenId: row.id, name: row.name, scope: row.scope as TokenScope, user: { sub: row.userId, username: row.username, role: row.role } };
}
