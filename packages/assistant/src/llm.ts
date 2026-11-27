import Anthropic from "@anthropic-ai/sdk";

/** The few shapes of the Messages API the loop needs. A fake client in tests implements LlmClient directly. */
export type LlmText = { type: "text"; text: string };
export type LlmToolUse = { type: "tool_use"; id: string; name: string; input: unknown };
export type LlmToolResult = { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };
export type LlmBlock = LlmText | LlmToolUse | LlmToolResult;

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmBlock[];
}

export interface LlmToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface LlmRequest {
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
  maxTokens: number;
}

export interface LlmResponse {
  content: Array<LlmText | LlmToolUse>;
  stopReason: string;
}

export interface LlmClient {
  /** One model turn. Text is streamed through onText as it arrives; the full turn is returned at the end. */
  complete(req: LlmRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<LlmResponse>;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** The Anthropic Messages API through the official SDK, streaming. */
export class AnthropicLlm implements LlmClient {
  private client: Anthropic;
  constructor(apiKey: string, opts: { baseURL?: string } = {}) {
    this.client = new Anthropic({ apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: 2 });
  }

  async complete(req: LlmRequest, onText: (delta: string) => void, signal: AbortSignal): Promise<LlmResponse> {
    const tools = req.tools.map((t, i) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as any,
      // The tool list and system prompt are the same on every turn: cache them.
      ...(i === req.tools.length - 1 ? { cache_control: { type: "ephemeral" as const } } : {}),
    }));
    const stream = this.client.messages.stream(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
        tools,
        messages: req.messages as any,
      },
      { signal }
    );
    stream.on("text", (delta) => onText(delta));
    const msg = await stream.finalMessage();
    const content: Array<LlmText | LlmToolUse> = [];
    for (const b of msg.content as any[]) {
      if (b.type === "text") content.push({ type: "text", text: b.text });
      else if (b.type === "tool_use") content.push({ type: "tool_use", id: b.id, name: b.name, input: b.input });
    }
    return { content, stopReason: String(msg.stop_reason ?? "end_turn") };
  }
}

/** Turns SDK errors into a sentence for the user. */
export function llmErrorText(e: any): string {
  const status = e?.status;
  if (status === 401) return "The Anthropic API key was refused. Set it with: dk config set anthropic-key";
  if (status === 429) return "The Anthropic API is rate limiting this key. Wait a moment and try again.";
  if (status === 529 || status === 503) return "The Anthropic API is overloaded right now. Try again in a minute.";
  if (status === 404) return `The model was not found: ${e?.message ?? ""}. Check the model name in the config.`;
  return `The AI request failed: ${e?.message ?? e}`;
}
