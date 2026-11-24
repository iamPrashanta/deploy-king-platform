import { TRPCError } from "@trpc/server";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { and, asc, eq, inArray, or, type SQL } from "drizzle-orm";
import { db, sessions, siteAccess, sites, users } from "@dbbkp/db";
import { JWT_SECRET } from "../config";

/**
 * Team access.
 *
 * A role says WHAT a member may do; the app list says WHERE.
 *   owner     - the first admin. Everything; nobody can change or remove them.
 *   admin     - everything, including the team and settings.
 *   developer - deploys and looks after the apps they can see. Extras are switched on per member.
 *   viewer    - sees status, logs and history of the apps they can see. Changes nothing.
 *
 * Which apps a member can see: the ones they created, plus either every app (allApps) or the ones listed in site_access.
 * Users from before teams existed have no team role; for them the older role tables still decide (see utils/rbac.ts).
 */

export const TEAM_ROLES = ["admin", "developer", "viewer"] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];

/** Extras that are off until switched on for one member. Only meaningful for developers. */
export type MemberGrants = { createApps?: boolean; deleteApps?: boolean; terminal?: boolean; agentTokens?: boolean };
export const GRANT_KEYS = ["createApps", "deleteApps", "terminal", "agentTokens"] as const;

/** Permission keys, as checked by permissionProcedure. Kept here so the rules below can be tested without a database. */
export const P = {
  SITE_CREATE: "site.create",
  SITE_DELETE: "site.delete",
  SITE_DEPLOY: "site.deploy",
  TERMINAL_OPEN: "terminal.open",
  TERMINAL_WRITE: "terminal.write",
  CRON_CREATE: "cron.create",
  AGENT_TOKENS: "agent.tokens",
} as const;

/** Pure: what a team role with these extras may do. Admins are handled before this is reached. */
export function memberPermissions(role: TeamRole, grants: MemberGrants | null | undefined): Set<string> {
  const out = new Set<string>();
  if (role === "admin") return new Set(["*"]);
  if (role === "viewer") return out;
  out.add(P.SITE_DEPLOY);
  out.add(P.CRON_CREATE);
  if (grants?.createApps) out.add(P.SITE_CREATE);
  if (grants?.deleteApps) out.add(P.SITE_DELETE);
  if (grants?.terminal) {
    out.add(P.TERMINAL_OPEN);
    out.add(P.TERMINAL_WRITE);
  }
  if (grants?.agentTokens) out.add(P.AGENT_TOKENS);
  return out;
}

/** Pure: keep only known extras, and only for the role that can have them. */
export function cleanGrants(role: TeamRole, grants: MemberGrants | null | undefined): MemberGrants {
  if (role !== "developer") return {};
  const out: MemberGrants = {};
  for (const k of GRANT_KEYS) if (grants?.[k] === true) out[k] = true;
  return out;
}

/** Pure: what an invitation or member may be changed to by this actor. Returns a reason when it is not allowed. */
export function manageProblem(actor: { id: string; isAdmin: boolean; isOwner: boolean }, target: { id: string; isOwner: boolean; isAdmin: boolean }, change: { toAdmin?: boolean } = {}): string | null {
  if (!actor.isAdmin) return "Only the owner and admins can manage the team.";
  if (target.isOwner) return "The owner cannot be changed or removed.";
  if (target.id === actor.id) return "You cannot change your own access.";
  if ((target.isAdmin || change.toAdmin) && !actor.isOwner) return "Only the owner can add, change or remove admins.";
  return null;
}

/** The owner is the admin who has been here longest. */
export async function ownerId(): Promise<string | null> {
  const [first] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).orderBy(asc(users.createdAt)).limit(1);
  return first?.id ?? null;
}

type Viewer = { sub: string; role: string };

/**
 * The condition that limits a query on `sites` to what this user may see.
 * undefined means "no limit" (admins, and members who were given every app).
 */
export async function visibleSites(user: Viewer): Promise<SQL | undefined> {
  if (user.role === "admin") return undefined;
  const [me] = await db.select({ allApps: users.allApps, teamRole: users.teamRole }).from(users).where(eq(users.id, user.sub)).limit(1);
  if (me?.teamRole && me.allApps) return undefined;
  const shared = await db.select({ siteId: siteAccess.siteId }).from(siteAccess).where(eq(siteAccess.userId, user.sub));
  const own = eq(sites.userId, user.sub);
  return shared.length ? or(own, inArray(sites.id, shared.map((s) => s.siteId))) : own;
}

/** One app, if this user may see it. */
export async function visibleSite(user: Viewer, siteId: string) {
  const limit = await visibleSites(user);
  const [site] = await db.select().from(sites).where(limit ? and(eq(sites.id, siteId), limit) : eq(sites.id, siteId)).limit(1);
  return site ?? null;
}

/** The app, if this user may see it. "Not found" otherwise, so nobody learns which ids exist. */
export async function requireSite(user: Viewer, siteId: string) {
  const site = await visibleSite(user, siteId);
  if (!site) throw new TRPCError({ code: "NOT_FOUND", message: "App not found" });
  return site;
}

/** Sign a user in: a server-side session plus the token the panel keeps. Used by login and by accepting an invitation. */
export async function issueSession(user: { id: string; username: string; email: string; role: string; mustChangePassword: boolean | null }) {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({ id: sessionId, userId: user.id, expiresAt });
  const token = jwt.sign({ sub: user.id, sid: sessionId, username: user.username, role: user.role, mcp: !!user.mustChangePassword }, JWT_SECRET, { expiresIn: "7d" } as jwt.SignOptions);
  return { token, user: { id: user.id, username: user.username, email: user.email, role: user.role, mustChangePassword: !!user.mustChangePassword } };
}

/** Invitation links carry a random token; only its hash is stored. */
export function newInviteToken() {
  const token = "dki_" + crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashInviteToken(token) };
}
export const hashInviteToken = (token: string) => crypto.createHash("sha256").update(token).digest("hex");
