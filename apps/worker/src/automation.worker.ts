import "./env";
import { Worker, Queue, type Job } from "bullmq";
import dns from "node:dns/promises";
import net from "node:net";
import { connection } from "./connection";
import { db, automations, automationRuns, sites, deployments, users, type AutomationGraph, type AutomationStep, type Site } from "@dbbkp/db";
import { and, desc, eq, isNotNull } from "drizzle-orm";

/**
 * Workflow executor.
 *
 * A run walks the graph from its trigger along the connections. Each step's
 * result is written to automation_runs.steps as it happens, so the panel can
 * show the run live. An "If" step follows only its true or false connection;
 * a failed step stops the run unless the step is set to continue on error.
 */

type Node = AutomationGraph["nodes"][number];
type Ctx = { trigger: any; steps: Record<string, any>; prev: any };

const hostingQueue = new Queue("hosting", { connection });
const automationQueue = new Queue("automation", { connection });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MAX_STEPS = 200;
const DEPLOY_WAIT_MS = 30 * 60_000;

// ─── Templates: {{ trigger.body.ref }}, {{ prev.status }}, {{ steps.<id>.url }} ─
function lookup(path: string, ctx: Ctx): unknown {
  let cur: any = { trigger: ctx.trigger, steps: ctx.steps, prev: ctx.prev };
  for (const part of path.split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}
function render(value: unknown, ctx: Ctx): string {
  return String(value ?? "").replace(/\{\{\s*([\w.$-]+)\s*\}\}/g, (_m, p) => {
    const v = lookup(p, ctx);
    if (v === undefined || v === null) return "";
    return typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

// ─── Guards ──────────────────────────────────────────────────────────────────
/**
 * Where a workflow may send requests.
 *  - Nobody: link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10, ...), which hand out server credentials.
 *  - Non-admin owners: also loopback and private ranges, so a user's workflow cannot reach the platform's
 *    own database, Redis, API or other people's containers. Admins run the server and may call internal services.
 * WORKFLOW_ALLOW_PRIVATE=true lifts the second rule (single-user and local development setups).
 */
const ALLOW_PRIVATE_FOR_ALL = process.env.WORKFLOW_ALLOW_PRIVATE === "true";

function v4Parts(a: string): number[] | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(a);
  return m ? m.slice(1).map(Number) : null;
}
export function addressKind(addr: string): "metadata" | "private" | "public" {
  const a = addr.toLowerCase();
  const p = v4Parts(a);
  if (p) {
    if (p[0] === 169 && p[1] === 254) return "metadata";
    if (a.endsWith("100.100.100.200")) return "metadata";
    if (p[0] === 0 || p[0] === 127 || p[0] === 10) return "private";
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return "private";
    if (p[0] === 192 && p[1] === 168) return "private";
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return "private"; // carrier-grade NAT
    if (p[0] >= 224) return "private"; // multicast and reserved
    return "public";
  }
  if (/^fe[89ab]/.test(a) || a === "fd00:ec2::254") return "metadata";
  if (a === "::1" || a === "::" || /^f[cd]/.test(a)) return "private";
  // IPv6 forms that carry an IPv4 address (::ffff:7f00:1, ::7f00:1, 64:ff9b::7f00:1) are judged by that address.
  const g = v6Groups(a);
  if (g) {
    const zeros = g.slice(0, 5).every((x) => x === 0);
    const nat64 = g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0);
    if ((zeros && (g[5] === 0xffff || g[5] === 0)) || nat64) {
      return addressKind(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
    }
  }
  return "public";
}
function v6Groups(a: string): number[] | null {
  if (!net.isIPv6(a) || a.includes(".")) return null;
  const [head, tail] = a.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : null;
  const parts = t === null ? h : [...h, ...Array(8 - h.length - t.length).fill("0"), ...t];
  return parts.length === 8 ? parts.map((x) => parseInt(x || "0", 16)) : null;
}

async function assertSafeUrl(raw: string, opts: { httpsOnly?: boolean; allowPrivate: boolean }) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw.slice(0, 120)}`);
  }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http and https URLs are allowed");
  if (opts.httpsOnly && u.protocol !== "https:") throw new Error("Use an https URL");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  for (const a of addrs) {
    const kind = addressKind(a);
    if (kind === "metadata") throw new Error("Requests to link-local or cloud metadata addresses are blocked");
    if (kind === "private" && !opts.allowPrivate && !ALLOW_PRIVATE_FOR_ALL) {
      throw new Error(`${host} is a private or internal address. Only an administrator's workflows can call those.`);
    }
  }
  return u;
}

/** fetch() that checks every redirect hop too, so a public URL cannot bounce a request to an internal one. */
async function safeFetch(url: string, init: RequestInit, opts: { httpsOnly?: boolean; allowPrivate: boolean }): Promise<Response> {
  let current = url;
  let method = init.method ?? "GET";
  let body = init.body;
  for (let hop = 0; hop <= 5; hop++) {
    await assertSafeUrl(current, opts);
    const res = await fetch(current, { ...init, method, body, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(res.status)) return res;
    const next = res.headers.get("location");
    if (!next) return res;
    current = new URL(next, current).toString();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== "GET" && method !== "HEAD")) {
      method = "GET";
      body = undefined;
    }
  }
  throw new Error("Too many redirects");
}

async function isAdminUser(id: string) {
  const [u] = await db.select({ role: users.role }).from(users).where(eq(users.id, id)).limit(1);
  return u?.role === "admin";
}

async function siteFor(node: Node, ctx: Ctx, ownerId: string, isAdmin: boolean): Promise<Site> {
  // the app can come from the trigger, e.g. {{ trigger.appId }} in a deploy-event workflow
  const siteId = render(node.data?.siteId, ctx).trim();
  if (!siteId) throw new Error("Pick an app for this step");
  const [s] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!s || (!isAdmin && s.userId !== ownerId)) throw new Error("The app for this step doesn't exist or isn't yours");
  return s;
}

async function waitForDeployment(id: string, onUpdate: (status: string) => Promise<void>) {
  const end = Date.now() + DEPLOY_WAIT_MS;
  let last = "";
  while (Date.now() < end) {
    const [d] = await db.select().from(deployments).where(eq(deployments.id, id)).limit(1);
    if (!d) throw new Error("The deployment disappeared");
    if (d.status !== last) {
      last = d.status;
      await onUpdate(d.status);
    }
    if (["active", "failed", "superseded"].includes(d.status)) return d;
    await sleep(2000);
  }
  throw new Error("Gave up waiting for the deployment after 30 minutes");
}

async function startDeploy(site: Site, opts: { rollbackTo?: string | null; automationId: string }) {
  const [dep] = await db
    .insert(deployments)
    .values({ siteId: site.id, status: "queued", trigger: opts.rollbackTo ? "rollback" : "workflow", commitMessage: opts.rollbackTo ? "Rollback from a workflow" : null })
    .returning();
  await db.update(sites).set({ status: "provisioning", updatedAt: new Date() }).where(eq(sites.id, site.id));
  await hostingQueue.add(
    "deploy-site",
    { siteId: site.id, deploymentId: dep.id, trigger: dep.trigger, rollbackToDeploymentId: opts.rollbackTo ?? null, reuseImage: false },
    { removeOnComplete: 200, removeOnFail: 500 }
  );
  return dep;
}

const publicUrl = (domain: string) => {
  const tls = (process.env.DBBKP_TLS ?? "true") !== "false";
  const port = Number(process.env.DBBKP_PUBLIC_HTTP_PORT || 80);
  return tls ? `https://${domain}` : `http://${domain}${port && port !== 80 ? `:${port}` : ""}`;
};

// ─── Step types ──────────────────────────────────────────────────────────────
type Exec = (node: Node, ctx: Ctx, env: { ownerId: string; isAdmin: boolean; automationId: string; progress: (o: unknown) => Promise<void> }) => Promise<{ output: unknown; branch?: string }>;

const EXECUTORS: Record<string, Exec> = {
  "trigger.manual": async (_n, ctx) => ({ output: ctx.trigger }),
  "trigger.schedule": async (_n, ctx) => ({ output: ctx.trigger }),
  "trigger.webhook": async (_n, ctx) => ({ output: ctx.trigger }),
  "trigger.deployment": async (_n, ctx) => ({ output: ctx.trigger }),

  "action.deploy": async (node, ctx, env) => {
    const site = await siteFor(node, ctx, env.ownerId, env.isAdmin);
    const dep = await startDeploy(site, { automationId: env.automationId });
    const base = { app: site.domain, deploymentId: dep.id, url: publicUrl(site.domain) };
    if (node.data?.wait === false) return { output: { ...base, status: "queued" } };
    const done = await waitForDeployment(dep.id, (status) => env.progress({ ...base, status }));
    const output = { ...base, status: done.status, durationMs: done.durationMs, error: done.error ?? undefined };
    if (done.status !== "active") throw Object.assign(new Error(`Deploy of ${site.domain} failed${done.error ? `: ${done.error.split("\n")[0]}` : ""}`), { output });
    return { output };
  },

  "action.rollback": async (node, ctx, env) => {
    const site = await siteFor(node, ctx, env.ownerId, env.isAdmin);
    const [prev] = await db
      .select()
      .from(deployments)
      .where(and(eq(deployments.siteId, site.id), eq(deployments.status, "superseded"), isNotNull(deployments.imageTag)))
      .orderBy(desc(deployments.finishedAt))
      .limit(1);
    if (!prev) throw new Error(`${site.domain} has no earlier release to roll back to`);
    const dep = await startDeploy(site, { rollbackTo: prev.id, automationId: env.automationId });
    const done = await waitForDeployment(dep.id, (status) => env.progress({ app: site.domain, status }));
    const output = { app: site.domain, deploymentId: dep.id, rolledBackTo: prev.id, status: done.status };
    if (done.status !== "active") throw Object.assign(new Error(`Rollback of ${site.domain} failed`), { output });
    return { output };
  },

  "action.http": async (node, ctx, env) => {
    const url = render(node.data?.url, ctx).trim();
    if (!url) throw new Error("Set a URL for this step");
    const guard = { allowPrivate: env.isAdmin };
    await assertSafeUrl(url, guard);
    const method = String(node.data?.method || "GET").toUpperCase();
    const headers: Record<string, string> = {};
    for (const line of render(node.data?.headers, ctx).split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    const body = ["GET", "HEAD"].includes(method) ? undefined : render(node.data?.body, ctx) || undefined;
    if (body && !Object.keys(headers).some((h) => h.toLowerCase() === "content-type") && /^\s*[[{]/.test(body)) headers["content-type"] = "application/json";
    const timeoutMs = Math.min(120, Math.max(1, Number(node.data?.timeout) || 30)) * 1000;
    const expect = String(node.data?.expectStatus || "2xx").trim();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await safeFetch(url, { method, headers, body, signal: controller.signal }, guard);
    } catch (err: any) {
      if (/private or internal address|metadata addresses|Too many redirects|Only http/.test(err?.message ?? "")) throw err;
      throw new Error(err?.name === "AbortError" ? `No answer from ${url} within ${timeoutMs / 1000}s` : `Could not reach ${url}: ${err?.cause?.code || err.message}`);
    } finally {
      clearTimeout(timer);
    }
    const text = (await res.text()).slice(0, 20_000);
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {}
    const output = { url, status: res.status, ok: res.ok, durationMs: Date.now() - started, body: parsed };
    const matches = /^\dxx$/i.test(expect) ? String(res.status)[0] === expect[0] : expect.split(/[,\s]+/).filter(Boolean).includes(String(res.status));
    if (!matches) throw Object.assign(new Error(`Expected status ${expect}, got ${res.status}`), { output });
    return { output };
  },

  "logic.if": async (node, ctx) => {
    const left = render(node.data?.left, ctx);
    const right = render(node.data?.right, ctx);
    const op = String(node.data?.op || "equals");
    const num = (s: string) => Number(s);
    let result: boolean;
    switch (op) {
      case "not_equals": result = left !== right; break;
      case "contains": result = left.includes(right); break;
      case "gt": result = num(left) > num(right); break;
      case "lt": result = num(left) < num(right); break;
      case "is_true": result = ["true", "1", "yes", "ok"].includes(left.toLowerCase()); break;
      case "is_empty": result = left.trim() === ""; break;
      default: result = left === right;
    }
    return { output: { result, left, op, right }, branch: result ? "true" : "false" };
  },

  "logic.wait": async (node) => {
    const seconds = Math.min(3600, Math.max(0, Number(node.data?.seconds) || 0));
    await sleep(seconds * 1000);
    return { output: { waitedSeconds: seconds } };
  },

  "notify.message": async (node, ctx, env) => {
    const url = render(node.data?.url, ctx).trim();
    if (!url) throw new Error("Add the webhook URL for this message");
    const guard = { httpsOnly: true, allowPrivate: env.isAdmin };
    await assertSafeUrl(url, guard);
    const message = render(node.data?.message, ctx).slice(0, 1900);
    const kind = String(node.data?.kind || "discord");
    const payload = kind === "slack" ? { text: message } : kind === "discord" ? { content: message } : { text: message, content: message, message };
    const res = await safeFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }, guard);
    const output = { status: res.status, ok: res.ok, sent: message };
    if (!res.ok) throw Object.assign(new Error(`The ${kind} webhook answered ${res.status}`), { output });
    return { output };
  },
};

export const SUPPORTED_TYPES = Object.keys(EXECUTORS);

// ─── Running a workflow ──────────────────────────────────────────────────────
async function executeRun(runId: string) {
  const [run] = await db.select().from(automationRuns).where(eq(automationRuns.id, runId)).limit(1);
  if (!run || run.status !== "queued") return;
  const [a] = await db.select().from(automations).where(eq(automations.id, run.automationId)).limit(1);
  if (!a) return;
  const input: any = run.input ?? {};
  const graph: AutomationGraph = input.__graph ?? a.graph;
  const { __graph, ...triggerData } = input;

  // The owner's role is read at run time: an admin's workflow keeps admin rights only while its owner is an admin.
  const isAdmin = await isAdminUser(a.userId);

  const started = new Date();
  const steps: Record<string, AutomationStep> = {};
  let saving: Promise<unknown> = Promise.resolve();
  const save = (extra: Record<string, unknown> = {}) => {
    saving = saving.then(() => db.update(automationRuns).set({ steps: { ...steps }, ...extra }).where(eq(automationRuns.id, runId)));
    return saving;
  };
  await save({ status: "running", startedAt: started });
  await db.update(automations).set({ lastRunAt: started, lastRunStatus: "running" }).where(eq(automations.id, a.id));

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const outgoing = new Map<string, AutomationGraph["edges"]>();
  for (const e of graph.edges) outgoing.set(e.source, [...(outgoing.get(e.source) ?? []), e]);
  const trigger = graph.nodes.find((n) => n.type.startsWith("trigger."));

  const ctx: Ctx = { trigger: triggerData, steps: {}, prev: triggerData };
  let failure: string | null = null;
  const queue: Array<{ id: string; prev: unknown }> = trigger ? [{ id: trigger.id, prev: triggerData }] : [];
  const done = new Set<string>();
  let count = 0;

  while (queue.length && !failure) {
    const { id, prev } = queue.shift()!;
    if (done.has(id)) continue;
    done.add(id);
    const node = byId.get(id);
    if (!node) continue;
    if (++count > MAX_STEPS) {
      failure = `Stopped after ${MAX_STEPS} steps`;
      break;
    }
    ctx.prev = prev;
    const exec = EXECUTORS[node.type];
    const stepStart = Date.now();
    steps[id] = { status: "running", startedAt: new Date(stepStart).toISOString() };
    await save();
    const retries = node.type === "action.http" ? Math.min(5, Math.max(0, Number(node.data?.retries) || 0)) : 0;
    let result: { output: unknown; branch?: string } | null = null;
    let error: any = null;
    let attempts = 0;
    for (let i = 0; i <= retries; i++) {
      attempts = i + 1;
      try {
        if (!exec) throw new Error(`"${node.type}" steps can't run yet`);
        result = await exec(node, ctx, {
          ownerId: a.userId,
          isAdmin,
          automationId: a.id,
          progress: async (o) => {
            steps[id] = { ...steps[id], output: o };
            await save();
          },
        });
        error = null;
        break;
      } catch (err) {
        error = err;
        if (i < retries) await sleep(2000);
      }
    }
    const durationMs = Date.now() - stepStart;
    if (result) {
      steps[id] = { status: "success", startedAt: steps[id].startedAt, durationMs, output: result.output, branch: result.branch, attempts };
      ctx.steps[id] = result.output;
      for (const e of outgoing.get(id) ?? []) {
        if (result.branch && (e.sourceHandle ?? "true") !== result.branch) continue;
        queue.push({ id: e.target, prev: result.output });
      }
    } else {
      const output = error?.output;
      steps[id] = { status: "failed", startedAt: steps[id].startedAt, durationMs, output, error: String(error?.message || error).slice(0, 2000), attempts };
      ctx.steps[id] = output ?? { error: steps[id].error };
      if (node.data?.continueOnError) {
        for (const e of outgoing.get(id) ?? []) queue.push({ id: e.target, prev: ctx.steps[id] });
      } else {
        failure = `${node.data?.label || node.type}: ${steps[id].error}`;
      }
    }
    await save();
  }

  for (const n of graph.nodes) if (!steps[n.id]) steps[n.id] = { status: "skipped", startedAt: new Date().toISOString() };
  const finished = new Date();
  const status = failure ? "failed" : "success";
  await save({ status, error: failure, finishedAt: finished, durationMs: finished.getTime() - started.getTime() });
  await saving;
  await db.update(automations).set({ lastRunAt: started, lastRunStatus: status }).where(eq(automations.id, a.id));
  return { status };
}

async function createRun(automationId: string, trigger: string, input: Record<string, unknown>) {
  const [a] = await db.select().from(automations).where(eq(automations.id, automationId)).limit(1);
  if (!a) return null;
  const [run] = await db.insert(automationRuns).values({ automationId, trigger, input: { ...input, __graph: a.graph }, status: "queued" }).returning();
  return run;
}

/** Called by the hosting worker when a deploy finishes. Deploys started by workflows don't fire it, so workflows can't loop. */
export async function fireDeployEvent(site: Site, deployment: { id: string; trigger: string | null; status: string; error?: string | null }) {
  if (deployment.trigger === "workflow") return;
  const event = deployment.status === "active" ? "success" : "failed";
  const candidates = await db.select().from(automations).where(and(eq(automations.enabled, true), eq(automations.triggerType, "deployment")));
  for (const a of candidates) {
    const t = a.graph.nodes.find((n) => n.type === "trigger.deployment");
    const wantEvent = String(t?.data?.event || "any");
    const wantSite = String(t?.data?.siteId || "");
    if (wantEvent !== "any" && wantEvent !== event) continue;
    if (wantSite && wantSite !== site.id) continue;
    // Only an admin's workflow hears about other people's apps.
    if (a.userId !== site.userId && !(await isAdminUser(a.userId))) continue;
    const run = await createRun(a.id, "deployment", {
      event,
      app: site.domain,
      appId: site.id,
      url: publicUrl(site.domain),
      deploymentId: deployment.id,
      error: deployment.error ?? null,
    });
    if (run) await automationQueue.add("run", { runId: run.id }, { removeOnComplete: 200, removeOnFail: 200 });
  }
}

export const automationWorker = new Worker(
  "automation",
  async (job: Job) => {
    if (job.name === "run") return executeRun(job.data.runId);
    if (job.name.startsWith("schedule:")) {
      const [a] = await db.select().from(automations).where(eq(automations.id, job.data.automationId)).limit(1);
      if (!a || !a.enabled || a.triggerType !== "schedule") return { skipped: true };
      const run = await createRun(a.id, "schedule", { scheduledAt: new Date().toISOString(), cron: a.schedule });
      return run ? executeRun(run.id) : null;
    }
    return undefined;
  },
  { connection, concurrency: Math.max(1, Number(process.env.WORKFLOW_CONCURRENCY || 4)) }
);

automationWorker.on("failed", (job, err) => console.error(`[Workflows] Job ${job?.id} failed: ${err.message}`));
console.log("[Worker Node] Booted workflow worker");
