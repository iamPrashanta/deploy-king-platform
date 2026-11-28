import http from "node:http";
import type { AddressInfo } from "node:net";

/** A Deploy King API on localhost: /mcp tools/call and /mcp/upload, answering from handlers. */
export async function fakeDeployKing(tools: Record<string, (args: any) => unknown>) {
  const calls: Array<{ name: string; args: any; auth: string | undefined }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const auth = req.headers.authorization;
      if (auth !== "Bearer dk_" + "t".repeat(40)) {
        res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Missing, expired or revoked token." } }));
        return;
      }
      if (req.url === "/mcp/upload") {
        calls.push({ name: "upload", args: { bytes: body.length }, auth });
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "s1", name: "x.localhost", url: "http://x.localhost", deploymentId: "d1" }));
        return;
      }
      const msg = JSON.parse(body || "{}");
      const name = msg.params?.name;
      calls.push({ name, args: msg.params?.arguments, auth });
      const h = tools[name];
      const result = h ? { content: [{ type: "text", text: JSON.stringify(h(msg.params?.arguments)) }], isError: false } : { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

type Block = { type: "text"; text: string } | { type: "tool_use"; name: string; input: unknown };

/**
 * The Anthropic Messages API on localhost, streaming server-sent events like the real one, playing scripted
 * turns. The official SDK is pointed at it with ANTHROPIC_BASE_URL; no real API is called.
 */
export async function fakeAnthropic(turns: Block[][]) {
  const requests: any[] = [];
  let i = 0;
  let tid = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
      const blocks = turns[i++] ?? [{ type: "text", text: "(end of script)" }];
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", "request-id": `req_${i}` });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `msg_${i}`, type: "message", role: "assistant", model: "fake", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
      blocks.forEach((b, index) => {
        if (b.type === "text") {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
          for (const part of b.text.match(/.{1,12}/gs) ?? []) send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
        } else {
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${++tid}`, name: b.name, input: {} } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
        }
        send("content_block_stop", { type: "content_block_stop", index });
      });
      const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
      send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => new Promise((r) => server.close(r)) };
}
