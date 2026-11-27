import type { AppRouter } from "../trpc";
import { BASE_DOMAIN, PUBLIC_HTTP_PORT, TLS_ENABLED } from "../config";
import type { TokenScope } from "../services/apiTokens";
import { anyObj, bool, int, obj, str, strList, strMap, type InputSchema } from "./schema";

export type Caller = ReturnType<AppRouter["createCaller"]>;
export type ToolCtx = { caller: Caller; user: { sub: string; username: string; role: string } };

export type Tool = {
  name: string;
  title: string;
  description: string;
  scope: TokenScope; // the least a token needs to use it
  inputSchema: InputSchema;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: Record<string, any>, t: ToolCtx) => Promise<unknown>;
  /** What goes into the activity log; secret values must not. */
  logArgs?: (args: Record<string, any>) => Record<string, any>;
};

/** An error the agent should read and act on (bad app name, wrong answer, ...). */
export class ToolError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Names only, for the activity log: variable values never get written down. */
const keysOf = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v) : undefined);

export function appUrl(domain: string) {
  const proto = TLS_ENABLED ? "https" : "http";
  const port = TLS_ENABLED ? 443 : PUBLIC_HTTP_PORT;
  const plain = (proto === "https" && port === 443) || (proto === "http" && port === 80);
  return `${proto}://${domain}${plain ? "" : `:${port}`}`;
}

const BUILD_PREFIX = /^(NEXT_PUBLIC_|VITE_|REACT_APP_|NUXT_PUBLIC_|GATSBY_|EXPO_PUBLIC_|PUBLIC_|VUE_APP_)/;

const lastLines = (text: string | null | undefined, n: number) => {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const cut = lines.length > n ? lines.length - n : 0;
  return (cut ? `… ${cut} earlier lines not shown\n` : "") + lines.slice(cut).join("\n").slice(-60_000);
};

const appRef = str("The app: its name (e.g. my-api), its full domain, or its id from list_apps");

async function findApp(t: ToolCtx, ref: string) {
  const r = String(ref).trim().toLowerCase();
  const apps = await t.caller.sites.list();
  const exact = apps.find((s) => s.id === ref || s.domain === r);
  if (exact) return exact;
  const byName = apps.filter((s) => s.domain.split(".")[0] === r);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) throw new ToolError(`More than one app is called "${ref}": ${byName.map((s) => s.domain).join(", ")}. Use the full domain.`);
  throw new ToolError(`There is no app called "${ref}". Call list_apps to see the apps you can use.`);
}

function brief(s: any) {
  return {
    id: s.id,
    name: s.domain,
    url: appUrl(s.domain),
    status: s.status === "active" && s.health === "crashing" ? "crashing" : s.status,
    source: s.source,
    repo: s.repoUrl ?? undefined,
    branch: s.source === "git" ? s.branch : undefined,
    image: s.image ?? undefined,
    createdAt: s.createdAt,
  };
}

const deployBrief = (d: any) => ({
  id: d.id,
  status: d.status,
  trigger: d.trigger,
  commit: d.commitSha ? d.commitSha.slice(0, 7) : undefined,
  commitMessage: d.commitMessage ? String(d.commitMessage).split("\n")[0].slice(0, 120) : undefined,
  error: d.error ?? undefined,
  question: d.status === "waiting_input" && d.prompt ? questionOf(d.prompt) : undefined,
  createdAt: d.createdAt,
  durationMs: d.durationMs ?? undefined,
});

const questionOf = (p: any) => ({
  question: p.title,
  detail: p.detail,
  answers: (p.options ?? []).map((o: any) => ({ answer: o.value, label: o.label, detail: o.detail })),
  defaultAnswer: p.default,
  expiresAt: p.expiresAt,
});

const DONE = ["active", "failed", "superseded"];

async function latestDeployment(t: ToolCtx, siteId: string) {
  const [d] = await t.caller.sites.deployments({ id: siteId, limit: 1 });
  return d;
}

async function waitDeployment(t: ToolCtx, site: any, deploymentId: string | undefined, seconds: number) {
  const id = deploymentId ?? (await latestDeployment(t, site.id))?.id;
  if (!id) throw new ToolError(`${site.domain} has not been deployed yet. Call deploy_app.`);
  const end = Date.now() + seconds * 1000;
  for (;;) {
    const d: any = await t.caller.sites.deployment({ deploymentId: id });
    if (d.siteId !== site.id) throw new ToolError("That deployment belongs to another app");
    const base = { app: site.domain, url: appUrl(site.domain), deployment: deployBrief(d) };
    if (d.status === "active") return { ...base, done: true, result: "live", hint: "The new release is live and taking traffic." };
    if (d.status === "superseded") return { ...base, done: true, result: "replaced", hint: "A newer deploy replaced this one before it finished." };
    if (d.status === "failed") {
      return { ...base, done: true, result: "failed", logTail: lastLines(d.log, 60), hint: "Read error and logTail. Fix the cause (code, port, variables, memory), then call deploy_app again." };
    }
    if (d.status === "waiting_input") {
      return { ...base, done: false, result: "needs_answer", hint: "The deploy is paused on a question. Pick an answer (ask the user if unsure) and call answer_deploy_question, then wait_for_deploy again." };
    }
    if (Date.now() > end) return { ...base, done: false, result: "still_running", hint: "Still deploying. Call wait_for_deploy again to keep following it." };
    await sleep(2000);
  }
}

// ─── The tools ───────────────────────────────────────────────────────────────
export const TOOLS: Tool[] = [
  {
    name: "list_apps",
    title: "List apps",
    description: "Lists the apps you can see on this Deploy King server, with their URL and status (active, crashing, provisioning, failed, stopped). crashing = live but restarting over and over; get_app says why.",
    scope: "read",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, t) => {
      const apps = await t.caller.sites.list();
      return { count: apps.length, apps: apps.map(brief) };
    },
  },
  {
    name: "get_app",
    title: "Get app details",
    description:
      "Everything about one app: settings, variable names (values are never shown), the last 5 deploys, whether the container is running or crash-looping, and any question a deploy is waiting on.",
    scope: "read",
    inputSchema: obj({ app: appRef }, ["app"]),
    annotations: { readOnlyHint: true },
    run: async (a, t) => {
      const s: any = await findApp(t, a.app);
      const [deps, env, rt] = await Promise.all([
        t.caller.sites.deployments({ id: s.id, limit: 5 }),
        t.caller.sites.envList({ id: s.id }),
        t.caller.sites.runtime({ id: s.id }),
      ]);
      const waiting: any = deps.find((d: any) => d.status === "waiting_input");
      return {
        ...brief(s),
        port: s.port ?? undefined,
        memoryMb: s.memoryLimit ?? undefined,
        autoDeploy: s.autoDeploy,
        buildCommand: s.buildCommand ?? undefined,
        startCommand: s.startCommand ?? undefined,
        rootDirectory: s.rootDirectory ?? undefined,
        variables: env.map((v: any) => v.key),
        buildVariables: env.filter((v: any) => v.buildTime).map((v: any) => v.key),
        container: rt
          ? { running: rt.running, restarts: rt.restarts, exitCode: rt.exitCode, outOfMemory: rt.outOfMemory, memoryLimitMb: rt.memoryLimitMb, lastOutput: rt.lastOutput || undefined }
          : null,
        deploys: deps.map(deployBrief),
        waitingQuestion: waiting?.prompt ? { deploymentId: waiting.id, ...questionOf(waiting.prompt) } : null,
      };
    },
  },
  {
    name: "get_deploy_log",
    title: "Read a deploy log",
    description: "The build and start log of an app's latest deploy (or of a given deploy), with its status and error. Use it to find out why a deploy failed.",
    scope: "read",
    inputSchema: obj(
      { app: appRef, deployment: str("A deploy id from get_app. Leave out for the latest."), lines: int("How many of the last lines to return", { minimum: 10, maximum: 1000, default: 150 }) },
      ["app"]
    ),
    annotations: { readOnlyHint: true },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const id = a.deployment ?? (await latestDeployment(t, s.id))?.id;
      if (!id) throw new ToolError(`${s.domain} has not been deployed yet.`);
      const d: any = await t.caller.sites.deployment({ deploymentId: id });
      if (d.siteId !== s.id) throw new ToolError("That deploy belongs to another app");
      return { app: s.domain, deployment: deployBrief(d), log: lastLines(d.log, a.lines) };
    },
  },
  {
    name: "get_app_logs",
    title: "Read app logs",
    description: "What the running app has printed (stdout and stderr), newest last. Use it to debug errors after a deploy is live.",
    scope: "read",
    inputSchema: obj({ app: appRef, lines: int("How many of the last lines", { minimum: 10, maximum: 1000, default: 200 }) }, ["app"]),
    annotations: { readOnlyHint: true },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const r: any = await t.caller.sites.logs({ id: s.id, tail: a.lines });
      if (!r.container) return { app: s.domain, running: false, logs: "", hint: "No container yet. Check get_deploy_log." };
      return { app: s.domain, running: r.running, logs: lastLines(r.lines.map((l: any) => l.text).join("\n"), a.lines) };
    },
  },
  {
    name: "check_repo",
    title: "Check a repository",
    description:
      "Clones a git repository and checks whether it can be deployed: framework, port, build plan, required variables, databases it needs, and problems to fix first. Run it before create_app for a repository.",
    scope: "read",
    inputSchema: obj(
      {
        repoUrl: str("https:// git URL, e.g. https://github.com/owner/repo"),
        branch: str("Branch", { maxLength: 100 }),
        rootDirectory: str("Check this folder instead of the repository root (see appFolders in the result)", { maxLength: 255 }),
      },
      ["repoUrl"]
    ),
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (a, t) => {
      const r: any = await t.caller.git.inspect({ repoUrl: a.repoUrl, branch: a.branch || "main", rootDirectory: a.rootDirectory });
      const p = r.report ?? {};
      return {
        repo: a.repoUrl,
        branch: r.branch,
        rootDirectory: r.rootDirectory ?? undefined,
        appFolders: r.folders?.length ? r.folders : undefined,
        commit: r.commit ? { sha: r.commit.sha?.slice(0, 7), message: String(r.commit.message ?? "").split("\n")[0] } : undefined,
        verdict: p.verdict,
        summary: p.summary,
        framework: p.framework,
        runtime: p.runtime,
        port: p.port,
        checks: p.checks,
        variables: (p.env ?? []).map((e: any) => ({ key: e.key, example: e.example, canGenerate: e.canGenerate, note: e.placeholder ? "placeholder in the repo, set a real value" : undefined })),
        services: p.services,
        questions: p.questions,
        error: p.error,
      };
    },
  },
  {
    name: "list_workflows",
    title: "List workflows",
    description: "Lists your workflows (automations), their trigger, whether they are active, and how the last run went.",
    scope: "read",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, t) => {
      const list: any[] = await t.caller.automations.list();
      return {
        count: list.length,
        workflows: list.map((w) => ({ id: w.id, name: w.name, trigger: w.triggerType, active: w.enabled, lastRun: w.lastRunAt ? { at: w.lastRunAt, status: w.lastRunStatus } : null })),
      };
    },
  },
  {
    name: "get_workflow_run",
    title: "Get a workflow run",
    description: "The result of one workflow run: status, error, and each step's status and output.",
    scope: "read",
    inputSchema: obj({ runId: str("Run id from run_workflow") }, ["runId"]),
    annotations: { readOnlyHint: true },
    run: async (a, t) => runSummary(await t.caller.automations.run({ runId: a.runId })),
  },
  {
    name: "platform_status",
    title: "Platform status",
    description: "Deploy King version, the domain apps get, and counts of apps, deploys today and workflows.",
    scope: "read",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, t) => {
      const [info, overview] = await Promise.all([t.caller.system.info(), t.caller.system.overview()]);
      const o: any = overview;
      return { version: info.version, appsGet: `<name>.${info.baseDomain}`, https: info.tls, apps: o.apps, deploysToday: o.deploysToday, workflows: o.workflows };
    },
  },
  {
    name: "check_fit",
    title: "Will it fit?",
    description:
      "Checks whether the server has room for a new app with the given memory limit (512 MB when left out), or for an existing app with a higher limit. Returns fits, tight or blocked, the reasons in words, and what to change. Run it before create_app. A blocked deploy cannot be forced through a token.",
    scope: "read",
    inputSchema: obj({ memoryMb: int("Memory limit in MB", { minimum: 64, maximum: 65536, default: 512 }), app: str("An existing app (name, domain or id) to check a new limit for") }),
    annotations: { readOnlyHint: true },
    run: async (a, t) => {
      const site = a.app ? await findApp(t, a.app) : null;
      const f: any = await t.caller.system.fit({ memoryMb: a.memoryMb, siteId: site?.id });
      return { verdict: f.verdict, needMemoryMb: f.needMemoryMb, note: f.note || undefined, reasons: f.reasons.map((r: any) => r.text), suggestions: f.suggestions };
    },
  },
  {
    name: "get_capacity",
    title: "Server capacity",
    description:
      "What the server has and what apps hold: memory in total, kept in reserve, already promised to apps, still free to promise and free right now; disk free; and roughly how many more apps fit. For the server owner.",
    scope: "read",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, t) => {
      const c: any = await t.caller.system.capacity();
      return { memoryMb: c.memory, diskMb: c.disk, apps: c.apps, settings: c.settings };
    },
  },
  {
    name: "list_security_findings",
    title: "Changes on the server",
    description:
      "New and changed things on the server since the admin last accepted its state: users, admin rights, SSH keys and settings, scheduled jobs, services, startup files, listening ports, containers, and running programs or outgoing connections that show a sign of trouble (coin miners, programs in temporary folders, mining-pool connections). Each has a level (urgent, check, note), why it matters and how to remove it by hand. Read only: you cannot mark a finding as expected or remove anything. Tell the user about urgent ones; do not decide for them. Needs an admin's token.",
    scope: "read",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, t) => {
      const [s, list]: any[] = await Promise.all([t.caller.host.summary(), t.caller.host.findings()]);
      return {
        watching: s.installed, lastReportAt: s.lastReportAt, watcherSilent: s.silent, waitingForFirstReview: s.toReview,
        findings: list.slice(0, 100).map((f: any) => ({ level: f.severity, kind: f.kind, what: f.label, state: f.status, stillThere: f.present, why: f.reason, firstSeen: f.firstSeenAt, changedAt: f.changedAt, detail: f.detail, toRemove: f.remove })),
      };
    },
  },
  {
    name: "wait_for_deploy",
    title: "Wait for a deploy",
    description:
      "Follows an app's latest deploy (or a given one) until it is live, fails, or stops on a question, for up to timeoutSeconds. Returns the error and the end of the log when it fails.",
    scope: "read",
    inputSchema: obj(
      { app: appRef, deployment: str("Deploy id. Leave out for the latest."), timeoutSeconds: int("How long to wait", { minimum: 5, maximum: 120, default: 50 }) },
      ["app"]
    ),
    annotations: { readOnlyHint: true },
    run: async (a, t) => waitDeployment(t, await findApp(t, a.app), a.deployment, a.timeoutSeconds),
  },

  // ─── Changes (deploy scope) ──────────────────────────────────────────────
  {
    name: "create_app",
    title: "Create and deploy an app",
    description: `Creates an app from a git repository (repoUrl) or a container image (image) and starts its first deploy. A plain name becomes <name>.${BASE_DOMAIN}. For repositories, run check_repo first and pass the port and variables it reports. Then call wait_for_deploy.`,
    scope: "deploy",
    inputSchema: obj(
      {
        name: str("App name (letters, digits, dashes) or a full domain", { maxLength: 253 }),
        repoUrl: str("https:// git URL. Use this or image."),
        branch: str("Branch (repositories only)", { maxLength: 100 }),
        image: str("Container image such as nginx:alpine or n8nio/n8n:latest. Use this or repoUrl.", { maxLength: 300 }),
        port: int("Port the app listens on inside its container", { minimum: 1, maximum: 65535 }),
        variables: strMap("Environment variables, e.g. {\"NODE_ENV\": \"production\"}"),
        buildVariables: strList("Names from variables that the build itself reads (NEXT_PUBLIC_*, VITE_* and similar). Those prefixes are detected without listing them."),
        rootDirectory: str("Folder inside the repository to build, for repositories with several apps, e.g. apps/web", { maxLength: 255 }),
        memoryMb: int("Memory limit in MB", { minimum: 128, maximum: 65536 }),
      },
      ["name"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    logArgs: (a) => ({ ...a, variables: keysOf(a.variables) }),
    run: async (a, t) => {
      if (!a.repoUrl === !a.image) throw new ToolError("Give either repoUrl or image (not both)");
      const name = String(a.name).trim().toLowerCase();
      const domain = name.includes(".") ? name : `${name}.${BASE_DOMAIN}`;
      const atBuild = new Set<string>(a.buildVariables ?? []);
      const env = Object.entries((a.variables ?? {}) as Record<string, string>).map(([key, value]) => ({ key, value, buildTime: !a.image && (atBuild.has(key) || BUILD_PREFIX.test(key)) }));
      const s: any = await t.caller.sites.create({
        domain,
        source: a.image ? "image" : "git",
        runtime: a.image ? "image" : "auto",
        repoUrl: a.repoUrl,
        branch: a.branch || "main",
        image: a.image,
        port: a.port,
        env,
        volumes: [],
        autoDeploy: true,
        memoryLimit: a.memoryMb,
        rootDirectory: a.image ? undefined : a.rootDirectory,
      } as any);
      const d = await latestDeployment(t, s.id);
      return { ...brief(s), deploymentId: d?.id, hint: `Deploy started. Call wait_for_deploy with app "${s.domain}".` };
    },
  },
  {
    name: "deploy_app",
    title: "Deploy an app",
    description:
      "Starts a new deploy: pulls the latest code or image and builds it. With restartOnly, starts the current build again so new variables or memory take effect (fast, no build). Traffic moves only after the new release passes its health check.",
    scope: "deploy",
    inputSchema: obj({ app: appRef, restartOnly: bool("Restart the current build instead of building again", false) }, ["app"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const r = await t.caller.sites.redeploy({ id: s.id, restartOnly: a.restartOnly });
      return { app: s.domain, deploymentId: r.deploymentId, hint: `Call wait_for_deploy with app "${s.domain}".` };
    },
  },
  {
    name: "answer_deploy_question",
    title: "Answer a deploy question",
    description:
      "Some deploys pause to ask something, for example which port the app really listens on, or whether to raise memory after it ran out. get_app or wait_for_deploy shows the question and its answers; send one of them here.",
    scope: "deploy",
    inputSchema: obj({ app: appRef, answer: str("One of the answers offered with the question", { maxLength: 100 }) }, ["app", "answer"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const deps: any[] = await t.caller.sites.deployments({ id: s.id, limit: 5 });
      const d = deps.find((x) => x.status === "waiting_input" && x.prompt);
      if (!d) throw new ToolError(`No deploy of ${s.domain} is waiting for an answer.`);
      const options: any[] = d.prompt.options ?? [];
      if (options.length && !options.some((o) => o.value === a.answer)) {
        throw new ToolError(`"${a.answer}" is not one of the answers. Choose one of: ${options.map((o) => o.value).join(", ")}`);
      }
      await t.caller.sites.answer({ deploymentId: d.id, promptId: d.prompt.id, value: a.answer });
      return { app: s.domain, deploymentId: d.id, answered: a.answer, hint: "The deploy continues. Call wait_for_deploy." };
    },
  },
  {
    name: "rollback_app",
    title: "Roll back an app",
    description: "Puts an earlier release back, without rebuilding. Without a deployment id it goes back to the release before the current one.",
    scope: "deploy",
    inputSchema: obj({ app: appRef, deployment: str("Id of the deploy to go back to (from get_app). Leave out for the previous release.") }, ["app"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      let target = a.deployment as string | undefined;
      if (!target) {
        const deps: any[] = await t.caller.sites.deployments({ id: s.id, limit: 30 });
        const live = deps.findIndex((d) => d.status === "active");
        const prev = deps.slice(live + 1).find((d) => d.imageTag && (d.status === "superseded" || d.status === "active"));
        if (!prev) throw new ToolError(`${s.domain} has no earlier release to go back to.`);
        target = prev.id;
      }
      const r = await t.caller.sites.rollback({ id: s.id, deploymentId: target! });
      return { app: s.domain, rollingBackTo: target, deploymentId: r.deploymentId, hint: `Call wait_for_deploy with app "${s.domain}".` };
    },
  },
  {
    name: "set_env",
    title: "Change variables",
    description:
      "Sets or removes an app's environment variables. Values are stored encrypted and never shown again. They take effect on the next deploy; pass restart: true to restart the app with them now.",
    scope: "deploy",
    inputSchema: obj(
      {
        app: appRef,
        set: strMap("Variables to add or change, e.g. {\"API_URL\": \"https://…\"}"),
        remove: strList("Names of variables to remove"),
        replaceAll: bool("Make set the complete list: every other variable of the app is removed", false),
        restart: bool("Restart the app now so the change takes effect", false),
      },
      ["app"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: true },
    logArgs: (a) => ({ app: a.app, set: keysOf(a.set), remove: a.remove, replaceAll: a.replaceAll, restart: a.restart }),
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const set = Object.entries((a.set ?? {}) as Record<string, string>).map(([key, value]) => ({ key, value }));
      const remove: string[] = [...(a.remove ?? [])];
      if (a.replaceAll) {
        if (!set.length) throw new ToolError("replaceAll needs the complete list in set");
        const keep = new Set(set.map((v) => v.key));
        for (const v of await t.caller.sites.envList({ id: s.id })) if (!keep.has(v.key) && !remove.includes(v.key)) remove.push(v.key);
      }
      if (!set.length && !remove.length) throw new ToolError("Nothing to change: pass set and/or remove");
      if (set.length) await t.caller.sites.envSetMany({ id: s.id, vars: set });
      for (const key of remove) await t.caller.sites.envUnset({ id: s.id, key });
      let deploymentId: string | undefined;
      if (a.restart) deploymentId = (await t.caller.sites.redeploy({ id: s.id, restartOnly: true })).deploymentId;
      return {
        app: s.domain,
        set: set.map((v) => v.key),
        removed: remove,
        deploymentId,
        hint: a.restart ? `Restarting. Call wait_for_deploy with app "${s.domain}".` : "Saved. They apply on the next deploy (or call deploy_app with restartOnly).",
      };
    },
  },
  {
    name: "run_workflow",
    title: "Run a workflow",
    description: "Runs a workflow now, with optional input (available to its steps as {{ trigger.<key> }}). Waits up to 60 seconds for the result unless wait is false.",
    scope: "deploy",
    inputSchema: obj(
      { workflow: str("Workflow name or id (see list_workflows)"), input: anyObj("Data for the run, e.g. {\"reason\": \"hotfix\"}"), wait: bool("Wait for the run to finish", true) },
      ["workflow"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    logArgs: (a) => ({ workflow: a.workflow, input: keysOf(a.input), wait: a.wait }),
    run: async (a, t) => {
      const list: any[] = await t.caller.automations.list();
      const ref = String(a.workflow).trim().toLowerCase();
      const hits = list.filter((w) => w.id === a.workflow || w.name.toLowerCase() === ref);
      if (!hits.length) throw new ToolError(`There is no workflow called "${a.workflow}". Call list_workflows.`);
      if (hits.length > 1) throw new ToolError(`More than one workflow is called "${a.workflow}". Use its id.`);
      const { runId } = await t.caller.automations.execute({ id: hits[0].id, input: a.input });
      if (!a.wait) return { workflow: hits[0].name, runId, hint: "Call get_workflow_run for the result." };
      const end = Date.now() + 60_000;
      for (;;) {
        const r: any = await t.caller.automations.run({ runId });
        if (!["queued", "running"].includes(r.status) || Date.now() > end) return { workflow: hits[0].name, runId, ...runSummary(r) };
        await sleep(1500);
      }
    },
  },

  // ─── Scheduled jobs, workers and databases (assistant agent) ─────────────
  {
    name: "list_scheduled_jobs",
    title: "List scheduled jobs",
    description: "An app's scheduled jobs (commands that run inside it on a schedule): schedule in words, time zone, where it runs, whether it is on, and how the last run went.",
    scope: "read",
    inputSchema: obj({ app: appRef }, ["app"]),
    annotations: { readOnlyHint: true },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const jobs: any[] = await t.caller.cron.list({ siteId: s.id });
      return {
        app: s.domain,
        jobs: jobs.map((j) => ({ id: j.id, name: j.name, command: j.command, schedule: j.schedule, words: j.words, timezone: j.timezone, runIn: j.runIn, active: j.active, nextRunAt: j.nextRunAt, lastRun: j.lastRunAt ? { at: j.lastRunAt, status: j.lastStatus, exitCode: j.lastExitCode } : null })),
      };
    },
  },
  {
    name: "add_scheduled_job",
    title: "Add a scheduled job",
    description: "Adds a scheduled job to an app: a command that runs inside the app's container (or one of its workers) on a five-field cron schedule such as \"0 6 * * *\", in a time zone.",
    scope: "deploy",
    inputSchema: obj(
      {
        app: appRef,
        name: str("Short name, e.g. Daily report", { maxLength: 120 }),
        command: str("The command, e.g. node scripts/report.js"),
        schedule: str("Five-field cron text, or @hourly / @daily / @weekly", { maxLength: 100 }),
        timezone: str("IANA time zone, e.g. Asia/Kolkata", { maxLength: 64 }),
        runIn: str("web (the app itself) or worker:<name>", { maxLength: 60 }),
        timeoutSeconds: int("Stop a run after this long", { minimum: 10, maximum: 3600, default: 600 }),
        runNow: bool("Also run it once now", false),
      },
      ["app", "name", "command", "schedule"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const j: any = await t.caller.cron.create({
        siteId: s.id, name: a.name, command: a.command, schedule: a.schedule, timezone: a.timezone || "UTC", runIn: a.runIn || "web", timeoutSec: a.timeoutSeconds, notifyOnFailure: true, runNow: a.runNow,
      });
      return { app: s.domain, job: { id: j.id, name: j.name, schedule: j.schedule, words: j.words, timezone: j.timezone, nextRunAt: j.nextRunAt } };
    },
  },
  {
    name: "list_workers",
    title: "List workers",
    description: "An app's workers (background processes from the same image and variables, without web traffic): command, copies, memory per copy, and whether they are running or crashing.",
    scope: "read",
    inputSchema: obj({ app: appRef }, ["app"]),
    annotations: { readOnlyHint: true },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const r: any = await t.caller.workers.list({ siteId: s.id });
      return {
        app: s.domain,
        deployed: r.deployed,
        workersMemoryMb: r.appWorkersMb,
        workers: r.workers.map((w: any) => ({ id: w.id, name: w.name, command: w.command, copies: w.copies, memoryMb: w.memoryLimit, enabled: w.enabled, status: w.status })),
      };
    },
  },
  {
    name: "add_worker",
    title: "Add a worker",
    description: "Adds a worker to an app: a background process (queue consumer, email sender) started from the app's image with its variables. Each copy holds its memory limit; check_fit tells whether it fits.",
    scope: "deploy",
    inputSchema: obj(
      {
        app: appRef,
        name: str("Lowercase name, e.g. emails", { maxLength: 30 }),
        command: str("The command, e.g. node dist/worker.js"),
        copies: int("How many copies", { minimum: 1, maximum: 8, default: 1 }),
        memoryMb: int("Memory limit of each copy in MB", { minimum: 64, maximum: 16384, default: 256 }),
      },
      ["app", "name", "command"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const w: any = await t.caller.workers.create({ siteId: s.id, name: a.name, command: a.command, copies: a.copies, memoryLimit: a.memoryMb, restart: true, gracefulStop: true, enabled: true });
      return { app: s.domain, worker: { id: w.id, name: w.name, copies: w.copies, memoryMb: w.memoryLimit }, hint: "The worker starts from the app's current release." };
    },
  },
  {
    name: "list_databases",
    title: "List databases",
    description: "The databases on this server you can see (admins: all; others: those of their apps), with the app each belongs to. Passwords are never shown.",
    scope: "read",
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
    run: async (_a, t) => {
      const [list, apps]: any[] = await Promise.all([t.caller.database.list(), t.caller.sites.list()]);
      const domain = new Map(apps.map((s: any) => [s.id, s.domain]));
      return { count: list.length, databases: list.map((d: any) => ({ id: d.id, name: d.name, type: d.type, user: d.dbUser, app: d.siteId ? domain.get(d.siteId) ?? d.siteId : null, createdAt: d.createdAt })) };
    },
  },
  {
    name: "create_database",
    title: "Create a database",
    description:
      "Creates a PostgreSQL database and its user for an app. The password is made on the server and never returned: with variable (default DATABASE_URL) the connection URL is stored in that variable of the app. It applies on the app's next deploy or restart.",
    scope: "deploy",
    inputSchema: obj(
      {
        app: appRef,
        name: str("Database name: lowercase letters, digits and _ (3-30), e.g. shop_api", { maxLength: 30 }),
        user: str("Database user (3-30, lowercase letters, digits, _). Defaults to the name.", { maxLength: 30 }),
        variable: str("App variable that gets the connection URL. Empty string to store none.", { maxLength: 100 }),
      },
      ["app", "name"]
    ),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      const r: any = await t.caller.database.create({ name: a.name, type: "pgsql", dbUser: a.user || a.name, siteId: s.id });
      const variable = a.variable === undefined ? "DATABASE_URL" : String(a.variable).trim();
      if (variable) {
        const c = r.credentials;
        const url = `postgres://${encodeURIComponent(c.username)}:${encodeURIComponent(c.password)}@${c.host}:${c.port}/${encodeURIComponent(c.database)}`;
        await t.caller.sites.envSetMany({ id: s.id, vars: [{ key: variable, value: url }] });
      }
      return {
        app: s.domain,
        database: { id: r.instance.id, name: r.instance.name, type: r.instance.type, user: r.instance.dbUser },
        variable: variable || undefined,
        hint: variable ? `${variable} is set (the value is never shown). Call deploy_app with restartOnly to use it now.` : "Created. The password was not stored anywhere you can read.",
      };
    },
  },

  // ─── Removal (full scope) ────────────────────────────────────────────────
  {
    name: "delete_app",
    title: "Delete an app",
    description:
      "Deletes an app: its containers, images, files and settings. This cannot be undone. Ask the user first. confirm must be the app's full domain.",
    scope: "full",
    inputSchema: obj({ app: appRef, confirm: str("The app's full domain, typed again to confirm", { maxLength: 253 }) }, ["app", "confirm"]),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    run: async (a, t) => {
      const s = await findApp(t, a.app);
      if (String(a.confirm).trim().toLowerCase() !== s.domain) throw new ToolError(`confirm must be "${s.domain}" exactly.`);
      await t.caller.sites.delete({ id: s.id });
      return { deleted: s.domain };
    },
  },
];

function runSummary(r: any) {
  const steps = Object.entries(r.steps ?? {}).map(([id, v]: [string, any]) => {
    const node = r.graph?.nodes?.find((n: any) => n.id === id);
    const out = v.output === undefined ? undefined : JSON.stringify(v.output);
    return {
      step: node?.data?.label ?? id,
      type: node?.type,
      status: v.status,
      branch: v.branch,
      error: v.error,
      output: out && out.length > 2000 ? out.slice(0, 2000) + "…" : v.output,
    };
  });
  return { status: r.status, trigger: r.trigger, error: r.error ?? undefined, startedAt: r.startedAt, durationMs: r.durationMs ?? undefined, steps };
}

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
