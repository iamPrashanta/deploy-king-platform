import { router, protectedProcedure, publicProcedure } from "../trpc";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { db, users, sessions, auditLogs } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";

import { logAudit } from "@dbbkp/audit";
import { issueSession } from "../../services/team";
import * as twoStep from "../../services/twofactor";

// ─── UTILITIES ───────────────────────────────────────────────────────────────

function deepClean(obj: any): any {
  if (obj === undefined) return null;
  if (obj === null) return null;
  if (Array.isArray(obj)) return obj.filter((v) => v !== undefined).map(deepClean);
  if (typeof obj === "object" && obj !== null) {
    if (obj instanceof Date) return obj;
    return Object.fromEntries(
      Object.entries(obj).filter(([_, v]) => v !== undefined).map(([k, v]) => [k, deepClean(v)])
    );
  }
  return obj;
}

function assertClean<T extends Record<string, any>>(obj: T): T {
  const cleaned = deepClean(obj);
  for (const [key, value] of Object.entries(cleaned)) {
    if (value === undefined) {
      throw new Error(`[DB Guard:Auth] Undefined value detected for key: "${key}"`);
    }
  }
  return cleaned;
}

// ─── ROUTER ──────────────────────────────────────────────────────────────────

export const authRouter = router({
  /**
   * Sign in. When the password is right:
   *  - no 2-step sign-in, and the team does not require it: a session ({ token, user });
   *  - 2-step sign-in is on: { step: "code", challenge }, then loginCode;
   *  - the team requires it and it is not set up: { step: "setup", challenge }, then setupStart and setupConfirm.
   */
  login: publicProcedure
    .input(z.object({ username: z.string(), password: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const [user] = await db.select().from(users).where(eq(users.username, input.username)).limit(1);
      if (!user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });

      const valid = await bcrypt.compare(input.password, user.passwordHash);
      if (!valid) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid credentials" });
      if (user.suspendedAt) throw new TRPCError({ code: "FORBIDDEN", message: "This account is suspended. Ask the owner of this panel." });
      const next = await twoStep.nextStep(user);
      if (next !== "none") return { step: next, challenge: twoStep.signChallenge(user.id, next) };
      return issueSession(user, { ip: ctx.ip, userAgent: ctx.userAgent, method: "password" });
    }),

  /** The second step: a code from the authenticator app, or a recovery code. Five wrong codes lock it for 15 minutes. */
  loginCode: publicProcedure
    .input(z.object({ challenge: z.string().min(20).max(2000), code: z.string().trim().min(6).max(20) }))
    .mutation(async ({ ctx, input }) => {
      const user = await twoStep.challengeUser(twoStep.readChallenge(input.challenge, "code"));
      const ok = await twoStep.verify(user.id, input.code);
      if (ok.method === "recovery code") logAudit("two_factor_recovery_used", { actorId: user.id, targetId: user.id, targetType: "user", targetName: user.username, metadata: { left: ok.recoveryLeft }, ip: ctx.ip ?? undefined });
      return { ...(await issueSession(user, { ip: ctx.ip, userAgent: ctx.userAgent, method: ok.method })), recoveryLeft: ok.recoveryLeft };
    }),

  /** Setting up 2-step sign-in during sign-in, when the team requires it. */
  setupStart: publicProcedure.input(z.object({ challenge: z.string().min(20).max(2000) })).mutation(async ({ input }) => {
    const user = await twoStep.challengeUser(twoStep.readChallenge(input.challenge, "setup"));
    const s = await twoStep.startSetup(user);
    return { qr: s.qr, secret: s.secret, uri: s.uri, username: user.username };
  }),

  setupConfirm: publicProcedure
    .input(z.object({ challenge: z.string().min(20).max(2000), code: z.string().trim().min(6).max(10) }))
    .mutation(async ({ ctx, input }) => {
      const user = await twoStep.challengeUser(twoStep.readChallenge(input.challenge, "setup"));
      const { recoveryCodes } = await twoStep.confirmSetup(user.id, input.code);
      logAudit("two_factor_enable", { actorId: user.id, targetId: user.id, targetType: "user", targetName: user.username, metadata: { duringSignIn: true }, ip: ctx.ip ?? undefined });
      return { recoveryCodes, ...(await issueSession(user, { ip: ctx.ip, userAgent: ctx.userAgent, method: "2-step" })) };
    }),

  // Get current user (Verifies session via tRPC middleware)
  me: protectedProcedure.query(async ({ ctx }) => {
    const [user] = await db.select({
      id: users.id, 
      username: users.username,
      email: users.email, 
      role: users.role, 
      createdAt: users.createdAt,
      mustChangePassword: users.mustChangePassword,
    }).from(users).where(eq(users.id, ctx.user.sub)).limit(1);

    if (!user) throw new TRPCError({ code: "NOT_FOUND" });
    return user;
  }),

  // Change Password
  changePassword: protectedProcedure
    .input(z.object({ newPassword: z.string().min(8) }))
    .mutation(async ({ ctx, input }) => {
      const passwordHash = await bcrypt.hash(input.newPassword, 12);
      
      // 1. Update Password & Flag
      await db.update(users)
        .set(assertClean({
          passwordHash,
          mustChangePassword: false,
          updatedAt: new Date()
        }))
        .where(eq(users.id, ctx.user.sub));

      // 2. Security Audit
      // await db.insert(auditLogs).values(assertClean({
      //   type: "security",
      //   userId: ctx.user.sub,
      //   event: "Password changed via dashboard. Mandatory rotation complete.",
      //   ip: ctx.ip,
      // }));
      await db.insert(auditLogs).values(assertClean({
        action: "password_changed",
        type: "security",
        userId: ctx.user.sub,
        event: "Password changed via dashboard. Mandatory rotation complete.",
        ip: ctx.ip,
      }));

      // 3. Global Session Revocation (Ensures old JWTs with sid are useless)
      await db.delete(sessions).where(eq(sessions.userId, ctx.user.sub));

      return { success: true };
    }),
});
