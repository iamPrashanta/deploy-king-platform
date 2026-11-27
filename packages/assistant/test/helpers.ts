import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";
import type { DkApi, ToolCallResult, ZipUpload } from "../src/api";
import type { LlmClient, LlmRequest, LlmResponse, LlmToolUse } from "../src/llm";
import type { AssistantEvent } from "../src/types";

/** A model that plays a script: each turn is a function of the request (so a test can look at what it was sent). */
export class FakeLlm implements LlmClient {
  requests: LlmRequest[] = [];
  private i = 0;
  constructor(private turns: Array<LlmResponse | ((req: LlmRequest) => LlmResponse)>) {}
  async complete(req: LlmRequest, onText: (d: string) => void, signal: AbortSignal): Promise<LlmResponse> {
    if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    // A deep copy: the conversation keeps adding to the same array.
    this.requests.push(JSON.parse(JSON.stringify(req)));
    const t = this.turns[this.i++];
    if (!t) return { content: [{ type: "text", text: "(script ended)" }], stopReason: "end_turn" };
    const r = typeof t === "function" ? t(req) : t;
    for (const b of r.content) if (b.type === "text") onText(b.text);
    return r;
  }
  /** Everything the model was ever sent, as one string. */
  seen() {
    return JSON.stringify(this.requests.map((r) => r.messages));
  }
}

let n = 0;
export const call = (name: string, input: unknown): LlmToolUse => ({ type: "tool_use", id: `tu_${++n}`, name, input });
export const turn = (...blocks: Array<LlmToolUse | string>): LlmResponse => ({
  content: blocks.map((b) => (typeof b === "string" ? { type: "text" as const, text: b } : b)),
  stopReason: blocks.some((b) => typeof b !== "string") ? "tool_use" : "end_turn",
});

/** The Deploy King API without a network: answers per tool, and records every call. */
export class FakeApi implements DkApi {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  uploads: ZipUpload[] = [];
  constructor(private handlers: Record<string, (args: any, nth: number) => ToolCallResult | unknown> = {}) {}
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    this.calls.push({ name, args });
    const h = this.handlers[name];
    if (!h) return { ok: false, error: `fake api: no handler for ${name}` };
    const r: any = h(args, this.calls.filter((c) => c.name === name).length);
    return r && typeof r === "object" && "ok" in r ? r : { ok: true, data: r };
  }
  async uploadZip(u: ZipUpload): Promise<ToolCallResult> {
    this.uploads.push(u);
    const h = this.handlers.__upload;
    if (h) return h(u, this.uploads.length) as ToolCallResult;
    return { ok: true, data: { id: "site-1", name: `${u.name}.localhost`, url: `http://${u.name}.localhost`, deploymentId: "dep-1" } };
  }
  names() {
    return this.calls.map((c) => c.name);
  }
}

/** Collects events; `on` lets a test react to one (approve a plan, answer a question). */
export function recorder(on: (e: AssistantEvent) => void = () => {}) {
  const events: AssistantEvent[] = [];
  return {
    events,
    handler: (e: AssistantEvent) => {
      events.push(e);
      on(e);
    },
    of<T extends AssistantEvent["type"]>(type: T) {
      return events.filter((e) => e.type === type) as Extract<AssistantEvent, { type: T }>[];
    },
  };
}

/** A small Express app as a ZIP, like the one in the terminal artboard. */
export function makeShopZip() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-test-"));
  const zip = new AdmZip();
  zip.addFile(
    "shop-api/package.json",
    Buffer.from(JSON.stringify({ name: "shop-api", version: "1.0.0", scripts: { start: "node server.js" }, dependencies: { express: "^4.18.0", pg: "^8.11.0" }, engines: { node: "20" } }, null, 2))
  );
  zip.addFile("shop-api/server.js", Buffer.from("const express = require('express');\nconst app = express();\napp.get('/', (_q, r) => r.send('ok'));\napp.listen(process.env.PORT || 3000);\n"));
  zip.addFile("shop-api/.env.example", Buffer.from("DATABASE_URL=postgres://user:pass@localhost:5432/shop\nJWT_SECRET=changeme\nPORT=3000\n"));
  const file = path.join(dir, "shop-api.zip");
  zip.writeZip(file);
  return { dir, file };
}

export const cfg = (extra: Record<string, unknown> = {}) => ({
  apiBase: "http://localhost:4000",
  token: "dk_" + "x".repeat(40),
  llm: { provider: "anthropic" as const, apiKey: "not-used", model: "claude-sonnet-5-5" },
  approve: "auto-read-only" as const,
  ...extra,
});
