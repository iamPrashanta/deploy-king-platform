import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantEvent, AssistantConversation, DkApi } from "@dbbkp/assistant";
import { c, out, status, step, Spinner, select, readLine, wrap, footer } from "./ui";

/** Tools whose results are shown as ✓ steps once a plan was approved (the rest are ● findings). */
const STEP_TOOLS = new Set(["deploy_zip", "create_app", "deploy_app", "set_env", "rollback_app", "add_scheduled_job", "add_worker", "create_database", "delete_app", "wait_for_deploy"]);

const DOING: Record<string, (i: any) => string> = {
  list_apps: () => "Listing apps",
  get_app: (i) => `Looking at ${i.app}`,
  get_deploy_log: (i) => `Reading the deploy log of ${i.app}`,
  get_app_logs: (i) => `Reading the logs of ${i.app}`,
  check_repo: (i) => `Checking ${i.repoUrl}`,
  check_project: (i) => `Checking ${i.file}`,
  check_fit: () => "Checking that it fits",
  platform_status: () => "Looking at the server",
  get_capacity: () => "Looking at the server's capacity",
  list_scheduled_jobs: (i) => `Listing the jobs of ${i.app}`,
  list_workers: (i) => `Listing the workers of ${i.app}`,
  list_databases: () => "Listing databases",
  wait_for_deploy: (i) => `Deploying ${i.app}`,
  deploy_zip: (i) => `Uploading ${i.file}`,
  create_app: (i) => `Creating ${i.name}`,
  deploy_app: (i) => `Deploying ${i.app}`,
  set_env: (i) => `Saving variables of ${i.app}`,
  rollback_app: (i) => `Rolling back ${i.app}`,
  add_scheduled_job: (i) => `Adding job ${i.name}`,
  add_worker: (i) => `Adding worker ${i.name}`,
  create_database: (i) => `Creating database ${i.name}`,
  delete_app: (i) => `Deleting ${i.app}`,
};

export function doingText(name: string, input: unknown) {
  try {
    return DOING[name]?.((input ?? {}) as any) ?? name.replace(/_/g, " ");
  } catch {
    return name.replace(/_/g, " ");
  }
}

/** Paths in what the user typed that are ZIP files or folders on this machine: they are attached. */
export function findAttachments(text: string, cwd = process.cwd()): { path: string; name: string }[] {
  const found: { path: string; name: string }[] = [];
  for (const raw of text.split(/\s+/)) {
    const token = raw.replace(/^["'`(]+|["'`),.;:!?]+$/g, "");
    if (!token) continue;
    const pathLike = /^(\.{1,2}\/|\/|~\/)/.test(token);
    if (!pathLike && !/\.zip$/i.test(token)) continue;
    const full = path.resolve(cwd, token.startsWith("~/") ? path.join(os.homedir(), token.slice(2)) : token);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!(st.isDirectory() || (st.isFile() && /\.zip$/i.test(full)))) continue;
    if (found.some((f) => f.path === full)) continue;
    found.push({ path: full, name: path.basename(full) });
  }
  return found;
}

export interface SessionOptions {
  apiUrl: string;
  trusted: Set<string>;
  onTrust: (app: string) => void;
}

/** Shows a conversation's events the way the artboard does, and asks the user when the assistant needs them. */
export class Renderer {
  private spinner = new Spinner();
  private started = new Map<string, { name: string; at: number }>();
  private midLine = false;
  private approved = false;
  /** The last thing printed was the assistant's text (so more text continues it). */
  private inText = false;
  /** Plans and questions are answered asynchronously; the send waits for them anyway. */
  private work: Promise<unknown> = Promise.resolve();

  constructor(private conv: AssistantConversation, private opts: SessionOptions) {}

  begin() {
    this.approved = false;
    this.inText = false;
    this.midLine = false;
    this.spinner.start("Thinking…");
  }

  end() {
    this.spinner.stop();
    if (this.midLine) process.stdout.write("\n");
    this.midLine = false;
    return this.work;
  }

  private newline() {
    this.spinner.stop();
    this.inText = false;
    if (this.midLine) {
      process.stdout.write("\n");
      this.midLine = false;
    }
  }

  handle = (e: AssistantEvent) => {
    switch (e.type) {
      case "text": {
        this.spinner.stop();
        if (!this.inText) {
          // A blank line between the prompt or the last status line and the answer.
          if (this.midLine) process.stdout.write("\n");
          out();
        }
        this.inText = true;
        process.stdout.write(c.bright(e.delta));
        this.midLine = !e.delta.endsWith("\n");
        break;
      }
      case "tool_start": {
        this.newline();
        this.started.set(e.id, { name: e.name, at: Date.now() });
        this.spinner.start(doingText(e.name, e.input));
        break;
      }
      case "tool_result": {
        this.newline();
        const s = this.started.get(e.id);
        this.started.delete(e.id);
        if (this.approved && s && STEP_TOOLS.has(s.name)) step(e.summary, e.ok, Date.now() - s.at);
        else status(e.ok ? e.summary : c.red(e.summary), e.ok);
        this.spinner.start("Thinking…");
        break;
      }
      case "plan": {
        this.newline();
        out();
        out(`  ${c.bright("Plan")}`);
        e.steps.forEach((s, i) => out(wrap(`${c.muted(`${i + 1}.`)} ${s}`, "  ")));
        out();
        this.work = this.work.then(() => this.askPlan(e.id, e.app));
        break;
      }
      case "question": {
        this.newline();
        out();
        this.work = this.work.then(() => this.askQuestion(e.id, e.prompt, e.options));
        break;
      }
      case "error": {
        this.newline();
        status(c.red(e.message), false);
        break;
      }
      case "done": {
        this.newline();
        if (e.stopReason === "cancelled") status(c.muted("Stopped."), true);
        break;
      }
    }
  };

  private async askPlan(id: string, app?: string) {
    if (app && this.opts.trusted.has(app)) {
      status(c.muted(`Approved: you chose not to be asked again for ${app}`));
      this.approved = true;
      await this.conv.approvePlan(id, true).catch(() => {});
      this.spinner.start("Working…");
      return;
    }
    const options = ["Yes", ...(app ? [`Yes, and don't ask again for ${app}`] : []), "No, change it"];
    const i = await select("Apply this plan?", options);
    const yes = i === 0 || (!!app && i === 1);
    if (app && i === 1) {
      this.opts.trusted.add(app);
      this.opts.onTrust(app);
    }
    this.approved ||= yes;
    await this.conv.approvePlan(id, yes).catch(() => {});
    if (!yes) out(c.muted("  Nothing was changed. Say what to change."));
    this.spinner.start(yes ? "Working…" : "Thinking…");
  }

  private async askQuestion(id: string, prompt: string, options: { id: string; label: string }[]) {
    for (;;) {
      let answer: string | null;
      if (options.length) {
        const labels = [...options.map((o) => o.label), "Type an answer"];
        const [first, ...rest] = prompt.split("\n");
        if (rest.length) out(c.muted(wrap(rest.join("\n"), "  ")));
        const i = await select(first!, labels);
        if (i < 0) {
          this.conv.cancel();
          return;
        }
        answer = i < options.length ? options[i]!.id : await readLine(`${c.blue(">")} `);
      } else {
        out(`${c.amber("?")} ${c.bright(prompt)}`);
        answer = await readLine(`${c.blue(">")} `);
      }
      if (answer === null) {
        this.conv.cancel();
        return;
      }
      try {
        await this.conv.answer(id, answer);
        this.spinner.start("Working…");
        return;
      } catch (err: any) {
        status(c.red(err?.message ?? String(err)), false);
        if (/No question/.test(err?.message ?? "")) return;
      }
    }
  }
}

// ─── slash commands that need no AI ───────────────────────────────────────────
export async function showApps(api: DkApi) {
  const r = await api.callTool("list_apps", {});
  if (!r.ok) return status(c.red(r.error), false);
  const d: any = r.data;
  if (!d.apps?.length) return status("No apps yet. Try: deploy ./my-app.zip");
  const w = Math.max(...d.apps.map((a: any) => String(a.name).length), 4);
  for (const a of d.apps) {
    const st = String(a.status);
    const col = st === "active" ? c.green : st === "crashing" || st === "failed" ? c.red : c.amber;
    out(`  ${col("●")} ${String(a.name).padEnd(w)}  ${col(st.padEnd(12))} ${c.blue(String(a.url ?? ""))}`);
  }
}

export async function showLogs(api: DkApi, app: string, lines = 80) {
  if (!app) return status(c.red("Usage: /logs <app> [lines]"), false);
  const r = await api.callTool("get_app_logs", { app, lines });
  if (!r.ok) return status(c.red(r.error), false);
  const d: any = r.data;
  if (d.running === false && !d.logs) return status(`${d.app}: not running. ${d.hint ?? ""}`, false);
  out(c.muted(`── ${d.app} · last ${lines} lines ──`));
  out(String(d.logs ?? "").replace(/\n+$/, ""));
}

export function help() {
  out(`${c.bright("Ask in plain words")}, for example:`);
  out(`  ${c.blue("deploy ./shop-api.zip as shop-api")}`);
  out(`  ${c.blue("why does blog keep crashing?")}`);
  out(`  ${c.blue("add a worker for emails to shop-api")}`);
  out(`  ${c.blue("run node scripts/report.js every day at 6 in Asia/Kolkata on shop-api")}`);
  out();
  out(`${c.bright("Commands")}`);
  out(`  ${c.blue("/apps")}          your apps and their status`);
  out(`  ${c.blue("/logs <app>")}    what the app printed (add a number for more lines)`);
  out(`  ${c.blue("/undo")}          not supported yet; ask to roll an app back instead`);
  out(`  ${c.blue("/help")}          this help`);
  out(`  ${c.blue("/quit")}          leave (or Ctrl+D)`);
  out();
  out(`${c.bright("Good to know")}`);
  out(c.muted("  Paths to a ZIP or a folder in your message are attached and checked on this machine first."));
  out(c.muted("  Nothing changes on the server until you approve a plan. Reading runs without asking."));
  out(c.muted("  Secrets you type (JWT_SECRET=…) are never sent to the AI; it sees a reference instead."));
  out(c.muted("  Ctrl+C stops the current answer; Ctrl+C at an empty prompt leaves."));
  footer();
}

export function shortcuts() {
  out(c.muted("  Enter send · ↑ ↓ earlier messages · ← → Enter choose in a plan · Ctrl+C stop · Ctrl+D quit"));
  footer();
}
