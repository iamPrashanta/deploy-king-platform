import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure, type Context } from "../trpc";
import { db, automations, automationRuns, type AutomationGraph } from "@dbbkp/db";
import { desc, eq } from "drizzle-orm";
import { analyseGraph, emptyGraph, enqueueRun, newWebhookToken, syncSchedule } from "../../services/automations";
import { PUBLIC_API_URL } from "../../config";
import { logAudit } from "@dbbkp/audit";

const graphInput = z.object({
  nodes: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        type: z.string().min(1).max(64),
        position: z.object({ x: z.number(), y: z.number() }),
        data: z.record(z.any()).default({}),
      })
    )
    .max(100),
  edges: z
    .array(z.object({ id: z.string().max(140), source: z.string().max(64), target: z.string().max(64), sourceHandle: z.string().max(32).nullish() }))
    .max(300),
});

async function owned(ctx: Context, id: string) {
  const [a] = await db.select().from(automations).where(eq(automations.id, id)).limit(1);
  if (!a || (ctx.user!.role !== "admin" && a.userId !== ctx.user!.sub)) throw new TRPCError({ code: "NOT_FOUND", message: "Workflow not found" });
  return a;
}

/** Validates a graph and works out the columns derived from it. */
function derive(graph: AutomationGraph, ctx: Context, current?: { webhookToken: string | null }) {
  const { triggerType, schedule } = analyseGraph(graph, { isAdmin: ctx.user!.role === "admin" });
  return {
    triggerType,
    schedule,
    webhookToken: triggerType === "webhook" ? current?.webhookToken || newWebhookToken() : current?.webhookToken ?? null,
  };
}

const hookUrl = (token: string | null) => (token ? `${PUBLIC_API_URL}/hooks/automations/${token}` : null);

export const automationsRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    const rows =
      ctx.user!.role === "admin"
        ? await db.select().from(automations).orderBy(desc(automations.updatedAt))
        : await db.select().from(automations).where(eq(automations.userId, ctx.user!.sub)).orderBy(desc(automations.updatedAt));
    return rows.map(({ webhookToken, ...a }) => a);
  }),

  get: protectedProcedure.input(z.object({ id: z.string().uuid() })).query(async ({ ctx, input }) => {
    const { webhookToken, ...a } = await owned(ctx, input.id);
    return { ...a, webhookUrl: hookUrl(webhookToken) };
  }),

  create: protectedProcedure
    .input(z.object({ name: z.string().min(1).max(120), description: z.string().max(500).optional(), graph: graphInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const graph = (input.graph as AutomationGraph | undefined) ?? emptyGraph();
      const d = derive(graph, ctx);
      const [a] = await db
        .insert(automations)
        .values({ userId: ctx.user!.sub, name: input.name.trim(), description: input.description?.trim() || null, graph, enabled: false, ...d })
        .returning();
      logAudit("automation_create" as any, { actorId: ctx.user!.sub, targetId: a.id, targetType: "automation", targetName: a.name });
      return { id: a.id };
    }),

  update: protectedProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().min(1).max(120).optional(), description: z.string().max(500).nullish(), graph: graphInput.optional() }))
    .mutation(async ({ ctx, input }) => {
      const a = await owned(ctx, input.id);
      const d = input.graph ? derive(input.graph as AutomationGraph, ctx, a) : {};
      const [u] = await db
        .update(automations)
        .set({
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          ...(input.graph ? { graph: input.graph as AutomationGraph } : {}),
          ...d,
          updatedAt: new Date(),
        })
        .where(eq(automations.id, a.id))
        .returning();
      await syncSchedule(u);
      return { id: u.id, updatedAt: u.updatedAt, triggerType: u.triggerType, webhookUrl: hookUrl(u.webhookToken) };
    }),

  setEnabled: protectedProcedure.input(z.object({ id: z.string().uuid(), enabled: z.boolean() })).mutation(async ({ ctx, input }) => {
    const a = await owned(ctx, input.id);
    const [u] = await db.update(automations).set({ enabled: input.enabled, updatedAt: new Date() }).where(eq(automations.id, a.id)).returning();
    await syncSchedule(u);
    return { enabled: u.enabled };
  }),

  duplicate: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const a = await owned(ctx, input.id);
    const [c] = await db
      .insert(automations)
      .values({
        userId: ctx.user!.sub,
        name: `${a.name} (copy)`.slice(0, 120),
        description: a.description,
        graph: a.graph,
        enabled: false,
        triggerType: a.triggerType,
        schedule: a.schedule,
        webhookToken: a.triggerType === "webhook" ? newWebhookToken() : null,
      })
      .returning();
    return { id: c.id };
  }),

  delete: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const a = await owned(ctx, input.id);
    await syncSchedule({ ...a, enabled: false });
    await db.delete(automations).where(eq(automations.id, a.id));
    logAudit("automation_delete" as any, { actorId: ctx.user!.sub, targetId: a.id, targetType: "automation", targetName: a.name });
    return { success: true };
  }),

  rotateWebhook: protectedProcedure.input(z.object({ id: z.string().uuid() })).mutation(async ({ ctx, input }) => {
    const a = await owned(ctx, input.id);
    const token = newWebhookToken();
    await db.update(automations).set({ webhookToken: token, updatedAt: new Date() }).where(eq(automations.id, a.id));
    return { webhookUrl: hookUrl(token) };
  }),

  /** Runs the saved version now, whatever its trigger and whether or not it is active. */
  execute: protectedProcedure.input(z.object({ id: z.string().uuid(), input: z.record(z.any()).optional() })).mutation(async ({ ctx, input }) => {
    const a = await owned(ctx, input.id);
    const run = await enqueueRun(a.id, "manual", input.input ?? {});
    return { runId: run.id };
  }),

  runs: protectedProcedure.input(z.object({ id: z.string().uuid(), limit: z.number().int().min(1).max(100).default(30) })).query(async ({ ctx, input }) => {
    const a = await owned(ctx, input.id);
    return db
      .select({
        id: automationRuns.id,
        status: automationRuns.status,
        trigger: automationRuns.trigger,
        error: automationRuns.error,
        createdAt: automationRuns.createdAt,
        startedAt: automationRuns.startedAt,
        finishedAt: automationRuns.finishedAt,
        durationMs: automationRuns.durationMs,
      })
      .from(automationRuns)
      .where(eq(automationRuns.automationId, a.id))
      .orderBy(desc(automationRuns.createdAt))
      .limit(input.limit);
  }),

  run: protectedProcedure.input(z.object({ runId: z.string().uuid() })).query(async ({ ctx, input }) => {
    const [r] = await db.select().from(automationRuns).where(eq(automationRuns.id, input.runId)).limit(1);
    if (!r) throw new TRPCError({ code: "NOT_FOUND" });
    const a = await owned(ctx, r.automationId);
    // The run shows the graph as it was when the run started, if it was saved with it.
    const input2: any = r.input ?? {};
    return { ...r, graph: (input2.__graph as AutomationGraph) ?? a.graph, input: { ...input2, __graph: undefined } };
  }),
});

