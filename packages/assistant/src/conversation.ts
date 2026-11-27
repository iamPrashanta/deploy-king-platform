import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { AssistantConfig, AssistantConversation, AssistantEvent, PlanAction, PlanInfo } from "./types";
import { AnthropicLlm, DEFAULT_MODEL, llmErrorText, type LlmBlock, type LlmClient, type LlmMessage, type LlmToolResult, type LlmToolUse } from "./llm";
import { ApiError, HttpDkApi, type DkApi, type ToolCallResult } from "./api";
import { SecretStore, UnknownSecretError } from "./secrets";
import { TOOL_BY_NAME, ToolInputError, appOf, toolDefs, type Attachment, type ToolContext, type ToolDef } from "./tools";
import { SYSTEM_PROMPT } from "./prompt";
import { isZip, sizeText } from "./project";

export interface ConversationDeps {
  /** The model. Default: the Anthropic Messages API with cfg.llm.apiKey. */
  llm?: LlmClient;
  /** The Deploy King API. Default: HTTP to cfg.apiBase with cfg.token. */
  api?: DkApi;
  /** Replaces the system prompt (tests). */
  system?: string;
}

/** A plan the user approved: changes with these tools (on this app) run without asking again during this send. */
interface Grant {
  id: string;
  steps: string[];
  app?: string;
  tools: Set<string>;
}

const MAX_RESULT = 24_000;
const MAX_MESSAGES = 120;

const clip = (s: string, n = MAX_RESULT) => (s.length > n ? `${s.slice(0, n)}\n… (cut: ${s.length - n} more characters)` : s);
const firstLine = (s: string) => String(s ?? "").split("\n")[0]!.slice(0, 300);
const newId = (kind: string) => `${kind}_${crypto.randomUUID().slice(0, 8)}`;
const appKey = (s: string | undefined) => (s ? s.trim().toLowerCase().split(".")[0] : undefined);

class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "AbortError";
  }
}

export class DkConversation implements AssistantConversation {
  private messages: LlmMessage[] = [];
  private secrets = new SecretStore();
  private attachments = new Map<string, Attachment>();
  private plans = new Map<string, (ok: boolean) => void>();
  private questions = new Map<string, { options: { id: string; label: string }[]; strict: boolean; resolve: (r: { id?: string; text: string }) => void; reject: (e: Error) => void }>();
  private grants: Grant[] = [];
  private running = false;
  private controller: AbortController | null = null;
  private emit: (e: AssistantEvent) => void = () => {};
  private llm: LlmClient;
  private api: DkApi;
  private system: string;

  constructor(private cfg: AssistantConfig, deps: ConversationDeps = {}) {
    this.llm = deps.llm ?? new AnthropicLlm(cfg.llm.apiKey);
    this.api = deps.api ?? new HttpDkApi(cfg.apiBase, cfg.token);
    this.system = deps.system ?? SYSTEM_PROMPT;
  }

  get busy() {
    return this.running;
  }

  // ─── the contract ──────────────────────────────────────────────────────────
  async send(text: string, attachments: { path: string; name: string }[], onEvent: (e: AssistantEvent) => void): Promise<void> {
    if (this.running) throw new Error("The assistant is still working on the previous message");
    this.running = true;
    this.grants = [];
    this.controller = new AbortController();
    let doneSent = false;
    this.emit = (e) => {
      if (e.type === "done") doneSent = true;
      try {
        onEvent(e);
      } catch {
        // A broken event handler must not break the conversation.
      }
    };
    try {
      const names = (attachments ?? []).map((a) => this.addAttachment(a));
      let content = this.secrets.captureFromUserText(String(text ?? ""));
      if (names.length) content += `\n\nAttached: ${names.map((n) => this.describeAttachment(n)).join(", ")}`;
      this.pushUser([{ type: "text", text: content || "(empty message)" }]);
      await this.loop();
    } catch (e: any) {
      if (e?.name === "AbortError") this.emit({ type: "done", stopReason: "cancelled" });
      else {
        this.emit({ type: "error", message: this.secrets.hide(String(e?.message ?? e)) });
        this.emit({ type: "done", stopReason: "error" });
      }
    } finally {
      if (!doneSent) this.emit({ type: "done", stopReason: this.controller?.signal.aborted ? "cancelled" : "end_turn" });
      this.dropPending();
      this.running = false;
      this.controller = null;
      this.emit = () => {};
    }
  }

  async answer(questionId: string, optionIdOrText: string): Promise<void> {
    const q = this.questions.get(questionId);
    if (!q) throw new Error(`No question ${questionId} is waiting for an answer`);
    const t = String(optionIdOrText ?? "").trim();
    const opt =
      q.options.find((o) => o.id === t) ??
      q.options.find((o) => o.label.toLowerCase() === t.toLowerCase()) ??
      (/^\d+$/.test(t) ? q.options[Number(t) - 1] : undefined);
    if (!opt && q.strict) throw new Error(`Choose one of: ${q.options.map((o) => o.label).join(", ")}`);
    if (!opt && !t) throw new Error("Type an answer");
    this.questions.delete(questionId);
    q.resolve(opt ? { id: opt.id, text: opt.label } : { text: t });
  }

  async approvePlan(planId: string, approved: boolean): Promise<void> {
    const p = this.plans.get(planId);
    if (!p) throw new Error(`No plan ${planId} is waiting for approval`);
    this.plans.delete(planId);
    p(!!approved);
  }

  cancel() {
    this.controller?.abort();
    this.dropPending();
  }

  // ─── the loop ──────────────────────────────────────────────────────────────
  private async loop() {
    const signal = this.controller!.signal;
    const tools = toolDefs();
    const maxTurns = this.cfg.maxTurns ?? 30;
    for (let turn = 0; turn < maxTurns; turn++) {
      if (signal.aborted) throw new Cancelled();
      this.trimHistory();
      let resp;
      try {
        resp = await this.llm.complete(
          { model: this.cfg.llm.model || DEFAULT_MODEL, system: this.system, messages: this.messages, tools, maxTokens: 4096 },
          (delta) => delta && this.emit({ type: "text", delta }),
          signal
        );
      } catch (e: any) {
        if (signal.aborted || e?.name === "AbortError" || e?.name === "APIUserAbortError") throw new Cancelled();
        this.emit({ type: "error", message: llmErrorText(e) });
        this.emit({ type: "done", stopReason: "error" });
        return;
      }
      const content = resp.content.filter((b) => (b.type === "text" ? b.text.trim().length > 0 : true));
      const uses = content.filter((b): b is LlmToolUse => b.type === "tool_use");
      if (content.length) this.messages.push({ role: "assistant", content });
      if (!uses.length) {
        this.emit({ type: "done", stopReason: resp.stopReason || "end_turn" });
        return;
      }
      const results = await this.runCalls(uses);
      this.messages.push({ role: "user", content: results });
      if (signal.aborted) throw new Cancelled();
    }
    this.emit({ type: "text", delta: `\nI stopped after ${maxTurns} steps. Tell me to continue if you want me to go on.` });
    this.emit({ type: "done", stopReason: "max_turns" });
  }

  /** Runs one model turn's tool calls, in order, asking for approval where needed. Every call gets a result. */
  private async runCalls(uses: LlmToolUse[]): Promise<LlmToolResult[]> {
    const signal = this.controller!.signal;
    const results: (LlmToolResult | undefined)[] = new Array(uses.length);
    const tools: (ToolDef | undefined)[] = uses.map((u) => TOOL_BY_NAME.get(u.name));
    const inputs = uses.map((u) => (u.input && typeof u.input === "object" && !Array.isArray(u.input) ? (u.input as Record<string, unknown>) : {}));
    const fail = (i: number, msg: string) => {
      results[i] = { type: "tool_result", tool_use_id: uses[i]!.id, content: this.secrets.hide(msg), is_error: true };
    };

    // Which calls need a plan the user has not approved yet?
    const ask: number[] = [];
    uses.forEach((u, i) => {
      const t = tools[i];
      if (!t) return fail(i, `Unknown tool ${u.name}`);
      if (t.kind === "control") return;
      if ((t.kind === "change" || this.cfg.approve === "ask") && !this.covered(t, inputs[i])) ask.push(i);
    });

    // One plan for all of them, so the user answers once per turn.
    const planOf = new Map<number, Omit<PlanInfo, "actions">>();
    if (ask.length) {
      const steps: string[] = [];
      for (const i of ask) {
        try {
          steps.push(this.secrets.hide(tools[i]!.step(inputs[i], { attachments: this.attachments })));
        } catch (e: any) {
          fail(i, e?.message ?? String(e));
        }
      }
      const asking = ask.filter((i) => !results[i]);
      if (asking.length) {
        const apps = [...new Set(asking.map((i) => appKey(appOf(inputs[i]))).filter(Boolean))];
        const plan = { id: newId("plan"), steps, ...(apps.length === 1 ? { app: apps[0]! } : {}) };
        const ok = await this.waitPlan(plan.id, plan.steps, plan.app);
        for (const i of asking) {
          if (ok) planOf.set(i, plan);
          else fail(i, "The user did not approve this. Nothing was changed. Ask what they want instead, or propose a different plan.");
        }
      }
    }

    // Changes pass the beforeChange hook (Deploy King Cloud later) once per turn, with the exact actions.
    const changes = uses.map((_, i) => i).filter((i) => !results[i] && tools[i]?.kind === "change");
    if (changes.length && this.cfg.beforeChange && !signal.aborted) {
      const base = planOf.get(changes[0]!) ?? this.grantFor(tools[changes[0]!]!, inputs[changes[0]!]) ?? { id: newId("plan"), steps: [] };
      const info: PlanInfo = { id: base.id, steps: base.steps, ...(base.app ? { app: base.app } : {}), actions: changes.map((i) => this.action(tools[i]!, inputs[i]!)) };
      let ok = false;
      try {
        ok = await this.cfg.beforeChange(info);
      } catch (e: any) {
        for (const i of changes) fail(i, `Not approved: ${e?.message ?? e}. Nothing was changed.`);
      }
      if (!ok) for (const i of changes) if (!results[i]) fail(i, "The change was not approved (beforeChange). Nothing was changed. Tell the user.");
    }

    for (let i = 0; i < uses.length; i++) {
      if (results[i]) continue;
      if (signal.aborted) {
        fail(i, "Cancelled by the user.");
        continue;
      }
      const u = uses[i]!;
      const t = tools[i]!;
      if (t.name === "propose_plan") results[i] = await this.proposePlan(u, inputs[i]!);
      else results[i] = await this.exec(t, u, inputs[i]!);
    }
    return results as LlmToolResult[];
  }

  private async proposePlan(u: LlmToolUse, input: Record<string, unknown>): Promise<LlmToolResult> {
    const steps = (Array.isArray(input.steps) ? input.steps : [])
      .map((s) => this.secrets.hide(String(s)).slice(0, 300))
      .filter(Boolean)
      .slice(0, 20);
    const allowed = (Array.isArray(input.tools) ? input.tools : []).map(String).filter((n) => TOOL_BY_NAME.has(n) && TOOL_BY_NAME.get(n)!.kind !== "control");
    const app = appKey(typeof input.app === "string" ? input.app : undefined);
    const reply = (text: string, isError = false): LlmToolResult => ({ type: "tool_result", tool_use_id: u.id, content: text, ...(isError ? { is_error: true } : {}) });
    if (!steps.length) return reply("A plan needs at least one step.", true);
    const id = newId("plan");
    const ok = await this.waitPlan(id, steps, app);
    if (!ok) return reply("The user did not approve the plan. Make no changes. Ask what they want changed.");
    this.grants.push({ id, steps, ...(app ? { app } : {}), tools: new Set(allowed) });
    const missing = allowed.length ? "" : " (You listed no tools, so each change will be shown to the user again.)";
    return reply(`Approved. Make these changes now, with ${allowed.join(", ") || "the tools needed"}.${missing}`);
  }

  private async exec(t: ToolDef, u: LlmToolUse, input: Record<string, unknown>): Promise<LlmToolResult> {
    const shown = this.secrets.hideValue(input);
    const isControl = t.kind === "control";
    if (!isControl) this.emit({ type: "tool_start", id: u.id, name: t.name, input: shown });
    let r: ToolCallResult;
    try {
      const real = this.secrets.resolve(input) as Record<string, unknown>;
      r = await t.run(real, this.context());
    } catch (e: any) {
      if (e?.name === "AbortError") r = { ok: false, error: "Cancelled by the user." };
      else if (e instanceof UnknownSecretError || e instanceof ToolInputError || e instanceof ApiError) r = { ok: false, error: e.message };
      else r = { ok: false, error: `The tool failed: ${e?.message ?? e}` };
    }
    let summary: string;
    try {
      summary = r.ok ? t.summary(r.data, shown) : firstLine(r.error);
    } catch {
      summary = r.ok ? "done" : "failed";
    }
    if (!isControl) this.emit({ type: "tool_result", id: u.id, ok: r.ok, summary: this.secrets.hide(summary) });
    const body = r.ok ? (typeof r.data === "string" ? this.secrets.hide(r.data) : JSON.stringify(this.secrets.hideValue(r.data ?? null))) : this.secrets.hide(r.error);
    return { type: "tool_result", tool_use_id: u.id, content: clip(body || (r.ok ? "done" : "failed")), ...(r.ok ? {} : { is_error: true }) };
  }

  // ─── approvals and questions ───────────────────────────────────────────────
  private covered(t: ToolDef, input: Record<string, unknown> | undefined) {
    return !!this.grantFor(t, input);
  }

  private grantFor(t: ToolDef, input: Record<string, unknown> | undefined) {
    const app = appKey(appOf(input));
    return this.grants.find((g) => g.tools.has(t.name) && (!g.app || !app || g.app === app));
  }

  private action(t: ToolDef, input: Record<string, unknown>): PlanAction {
    let file: PlanAction["file"];
    try {
      file = t.file?.(input, { attachments: this.attachments });
    } catch {
      file = undefined;
    }
    const app = appOf(input);
    return { tool: t.name, action: t.action ?? "read", ...(app ? { app } : {}), input: this.secrets.hideValue(input), ...(file ? { file } : {}) };
  }

  private waitPlan(id: string, steps: string[], app?: string): Promise<boolean> {
    const signal = this.controller?.signal;
    if (signal?.aborted) return Promise.resolve(false);
    const p = new Promise<boolean>((resolve) => this.plans.set(id, resolve));
    // Registered before the event goes out, so a handler may approve straight away.
    this.emit({ type: "plan", id, steps, ...(app ? { app } : {}) });
    return p;
  }

  private context(): ToolContext {
    return {
      api: this.api,
      secrets: this.secrets,
      attachments: this.attachments,
      signal: this.controller!.signal,
      ask: (prompt, options, opts) => this.ask(prompt, options, !!opts?.strict),
      confirmAnswer: async (app, question, answer) => {
        if (!this.cfg.beforeChange) return true;
        return this.cfg.beforeChange({
          id: newId("q"),
          steps: [`Answer "${question}" for ${app}: ${answer}`],
          app,
          actions: [{ tool: "answer_deploy_question", action: "change", app, input: { app, answer } }],
        });
      },
    };
  }

  private ask(prompt: string, options: { id: string; label: string }[], strict: boolean) {
    const signal = this.controller?.signal;
    if (signal?.aborted) return Promise.reject(new Cancelled());
    const id = newId("q");
    const p = new Promise<{ id?: string; text: string }>((resolve, reject) => this.questions.set(id, { options, strict, resolve, reject }));
    this.emit({ type: "question", id, prompt: this.secrets.hide(prompt), options });
    return p;
  }

  private dropPending() {
    for (const [, p] of this.plans) p(false);
    this.plans.clear();
    for (const [, q] of this.questions) q.reject(new Cancelled());
    this.questions.clear();
  }

  // ─── history and attachments ───────────────────────────────────────────────
  private pushUser(blocks: LlmBlock[]) {
    const last = this.messages[this.messages.length - 1];
    // After a failed model call the last message is still the user's: add to it, the API wants turns to alternate.
    if (last?.role === "user") last.content.push(...blocks);
    else this.messages.push({ role: "user", content: blocks });
  }

  /** Drops the oldest exchanges when the history gets long; it always restarts at a message the user typed. */
  private trimHistory() {
    if (this.messages.length <= MAX_MESSAGES) return;
    const start = this.messages.findIndex((m, i) => i >= this.messages.length - MAX_MESSAGES && m.role === "user" && m.content.some((b) => b.type === "text"));
    if (start > 0) this.messages = this.messages.slice(start);
  }

  private addAttachment(a: { path: string; name: string }): string {
    const full = path.resolve(a.path);
    const base = (a.name || path.basename(full)).trim() || "attachment";
    for (const [k, v] of this.attachments) if (v.path === full) return k;
    let name = base;
    for (let i = 2; this.attachments.has(name); i++) name = `${base} (${i})`;
    this.attachments.set(name, { name, path: full });
    return name;
  }

  private describeAttachment(name: string) {
    const a = this.attachments.get(name)!;
    try {
      const st = fs.statSync(a.path);
      if (st.isDirectory()) return `${name} (folder)`;
      return `${name} (${isZip(a.path) ? "ZIP" : "file"}, ${sizeText(st.size)})`;
    } catch {
      return `${name} (missing on disk)`;
    }
  }
}

export function createConversation(cfg: AssistantConfig, deps: ConversationDeps = {}): AssistantConversation {
  return new DkConversation(cfg, deps);
}
