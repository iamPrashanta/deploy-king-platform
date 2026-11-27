// The shared contract with the desktop app (see BRIEF.md, "Shared contract"), plus the optional extras
// this package adds on top. Everything marked "extra" is optional, so code written against the contract
// alone keeps working.

export type AssistantEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; ok: boolean; summary: string }
  | { type: "question"; id: string; prompt: string; options: { id: string; label: string }[] }
  /** Needs approval (approvePlan) before the changes run. extra: `app`, the app the plan is about, when there is one. */
  | { type: "plan"; id: string; steps: string[]; app?: string }
  | { type: "done"; stopReason: string }
  | { type: "error"; message: string };

export interface AssistantConfig {
  /** Deploy King API, e.g. http://localhost:4000 */
  apiBase: string;
  /** A Deploy King API token (dk_…, made on the AI agents page). */
  token: string;
  llm: { provider: "anthropic"; apiKey: string; model: string };
  /**
   * "auto-read-only": read-only tools run straight away, changes wait for an approved plan.
   * "ask": every tool, reads included, waits for an approved plan.
   */
  approve: "ask" | "auto-read-only";
  /**
   * extra: called after the user approved a plan and before any of its changes run. Return false to stop it.
   * This is where Deploy King Cloud approval (signed tickets) plugs in later; nothing calls a control server today.
   */
  beforeChange?: (plan: PlanInfo) => Promise<boolean>;
  /** extra: maximum model turns per send (default 30). */
  maxTurns?: number;
}

export interface Conversation {
  send(text: string, attachments: { path: string; name: string }[], onEvent: (e: AssistantEvent) => void): Promise<void>;
  answer(questionId: string, optionIdOrText: string): Promise<void>;
  approvePlan(planId: string, approved: boolean): Promise<void>;
}

/** extra: what createConversation really returns. */
export interface AssistantConversation extends Conversation {
  /** Stops the running send: pending plans and questions are refused, the model call is aborted. */
  cancel(): void;
  /** True while a send is running. */
  readonly busy: boolean;
}

/** What beforeChange gets: the plan as the user saw it, and the exact changes behind it. */
export interface PlanInfo {
  id: string;
  steps: string[];
  app?: string;
  actions: PlanAction[];
}

export interface PlanAction {
  /** Tool name, e.g. create_app, deploy_zip, set_env. Empty for a plan the model wrote before choosing tools. */
  tool: string;
  /** Deploy King Cloud ticket action: deploy, change, delete, read. */
  action: "deploy" | "change" | "delete" | "read";
  app?: string;
  /** Tool input with secrets hidden ({{secret:NAME}} references, never values). */
  input: unknown;
  /** For uploads: the file that will be sent. */
  file?: { name: string; bytes: number; sha256: string };
}
