import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, adminProcedure } from "../trpc";
import { logAudit } from "@dbbkp/audit";
import { KINDS, acceptInitial, decide, findings, listByStatus, summary } from "../../services/hostwatch";
import { ActionError, helperStatus, listActions, requestRemoval, requestUndo, syncResults } from "../../services/hostactions";

const panelOnly = (ctx: any, what: string) => {
  if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: `${what} can only be done in the panel.` });
};
const asConflict = (e: unknown) => {
  if (e instanceof ActionError) throw new TRPCError({ code: "CONFLICT", message: e.message });
  throw e;
};

// What is on the server, and what changed since the admin last accepted it. Admins only: the list
// shows every account, key and scheduled job on the machine.
export const hostRouter = router({
  summary: adminProcedure.query(() => summary()),

  /** New and changed things, most urgent first, each with why it matters and how to remove it by hand. */
  findings: adminProcedure.query(() => findings()),

  /** The first scan, waiting for its one-time review. */
  initial: adminProcedure.query(() => listByStatus("initial")),

  baseline: adminProcedure.input(z.object({ kind: z.enum(KINDS).optional() }).optional()).query(({ input }) => listByStatus("accepted", input?.kind)),

  acceptInitial: adminProcedure.mutation(async ({ ctx }) => {
    if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "The baseline can only be accepted in the panel." });
    const accepted = await acceptInitial(ctx.user!.sub);
    if (accepted) logAudit("host_baseline_accept", { actorId: ctx.user!.sub, targetType: "platform", targetName: "server baseline", metadata: { items: accepted }, ip: ctx.ip ?? undefined });
    return { accepted };
  }),

  /** Whether the helper that can change the server is installed and running. */
  helper: adminProcedure.query(() => helperStatus()),

  /** Remove and Undo requests, newest first. */
  actions: adminProcedure.query(async () => {
    await syncResults().catch(() => 0);
    return listActions();
  }),

  remove: adminProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    panelOnly(ctx, "Removing things from the server");
    const row = await requestRemoval(input.id, { sub: ctx.user!.sub, username: ctx.user!.username }).catch(asConflict);
    logAudit("host_remove", { actorId: ctx.user!.sub, targetType: "host", targetName: row!.itemLabel, metadata: { key: row!.itemKey, action: row!.action, target: row!.target, actionId: row!.id }, ip: ctx.ip ?? undefined });
    return row!;
  }),

  undo: adminProcedure.input(z.object({ actionId: z.string().uuid() })).mutation(async ({ input, ctx }) => {
    panelOnly(ctx, "Undo");
    const row = await requestUndo(input.actionId, { sub: ctx.user!.sub, username: ctx.user!.username }).catch(asConflict);
    logAudit("host_undo", { actorId: ctx.user!.sub, targetType: "host", targetName: row!.itemLabel, metadata: { key: row!.itemKey, action: row!.action, actionId: row!.id }, ip: ctx.ip ?? undefined });
    return { ok: true };
  }),

  decide: adminProcedure
    .input(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), answer: z.enum(["expected", "later", "dismiss"]), note: z.string().max(500).optional() }))
    .mutation(async ({ input, ctx }) => {
      // An AI agent may read findings. Saying "this is fine" is exactly what an intruder would want it to do.
      if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "Findings can only be answered in the panel." });
      const done = await decide(input.ids, input.answer, ctx.user!.sub, input.note?.trim() || undefined);
      for (const d of done) {
        logAudit("host_finding_decide", { actorId: ctx.user!.sub, targetType: "host", targetName: d.label, metadata: { key: d.key, answer: input.answer, severity: d.severity, note: input.note }, ip: ctx.ip ?? undefined });
      }
      return { decided: done.length };
    }),
});
