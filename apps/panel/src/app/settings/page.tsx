"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { CheckCircle2, ExternalLink, Github, KeyRound, Monitor, RefreshCw, Server, Trash2, Webhook, Wrench, XCircle, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { ThemeSwitch, useTheme } from "@/components/theme";
import { Code, CopyButton, Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";
import { useAuth } from "@/components/AuthProvider";

type Tab = "general" | "server" | "github" | "webhooks";

function General() {
  const { choice, resolved } = useTheme();
  return (
    <div className="card">
      <div className="card-head"><Monitor size={15} /><h3>Appearance</h3></div>
      <div className="card-body">
        <div className="row wrap" style={{ gap: 20 }}>
          <div className="grow" style={{ minWidth: 240 }}>
            <div className="strong">Theme</div>
            <div className="muted small">
              Dark is the default. Auto follows your device and switches when it does
              {choice === "system" ? ` (it is ${resolved} right now)` : ""}. Saved in this browser.
            </div>
          </div>
          <ThemeSwitch />
        </div>
        <div className="grid g3" style={{ marginTop: 18, gap: 12 }}>
          {(["dark", "light"] as const).map((t) => (
            <div key={t} data-theme={t} className="card" style={{ padding: 12, background: "var(--bg)" }}>
              <div className="row" style={{ gap: 8 }}>
                <span style={{ width: 34, height: 60, borderRadius: 6, background: "var(--surface)", border: "1px solid var(--border)" }} />
                <div className="grow stack" style={{ gap: 6 }}>
                  <span style={{ height: 10, width: "60%", borderRadius: 4, background: "var(--text)", opacity: 0.85 }} />
                  <span style={{ height: 8, width: "90%", borderRadius: 4, background: "var(--muted-2)", opacity: 0.6 }} />
                  <span style={{ height: 18, width: 54, borderRadius: 5, background: "var(--primary-bg)" }} />
                </div>
              </div>
              <div className="small strong" style={{ marginTop: 8, color: "var(--text)" }}>{t === "dark" ? "Dark" : "Light"}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ServerChecks() {
  const { user } = useAuth();
  const checks = trpc.system.checks.useQuery(undefined, { staleTime: 0 });
  const fix = trpc.system.fixNetwork.useMutation({
    onSuccess: () => {
      toast.success("Network created");
      checks.refetch();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const list: any[] = (checks.data as any[]) ?? [];
  const bad = list.filter((c) => c.status === "bad").length;
  const warn = list.filter((c) => c.status === "warn").length;
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className={cx("notice", checks.isLoading ? "" : bad ? "bad" : warn ? "warn" : "ok")}>
        {checks.isLoading ? <Spinner /> : bad ? <XCircle size={16} className="bad-text" /> : warn ? <AlertTriangle size={16} className="warn-text" /> : <CheckCircle2 size={16} className="ok-text" />}
        <div className="grow">
          <div className="strong">
            {checks.isLoading ? "Checking the server…" : bad ? `${bad} problem${bad === 1 ? "" : "s"} to fix before deploying` : warn ? "Ready, with warnings" : "Server is ready to deploy"}
          </div>
          <div className="muted small">Container engine, proxy, network, queue, database, disk and secrets.</div>
        </div>
        <button className="btn btn-sm" onClick={() => checks.refetch()} disabled={checks.isFetching}><RefreshCw size={13} className={checks.isFetching ? "spin" : ""} /> Run again</button>
      </div>
      <div className="card">
        {checks.isLoading ? (
          <div className="card-body stack">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} h={24} />)}</div>
        ) : (
          <div className="list">
            {list.map((c) => (
              <div key={c.key} className="row" style={{ padding: "12px 18px" }}>
                {c.status === "ok" ? <CheckCircle2 size={16} className="ok-text" /> : c.status === "warn" ? <AlertTriangle size={16} className="warn-text" /> : <XCircle size={16} className="bad-text" />}
                <span className="strong" style={{ width: 200 }}>{c.label}</span>
                <span className="muted small grow ellipsis">{c.value}</span>
                {c.fix === "network" && user?.role === "admin" && (
                  <button className="btn btn-sm" disabled={fix.isLoading} onClick={() => fix.mutate()}><Wrench size={13} /> Create it</button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function GitHubSettings() {
  const utils = trpc.useContext();
  const providers = trpc.git.providers.useQuery();
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const connect = trpc.git.connectGithub.useMutation({
    onSuccess: (p: any) => {
      toast.success(`Connected as ${p.login}`);
      setOpen(false);
      setToken("");
      setName("");
      utils.git.providers.invalidate();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const disconnect = trpc.git.disconnect.useMutation({ onSuccess: () => utils.git.providers.invalidate(), onError: (e) => toast.error(errMsg(e)) });

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head">
          <Github size={15} />
          <h3>GitHub connections</h3>
          <span className="right"><button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}><Github size={13} /> Connect GitHub</button></span>
        </div>
        {providers.isLoading ? (
          <div className="card-body"><Skeleton h={40} /></div>
        ) : !providers.data?.length ? (
          <Empty icon={<Github size={18} />} title="Nothing connected yet">
            Connect an account to deploy private repositories and pick repos from a list. Public repositories work without it.
          </Empty>
        ) : (
          <div className="list">
            {providers.data.map((p: any) => (
              <div key={p.id} className="row" style={{ padding: "12px 18px" }}>
                {p.avatarUrl ? <img src={p.avatarUrl} alt="" width={30} height={30} style={{ borderRadius: "50%" }} /> : <Github size={20} />}
                <div className="grow">
                  <div className="strong">{p.name}</div>
                  <div className="faint small">@{p.login} · connected {timeAgo(p.createdAt)}</div>
                </div>
                <button className="btn btn-sm btn-danger" onClick={() => disconnect.mutate({ id: p.id })}><Trash2 size={13} /> Disconnect</button>
              </div>
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        width={600}
        title="Connect GitHub"
        subtitle="You choose on GitHub which repositories Deploy King may read: all of them, or only the ones you pick."
        footer={
          <>
            <button className="btn" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={token.trim().length < 20 || connect.isLoading} onClick={() => connect.mutate({ token: token.trim(), name: name.trim() || undefined })}>
              {connect.isLoading ? <Spinner /> : "Verify and connect"}
            </button>
          </>
        }
      >
        <ol className="stack" style={{ gap: 14, listStyle: "none" }}>
          <li className="row top">
            <span className="step-num">1</span>
            <div className="grow">
              <div className="strong">Create a fine-grained token on GitHub</div>
              <div className="muted small">Under <b>Repository access</b>, pick <b>All repositories</b> or <b>Only select repositories</b> and tick the ones to deploy. You can change the selection on GitHub later.</div>
              <a className="btn btn-sm" style={{ marginTop: 8 }} href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">
                <ExternalLink size={13} /> Open GitHub token settings
              </a>
            </div>
          </li>
          <li className="row top">
            <span className="step-num">2</span>
            <div className="grow">
              <div className="strong">Give it read access</div>
              <div className="muted small">Repository permissions: <b>Contents: Read-only</b> (Metadata is added automatically). Set an expiry you are comfortable with.</div>
            </div>
          </li>
          <li className="row top">
            <span className="step-num">3</span>
            <div className="grow">
              <div className="strong">Paste it here</div>
              <input className="input mono" style={{ marginTop: 6 }} type="password" placeholder="github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} autoFocus />
              <input className="input" style={{ marginTop: 8 }} placeholder="Name (optional), e.g. Work account" value={name} onChange={(e) => setName(e.target.value)} />
              <div className="hint"><KeyRound size={11} style={{ verticalAlign: -1 }} /> The token is checked with GitHub, then stored encrypted on this server. It is never shown again and never written into logs.</div>
            </div>
          </li>
        </ol>
      </Dialog>
    </div>
  );
}

function Webhooks() {
  const info = trpc.system.info.useQuery();
  const url = info.data?.webhookUrl?.startsWith("/") ? `${typeof window !== "undefined" ? window.location.origin : ""}${info.data.webhookUrl}` : info.data?.webhookUrl ?? "";
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head"><Webhook size={15} /><h3>Deploy on push</h3></div>
        <div className="card-body stack" style={{ gap: 14 }}>
          <div className="muted small">Apps with “Redeploy on push” turned on deploy when GitHub sends a push for their branch. Pull requests get preview apps. Add this webhook to each repository (Settings → Webhooks → Add webhook):</div>
          <dl className="kv">
            <dt>Payload URL</dt>
            <dd className="row" style={{ gap: 8 }}><span className="mono small">{url || "…"}</span>{url && <CopyButton text={url} />}</dd>
            <dt>Content type</dt><dd className="mono small">application/json</dd>
            <dt>Secret</dt>
            <dd>{info.data?.webhookSecretSet ? <span className="ok-text small">Set on the server (GITHUB_WEBHOOK_SECRET). Use the same value.</span> : <span className="bad-text small">Not set. Add GITHUB_WEBHOOK_SECRET to the API environment first; unsigned webhooks are rejected.</span>}</dd>
            <dt>Events</dt><dd className="small">Pushes and Pull requests</dd>
          </dl>
          <Code>{`# generate a secret for GITHUB_WEBHOOK_SECRET
openssl rand -hex 32`}</Code>
        </div>
      </div>
    </div>
  );
}

function SettingsInner() {
  useCrumbs([{ label: "Settings" }]);
  const params = useSearchParams();
  const router = useRouter();
  const tab = ((params.get("tab") as Tab) || "general") as Tab;
  const go = (t: Tab) => router.replace(t === "general" ? "/settings" : `/settings?tab=${t}`, { scroll: false });
  const tabs: Array<[Tab, string, React.ReactNode]> = [
    ["general", "General", <Monitor key="m" size={14} />],
    ["server", "Server", <Server key="s" size={14} />],
    ["github", "GitHub", <Github key="g" size={14} />],
    ["webhooks", "Webhooks", <Webhook key="w" size={14} />],
  ];
  return (
    <div className="page" style={{ maxWidth: 960 }}>
      <PageHeader title="Settings" description="Appearance, server readiness and connections." />
      <div className="tabs">
        {tabs.map(([k, l, ic]) => (
          <button key={k} className={cx("tab", tab === k && "on")} onClick={() => go(k)}>{ic}{l}</button>
        ))}
      </div>
      {tab === "general" && <General />}
      {tab === "server" && <ServerChecks />}
      {tab === "github" && <GitHubSettings />}
      {tab === "webhooks" && <Webhooks />}
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense>
      <SettingsInner />
    </Suspense>
  );
}
