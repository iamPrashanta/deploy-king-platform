import os from "node:os";
import { createConversation, DEFAULT_MODEL, HttpDkApi, type AssistantConversation } from "@dbbkp/assistant";
import { DEFAULT_API_URL, configPath, effective, masked, readConfig, trustApp, updateConfig } from "./config";
import { c, out, box, status, readLine, footer } from "./ui";
import { Renderer, findAttachments, help, shortcuts, showApps, showLogs } from "./session";

declare const __DK_VERSION__: string;
const VERSION = typeof __DK_VERSION__ !== "undefined" ? __DK_VERSION__ : "dev";
const TOKEN = /^dk_[A-Za-z0-9_-]{30,60}$/;

const USAGE = `dk — the Deploy King assistant in your terminal

  dk                         start a session (talk to the assistant)
  dk "<message>"             start a session with a first message
  dk login [--url <url>] [--token <dk_…>] [--force]
                             save the Deploy King API URL and an API token (panel: AI agents → New token)
  dk logout                  forget the token
  dk config set anthropic-key [<key>]   save an Anthropic API key (or set ANTHROPIC_API_KEY)
  dk config set model <model>           default: ${DEFAULT_MODEL}
  dk config set api-url <url>           default: ${DEFAULT_API_URL}
  dk config unset <anthropic-key|model|trusted-apps>
  dk config show | path
  dk --version

Environment: DK_API_URL, DK_TOKEN, ANTHROPIC_API_KEY, DK_MODEL, DK_CONFIG (config file), NO_COLOR.`;

function flag(args: string[], name: string) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v && !v.startsWith("--") ? 2 : 1);
  return v && !v.startsWith("--") ? v : "";
}

async function login(args: string[]) {
  const force = args.includes("--force");
  let url = flag(args, "--url");
  let token = flag(args, "--token") || process.env.DK_TOKEN || "";
  const cfg = readConfig();
  if (!url) {
    const dflt = cfg.apiUrl || DEFAULT_API_URL;
    url = process.stdin.isTTY ? ((await readLine(`Deploy King API URL ${c.muted(`[${dflt}]`)}: `)) ?? "").trim() || dflt : dflt;
  }
  url = url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error("The URL must start with http:// or https://");
  if (!token) {
    out(c.muted("Make a token in the panel: AI agents → New token. Choose deploy access to let dk deploy."));
    token = ((await readLine("API token: ", { hidden: true })) ?? "").trim();
  }
  if (!TOKEN.test(token)) throw new Error("That does not look like a Deploy King API token (dk_…).");
  const r = await new HttpDkApi(url, token).callTool("platform_status", {}).catch((e: any) => ({ ok: false as const, error: e?.message ?? String(e) }));
  if (!r.ok && !force) throw new Error(`${r.error}\nNothing was saved. Use --force to save it anyway.`);
  updateConfig((c) => {
    c.apiUrl = url;
    c.token = token;
  });
  const d: any = r.ok ? r.data : null;
  status(d ? `Signed in${d.you?.username ? ` as ${d.you.username}` : ""} on Deploy King ${d.version} at ${url}` : `Saved for ${url} (not checked)`);
  out(c.muted(`  Saved in ${configPath()} (readable only by you).`));
  if (!effective().anthropicKey) out(c.muted("  Next: set ANTHROPIC_API_KEY, or run: dk config set anthropic-key"));
}

async function config(args: string[]) {
  const [verb, name, ...rest] = args;
  const value = rest.join(" ").trim();
  if (verb === "path") return out(configPath());
  if (verb === "show") {
    const e = effective();
    const f = readConfig();
    out(`api-url        ${e.apiUrl}`);
    out(`token          ${masked(e.token)}${process.env.DK_TOKEN ? c.muted(" (from DK_TOKEN)") : ""}`);
    out(`anthropic-key  ${masked(e.anthropicKey)}${e.anthropicKeyFrom === "ANTHROPIC_API_KEY" ? c.muted(" (from ANTHROPIC_API_KEY)") : ""}`);
    out(`model          ${e.model || `${DEFAULT_MODEL} ${c.muted("(default)")}`}`);
    const trusted = Object.entries(f.trustedApps ?? {}).flatMap(([u, apps]) => apps.map((a) => `${a} ${c.muted(`(${u})`)}`));
    out(`trusted-apps   ${trusted.length ? trusted.join(", ") : c.muted("none")}`);
    out(c.muted(`file           ${configPath()}`));
    return;
  }
  if (verb === "set") {
    if (name === "anthropic-key") {
      const key = value || ((await readLine("Anthropic API key: ", { hidden: true })) ?? "").trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) throw new Error("That does not look like an Anthropic API key (sk-ant-…).");
      updateConfig((c) => void (c.anthropicKey = key));
      return status(`Anthropic API key saved in ${configPath()} (readable only by you).`);
    }
    if (name === "model") {
      if (!value) throw new Error("Usage: dk config set model <model>");
      updateConfig((c) => void (c.model = value));
      return status(`Model: ${value}`);
    }
    if (name === "api-url") {
      if (!/^https?:\/\//.test(value)) throw new Error("Usage: dk config set api-url http://localhost:4000");
      updateConfig((c) => void (c.apiUrl = value.replace(/\/+$/, "")));
      return status(`API URL: ${value}`);
    }
  }
  if (verb === "unset") {
    const field = ({ "anthropic-key": "anthropicKey", model: "model", "trusted-apps": "trustedApps", token: "token" } as const)[name as "model"];
    if (!field) throw new Error("Usage: dk config unset <anthropic-key|model|trusted-apps>");
    updateConfig((c) => void delete (c as any)[field]);
    return status(`${name} removed.`);
  }
  throw new Error("Usage: dk config set <anthropic-key|model|api-url> <value>, dk config unset <name>, dk config show");
}

const home = (p: string) => (p.startsWith(os.homedir()) ? "~" + p.slice(os.homedir().length) : p);

async function header(api: HttpDkApi, apiUrl: string, model: string) {
  const timeout = <T>(p: Promise<T>) => Promise.race([p, new Promise<null>((r) => setTimeout(() => r(null), 4000))]);
  const [st, apps] = await Promise.all([timeout(api.callTool("platform_status", {})).catch(() => null), timeout(api.callTool("list_apps", {})).catch(() => null)]);
  const s: any = st && st.ok ? st.data : null;
  const a: any = apps && apps.ok ? apps.data : null;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(apiUrl);
  const running = a ? (a.apps ?? []).filter((x: any) => x.status === "active").length : null;
  const line1 = `${c.bright("♛ Deploy King")}${c.muted(` ${s?.version ?? VERSION}${s?.you?.username ? ` · signed in as ${s.you.username}` : ""} · ${model}`)}`;
  const where = local ? `Server ${os.hostname()} · ${Math.round(os.totalmem() / 1024 ** 3)} GB` : `Server ${new URL(apiUrl).host}`;
  const line2 = c.muted(`${where}${running !== null ? ` · ${running} app${running === 1 ? "" : "s"} running` : ""} · ${home(process.cwd())}`);
  box([line1, line2]);
  if (st && !st.ok) status(c.red(st.error), false);
  else if (!st) status(c.red(`Deploy King at ${apiUrl} did not answer. Is the API running?`), false);
}

async function session(first: string | undefined) {
  const e = effective();
  if (!e.token) {
    out(`Not signed in. Run: ${c.blue("dk login")}`);
    process.exitCode = 1;
    return;
  }
  const model = e.model || DEFAULT_MODEL;
  const api = new HttpDkApi(e.apiUrl, e.token);
  let conv: AssistantConversation | null = null;
  const getConv = () =>
    (conv ??= createConversation(
      {
        apiBase: e.apiUrl,
        token: e.token,
        llm: { provider: "anthropic", apiKey: e.anthropicKey, model },
        approve: "auto-read-only",
        // Deploy King Cloud approval (signed tickets) plugs in here later: beforeChange: (plan) => cloud.approve(plan).
      },
      { api }
    ));

  out();
  await header(api, e.apiUrl, model);
  footer();

  let interrupted = 0;
  process.on("SIGINT", () => {
    // Only reached while the assistant works (prompts handle Ctrl+C themselves).
    if (conv?.busy) conv.cancel();
    else if (++interrupted > 1) process.exit(130);
  });

  let pending = first;
  for (;;) {
    out();
    const line = pending ?? (await readLine(`${c.blue(">")} `, { history: true }));
    pending = undefined;
    if (line === null) break;
    const text = line.trim();
    if (!text) continue;
    if (text === "?") {
      shortcuts();
      continue;
    }
    if (text.startsWith("/")) {
      const [cmd, ...args] = text.split(/\s+/);
      if (cmd === "/quit" || cmd === "/exit" || cmd === "/q") break;
      if (cmd === "/help") help();
      else if (cmd === "/apps") await showApps(api);
      else if (cmd === "/logs") await showLogs(api, args[0] ?? "", Math.min(Math.max(Number(args[1]) || 80, 10), 1000));
      else if (cmd === "/undo") status("Undo is not supported yet. To go back to an app's previous release, ask: roll back <app>.", false);
      else status(`Unknown command ${cmd}. Type /help.`, false);
      continue;
    }
    if (!e.anthropicKey) {
      status(c.red("No Anthropic API key. Set ANTHROPIC_API_KEY, or run: dk config set anthropic-key"), false);
      continue;
    }
    const attachments = findAttachments(text);
    for (const a of attachments) out(c.muted(`  attached ${home(a.path)}`));
    const conversation = getConv();
    const r = new Renderer(conversation, { apiUrl: e.apiUrl, trusted: e.trusted, onTrust: (app) => trustApp(e.apiUrl, app) });
    r.begin();
    try {
      await conversation.send(text, attachments, r.handle);
    } catch (err: any) {
      status(c.red(err?.message ?? String(err)), false);
    }
    await r.end();
  }
  out(c.muted("Bye."));
}

export async function main(argv = process.argv.slice(2)) {
  const args = [...argv];
  const cmd = args[0];
  try {
    if (cmd === "--version" || cmd === "-v") return out(VERSION);
    if (cmd === "--help" || cmd === "-h" || cmd === "help") return out(USAGE);
    if (cmd === "login") return await login(args.slice(1));
    if (cmd === "logout") {
      updateConfig((c) => void delete c.token);
      return status("Signed out: the token was removed from this computer. Revoke it in the panel if it should stop working.");
    }
    if (cmd === "config") return await config(args.slice(1));
    return await session(args.length ? args.join(" ") : undefined);
  } catch (err: any) {
    status(c.red(err?.message ?? String(err)), false);
    process.exitCode = 1;
  }
}
