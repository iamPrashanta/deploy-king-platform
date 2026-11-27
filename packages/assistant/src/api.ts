/**
 * The Deploy King API as the assistant uses it, with a Deploy King API token (dk_…):
 *   POST /mcp         JSON-RPC tools/call: the same tools AI agents get (apps/api/src/mcp/tools.ts)
 *   POST /mcp/upload  multipart ZIP upload that creates an app and starts its first deploy
 * Tools run on the server as the token's user, with the panel's own permission checks.
 */

export type ToolCallResult = { ok: true; data: unknown } | { ok: false; error: string };

export interface ZipUpload {
  zip: Uint8Array;
  fileName: string;
  /** App name or full domain. */
  name: string;
  port?: number;
  memoryMb?: number;
  /** Real values: secrets are already resolved here. */
  variables?: Record<string, string>;
}

export interface DkApi {
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult>;
  uploadZip(upload: ZipUpload, signal?: AbortSignal): Promise<ToolCallResult>;
}

export class ApiError extends Error {}

export class HttpDkApi implements DkApi {
  private base: string;
  private seq = 0;
  constructor(apiBase: string, private token: string, private fetchImpl: typeof fetch = globalThis.fetch) {
    this.base = apiBase.replace(/\/+$/, "");
  }

  private headers(extra: Record<string, string> = {}) {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json", ...extra };
  }

  private static refused(status: number, body: any): string {
    const msg = body?.error?.message ?? body?.error ?? "";
    if (status === 401) return `The Deploy King token was refused (${msg || "unauthorized"}). Run dk login again.`;
    if (status === 403) return msg || "Not allowed with this token.";
    if (status === 429) return msg || "Too many calls; wait a minute.";
    return msg || `The Deploy King API answered ${status}.`;
  }

  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolCallResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/mcp`, {
        method: "POST",
        headers: this.headers({ "Content-Type": "application/json" }),
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.seq, method: "tools/call", params: { name, arguments: args } }),
        signal: signal ?? null,
      });
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      throw new ApiError(`Cannot reach Deploy King at ${this.base}: ${e?.cause?.code ?? e?.message ?? e}`);
    }
    const body: any = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: HttpDkApi.refused(res.status, body) };
    if (body?.error) return { ok: false, error: String(body.error.message ?? "Tool call failed") };
    const result = body?.result;
    const text = (result?.content ?? []).map((c: any) => (c?.type === "text" ? c.text : "")).join("");
    if (result?.isError) return { ok: false, error: text || "The tool failed" };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: true, data: text };
    }
  }

  async uploadZip(u: ZipUpload, signal?: AbortSignal): Promise<ToolCallResult> {
    const form = new FormData();
    form.append("project", new Blob([u.zip as Uint8Array<ArrayBuffer>], { type: "application/zip" }), u.fileName.endsWith(".zip") ? u.fileName : `${u.fileName}.zip`);
    form.append("name", u.name);
    if (u.port !== undefined) form.append("port", String(u.port));
    if (u.memoryMb !== undefined) form.append("memoryMb", String(u.memoryMb));
    if (u.variables && Object.keys(u.variables).length) form.append("variables", JSON.stringify(u.variables));
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/mcp/upload`, { method: "POST", headers: this.headers(), body: form, signal: signal ?? null });
    } catch (e: any) {
      if (e?.name === "AbortError") throw e;
      throw new ApiError(`Cannot reach Deploy King at ${this.base}: ${e?.cause?.code ?? e?.message ?? e}`);
    }
    const body: any = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: HttpDkApi.refused(res.status, body) };
    return { ok: true, data: body };
  }
}
