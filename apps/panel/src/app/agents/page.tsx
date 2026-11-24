"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Bot, Eye, KeyRound, Plus, Rocket, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Code, CopyButton, Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";

/**
 * Connect AI agents (Claude, Cursor, Codex, VS Code, any MCP client) to this server.
 * Tokens are made here; the MCP endpoint is <panel>/mcp, proxied to the API.
 */

type Scope = "read" | "deploy" | "full";
const SCOPES: Array<{ v: Scope; label: string; icon: React.ReactNode; text: string }> = [
  { v: "read", label: "Read only", icon: <Eye size={16} />, text: "Look at apps, logs, deploys and workflows, and check repositories. Changes nothing." },
  { v: "deploy", label: "Deploy", icon: <Rocket size={16} />, text: "Also create apps, deploy, restart, roll back, change variables and run workflows." },
  { v: "full", label: "Full", icon: <AlertTriangle size={16} />, text: "Also delete apps. Give this only to agents you watch." },
];
const SCOPE_LABEL: Record<string, string> = { read: "Read only", deploy: "Deploy", full: "Full" };
const SCOPE_TONE: Record<string, string> = { read: "", deploy: "info", full: "warn" };
const EXPIRY = [
  { v: 7, label: "7 days" },
  { v: 30, label: "30 days" },
  { v: 90, label: "90 days" },
  { v: 365, label: "1 year" },
  { v: 0, label: "Never" },
];

const CLIENTS = ["Claude Code", "Claude Desktop", "Cursor", "VS Code", "Codex", "Other"] as const;
type Client = (typeof CLIENTS)[number];

function snippet(client: Client, url: string, token: string): { label: string; code: string; note: React.ReactNode } {
  switch (client) {
    case "Claude Code":
      return {
        label: "terminal",
        code: `claude mcp add --transport http deploy-king ${url} \\\n  --header "Authorization: Bearer ${token}"`,
        note: <>Add <code className="inline-code">--scope user</code> to use it in every project. Check with <code className="inline-code">claude mcp list</code>.</>,
      };
    case "Claude Desktop":
      return {
        label: "claude_desktop_config.json",
        code: JSON.stringify(
          { mcpServers: { "deploy-king": { command: "npx", args: ["-y", "mcp-remote", url, "--header", "Authorization:${DK_AUTH}"], env: { DK_AUTH: `Bearer ${token}` } } } },
          null,
          2
        ),
        note: <>Settings → Developer → Edit Config, add this, then restart Claude. Needs Node.js; <code className="inline-code">mcp-remote</code> connects the app to this server.</>,
      };
    case "Cursor":
      return {
        label: "~/.cursor/mcp.json",
        code: JSON.stringify({ mcpServers: { "deploy-king": { url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2),
        note: <>Or <code className="inline-code">.cursor/mcp.json</code> in one project. Keep tokens out of files you commit.</>,
      };
    case "VS Code":
      return {
        label: ".vscode/mcp.json",
        code: JSON.stringify(
          {
            inputs: [{ type: "promptString", id: "deploy-king-token", description: "Deploy King token", password: true }],
            servers: { "deploy-king": { type: "http", url, headers: { Authorization: "Bearer ${input:deploy-king-token}" } } },
          },
          null,
          2
        ),
        note: <>VS Code asks for the token the first time and keeps it out of the file, so this file is safe to commit.</>,
      };
    case "Codex":
      return {
        label: "terminal",
        code: `export DEPLOY_KING_TOKEN=${token}\ncodex mcp add deploy-king --url ${url} --bearer-token-env-var DEPLOY_KING_TOKEN`,
        note: <>Put the <code className="inline-code">export</code> line in your shell profile. Codex reads the token from it, so it never lands in config.toml.</>,
      };
    default:
      return {
        label: "check the connection",
        code: `curl -s ${url} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
        note: <>Any MCP client that speaks <b>Streamable HTTP</b> works: use the URL above and send <code className="inline-code">Authorization: Bearer &lt;token&gt;</code>.</>,
      };
  }
}

const EXAMPLES = [
  "Deploy https://github.com/heroku/node-js-getting-started as node-demo on Deploy King and give me the URL.",
  "Why did the last deploy of my-api fail? Find the cause and fix it.",
  "Show me the errors in n8n's logs from the last 200 lines.",
  "Set NODE_ENV=production on my-api and restart it.",
];

function Section({ icon, title, lead, action, children }: { icon: React.ReactNode; title: string; lead?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 32 }}>
      <div className="row wrap" style={{ marginBottom: lead ? 4 : 12 }}>
        <h2 className="section" style={{ fontSize: 16, margin: 0 }}>
          <span className="step-num" style={{ width: 26, height: 26 }}>{icon}</span>
          {title}
        </h2>
        {action && <span className="right">{action}</span>}
      </div>
      {lead && <p className="muted small" style={{ margin: "0 0 12px", maxWidth: 760 }}>{lead}</p>}
      {children}
    </section>
  );
}

export default function AgentsPage() {
  useCrumbs([{ label: "AI agents" }]);
  const utils = trpc.useContext();
  const tokens = trpc.mcp.tokens.useQuery();
  const tools = trpc.mcp.tools.useQuery(undefined, { staleTime: Infinity });
  const activity = trpc.mcp.activity.useQuery({ limit: 30 }, { refetchInterval: 10_000 });
  const revoke = trpc.mcp.revokeToken.useMutation({
    onSuccess: () => {
      utils.mcp.tokens.invalidate();
      toast.success("Token revoked");
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const [origin, setOrigin] = useState("https://your-panel");
  useEffect(() => setOrigin(window.location.origin), []);
  const url = `${origin}/mcp`;
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [client, setClient] = useState<Client>("Claude Code");
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);
  const token = fresh?.token ?? "dk_your_token";
  const s = snippet(client, url, token);

  const grouped = useMemo(() => {
    const by: Record<Scope, any[]> = { read: [], deploy: [], full: [] };
    for (const t of tools.data ?? []) by[t.scope as Scope]?.push(t);
    return by;
  }, [tools.data]);

  return (
    <div className="page" style={{ maxWidth: 1080 }}>
      <PageHeader
        title="AI agents"
        description="Let Claude, Cursor, Codex or any MCP client check repositories, deploy, read logs and fix failed deploys on this server. Each agent gets its own token, with only the access you choose."
        actions={
          <button className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={15} /> New token
          </button>
        }
      />

      <div className="card card-pad" style={{ marginBottom: 32 }}>
        <div className="row wrap" style={{ gap: 14 }}>
          <span className="wf-icon-tile" style={{ width: 40, height: 40, borderRadius: 10, color: "var(--blue)" }}><Bot size={19} /></span>
          <div className="grow" style={{ minWidth: 240 }}>
            <div className="label" style={{ marginBottom: 4 }}>MCP server URL</div>
            <div className="row" style={{ gap: 8 }}>
              <code className="mono strong" style={{ fontSize: 14 }}>{url}</code>
              <CopyButton text={url} label="" />
            </div>
            <div className="faint small" style={{ marginTop: 4 }}>
              Streamable HTTP · bearer token · {tools.data?.length ?? 16} tools · agents can read <a className="link" href="/llms.txt" target="_blank" rel="noreferrer">/llms.txt</a> to learn the platform
            </div>
          </div>
        </div>
      </div>

      <Section
        icon={<KeyRound size={14} />}
        title="Tokens"
        lead="A token acts as you, limited to its access level, and only works on the MCP URL. Only a fingerprint is stored, so a lost token can't be shown again: revoke it and make a new one."
      >
        <div className="card">
          {tokens.isLoading ? (
            <div style={{ padding: 18 }}><Skeleton h={60} /></div>
          ) : !tokens.data?.length ? (
            <Empty icon={<KeyRound size={20} />} title="No tokens yet" action={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={15} /> New token</button>}>
              Make one token per agent, so you can see what each one did and revoke it on its own.
            </Empty>
          ) : (
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Access</th><th className="desktop-only">Created</th><th>Last used</th><th className="desktop-only">Expires</th><th /></tr>
              </thead>
              <tbody>
                {tokens.data.map((t: any) => (
                  <tr key={t.id}>
                    <td>
                      <div className="strong">{t.name}</div>
                      <div className="faint tiny mono">{t.prefix}…</div>
                    </td>
                    <td><span className={cx("badge", SCOPE_TONE[t.scope])}>{SCOPE_LABEL[t.scope] ?? t.scope}</span></td>
                    <td className="small desktop-only">{timeAgo(t.createdAt)}</td>
                    <td className="small">{t.lastUsedAt ? <span title={t.lastUsedIp ?? ""}>{timeAgo(t.lastUsedAt)}</span> : <span className="faint">Never</span>}</td>
                    <td className="small desktop-only">{t.expiresAt ? new Date(t.expiresAt).toLocaleDateString() : <span className="faint">Never</span>}</td>
                    <td style={{ width: 90, textAlign: "right" }}>
                      <button className="btn btn-sm btn-ghost bad-text" onClick={() => setConfirm({ id: t.id, name: t.name })}>Revoke</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <Section icon={<Bot size={14} />} title="Connect an agent" lead={fresh ? <>Showing your new token <b>{fresh.name}</b> in the commands below. Copy what you need now.</> : "Make a token first; it fills in the commands below."}>
        <div className="seg" style={{ marginBottom: 10, flexWrap: "wrap" }}>
          {CLIENTS.map((c) => (
            <button key={c} className={client === c ? "on" : ""} onClick={() => setClient(c)}>{c}</button>
          ))}
        </div>
        <Code label={s.label}>{s.code}</Code>
        <p className="muted small" style={{ marginTop: 8 }}>{s.note}</p>
        <div className="card card-pad" style={{ marginTop: 14 }}>
          <div className="label">Then ask it things like</div>
          <div className="stack" style={{ gap: 6 }}>
            {EXAMPLES.map((e) => (
              <div key={e} className="row small" style={{ gap: 8 }}>
                <span className="grow">“{e}”</span>
                <CopyButton text={e} label="" />
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section icon={<ShieldCheck size={14} />} title="What agents can do" lead="The tools an agent gets depend on its token. Every tool goes through the same checks as the panel, so an agent can only touch your apps.">
        <div className="grid g3" style={{ alignItems: "start" }}>
          {SCOPES.map((sc) => (
            <div key={sc.v} className="card">
              <div className="card-head">
                <span className="row" style={{ gap: 8 }}>{sc.icon}<h3>{sc.label}</h3></span>
                <span className="right faint tiny">{sc.v === "read" ? "" : sc.v === "deploy" ? "+ read" : "+ deploy"}</span>
              </div>
              <div className="card-body stack" style={{ gap: 10 }}>
                {tools.isLoading && <Skeleton h={80} />}
                {grouped[sc.v].map((t) => (
                  <div key={t.name}>
                    <div className="row" style={{ gap: 6 }}>
                      <code className="mono small strong">{t.name}</code>
                      {t.destructive && <span className="badge warn" style={{ fontSize: 10.5 }}>{t.name === "delete_app" ? "deletes" : "overwrites"}</span>}
                    </div>
                    <div className="muted tiny" style={{ marginTop: 2 }}>{t.description}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section icon={<Rocket size={14} />} title="Activity" lead="Every call your agents made in the last 30 days. Variable values are never logged.">
        <div className="card">
          {activity.isLoading ? (
            <div style={{ padding: 18 }}><Skeleton h={60} /></div>
          ) : !activity.data?.length ? (
            <div className="empty" style={{ padding: 28 }}><p className="small muted">No calls yet. Connect an agent and ask it to list your apps.</p></div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>When</th><th>Agent token</th><th>Tool</th><th className="desktop-only">Arguments</th><th>Result</th></tr>
              </thead>
              <tbody>
                {activity.data.map((a: any) => (
                  <tr key={a.id}>
                    <td className="small faint" style={{ whiteSpace: "nowrap" }}>{timeAgo(a.createdAt)}</td>
                    <td className="small">{a.tokenName ?? <span className="faint">deleted</span>}</td>
                    <td><code className="mono small">{a.tool}</code></td>
                    <td className="desktop-only" style={{ maxWidth: 320 }}>
                      <span className="mono tiny faint ellipsis" style={{ display: "block" }} title={JSON.stringify(a.args)}>{argText(a.args)}</span>
                    </td>
                    <td className="small">
                      {a.ok ? (
                        <span className="row" style={{ gap: 6 }}><span className="dot ok" />Done · {took(a.durationMs ?? 0)}</span>
                      ) : (
                        <div style={{ maxWidth: 300 }}>
                          <span className="row bad-text" style={{ gap: 6 }}><span className="dot bad" />Error</span>
                          <div className="faint tiny ellipsis" title={a.error ?? ""} style={{ whiteSpace: "nowrap" }}>{a.error}</div>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </Section>

      <div className="notice small" style={{ marginBottom: 24 }}>
        <ShieldCheck size={15} />
        <span>
          Safety: read-only tokens can't change anything · deleting needs a Full token and the app's domain typed again · variable values are never returned · tokens never work on the panel's own API · 120 calls a minute per token · revoking takes effect at once.
        </span>
      </div>

      <NewToken
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(t) => {
          setFresh(t);
          utils.mcp.tokens.invalidate();
        }}
      />

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title="Revoke this token?"
        subtitle={confirm?.name}
        width={440}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button
              className="btn btn-danger"
              disabled={revoke.isLoading}
              onClick={() => confirm && revoke.mutate({ id: confirm.id }, { onSuccess: () => { setConfirm(null); if (fresh && confirm.name === fresh.name) setFresh(null); } })}
            >
              {revoke.isLoading ? <Spinner size={14} /> : <Trash2 size={14} />} Revoke
            </button>
          </>
        }
      >
        <p className="small muted">Agents using it stop working straight away. This can't be undone.</p>
      </Dialog>
    </div>
  );
}

const took = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

function argText(args: any) {
  if (!args || typeof args !== "object") return "";
  return Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("  ");
}

function NewToken({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (t: { token: string; name: string }) => void }) {
  const [name, setName] = useState("");
  const [scope, setScope] = useState<Scope>("deploy");
  const [days, setDays] = useState(90);
  const [made, setMade] = useState<{ token: string; name: string } | null>(null);
  const create = trpc.mcp.createToken.useMutation();
  useEffect(() => {
    if (open) {
      setName("");
      setScope("deploy");
      setDays(90);
      setMade(null);
    }
  }, [open]);
  const submit = async () => {
    try {
      const r: any = await create.mutateAsync({ name: name.trim() || "My agent", scope, expiresInDays: days || null });
      const t = { token: r.token, name: r.name };
      setMade(t);
      onCreated(t);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={made ? "Copy your token" : "New token"}
      subtitle={made ? "It is shown once. Store it in your agent's settings now." : "One token per agent makes its activity easy to follow."}
      width={560}
      footer={
        made ? (
          <button className="btn btn-primary" onClick={onClose}>Done</button>
        ) : (
          <>
            <button className="btn" onClick={onClose}>Cancel</button>
            <button className="btn btn-primary" disabled={create.isLoading} onClick={submit}>
              {create.isLoading ? <Spinner size={14} /> : <KeyRound size={14} />} Create token
            </button>
          </>
        )
      }
    >
      {made ? (
        <div className="stack" style={{ gap: 12 }}>
          <Code label={made.name}>{made.token}</Code>
          <div className="notice warn small"><AlertTriangle size={14} /><span>Anyone with this token can act as you with its access level. Don't paste it into chats or commit it.</span></div>
          <p className="small muted" style={{ margin: 0 }}>The connect commands on this page now include it.</p>
        </div>
      ) : (
        <div>
          <div className="field">
            <label className="label" htmlFor="tok-name">Name</label>
            <input id="tok-name" className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Code on my laptop" maxLength={100} onKeyDown={(e) => e.key === "Enter" && submit()} />
          </div>
          <div className="field">
            <div className="label">Access</div>
            <div className="stack" style={{ gap: 8 }}>
              {SCOPES.map((sc) => (
                <button key={sc.v} type="button" className={cx("option", scope === sc.v && "on")} onClick={() => setScope(sc.v)}>
                  <span className="oi">{sc.icon}</span>
                  <span><span className="strong">{sc.label}</span><br /><span className="muted small">{sc.text}</span></span>
                </button>
              ))}
            </div>
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label className="label" htmlFor="tok-exp">Expires</label>
            <select id="tok-exp" className="select" value={days} onChange={(e) => setDays(Number(e.target.value))} style={{ maxWidth: 200 }}>
              {EXPIRY.map((x) => <option key={x.v} value={x.v}>{x.label}</option>)}
            </select>
          </div>
        </div>
      )}
    </Dialog>
  );
}
