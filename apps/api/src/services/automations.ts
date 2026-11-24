import crypto from "node:crypto";
import { TRPCError } from "@trpc/server";
import parser from "cron-parser";
import { db, automations, automationRuns, users, type Automation, type AutomationGraph, type Site } from "@dbbkp/db";
import { and, eq } from "drizzle-orm";
import { automationQueue } from "../queues";
import { publicAppUrl } from "../config";

export const TRIGGER_TYPES = ["manual", "schedule", "webhook", "deployment"] as const;
const MAX_NODES = 100;

export function emptyGraph(): AutomationGraph {
  return {
    nodes: [{ id: "trigger", type: "trigger.manual", position: { x: 80, y: 200 }, data: { label: "When clicking Execute" } }],
    edges: [],
  };
}

/** Checks the graph's shape and works out how the automation is triggered. */
export function analyseGraph(graph: AutomationGraph, opts: { isAdmin: boolean }) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid workflow graph" });
  }
  if (graph.nodes.length > MAX_NODES) throw new TRPCError({ code: "BAD_REQUEST", message: `A workflow can have at most ${MAX_NODES} steps` });

  const triggers = graph.nodes.filter((n) => String(n.type).startsWith("trigger."));
  if (triggers.length !== 1) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "A workflow needs exactly one trigger" });
  }
  if (!opts.isAdmin && graph.nodes.some((n) => n.type === "action.command")) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Only admins can use the Run command step" });
  }

  const ids = new Set(graph.nodes.map((n) => n.id));
  for (const e of graph.edges) {
    if (!ids.has(e.source) || !ids.has(e.target)) throw new TRPCError({ code: "BAD_REQUEST", message: "A connection points to a missing step" });
  }

  const trigger = triggers[0];
  const triggerType = trigger.type.slice("trigger.".length);
  if (!(TRIGGER_TYPES as readonly string[]).includes(triggerType)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Unknown trigger ${trigger.type}` });
  }

  let schedule: string | null = null;
  if (triggerType === "schedule") {
    schedule = String(trigger.data?.cron || "").trim();
    try {
      parser.parseExpression(schedule);
    } catch {
      throw new TRPCError({ code: "BAD_REQUEST", message: `Invalid schedule "${schedule}". Use cron syntax, e.g. 0 8 * * *` });
    }
  }
  return { triggerType, schedule };
}

export function newWebhookToken() {
  return crypto.randomBytes(24).toString("base64url");
}

/** Keeps BullMQ's repeatable job in line with the automation's schedule. */
export async function syncSchedule(a: Pick<Automation, "id" | "enabled" | "triggerType" | "schedule">) {
  const name = `schedule:${a.id}`;
  const repeatables = await automationQueue.getRepeatableJobs();
  for (const r of repeatables) {
    if (r.name === name) await automationQueue.removeRepeatableByKey(r.key);
  }
  if (a.enabled && a.triggerType === "schedule" && a.schedule) {
    await automationQueue.add(
      name,
      { automationId: a.id },
      { repeat: { pattern: a.schedule }, removeOnComplete: 50, removeOnFail: 100 }
    );
  }
}

export async function syncAllSchedules() {
  const all = await db.select().from(automations);
  for (const a of all) await syncSchedule(a);
  return all.length;
}

export async function enqueueRun(automationId: string, trigger: string, input: unknown) {
  // The run keeps a copy of the graph it ran, so later edits don't change how old runs look.
  const [a] = await db.select({ graph: automations.graph }).from(automations).where(eq(automations.id, automationId)).limit(1);
  const payload = { ...((input as Record<string, unknown>) ?? {}), __graph: a?.graph };
  const [run] = await db.insert(automationRuns).values({ automationId, trigger, input: payload, status: "queued" }).returning();
  await automationQueue.add("run", { runId: run.id }, { removeOnComplete: 200, removeOnFail: 200 });
  await db.update(automations).set({ lastRunAt: new Date(), lastRunStatus: "queued" }).where(eq(automations.id, automationId));
  return run;
}

/**
 * Starts the workflows that listen for something happening to a running app
 * (today: "keeps crashing"). Deploy results are fired by the worker, which owns deploys.
 */
export async function fireAppEvent(site: Pick<Site, "id" | "domain" | "userId">, event: "crashing", data: Record<string, unknown>) {
  const candidates = await db.select().from(automations).where(and(eq(automations.enabled, true), eq(automations.triggerType, "deployment")));
  let started = 0;
  for (const a of candidates) {
    const t = a.graph.nodes.find((n) => n.type === "trigger.deployment");
    if (String(t?.data?.event || "any") !== event) continue; // "any" means any deploy result, not app events
    const wantSite = String(t?.data?.siteId || "");
    if (wantSite && wantSite !== site.id) continue;
    if (a.userId !== site.userId) {
      // Only an admin's workflow hears about other people's apps.
      const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, a.userId)).limit(1);
      if (u?.role !== "admin") continue;
    }
    await enqueueRun(a.id, "app", { event, app: site.domain, appId: site.id, url: publicAppUrl(site.domain), ...data });
    started += 1;
  }
  return started;
}
