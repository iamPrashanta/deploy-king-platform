import path from "node:path";
import type { DkApi, ToolCallResult } from "./api";
import type { LlmToolDef } from "./llm";
import type { PlanAction } from "./types";
import { SecretStore } from "./secrets";
import { checkProject, prepareUpload, sizeText } from "./project";

/**
 * The tools the model gets. Most are the Deploy King MCP tools (apps/api/src/mcp/tools.ts) called over
 * HTTP; a few run here: the project check of an attached ZIP, its upload, plans and questions to the user.
 *
 * kind:
 *   read     runs without asking (unless the config says "ask")
 *   change   runs only inside an approved plan
 *   control  propose_plan / ask_user: talk to the user, never touch the server
 */

export type ToolKind = "read" | "change" | "control";

export interface Attachment {
  name: string;
  path: string;
}

export interface ToolContext {
  api: DkApi;
  secrets: SecretStore;
  attachments: Map<string, Attachment>;
  signal: AbortSignal;
  /** Ask the user; resolves with the chosen option (id and label), or only text when they typed their own answer. */
  ask(prompt: string, options: { id: string; label: string }[], opts?: { strict?: boolean }): Promise<{ id?: string; text: string }>;
  /** A deploy question is answered: this is a change, so the beforeChange hook sees it. */
  confirmAnswer(app: string, question: string, answer: string): Promise<boolean>;
}

export interface ToolDef {
  name: string;
  description: string;
  kind: ToolKind;
  /** For change tools: the Deploy King Cloud ticket action. */
  action?: PlanAction["action"];
  properties: Record<string, unknown>;
  required?: string[];
  /** The plan line for this call. */
  step(input: any, ctx: Pick<ToolContext, "attachments">): string;
  /** The one line shown when it finished. */
  summary(data: any, input: any): string;
  run(input: any, ctx: ToolContext): Promise<ToolCallResult>;
  /** For uploads: what will be sent, for the plan and beforeChange. */
  file?(input: any, ctx: Pick<ToolContext, "attachments">): PlanAction["file"];
}

class ToolInputError extends Error {}

const S = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const I = (description: string, extra: Record<string, unknown> = {}) => ({ type: "integer", description, ...extra });
const B = (description: string) => ({ type: "boolean", description });
const MAP = (description: string) => ({ type: "object", description, additionalProperties: { type: "string" } });
const LIST = (description: string) => ({ type: "array", description, items: { type: "string" } });

const APP = S("The app: its name (e.g. shop-api), its full domain, or its id from list_apps");
const SECRET_HINT =
  "Values may be {{secret:NAME}} (a secret the user gave, see the user's message) or {{random}} / {{random:64}} (a new random value made on this computer). Never write a secret value yourself.";

/** Runs an MCP tool of the same name on the server. */
const mcp = (name: string) => async (input: any, ctx: ToolContext) => ctx.api.callTool(name, input ?? {}, ctx.signal);

const appOf = (input: any) => (typeof input?.app === "string" ? input.app : typeof input?.name === "string" ? input.name : undefined);
const keys = (m: unknown) => (m && typeof m === "object" ? Object.keys(m as object) : []);
const list = (xs: string[]) => (xs.length <= 4 ? xs.join(", ") : `${xs.slice(0, 4).join(", ")} and ${xs.length - 4} more`);
const n = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function attachment(input: any, ctx: Pick<ToolContext, "attachments">): Attachment {
  const ref = String(input?.file ?? "");
  const a = ctx.attachments.get(ref) ?? [...ctx.attachments.values()].find((x) => x.name.toLowerCase() === ref.toLowerCase() || path.basename(x.path) === ref);
  if (!a) {
    const names = [...ctx.attachments.keys()];
    throw new ToolInputError(names.length ? `There is no attachment called "${ref}". Attached: ${names.join(", ")}` : "No file is attached. Ask the user to attach the ZIP or folder.");
  }
  return a;
}

function deployLine(d: any) {
  if (!d) return "done";
  if (d.result === "live") return `live at ${d.url}`;
  if (d.result === "failed") return `deploy failed${d.deployment?.error ? `: ${String(d.deployment.error).split("\n")[0]}` : ""}`;
  if (d.result === "replaced") return "replaced by a newer deploy";
  if (d.result === "needs_answer") return "waiting for an answer";
  return "still deploying";
}

export const TOOLS: ToolDef[] = [
  // ─── control ──────────────────────────────────────────────────────────────
  {
    name: "propose_plan",
    description:
      "Show the user a numbered plan of the changes you are about to make and wait for their answer. Required before any change (create, deploy, upload, variables, jobs, workers, databases, rollback, delete). List in `tools` every change tool the plan will use; changes with other tools need a new plan.",
    kind: "control",
    properties: {
      steps: LIST("The plan, one short line per step, in the user's words (\"Create database shop_api and set DATABASE_URL\")"),
      tools: LIST("The change tools the plan will call, e.g. [\"create_database\", \"deploy_zip\"]"),
      app: S("The app the plan is about, if it is about one"),
    },
    required: ["steps", "tools"],
    step: () => "",
    summary: (d) => (d?.approved ? "approved" : "not approved"),
    run: async () => ({ ok: true, data: null }), // handled by the conversation
  },
  {
    name: "ask_user",
    description: "Ask the user one question, with a few answers to choose from when there are obvious ones. Use it when something is missing or unclear; do not guess names, domains or secrets.",
    kind: "control",
    properties: { question: S("The question"), options: LIST("Up to 4 short answers to choose from (the user may also type their own)") },
    required: ["question"],
    step: () => "",
    summary: (d) => `answered: ${d?.answer ?? ""}`,
    run: async (input, ctx) => {
      const opts = (Array.isArray(input.options) ? input.options : []).slice(0, 6).map((label: unknown, i: number) => ({ id: String(i + 1), label: String(label) }));
      const answer = await ctx.ask(String(input.question ?? ""), opts);
      return { ok: true, data: { answer: ctx.secrets.captureFromUserText(answer.text) } };
    },
  },

  // ─── read ─────────────────────────────────────────────────────────────────
  {
    name: "list_apps",
    description: "Lists the apps on this Deploy King server with their URL and status (active, crashing, provisioning, failed, stopped).",
    kind: "read",
    properties: {},
    step: () => "List the apps",
    summary: (d) => n(d?.count ?? 0, "app"),
    run: mcp("list_apps"),
  },
  {
    name: "get_app",
    description: "Everything about one app: settings, variable names (values are never shown), the last deploys, whether it is running or crash-looping, and any question a deploy waits on.",
    kind: "read",
    properties: { app: APP },
    required: ["app"],
    step: (a) => `Look at ${a.app}`,
    summary: (d) => `${d?.name ?? "app"}: ${d?.status ?? "?"}${d?.container?.restarts ? `, ${n(d.container.restarts, "restart")}` : ""}`,
    run: mcp("get_app"),
  },
  {
    name: "get_deploy_log",
    description: "The build and start log of an app's latest deploy (or a given one), with its status and error.",
    kind: "read",
    properties: { app: APP, deployment: S("Deploy id; leave out for the latest"), lines: I("How many of the last lines (10-1000)") },
    required: ["app"],
    step: (a) => `Read the deploy log of ${a.app}`,
    summary: (d) => `deploy ${d?.deployment?.status ?? "?"}`,
    run: mcp("get_deploy_log"),
  },
  {
    name: "get_app_logs",
    description: "What the running app printed (stdout and stderr), newest last.",
    kind: "read",
    properties: { app: APP, lines: I("How many of the last lines (10-1000)") },
    required: ["app"],
    step: (a) => `Read the logs of ${a.app}`,
    summary: (d) => (d?.running === false ? "not running" : `${String(d?.logs ?? "").split("\n").filter(Boolean).length} lines`),
    run: mcp("get_app_logs"),
  },
  {
    name: "check_repo",
    description: "Clones a git repository on the server and checks whether it can be deployed: framework, port, variables, databases it needs, problems. Run it before create_app for a repository.",
    kind: "read",
    properties: { repoUrl: S("https:// git URL"), branch: S("Branch"), rootDirectory: S("Folder inside the repository to check") },
    required: ["repoUrl"],
    step: (a) => `Check ${a.repoUrl}`,
    summary: (d) => d?.summary ?? d?.verdict ?? "checked",
    run: mcp("check_repo"),
  },
  {
    name: "check_project",
    description: "Checks an attached ZIP file or folder on this computer (nothing is uploaded): framework, port, start command, variables it needs, databases, problems. Run it before deploy_zip.",
    kind: "read",
    properties: { file: S("The attachment's name, as listed in the user's message") },
    required: ["file"],
    step: (a) => `Check ${a.file}`,
    summary: (d, a) => {
      const bits = [d?.framework, d?.runtime, d?.port ? `port ${d.port}` : null].filter(Boolean);
      return `Checked ${a?.file}: ${bits.length ? bits.join(" · ") : d?.summary ?? d?.verdict}`;
    },
    run: async (input, ctx) => {
      const a = attachment(input, ctx);
      try {
        return { ok: true, data: checkProject(a.path) };
      } catch (e: any) {
        return { ok: false, error: e?.message ?? String(e) };
      }
    },
  },
  {
    name: "check_fit",
    description: "Whether the server has room for a new app with a memory limit (512 MB when left out), or for an existing app with a higher limit: fits, tight or blocked, and why.",
    kind: "read",
    properties: { memoryMb: I("Memory limit in MB"), app: S("An existing app, to check a new limit for") },
    step: (a) => `Check that ${a.memoryMb ?? 512} MB fits`,
    summary: (d) => String(d?.verdict ?? "checked"),
    run: mcp("check_fit"),
  },
  {
    name: "platform_status",
    description: "Deploy King version, the domain apps get (<name>.<domain>), whether HTTPS is on, and counts of apps and deploys today.",
    kind: "read",
    properties: {},
    step: () => "Look at the platform status",
    summary: (d) => `Deploy King ${d?.version ?? ""} · apps get ${d?.appsGet ?? "?"}`,
    run: mcp("platform_status"),
  },
  {
    name: "get_capacity",
    description: "Server memory and disk: total, reserved, promised to apps, free; roughly how many more apps fit. Needs an admin's token.",
    kind: "read",
    properties: {},
    step: () => "Look at the server's capacity",
    summary: (d) => (d?.memoryMb?.freeToPromiseMb !== undefined ? `${d.memoryMb.freeToPromiseMb} MB free to give out` : "checked"),
    run: mcp("get_capacity"),
  },
  {
    name: "list_scheduled_jobs",
    description: "An app's scheduled jobs: command, schedule in words, time zone, on or off, last run.",
    kind: "read",
    properties: { app: APP },
    required: ["app"],
    step: (a) => `List the scheduled jobs of ${a.app}`,
    summary: (d) => n(d?.jobs?.length ?? 0, "scheduled job"),
    run: mcp("list_scheduled_jobs"),
  },
  {
    name: "list_workers",
    description: "An app's workers (background processes): command, copies, memory, running or crashing.",
    kind: "read",
    properties: { app: APP },
    required: ["app"],
    step: (a) => `List the workers of ${a.app}`,
    summary: (d) => n(d?.workers?.length ?? 0, "worker"),
    run: mcp("list_workers"),
  },
  {
    name: "list_databases",
    description: "The databases on this server you can see, and the app each belongs to. Passwords are never shown.",
    kind: "read",
    properties: {},
    step: () => "List the databases",
    summary: (d) => n(d?.count ?? 0, "database"),
    run: mcp("list_databases"),
  },
  {
    name: "wait_for_deploy",
    description:
      "Follows an app's latest deploy until it is live or fails (a few minutes at most). If the deploy stops on a question, the user is asked here and the answer is sent for you. Returns the error and the end of the log when it fails.",
    kind: "read",
    properties: { app: APP, deployment: S("Deploy id; leave out for the latest") },
    required: ["app"],
    step: (a) => `Follow the deploy of ${a.app}`,
    summary: (d) => deployLine(d),
    run: async (input, ctx) => {
      const end = Date.now() + 10 * 60_000;
      let r: ToolCallResult;
      for (;;) {
        r = await ctx.api.callTool("wait_for_deploy", { app: input.app, ...(input.deployment ? { deployment: input.deployment } : {}), timeoutSeconds: 110 }, ctx.signal);
        if (!r.ok) return r;
        const d: any = r.data;
        if (d?.result === "needs_answer" && d.deployment?.question) {
          const q = d.deployment.question;
          const options = (q.answers ?? []).map((o: any) => ({ id: String(o.answer), label: String(o.label ?? o.answer) }));
          const prompt = [q.question, q.detail].filter(Boolean).join("\n");
          const picked = await ctx.ask(`${d.app}: ${prompt}`, options, { strict: options.length > 0 });
          const value = picked.id ?? picked.text;
          if (!(await ctx.confirmAnswer(d.app, q.question, picked.text))) {
            return { ok: false, error: "The answer to the deploy question was not approved, so the deploy is still waiting." };
          }
          const a = await ctx.api.callTool("answer_deploy_question", { app: d.app, answer: value }, ctx.signal);
          if (!a.ok) return a;
          continue;
        }
        if (d?.result === "still_running" && Date.now() < end) continue;
        return r;
      }
    },
  },

  // ─── change ───────────────────────────────────────────────────────────────
  {
    name: "deploy_zip",
    description: `Uploads an attached ZIP file or folder and deploys it as a new app (a plain name becomes <name>.<the server's domain>). Pass the port and variables check_project reported. ${SECRET_HINT} Then call wait_for_deploy.`,
    kind: "change",
    action: "deploy",
    properties: {
      file: S("The attachment's name"),
      name: S("App name (letters, digits, dashes) or a full domain"),
      port: I("Port the app listens on"),
      memoryMb: I("Memory limit in MB"),
      variables: MAP("Environment variables"),
    },
    required: ["file", "name"],
    file: (input, ctx) => {
      const a = attachment(input, ctx);
      const p = prepareUpload(a.path);
      return { name: a.name, bytes: p.bytes, sha256: p.sha256 };
    },
    step: (a, ctx) => {
      let size = "";
      try {
        size = ` (${sizeText(prepareUpload(attachment(a, ctx).path).bytes)})`;
      } catch {}
      const vars = keys(a.variables);
      return `Upload ${a.file}${size} and deploy it as ${a.name}${a.port ? ` on port ${a.port}` : ""}${a.memoryMb ? ` with ${a.memoryMb} MB` : ""}${vars.length ? `, variables ${list(vars)}` : ""}`;
    },
    summary: (d) => `${d?.name ?? "app"} uploaded, deploy started`,
    run: async (input, ctx) => {
      const a = attachment(input, ctx);
      const p = prepareUpload(a.path);
      return ctx.api.uploadZip(
        {
          zip: p.zip,
          fileName: path.basename(a.path),
          name: String(input.name),
          ...(input.port ? { port: Number(input.port) } : {}),
          ...(input.memoryMb ? { memoryMb: Number(input.memoryMb) } : {}),
          ...(input.variables ? { variables: input.variables } : {}),
        },
        ctx.signal
      );
    },
  },
  {
    name: "create_app",
    description: `Creates an app from a git repository (repoUrl) or a container image (image) and starts its first deploy. Run check_repo first for repositories. ${SECRET_HINT} Then call wait_for_deploy.`,
    kind: "change",
    action: "deploy",
    properties: {
      name: S("App name or full domain"),
      repoUrl: S("https:// git URL (or use image)"),
      branch: S("Branch"),
      image: S("Container image such as nginx:alpine (or use repoUrl)"),
      port: I("Port the app listens on"),
      variables: MAP("Environment variables"),
      buildVariables: LIST("Names from variables that the build reads"),
      rootDirectory: S("Folder inside the repository to build"),
      memoryMb: I("Memory limit in MB"),
    },
    required: ["name"],
    step: (a) => {
      const vars = keys(a.variables);
      const from = a.image ? `image ${a.image}` : `${a.repoUrl}${a.branch ? ` (${a.branch})` : ""}`;
      return `Create ${a.name} from ${from}${a.port ? `, port ${a.port}` : ""}${a.memoryMb ? `, ${a.memoryMb} MB` : ""}${vars.length ? `, variables ${list(vars)}` : ""}, and deploy it`;
    },
    summary: (d) => `${d?.name ?? "app"} created, deploy started`,
    run: mcp("create_app"),
  },
  {
    name: "deploy_app",
    description: "Starts a new deploy of an app (pulls and builds again), or with restartOnly restarts the current build so new variables take effect.",
    kind: "change",
    action: "deploy",
    properties: { app: APP, restartOnly: B("Restart the current build instead of building again") },
    required: ["app"],
    step: (a) => (a.restartOnly ? `Restart ${a.app} with its current build` : `Build and deploy ${a.app} again`),
    summary: (d) => `${d?.app ?? "app"}: deploy started`,
    run: mcp("deploy_app"),
  },
  {
    name: "set_env",
    description: `Sets or removes an app's environment variables (values are stored encrypted and never shown again). replaceAll makes \`set\` the complete list. ${SECRET_HINT}`,
    kind: "change",
    action: "change",
    properties: {
      app: APP,
      set: MAP("Variables to add or change"),
      remove: LIST("Names to remove"),
      replaceAll: B("Remove every variable not in set"),
      restart: B("Restart the app now so it takes effect"),
    },
    required: ["app"],
    step: (a) => {
      const parts: string[] = [];
      const set = keys(a.set);
      if (set.length) parts.push(`set ${list(set)}`);
      if (a.remove?.length) parts.push(`remove ${list(a.remove)}`);
      if (a.replaceAll) parts.push("remove every other variable");
      const text = parts.join(", ") || "change variables";
      return `${text[0]!.toUpperCase()}${text.slice(1)} on ${a.app}${a.restart ? ", then restart it" : ""}`;
    },
    summary: (d) => [d?.set?.length ? `set ${list(d.set)}` : "", d?.removed?.length ? `removed ${list(d.removed)}` : ""].filter(Boolean).join("; ") || "variables saved",
    run: mcp("set_env"),
  },
  {
    name: "rollback_app",
    description: "Puts an earlier release of an app back without rebuilding (the one before the current, or a given deploy id).",
    kind: "change",
    action: "deploy",
    properties: { app: APP, deployment: S("Deploy id to go back to") },
    required: ["app"],
    step: (a) => `Roll ${a.app} back to ${a.deployment ? `deploy ${a.deployment}` : "the previous release"}`,
    summary: (d) => `${d?.app ?? "app"}: rolling back`,
    run: mcp("rollback_app"),
  },
  {
    name: "add_scheduled_job",
    description: "Adds a scheduled job to an app: a command that runs inside it on a five-field cron schedule, in a time zone.",
    kind: "change",
    action: "change",
    properties: {
      app: APP,
      name: S("Short name"),
      command: S("The command"),
      schedule: S("Cron text such as 0 6 * * *, or @daily"),
      timezone: S("IANA time zone"),
      runIn: S("web or worker:<name>"),
      runNow: B("Also run it once now"),
    },
    required: ["app", "name", "command", "schedule"],
    step: (a) => `Add scheduled job "${a.name}" to ${a.app}: ${a.command} (${a.schedule}${a.timezone ? ` ${a.timezone}` : ""})`,
    summary: (d) => `job ${d?.job?.name ?? ""} added · ${d?.job?.words ?? ""}`.trim(),
    run: mcp("add_scheduled_job"),
  },
  {
    name: "add_worker",
    description: "Adds a worker to an app: a background process from the app's image (queue consumer, email sender).",
    kind: "change",
    action: "change",
    properties: { app: APP, name: S("Lowercase name"), command: S("The command"), copies: I("Copies (1-8)"), memoryMb: I("Memory per copy in MB") },
    required: ["app", "name", "command"],
    step: (a) => `Add worker ${a.name} to ${a.app}: ${a.command}, ${a.copies ?? 1} × ${a.memoryMb ?? 256} MB`,
    summary: (d) => `worker ${d?.worker?.name ?? ""} added`,
    run: mcp("add_worker"),
  },
  {
    name: "create_database",
    description: "Creates a PostgreSQL database and user for an app. The password is made on the server and never shown; the connection URL goes into the app variable `variable` (default DATABASE_URL).",
    kind: "change",
    action: "change",
    properties: { app: APP, name: S("Database name: lowercase letters, digits, _"), user: S("Database user; defaults to the name"), variable: S("Variable that gets the connection URL") },
    required: ["app", "name"],
    step: (a) => `Create database ${a.name} for ${a.app} and set ${a.variable || "DATABASE_URL"}`,
    summary: (d) => `database ${d?.database?.name ?? ""} created${d?.variable ? `, ${d.variable} set` : ""}`,
    run: mcp("create_database"),
  },
  {
    name: "delete_app",
    description: "Deletes an app: containers, images, files, settings. Cannot be undone. confirm must be the app's full domain.",
    kind: "change",
    action: "delete",
    properties: { app: APP, confirm: S("The app's full domain, again") },
    required: ["app", "confirm"],
    step: (a) => `Delete ${a.confirm || a.app} for good (containers, files and settings)`,
    summary: (d) => `${d?.deleted ?? "app"} deleted`,
    run: mcp("delete_app"),
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export const CHANGE_TOOLS = TOOLS.filter((t) => t.kind === "change").map((t) => t.name);

export function toolDefs(): LlmToolDef[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: { type: "object", properties: t.properties, ...(t.required?.length ? { required: t.required } : {}) },
  }));
}

export { ToolInputError, appOf };
