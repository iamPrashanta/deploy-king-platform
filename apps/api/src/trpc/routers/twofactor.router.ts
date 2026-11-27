import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { db, users } from "@dbbkp/db";
import { logAudit } from "@dbbkp/audit";
import { router, protectedProcedure, type Context } from "../trpc";
import * as twoStep from "../../services/twofactor";

/** Your own 2-step sign-in, in Settings › Sign-in. Only in the panel: an agent token can never change how its owner signs in. */
function panelOnly(ctx: Context) {
  if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "2-step sign-in can only be changed in the panel." });
}

const code = z.string().trim().min(6).max(20);

export const twoFactorRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    const [s, rules] = await Promise.all([twoStep.status(ctx.user!.sub), twoStep.teamRules()]);
    return { ...s, required: rules.requireTwoFactor };
  }),

  /** A new secret, as a QR code and as a key to type. Nothing changes until it is confirmed with a code. */
  start: protectedProcedure.mutation(async ({ ctx }) => {
    panelOnly(ctx);
    const [u] = await db.select({ id: users.id, username: users.username }).from(users).where(eq(users.id, ctx.user!.sub)).limit(1);
    if (!u) throw new TRPCError({ code: "NOT_FOUND" });
    const s = await twoStep.startSetup(u);
    return { qr: s.qr, secret: s.secret, uri: s.uri };
  }),

  /** Turns it on. The recovery codes are returned once and never again. */
  confirm: protectedProcedure.input(z.object({ code })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const out = await twoStep.confirmSetup(ctx.user!.sub, input.code);
    logAudit("two_factor_enable", { actorId: ctx.user!.sub, targetId: ctx.user!.sub, targetType: "user", targetName: ctx.user!.username, ip: ctx.ip ?? undefined });
    return out;
  }),

  /** Turning it off needs a current code. Not allowed while the team requires it. */
  disable: protectedProcedure.input(z.object({ code })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    if ((await twoStep.teamRules()).requireTwoFactor) throw new TRPCError({ code: "FORBIDDEN", message: "This team requires 2-step sign-in, so it cannot be turned off. If you lost your phone, an admin can reset it." });
    await twoStep.verify(ctx.user!.sub, input.code);
    await twoStep.remove(ctx.user!.sub);
    logAudit("two_factor_disable", { actorId: ctx.user!.sub, targetId: ctx.user!.sub, targetType: "user", targetName: ctx.user!.username, ip: ctx.ip ?? undefined });
    return { success: true };
  }),

  /** New recovery codes; the old ones stop working. Needs a current code. */
  newRecoveryCodes: protectedProcedure.input(z.object({ code })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    await twoStep.verify(ctx.user!.sub, input.code);
    const out = await twoStep.newRecovery(ctx.user!.sub);
    logAudit("two_factor_recovery_new", { actorId: ctx.user!.sub, targetId: ctx.user!.sub, targetType: "user", targetName: ctx.user!.username, ip: ctx.ip ?? undefined });
    return out;
  }),
});
