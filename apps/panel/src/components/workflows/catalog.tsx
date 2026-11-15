import { Clock, GitFork, Globe, Hourglass, MessageSquare, Rocket, RotateCcw, Webhook, Zap, CloudUpload, type LucideIcon } from "lucide-react";

/** Every step a workflow can have: how it looks, its defaults, and a one-line summary of its settings. */
export type StepKind = {
  type: string;
  group: "Triggers" | "Apps" | "Web" | "Logic" | "Notify";
  label: string;
  description: string;
  icon: LucideIcon;
  color: string; // CSS colour for the icon
  defaults: Record<string, any>;
  summary: (d: Record<string, any>, ctx: { appName: (id: string) => string }) => string;
  branches?: Array<{ id: string; label: string; color: string }>;
};

const CRON_NAMES: Record<string, string> = {
  "*/5 * * * *": "Every 5 minutes",
  "*/15 * * * *": "Every 15 minutes",
  "0 * * * *": "Every hour",
  "0 2 * * *": "Every day at 02:00",
  "0 8 * * 1": "Mondays at 08:00",
};

export const STEPS: StepKind[] = [
  {
    type: "trigger.manual", group: "Triggers", label: "Manual", description: "Runs when you click Execute.",
    icon: Zap, color: "var(--amber)", defaults: { label: "When I click Execute" }, summary: () => "Execute button",
  },
  {
    type: "trigger.schedule", group: "Triggers", label: "Schedule", description: "Runs on a timetable (cron).",
    icon: Clock, color: "var(--amber)", defaults: { label: "On a schedule", cron: "0 2 * * *" },
    summary: (d) => CRON_NAMES[d.cron] ?? d.cron ?? "",
  },
  {
    type: "trigger.webhook", group: "Triggers", label: "Webhook", description: "Runs when something POSTs to its URL.",
    icon: Webhook, color: "var(--amber)", defaults: { label: "On a webhook call" }, summary: () => "POST to its URL",
  },
  {
    type: "trigger.deployment", group: "Triggers", label: "After a deploy", description: "Runs when an app finishes deploying.",
    icon: Rocket, color: "var(--amber)", defaults: { label: "After a deploy", event: "any", siteId: "" },
    summary: (d, c) => `${d.event === "success" ? "Succeeded" : d.event === "failed" ? "Failed" : "Any result"} · ${d.siteId ? c.appName(d.siteId) : "any app"}`,
  },
  {
    type: "action.deploy", group: "Apps", label: "Deploy app", description: "Builds and starts a new release.",
    icon: CloudUpload, color: "var(--blue)", defaults: { label: "Deploy app", siteId: "", wait: true },
    summary: (d, c) => `${d.siteId ? c.appName(d.siteId) : "Pick an app"}${d.wait === false ? "" : " · wait"}`,
  },
  {
    type: "action.rollback", group: "Apps", label: "Roll back", description: "Puts the previous release back.",
    icon: RotateCcw, color: "var(--red)", defaults: { label: "Roll back", siteId: "" },
    summary: (d, c) => (d.siteId ? c.appName(d.siteId) : "Pick an app"),
  },
  {
    type: "action.http", group: "Web", label: "HTTP request", description: "Calls a URL and checks the answer.",
    icon: Globe, color: "var(--purple)", defaults: { label: "HTTP request", method: "GET", url: "", expectStatus: "2xx", timeout: 30, retries: 0 },
    summary: (d) => `${d.method || "GET"} ${String(d.url || "").replace(/^https?:\/\//, "").slice(0, 28) || "…"}`,
  },
  {
    type: "logic.if", group: "Logic", label: "If", description: "Goes one way or the other.",
    icon: GitFork, color: "var(--green)", defaults: { label: "If", left: "{{ prev.ok }}", op: "is_true", right: "" },
    summary: (d) => `${String(d.left || "").replace(/\{\{\s*|\s*\}\}/g, "")} ${OPS[d.op] ?? d.op} ${d.op === "is_true" || d.op === "is_empty" ? "" : d.right ?? ""}`.trim(),
    branches: [
      { id: "true", label: "true", color: "var(--green)" },
      { id: "false", label: "false", color: "var(--red)" },
    ],
  },
  {
    type: "logic.wait", group: "Logic", label: "Wait", description: "Pauses before the next step.",
    icon: Hourglass, color: "var(--muted)", defaults: { label: "Wait", seconds: 30 }, summary: (d) => `${d.seconds ?? 0} s`,
  },
  {
    type: "notify.message", group: "Notify", label: "Send a message", description: "Posts to Discord, Slack or any webhook.",
    icon: MessageSquare, color: "var(--text)", defaults: { label: "Send a message", kind: "discord", url: "", message: "" },
    summary: (d) => (d.kind === "slack" ? "Slack" : d.kind === "webhook" ? "Webhook" : "Discord"),
  },
];

export const OPS: Record<string, string> = {
  equals: "=",
  not_equals: "≠",
  contains: "contains",
  gt: ">",
  lt: "<",
  is_true: "is true",
  is_empty: "is empty",
};

export const STEP_BY_TYPE = Object.fromEntries(STEPS.map((s) => [s.type, s]));
export const isTrigger = (type: string) => type.startsWith("trigger.");
export const CRON_PRESETS = Object.entries(CRON_NAMES);

export type WFNode = { id: string; type: string; position: { x: number; y: number }; data: Record<string, any> };
export type WFEdge = { id: string; source: string; target: string; sourceHandle?: string | null };
export type WFGraph = { nodes: WFNode[]; edges: WFEdge[] };

/** "Trigger → Step → Step" summary for lists. */
export function chain(graph: WFGraph | null | undefined): string {
  if (!graph?.nodes?.length) return "";
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const start = graph.nodes.find((n) => isTrigger(n.type));
  const seen = new Set<string>();
  const out: string[] = [];
  let cur = start;
  while (cur && !seen.has(cur.id) && out.length < 6) {
    seen.add(cur.id);
    out.push(cur.data?.label || STEP_BY_TYPE[cur.type]?.label || cur.type);
    const next = graph.edges.filter((e) => e.source === cur!.id);
    if (next.length > 1) {
      out.push(next.map((e) => byId.get(e.target)?.data?.label ?? "…").join(" / "));
      break;
    }
    cur = next[0] ? byId.get(next[0].target) : undefined;
  }
  return out.join(" → ");
}

export function newId(graph: WFGraph, prefix = "s") {
  let i = graph.nodes.length + 1;
  while (graph.nodes.some((n) => n.id === `${prefix}${i}`)) i++;
  return `${prefix}${i}`;
}

// ─── Recipes ────────────────────────────────────────────────────────────────
const n = (id: string, type: string, x: number, y: number, data: Record<string, any> = {}): WFNode => ({
  id, type, position: { x, y }, data: { ...STEP_BY_TYPE[type].defaults, ...data },
});
const e = (source: string, target: string, sourceHandle?: string): WFEdge => ({ id: `${source}-${sourceHandle ?? "out"}-${target}`, source, target, sourceHandle: sourceHandle ?? null });

export const RECIPES: Array<{ id: string; name: string; steps: string; description: string; graph: WFGraph }> = [
  {
    id: "smoke-test",
    name: "Smoke test after every deploy",
    steps: "deploy → check → if → notify / roll back",
    description: "When an app deploys, call its URL. Healthy: say so. Not healthy: roll back and alert.",
    graph: {
      nodes: [
        n("t", "trigger.deployment", 0, 160, { label: "After a deploy", event: "success" }),
        n("check", "action.http", 200, 160, { label: "Check the app", url: "{{ trigger.url }}", retries: 2, continueOnError: true }),
        n("ok", "logic.if", 400, 160, { label: "Healthy?", left: "{{ prev.ok }}", op: "is_true" }),
        n("live", "notify.message", 620, 40, { label: "Say it is live", message: "✅ {{ trigger.app }} is live: {{ trigger.url }}" }),
        n("back", "action.rollback", 620, 280, { label: "Roll back", siteId: "{{ trigger.appId }}" }),
        n("alert", "notify.message", 820, 280, { label: "Alert the team", message: "⚠️ {{ trigger.app }} failed its smoke test and was rolled back." }),
      ],
      edges: [e("t", "check"), e("check", "ok"), e("ok", "live", "true"), e("ok", "back", "false"), e("back", "alert")],
    },
  },
  {
    id: "uptime",
    name: "Check a site every 5 minutes",
    steps: "schedule → request → if → notify",
    description: "Call a URL on a timer and post to Discord or Slack when it stops answering.",
    graph: {
      nodes: [
        n("t", "trigger.schedule", 0, 120, { label: "Every 5 minutes", cron: "*/5 * * * *" }),
        n("get", "action.http", 200, 120, { label: "Call the site", url: "https://example.com", continueOnError: true }),
        n("up", "logic.if", 400, 120, { label: "Answering?", left: "{{ prev.ok }}", op: "is_true" }),
        n("tell", "notify.message", 620, 240, { label: "Tell the team", message: "🔴 {{ steps.get.url }} is not answering {{ steps.get.status }}" }),
      ],
      edges: [e("t", "get"), e("get", "up"), e("up", "tell", "false")],
    },
  },
  {
    id: "deploy-failed",
    name: "Tell the team when a deploy breaks",
    steps: "deploy failed → message",
    description: "Post the app and the error to Discord or Slack whenever a deploy fails.",
    graph: {
      nodes: [
        n("t", "trigger.deployment", 0, 120, { label: "A deploy failed", event: "failed" }),
        n("msg", "notify.message", 220, 120, { label: "Post the error", message: "❌ {{ trigger.app }} failed to deploy: {{ trigger.error }}" }),
      ],
      edges: [e("t", "msg")],
    },
  },
];

export function blankGraph(): WFGraph {
  return { nodes: [n("t", "trigger.manual", 0, 120)], edges: [] };
}
