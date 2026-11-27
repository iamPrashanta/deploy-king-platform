import { z } from "zod";
import bcrypt from "bcryptjs";
import { TRPCError } from "@trpc/server";
import { and, asc, count, desc, eq, gt, inArray, isNull, max, ne, sql } from "drizzle-orm";
import { db, accessRequests, apiTokens, auditLogs, invitations, sessionDevices, sessions, siteAccess, sites, users } from "@dbbkp/db";
import { logAudit } from "@dbbkp/audit";
import { getEmailSettings, isConfigured, panelUrl, renderInviteEmail, sendMail } from "@dbbkp/notify";
import * as twoStep from "../../services/twofactor";
import { router, adminProcedure, protectedProcedure, publicProcedure, type Context } from "../trpc";
import { TEAM_ROLES, cleanGrants, hashInviteToken, issueSession, manageProblem, memberPermissions, newInviteToken, ownerId, type MemberGrants, type TeamRole } from "../../services/team";

const INVITE_DAYS = [1, 3, 7, 14] as const;
const grantsInput = z.object({ createApps: z.boolean().optional(), deleteApps: z.boolean().optional(), terminal: z.boolean().optional(), agentTokens: z.boolean().optional() }).default({});
const accessInput = z.object({
  role: z.enum(TEAM_ROLES),
  allApps: z.boolean(),
  siteIds: z.array(z.string().uuid()).max(500).default([]),
  grants: grantsInput,
});
const emailInput = z.string().trim().toLowerCase().email().max(255);
const usernameInput = z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{2,29}$/, "3 to 30 letters, numbers, dots, dashes or underscores");

/** Team pages and changes are for people signed in to the panel, never for agent tokens. */
function panelOnly(ctx: Context) {
  if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "The team can only be managed in the panel." });
}

/** Only apps that exist are kept; an admin role or "all apps" needs no list. */
async function cleanAccess(input: z.infer<typeof accessInput>) {
  const role = input.role as TeamRole;
  const allApps = role === "admin" ? true : input.allApps;
  let siteIds: string[] = [];
  if (!allApps && input.siteIds.length) {
    const found = await db.select({ id: sites.id }).from(sites).where(inArray(sites.id, input.siteIds));
    siteIds = found.map((s) => s.id);
  }
  return { role, allApps, siteIds, grants: cleanGrants(role, input.grants) };
}

async function actorOf(ctx: Context) {
  const owner = await ownerId();
  return { id: ctx.user!.sub, isAdmin: ctx.user!.role === "admin", isOwner: ctx.user!.sub === owner, owner };
}

function inviteState(i: { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }) {
  if (i.acceptedAt) return "accepted" as const;
  if (i.revokedAt) return "cancelled" as const;
  return i.expiresAt < new Date() ? ("expired" as const) : ("waiting" as const);
}

type InviteLink = { email: string; path: string; expiresAt: Date; emailed: boolean; emailError?: string };

/**
 * Emails an invitation when an SMTP server is set up. The link is returned either way, so "Copy link" keeps working;
 * a failed email never undoes the invitation.
 */
async function emailInvite(inv: { email: string; role: string; allApps: boolean; siteIds: string[]; note: string | null; expiresAt: Date }, path: string, inviterId: string, origin?: string | null): Promise<Pick<InviteLink, "emailed" | "emailError">> {
  const settings = await getEmailSettings();
  if (!isConfigured(settings)) return { emailed: false };
  const base = (await panelUrl()) || (origin ?? "");
  if (!base) return { emailed: false, emailError: "The panel address is not set in Settings › Email, so the email would have no working link." };
  const [inviter] = await db.select({ username: users.username, email: users.email }).from(users).where(eq(users.id, inviterId)).limit(1);
  const apps = inv.allApps || !inv.siteIds.length ? [] : (await db.select({ domain: sites.domain }).from(sites).where(inArray(sites.id, inv.siteIds))).map((a) => a.domain);
  const mail = renderInviteEmail({ inviter: inviter?.username ?? "An admin", inviterEmail: inviter?.email, teamName: settings.teamName, email: inv.email, role: inv.role, allApps: inv.allApps, apps, note: inv.note, url: base + path, expiresAt: inv.expiresAt });
  try {
    await sendMail({ to: inv.email, ...mail, replyTo: inviter?.email }, settings);
    return { emailed: true };
  } catch (e: any) {
    return { emailed: false, emailError: String(e?.response || e?.message || e).replace(/\s+/g, " ").slice(0, 200) };
  }
}

/** Sign-in details, devices, agent tokens and recent activity of one member, for their access page. */
async function memberDetails(u: { id: string; invitedBy: string | null; createdAt: Date | null }, viewerId: string) {
  const now = new Date();
  const [tf, devices, tokens, activity, inviter, seen] = await Promise.all([
    twoStep.status(u.id),
    db
      .select({ id: sessions.id, createdAt: sessions.createdAt, lastActivityAt: sessions.lastActivityAt, expiresAt: sessions.expiresAt, ip: sessionDevices.ip, userAgent: sessionDevices.userAgent, method: sessionDevices.method })
      .from(sessions)
      .leftJoin(sessionDevices, eq(sessionDevices.sessionId, sessions.id))
      .where(and(eq(sessions.userId, u.id), gt(sessions.expiresAt, now)))
      .orderBy(desc(sessions.lastActivityAt))
      .limit(20),
    db
      .select({ id: apiTokens.id, name: apiTokens.name, scope: apiTokens.scope, prefix: apiTokens.prefix, expiresAt: apiTokens.expiresAt, lastUsedAt: apiTokens.lastUsedAt, createdAt: apiTokens.createdAt })
      .from(apiTokens)
      .where(and(eq(apiTokens.userId, u.id), isNull(apiTokens.revokedAt)))
      .orderBy(desc(apiTokens.createdAt)),
    db
      .select({ id: auditLogs.id, action: auditLogs.action, targetName: auditLogs.targetName, targetType: auditLogs.targetType, metadata: auditLogs.metadata, createdAt: auditLogs.createdAt })
      .from(auditLogs)
      .where(eq(auditLogs.actorId, u.id))
      .orderBy(desc(auditLogs.createdAt))
      .limit(8),
    u.invitedBy ? db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, u.invitedBy)).limit(1) : Promise.resolve([]),
    db.select({ at: max(sessions.lastActivityAt) }).from(sessions).where(eq(sessions.userId, u.id)),
  ]);
  const by = (inviter as Array<{ id: string; username: string }>)[0];
  return {
    twoFactor: tf.enabled,
    twoFactorSince: tf.enabledAt,
    recoveryLeft: tf.recoveryLeft,
    lastActiveAt: seen[0]?.at ?? null,
    joinedAt: u.createdAt,
    invitedBy: by ? (by.id === viewerId ? "you" : by.username) : null,
    devices: devices.map((d) => ({ ...d, expiresAt: d.expiresAt })),
    tokens: tokens.filter((t) => !t.expiresAt || t.expiresAt > now),
    activity,
  };
}

/** The browser's own address, used for invitation links only when no panel address is saved. */
const originInput = z.string().trim().max(300).regex(/^https?:\/\/[^\s/]+$/i).optional();

export const teamRouter = router({
  /** What the signed-in person is, for showing or hiding parts of the panel. The server still checks every action. */
  me: protectedProcedure.query(async ({ ctx }) => {
    const [u] = await db.select({ role: users.role, teamRole: users.teamRole, grants: users.grants, allApps: users.allApps }).from(users).where(eq(users.id, ctx.user!.sub)).limit(1);
    const isAdmin = u?.role === "admin";
    const role = isAdmin ? ((await ownerId()) === ctx.user!.sub ? "owner" : "admin") : ((u?.teamRole as TeamRole | null) ?? "member");
    const can = isAdmin ? ["*"] : u?.teamRole ? [...memberPermissions(u.teamRole as TeamRole, u.grants)] : [];
    return { role, can, allApps: isAdmin || !!u?.allApps };
  }),

  members: adminProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    const owner = await ownerId();
    const rows = await db
      .select({ id: users.id, username: users.username, email: users.email, role: users.role, teamRole: users.teamRole, allApps: users.allApps, grants: users.grants, suspendedAt: users.suspendedAt, createdAt: users.createdAt })
      .from(users)
      .orderBy(asc(users.createdAt));
    const shared = await db.select({ userId: siteAccess.userId, n: count() }).from(siteAccess).groupBy(siteAccess.userId);
    const own = await db.select({ userId: sites.userId, n: count() }).from(sites).groupBy(sites.userId);
    const seen = await db.select({ userId: sessions.userId, at: max(sessions.lastActivityAt) }).from(sessions).groupBy(sessions.userId);
    const twoStepOn = await twoStep.enabledUserIds();
    const sharedBy = new Map(shared.map((r) => [r.userId, Number(r.n)]));
    const ownBy = new Map(own.map((r) => [r.userId, Number(r.n)]));
    const seenBy = new Map(seen.map((r) => [r.userId, r.at]));
    return rows.map((u) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.id === owner ? "owner" : u.role === "admin" ? "admin" : ((u.teamRole as TeamRole | null) ?? "member"),
      allApps: u.role === "admin" || u.allApps,
      sharedApps: sharedBy.get(u.id) ?? 0,
      ownApps: ownBy.get(u.id) ?? 0,
      grants: u.grants ?? {},
      suspended: !!u.suspendedAt,
      twoFactor: twoStepOn.has(u.id),
      lastActiveAt: seenBy.get(u.id) ?? null,
      joinedAt: u.createdAt,
      you: u.id === ctx.user!.sub,
    }));
  }),

  /** One member, with the apps shared with them, for the access screen. */
  member: adminProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    panelOnly(ctx);
    const [u] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!u) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    const shared = await db.select({ siteId: siteAccess.siteId }).from(siteAccess).where(eq(siteAccess.userId, u.id));
    const owner = await ownerId();
    return {
      id: u.id,
      username: u.username,
      email: u.email,
      role: u.id === owner ? "owner" : u.role === "admin" ? "admin" : ((u.teamRole as TeamRole | null) ?? "member"),
      allApps: u.role === "admin" || u.allApps,
      siteIds: shared.map((s) => s.siteId),
      grants: (u.grants ?? {}) as MemberGrants,
      suspended: !!u.suspendedAt,
      ...(await memberDetails(u, ctx.user!.sub)),
    };
  }),

  /** Team rules: today, whether everyone must use 2-step sign-in. */
  rules: adminProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    const [rules, on, total] = await Promise.all([twoStep.teamRules(), twoStep.enabledUserIds(), db.select({ id: users.id }).from(users)]);
    return { ...rules, twoFactorCount: total.filter((u) => on.has(u.id)).length, memberCount: total.length };
  }),

  /** Members without 2-step sign-in are asked to set it up at their next sign-in. Only the owner and admins. */
  setRules: adminProcedure.input(z.object({ requireTwoFactor: z.boolean() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const before = await twoStep.teamRules();
    const after = await twoStep.saveTeamRules({ requireTwoFactor: input.requireTwoFactor === true }, ctx.user!.sub);
    logAudit("team_rules", { actorId: ctx.user!.sub, targetType: "settings", targetName: "team_rules", metadata: { before, after }, ip: ctx.ip ?? undefined });
    return after;
  }),

  /** For a member who lost their phone: their 2-step sign-in is removed. They set it up again (at once, if the team requires it). */
  resetTwoFactor: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const actor = await actorOf(ctx);
    const [target] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    const problem = manageProblem(actor, { id: target.id, isOwner: target.id === actor.owner, isAdmin: target.role === "admin" });
    if (problem) throw new TRPCError({ code: "FORBIDDEN", message: problem });
    const had = await twoStep.remove(target.id);
    if (!had) throw new TRPCError({ code: "BAD_REQUEST", message: `${target.username} has not set up 2-step sign-in.` });
    // Whoever has their phone should not stay signed in either.
    await db.delete(sessions).where(eq(sessions.userId, target.id));
    logAudit("two_factor_reset", { actorId: actor.id, targetId: target.id, targetType: "user", targetName: target.username, ip: ctx.ip ?? undefined });
    return { success: true };
  }),

  /** Ends every session of a member. Their agent tokens keep working; revoke those separately. */
  signOutEverywhere: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const actor = await actorOf(ctx);
    const [target] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    const problem = manageProblem(actor, { id: target.id, isOwner: target.id === actor.owner, isAdmin: target.role === "admin" });
    if (problem) throw new TRPCError({ code: "FORBIDDEN", message: problem });
    const ended = await db.delete(sessions).where(eq(sessions.userId, target.id)).returning({ id: sessions.id });
    logAudit("team_sign_out_everywhere", { actorId: actor.id, targetId: target.id, targetType: "user", targetName: target.username, metadata: { sessions: ended.length }, ip: ctx.ip ?? undefined });
    return { sessions: ended.length };
  }),

  /** Revoke one of a member's AI agent tokens. */
  revokeMemberToken: adminProcedure.input(z.object({ id: z.string().uuid(), tokenId: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const actor = await actorOf(ctx);
    const [target] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    const problem = manageProblem(actor, { id: target.id, isOwner: target.id === actor.owner, isAdmin: target.role === "admin" });
    if (problem) throw new TRPCError({ code: "FORBIDDEN", message: problem });
    const [row] = await db.update(apiTokens).set({ revokedAt: new Date() }).where(and(eq(apiTokens.id, input.tokenId), eq(apiTokens.userId, target.id), isNull(apiTokens.revokedAt))).returning({ id: apiTokens.id, name: apiTokens.name });
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "Token not found" });
    logAudit("team_token_revoke", { actorId: actor.id, targetId: row.id, targetType: "api_token", targetName: row.name, metadata: { member: target.username }, ip: ctx.ip ?? undefined });
    return { success: true };
  }),

  invitations: adminProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    const rows = await db
      .select({ id: invitations.id, email: invitations.email, role: invitations.role, allApps: invitations.allApps, siteIds: invitations.siteIds, expiresAt: invitations.expiresAt, acceptedAt: invitations.acceptedAt, revokedAt: invitations.revokedAt, createdAt: invitations.createdAt, invitedBy: users.username })
      .from(invitations)
      .leftJoin(users, eq(invitations.invitedBy, users.id))
      .where(and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt)))
      .orderBy(desc(invitations.createdAt))
      .limit(200);
    return rows.map((i) => ({ id: i.id, email: i.email, role: i.role, allApps: i.allApps, apps: i.siteIds.length, state: inviteState(i), expiresAt: i.expiresAt, createdAt: i.createdAt, invitedBy: i.invitedBy }));
  }),

  /**
   * Invite one or more people. Each gets their own link, shown once to the person inviting.
   * Email sending is not built yet, so the link is passed on by hand for now.
   */
  invite: adminProcedure
    .input(accessInput.extend({ emails: z.array(emailInput).min(1).max(20), note: z.string().trim().max(500).optional(), expiresInDays: z.number().int().refine((d) => (INVITE_DAYS as readonly number[]).includes(d)).default(7), origin: originInput }))
    .mutation(async ({ ctx, input }) => {
      panelOnly(ctx);
      const actor = await actorOf(ctx);
      if (input.role === "admin" && !actor.isOwner) throw new TRPCError({ code: "FORBIDDEN", message: "Only the owner can invite admins." });
      const access = await cleanAccess(input);
      const emails = [...new Set(input.emails)];
      const existing = await db.select({ email: users.email }).from(users).where(inArray(users.email, emails));
      if (existing.length) throw new TRPCError({ code: "CONFLICT", message: `Already a member: ${existing.map((e) => e.email).join(", ")}` });

      const out: InviteLink[] = [];
      for (const email of emails) {
        // A new invitation replaces any earlier one for the same address, so only one link ever works.
        await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.email, email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
        const { token, hash } = newInviteToken();
        const expiresAt = new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000);
        const [row] = await db.insert(invitations).values({ email, role: access.role, allApps: access.allApps, siteIds: access.siteIds, grants: access.grants, note: input.note || null, tokenHash: hash, invitedBy: actor.id, expiresAt }).returning({ id: invitations.id });
        const path = `/invite/${token}`;
        const mail = await emailInvite({ email, role: access.role, allApps: access.allApps, siteIds: access.siteIds, note: input.note || null, expiresAt }, path, actor.id, input.origin);
        logAudit("team_invite", { actorId: actor.id, targetId: row.id, targetType: "invitation", targetName: email, metadata: { role: access.role, allApps: access.allApps, apps: access.siteIds.length, grants: access.grants, emailed: mail.emailed }, ip: ctx.ip ?? undefined });
        out.push({ email, path, expiresAt, ...mail });
      }
      return out;
    }),

  /** A fresh link for an invitation that is waiting or has expired. The old link stops working. */
  renewInvite: adminProcedure.input(z.object({ id: z.string().uuid(), send: z.boolean().default(true), origin: originInput })).mutation(async ({ ctx, input }): Promise<InviteLink> => {
    panelOnly(ctx);
    const [inv] = await db.select().from(invitations).where(eq(invitations.id, input.id)).limit(1);
    if (!inv || inv.acceptedAt || inv.revokedAt) throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
    const { token, hash } = newInviteToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.update(invitations).set({ tokenHash: hash, expiresAt }).where(eq(invitations.id, inv.id));
    const path = `/invite/${token}`;
    const mail = input.send ? await emailInvite({ ...inv, expiresAt }, path, ctx.user!.sub, input.origin) : { emailed: false };
    logAudit("team_invite", { actorId: ctx.user!.sub, targetId: inv.id, targetType: "invitation", targetName: inv.email, metadata: { renewed: true, emailed: mail.emailed }, ip: ctx.ip ?? undefined });
    return { email: inv.email, path, expiresAt, ...mail };
  }),

  cancelInvite: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const [inv] = await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.id, input.id), isNull(invitations.acceptedAt))).returning({ id: invitations.id, email: invitations.email });
    if (!inv) throw new TRPCError({ code: "NOT_FOUND", message: "Invitation not found" });
    logAudit("team_invite_cancel", { actorId: ctx.user!.sub, targetId: inv.id, targetType: "invitation", targetName: inv.email, ip: ctx.ip ?? undefined });
    return { success: true };
  }),

  /** Public: what the invitation page shows before the person has an account. Says nothing when the link is wrong. */
  invitation: publicProcedure.input(z.object({ token: z.string().min(20).max(200) })).query(async ({ input }) => {
    const [inv] = await db
      .select({ email: invitations.email, role: invitations.role, allApps: invitations.allApps, siteIds: invitations.siteIds, grants: invitations.grants, note: invitations.note, expiresAt: invitations.expiresAt, acceptedAt: invitations.acceptedAt, revokedAt: invitations.revokedAt, inviter: users.username })
      .from(invitations)
      .leftJoin(users, eq(invitations.invitedBy, users.id))
      .where(eq(invitations.tokenHash, hashInviteToken(input.token)))
      .limit(1);
    if (!inv) return { state: "invalid" as const };
    const state = inviteState(inv);
    if (state !== "waiting") return { state, inviter: inv.inviter };
    const apps = inv.allApps || !inv.siteIds.length ? [] : await db.select({ domain: sites.domain }).from(sites).where(inArray(sites.id, inv.siteIds));
    const twoStepRequired = (await twoStep.teamRules()).requireTwoFactor;
    const teamName = (await getEmailSettings())?.teamName?.trim() || null;
    return { state, email: inv.email, role: inv.role, allApps: inv.allApps, apps: apps.map((a) => a.domain), grants: inv.grants, note: inv.note, inviter: inv.inviter, expiresAt: inv.expiresAt, twoStepRequired, teamName };
  }),

  /** Public: accept an invitation by choosing a username and password. Signs the new member in. */
  accept: publicProcedure
    .input(z.object({ token: z.string().min(20).max(200), username: usernameInput, password: z.string().min(12).max(200) }))
    .mutation(async ({ ctx, input }) => {
      const [inv] = await db.select().from(invitations).where(eq(invitations.tokenHash, hashInviteToken(input.token))).limit(1);
      if (!inv || inviteState(inv) !== "waiting") throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation is no longer valid. Ask for a new one." });
      const [taken] = await db.select({ id: users.id, username: users.username, email: users.email }).from(users).where(sql`${users.username} = ${input.username} or ${users.email} = ${inv.email}`).limit(1);
      if (taken) throw new TRPCError({ code: "CONFLICT", message: taken.email === inv.email ? "This email already has an account. Sign in instead." : "That username is taken." });

      const role = inv.role as TeamRole;
      const passwordHash = await bcrypt.hash(input.password, 12);
      // Claim the invitation first, so two requests with the same link cannot both create an account.
      const [claimed] = await db.update(invitations).set({ acceptedAt: new Date() }).where(and(eq(invitations.id, inv.id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, new Date()))).returning({ id: invitations.id });
      if (!claimed) throw new TRPCError({ code: "BAD_REQUEST", message: "This invitation is no longer valid. Ask for a new one." });

      const [user] = await db
        .insert(users)
        .values({ email: inv.email, username: input.username, passwordHash, role: role === "admin" ? "admin" : "user", teamRole: role, allApps: inv.allApps, grants: cleanGrants(role, inv.grants), invitedBy: inv.invitedBy, mustChangePassword: false })
        .returning();
      if (!inv.allApps && inv.siteIds.length) {
        const alive = await db.select({ id: sites.id }).from(sites).where(inArray(sites.id, inv.siteIds));
        if (alive.length) await db.insert(siteAccess).values(alive.map((s) => ({ userId: user.id, siteId: s.id, grantedBy: inv.invitedBy }))).onConflictDoNothing();
      }
      await db.update(invitations).set({ acceptedBy: user.id }).where(eq(invitations.id, inv.id));
      logAudit("team_accept", { actorId: user.id, targetId: inv.id, targetType: "invitation", targetName: inv.email, metadata: { role }, ip: ctx.ip ?? undefined });
      // A team that requires 2-step sign-in: set it up first (auth.setupStart / setupConfirm), then the session.
      if ((await twoStep.teamRules()).requireTwoFactor) return { step: "setup" as const, challenge: twoStep.signChallenge(user.id, "setup") };
      return issueSession(user, { ip: ctx.ip, userAgent: ctx.userAgent, method: "invitation" });
    }),

  /** Change a member's role, apps and extras. Applies at once; they do not have to sign in again. */
  updateMember: adminProcedure.input(accessInput.extend({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const actor = await actorOf(ctx);
    const [target] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    const problem = manageProblem(actor, { id: target.id, isOwner: target.id === actor.owner, isAdmin: target.role === "admin" }, { toAdmin: input.role === "admin" });
    if (problem) throw new TRPCError({ code: "FORBIDDEN", message: problem });

    const access = await cleanAccess(input);
    await db.update(users).set({ role: access.role === "admin" ? "admin" : "user", teamRole: access.role, allApps: access.allApps, grants: access.grants, updatedAt: new Date() }).where(eq(users.id, target.id));
    await db.delete(siteAccess).where(eq(siteAccess.userId, target.id));
    if (!access.allApps && access.siteIds.length) await db.insert(siteAccess).values(access.siteIds.map((siteId) => ({ userId: target.id, siteId, grantedBy: actor.id })));
    logAudit("team_member_update", { actorId: actor.id, targetId: target.id, targetType: "user", targetName: target.username, metadata: { role: access.role, allApps: access.allApps, apps: access.siteIds.length, grants: access.grants }, ip: ctx.ip ?? undefined });
    return { success: true };
  }),

  /** Suspend: signed out everywhere and cannot sign in, but nothing is deleted. */
  setSuspended: adminProcedure.input(z.object({ id: z.string().uuid(), suspended: z.boolean() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const actor = await actorOf(ctx);
    const [target] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    const problem = manageProblem(actor, { id: target.id, isOwner: target.id === actor.owner, isAdmin: target.role === "admin" });
    if (problem) throw new TRPCError({ code: "FORBIDDEN", message: problem });
    await db.update(users).set({ suspendedAt: input.suspended ? new Date() : null, updatedAt: new Date() }).where(eq(users.id, target.id));
    if (input.suspended) await db.delete(sessions).where(eq(sessions.userId, target.id));
    logAudit("team_member_suspend", { actorId: actor.id, targetId: target.id, targetType: "user", targetName: target.username, metadata: { suspended: input.suspended }, ip: ctx.ip ?? undefined });
    return { success: true };
  }),

  /**
   * Remove a member. Apps they created are handed to the person removing them first:
   * deleting the account must never delete running apps.
   */
  remove: adminProcedure.input(z.object({ id: z.string().uuid(), confirm: z.string() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const actor = await actorOf(ctx);
    const [target] = await db.select().from(users).where(eq(users.id, input.id)).limit(1);
    if (!target) throw new TRPCError({ code: "NOT_FOUND", message: "Member not found" });
    const problem = manageProblem(actor, { id: target.id, isOwner: target.id === actor.owner, isAdmin: target.role === "admin" });
    if (problem) throw new TRPCError({ code: "FORBIDDEN", message: problem });
    if (input.confirm !== target.username) throw new TRPCError({ code: "BAD_REQUEST", message: "Type the member's username to confirm." });
    const moved = await db.update(sites).set({ userId: actor.id, updatedAt: new Date() }).where(eq(sites.userId, target.id)).returning({ id: sites.id });
    await db.delete(users).where(and(eq(users.id, target.id), ne(users.id, actor.id)));
    logAudit("team_member_remove", { actorId: actor.id, targetId: target.id, targetType: "user", targetName: target.username, metadata: { email: target.email, appsHandedOver: moved.length }, ip: ctx.ip ?? undefined });
    return { success: true, appsHandedOver: moved.length };
  }),

  // ── Sign-up: request access ────────────────────────────────────────────────

  /** Public: the sign-up page. Creates a request the owner approves or declines; no account exists until then. */
  requestAccess: publicProcedure
    .input(z.object({ email: emailInput, name: z.string().trim().min(2).max(120), message: z.string().trim().max(1000).optional() }))
    .mutation(async ({ ctx, input }) => {
      // The answer is the same whether or not the address is known, so the page cannot be used to find members.
      const done = { received: true };
      const [member] = await db.select({ id: users.id }).from(users).where(eq(users.email, input.email)).limit(1);
      if (member) return done;
      const [open] = await db.select({ id: accessRequests.id }).from(accessRequests).where(and(eq(accessRequests.email, input.email), eq(accessRequests.status, "pending"))).limit(1);
      if (open) return done;
      // A simple brake: at most 5 requests an hour from one address.
      if (ctx.ip) {
        const [recent] = await db.select({ n: count() }).from(accessRequests).where(and(eq(accessRequests.ip, ctx.ip), gt(accessRequests.createdAt, new Date(Date.now() - 60 * 60 * 1000))));
        if (Number(recent?.n ?? 0) >= 5) throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: "Too many requests from here. Try again in an hour." });
      }
      await db.insert(accessRequests).values({ email: input.email, name: input.name, message: input.message || null, ip: ctx.ip });
      return done;
    }),

  requests: adminProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    return db.select({ id: accessRequests.id, email: accessRequests.email, name: accessRequests.name, message: accessRequests.message, createdAt: accessRequests.createdAt }).from(accessRequests).where(eq(accessRequests.status, "pending")).orderBy(desc(accessRequests.createdAt)).limit(200);
  }),

  /**
   * Approve: the person gets an invitation as a developer who can create and run their own apps, and sees no one else's.
   * Decline: nothing is created.
   */
  decideRequest: adminProcedure.input(z.object({ id: z.string().uuid(), approve: z.boolean(), origin: originInput })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const [req] = await db.update(accessRequests).set({ status: input.approve ? "approved" : "declined", decidedBy: ctx.user!.sub, decidedAt: new Date() }).where(and(eq(accessRequests.id, input.id), eq(accessRequests.status, "pending"))).returning();
    if (!req) throw new TRPCError({ code: "NOT_FOUND", message: "Request not found" });
    logAudit("access_request_decide", { actorId: ctx.user!.sub, targetId: req.id, targetType: "access_request", targetName: req.email, metadata: { approved: input.approve }, ip: ctx.ip ?? undefined });
    if (!input.approve) return { approved: false as const };
    await db.update(invitations).set({ revokedAt: new Date() }).where(and(eq(invitations.email, req.email), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    const { token, hash } = newInviteToken();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await db.insert(invitations).values({ email: req.email, role: "developer", allApps: false, siteIds: [], grants: { createApps: true, deleteApps: true, agentTokens: true }, tokenHash: hash, invitedBy: ctx.user!.sub, expiresAt });
    const path = `/invite/${token}`;
    const mail = await emailInvite({ email: req.email, role: "developer", allApps: false, siteIds: [], note: null, expiresAt }, path, ctx.user!.sub, input.origin);
    return { approved: true as const, email: req.email, path, expiresAt, ...mail };
  }),
});
