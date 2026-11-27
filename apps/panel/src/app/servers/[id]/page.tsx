"use client";

import Link from "next/link";
import { Suspense, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Cpu, HardDrive, KeyRound, MemoryStick, Play, Power, RefreshCw, Server, Timer, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Code, CopyButton, Dialog, Empty, Skeleton, Spinner, Tile, cx, errMsg, timeAgo } from "@/components/ui";
import { RulesEditor, ServerStatus, TYPE_LABEL, keyAgeNote, since, signIn, uptimeText, type Rules } from "@/components/servers/common";
import { TestResults } from "@/components/servers/Checks";
import { ReplayPlayer, SshTerminal, type SshTerminalHandle } from "@/components/servers/SshTerminal";

/**
 * One connected server: Terminal (live numbers, a recorded terminal, quick commands, recent sessions),
 * Overview (connection test, identity, connection details), Keys, Access rules and Activity.
 */

type Tab = "terminal" | "overview" | "keys" | "access" | "activity";
const onError = (e: unknown) => toast.error(errMsg(e));

const QUICK: Array<{ name: string; cmd: string; asks?: boolean; needsDocker?: boolean }> = [
  { name: "Disk usage", cmd: "df -h" },
  { name: "Memory", cmd: "free -h" },
  { name: "Failed services", cmd: "systemctl --failed" },
  { name: "Recent sign-ins", cmd: "last -n 10" },
  { name: "Containers", cmd: "docker ps", needsDocker: true },
  { name: "Recent errors", cmd: "sudo journalctl -p err -n 20 --no-pager", asks: true },
];

const ACTION_TEXT: Record<string, string> = {
  ssh_server_add: "added the server",
  ssh_server_update: "changed the server",
  ssh_server_delete: "removed the server",
  ssh_key_install: "installed the key",
  ssh_host_trust: "trusted the fingerprint",
  ssh_host_refused: "connection refused: the fingerprint changed",
  ssh_test: "ran the connection test",
  ssh_terminal_open: "opened a terminal",
  ssh_terminal_close: "closed a terminal",
  ssh_terminal_denied: "was refused a terminal",
};

function Stat({ icon, k, v, s, pct }: { icon: React.ReactNode; k: string; v: string; s: string; pct?: number }) {
  return (
    <div className="card card-pad stat">
      <div className="k">{icon} {k}</div>
      <div className="v">{v || "–"}</div>
      <div className="s">{s || " "}</div>
      {pct != null && <div className={cx("meter", pct > 90 ? "bad" : pct > 75 && "warn")}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>}
    </div>
  );
}

function Replay({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const rec = trpc.servers.recording.useQuery({ sessionId }, { retry: false });
  const r = rec.data as any;
  return (
    <Dialog open onClose={onClose} width={960} title="Replay" subtitle={r ? `${r.actor} · ${new Date(r.startedAt).toLocaleString()}` : undefined}>
      {rec.error ? <div className="notice bad small">{rec.error.message}</div> : !r ? <Skeleton h={300} /> : <ReplayPlayer cast={r.cast} />}
    </Dialog>
  );
}

function sessionLine(x: any) {
  const start = new Date(x.startedAt);
  const today = start.toDateString() === new Date().toDateString();
  const mins = x.endedAt ? Math.max(1, Math.round((new Date(x.endedAt).getTime() - start.getTime()) / 60000)) : null;
  if (x.live) return `Started ${since(x.startedAt)}`;
  return [`${today ? "Today" : start.toLocaleDateString()} ${start.toTimeString().slice(0, 5)}`, mins && `${mins} min`, `${x.commands} command${x.commands === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
}

function Sessions({ id, limit, onReplay }: { id: string; limit: number; onReplay: (sid: string) => void }) {
  const sessions = trpc.servers.sessions.useQuery({ id, limit }, { refetchInterval: 15_000 });
  const list = (sessions.data as any[]) ?? [];
  if (sessions.isLoading) return <div className="card-body"><Skeleton h={60} /></div>;
  if (!list.length) return <div className="card-body small muted">No terminal sessions yet.</div>;
  return (
    <div>
      {list.map((x) => (
        <div key={x.id} className="attn-row">
          <div className="grow" style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 550 }}>{x.actor}{x.live && <span className="faint" style={{ fontWeight: 400 }}> · open now</span>}</div>
            <div className="small muted">{sessionLine(x)}{x.endReason === "idle" ? " · closed when idle" : ""}</div>
          </div>
          {x.recorded && !x.live ? <button className="btn btn-sm" onClick={() => onReplay(x.id)}><Play size={12} /> Replay</button> : !x.recorded && !x.live ? <span className="tiny faint">Not recorded</span> : null}
        </div>
      ))}
    </div>
  );
}

function TerminalTab({ s }: { s: any }) {
  const term = useRef<SshTerminalHandle>(null);
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState<string | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const utils = trpc.useContext();
  const sys = s.system ?? {};
  const memPct = sys.memoryMb ? Math.round((100 * (sys.memoryUsedMb ?? 0)) / sys.memoryMb) : undefined;
  const diskPct = sys.diskTotalGb ? Math.round((100 * (sys.diskTotalGb - (sys.diskFreeGb ?? 0))) / sys.diskTotalGb) : undefined;
  const run = (cmd: string) => { if (!term.current?.run(cmd)) toast.error("Open the terminal first."); };

  if (!s.hostKey) return <div className="notice warn"><AlertTriangle size={15} /> <span>Confirm the server's fingerprint before opening a terminal. <Link href={`/servers/new?id=${s.id}&step=3`}>Finish setup</Link></span></div>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="grid g4">
        <Stat icon={<Cpu size={14} />} k="CPU" v={sys.cpuPct != null ? `${sys.cpuPct}%` : ""} s={[sys.cpus && `${sys.cpus} vCPU`, sys.load != null && `load ${sys.load}`].filter(Boolean).join(" · ")} pct={sys.cpuPct} />
        <Stat icon={<MemoryStick size={14} />} k="Memory" v={sys.memoryUsedMb != null ? `${(sys.memoryUsedMb / 1024).toFixed(1)} GB` : ""} s={sys.memoryMb ? `of ${Math.round(sys.memoryMb / 1024)} GB` : ""} pct={memPct} />
        <Stat icon={<HardDrive size={14} />} k="Disk" v={sys.diskFreeGb != null ? `${sys.diskFreeGb} GB free` : ""} s={sys.diskTotalGb ? `of ${sys.diskTotalGb} GB` : ""} pct={diskPct} />
        <Stat icon={<Timer size={14} />} k="Uptime" v={uptimeText(sys.uptimeSec)} s={sys.uptimeSec ? `since ${new Date(Date.now() - sys.uptimeSec * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short" })}` : ""} />
      </div>
      {sys.checkedAt && <div className="tiny faint" style={{ marginTop: -8 }}>Numbers from the last check, {timeAgo(sys.checkedAt)}. Run checks to refresh them.</div>}

      <div className="side-layout">
        <SshTerminal
          ref={term}
          serverId={s.id}
          title={`${s.username}@${s.name}`}
          askPassword={!!s.rules.askPassword}
          askPassphrase={!!s.key?.hasPassphrase && s.authMethod !== "password"}
          idleMinutes={s.rules.idleMinutes}
          onChange={(st) => { setOpen(st === "open"); if (st === "open" || st === "closed") { utils.servers.sessions.invalidate({ id: s.id }); utils.servers.get.invalidate({ id: s.id }); } }}
        />
        <div className="stack" style={{ gap: 16 }}>
          <section className="card">
            <div className="card-head"><h3>Quick commands</h3></div>
            {QUICK.filter((q) => !q.needsDocker || s.system?.docker).map((q) => (
              <div key={q.cmd} className="attn-row">
                <div className="grow" style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 550 }}>{q.name}</div>
                  <div className="tiny mono faint ellipsis">{q.cmd}</div>
                </div>
                <button className={cx("btn btn-sm", q.asks && "btn-ghost")} disabled={!open} onClick={() => (q.asks ? setAsking(q.cmd) : run(q.cmd))}>
                  {q.asks ? <span className="warn-text">Asks first</span> : "Run"}
                </button>
              </div>
            ))}
          </section>
          <section className="card">
            <div className="card-head"><h3>Recent sessions</h3></div>
            <Sessions id={s.id} limit={5} onReplay={setReplay} />
          </section>
        </div>
      </div>

      <Dialog open={!!asking} onClose={() => setAsking(null)} title="Run this command?" subtitle="It uses sudo, so it can change the server." footer={<><button className="btn" onClick={() => setAsking(null)}>Cancel</button><button className="btn btn-primary" onClick={() => { run(asking!); setAsking(null); }}>Run it</button></>}>
        <Code copy={false}>{asking ?? ""}</Code>
      </Dialog>
      {replay && <Replay sessionId={replay} onClose={() => setReplay(null)} />}
    </div>
  );
}

function OverviewTab({ s, result, testing, onTest }: { s: any; result: any; testing: boolean; onTest: () => void }) {
  const router = useRouter();
  const utils = trpc.useContext();
  const servers = trpc.servers.list.useQuery();
  const [f, setF] = useState({ name: s.name, host: s.host, port: s.port, username: s.username, timeoutSec: s.timeoutSec, jumpServerId: s.jumpServerId ?? "" });
  const [removing, setRemoving] = useState(false);
  const [typed, setTyped] = useState("");
  const update = trpc.servers.update.useMutation({ onSuccess: () => { toast.success("Saved"); utils.servers.get.invalidate({ id: s.id }); }, onError });
  const remove = trpc.servers.remove.useMutation({ onSuccess: () => { toast.success(`${s.name} removed`); router.push("/servers"); }, onError });
  const jumps = ((servers.data as any)?.servers ?? []).filter((x: any) => x.setupDone && x.id !== s.id);
  const changed = f.name !== s.name || f.host !== s.host || f.port !== s.port || f.username !== s.username || f.timeoutSec !== s.timeoutSec || (f.jumpServerId || null) !== (s.jumpServerId ?? null);
  return (
    <div className="side-layout">
      <div className="stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-head"><h3>Connection test</h3><span className="right"><button className="btn btn-sm" disabled={testing} onClick={onTest}>{testing ? <Spinner size={13} /> : <RefreshCw size={13} />} Run checks</button></span></div>
          <TestResults result={result} loading={testing} />
        </section>
        <section className="card">
          <div className="card-head"><h3>Connection</h3></div>
          <div className="card-body">
            <div className="grid g2" style={{ gap: 12 }}>
              <div><label className="label">Name</label><input className="input mono" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
              <div><label className="label">User</label><input className="input mono" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.trim() })} /></div>
              <div><label className="label">Host or IP address</label><input className="input mono" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value.trim() })} /></div>
              <div><label className="label">Port</label><input className="input mono" type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></div>
              <div>
                <label className="label">Jump server</label>
                <select className="input" value={f.jumpServerId} onChange={(e) => setF({ ...f, jumpServerId: e.target.value })}>
                  <option value="">None, connect directly</option>
                  {jumps.map((j: any) => <option key={j.id} value={j.id}>{j.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Timeout</label>
                <select className="input" value={f.timeoutSec} onChange={(e) => setF({ ...f, timeoutSec: Number(e.target.value) })}>{[5, 10, 20, 30, 60].map((x) => <option key={x} value={x}>{x} seconds</option>)}</select>
              </div>
            </div>
            <div className="hint">The trusted fingerprint stays. If the new address is another machine, Deploy King refuses to connect.</div>
            <div className="row" style={{ marginTop: 12 }}><button className="btn btn-primary" disabled={!changed || update.isLoading} onClick={() => update.mutate({ id: s.id, ...f, jumpServerId: f.jumpServerId || null })}>Save</button></div>
          </div>
        </section>
      </div>
      <div className="stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-head"><h3>Server identity</h3></div>
          <div className="card-body small stack" style={{ gap: 6 }}>
            {s.hostKey ? <><div className="mono" style={{ wordBreak: "break-all" }}>{s.hostKey.type} {s.hostKey.fingerprint}</div><div className="muted">Trusted {timeAgo(s.hostKey.trustedAt)}</div></> : <div className="warn-text">Not confirmed yet.</div>}
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Remove server</h3></div>
          <div className="card-body small stack" style={{ gap: 10 }}>
            <div className="muted">Ends open terminals and deletes this server's recordings. Its key stays on the SSH keys page; remove it from the server's authorized_keys yourself.</div>
            <div><button className="btn btn-danger btn-sm" onClick={() => setRemoving(true)}><Trash2 size={13} /> Remove {s.name}</button></div>
          </div>
        </section>
      </div>
      <Dialog open={removing} onClose={() => setRemoving(false)} title={`Remove ${s.name}?`} subtitle="Type the server's name to confirm." footer={<><button className="btn" onClick={() => setRemoving(false)}>Cancel</button><button className="btn btn-danger" disabled={typed !== s.name || remove.isLoading} onClick={() => remove.mutate({ id: s.id })}>Remove</button></>}>
        <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={s.name} autoFocus />
      </Dialog>
    </div>
  );
}

function KeysTab({ s }: { s: any }) {
  const utils = trpc.useContext();
  const rotate = trpc.servers.rotateKey.useMutation({
    onSuccess: (r: any) => { (r.ok ? toast.success : toast.error)(r.message); utils.servers.get.invalidate({ id: s.id }); },
    onError,
  });
  if (s.authMethod === "password") return <div className="notice warn"><AlertTriangle size={15} /> <span>This server signs in with a stored password. Less safe: switch to a key with <Link href={`/servers/new?id=${s.id}&step=2`}>Add server, step 2</Link>.</span></div>;
  const k = s.key;
  if (!k) return <Empty icon={<KeyRound size={20} />} title="No key yet" action={<Link className="btn btn-primary" href={`/servers/new?id=${s.id}&step=2`}>Create a key</Link>} />;
  const age = keyAgeNote(k);
  return (
    <div className="side-layout">
      <section className="card">
        <div className="card-head"><KeyRound size={15} /><h3 className="mono">{k.label}</h3><span className="right"><Link href="/servers/keys" className="btn btn-sm">All SSH keys</Link></span></div>
        <div className="card-body stack" style={{ gap: 12 }}>
          <dl className="kv">
            <dt>Type</dt><dd>{TYPE_LABEL[k.type] ?? k.type}</dd>
            <dt>Fingerprint</dt><dd className="mono small">{k.fingerprint}</dd>
            <dt>Limits</dt><dd className="small">{[k.fromAddress ? `Only from ${k.fromAddress}` : "From anywhere", k.restrict ? "no forwarding" : "forwarding allowed", k.hasPassphrase && "has a passphrase"].filter(Boolean).join(" · ")}</dd>
            <dt>Age</dt><dd className={cx("small", age.warn && "warn-text")}>{k.ageDays === 0 ? "Created today" : `${k.ageDays} days`} · {age.note}</dd>
            <dt>Last used</dt><dd className="small">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : "Never"}</dd>
          </dl>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="label" style={{ margin: 0 }}>Public key</span><CopyButton text={k.publicKey} /></div>
          <pre className="code mono small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{k.publicKey}</pre>
        </div>
      </section>
      <section className="card">
        <div className="card-head"><h3>Rotate this key</h3></div>
        <div className="card-body small stack" style={{ gap: 10 }}>
          <ol className="stack" style={{ gap: 6, paddingLeft: 18 }}>
            <li>Deploy King creates a new key pair.</li>
            <li>It signs in with the old key and adds the new public key.</li>
            <li>It tests the new key, then removes the old one from the server.</li>
            <li>If the test fails, the old key stays and nothing changes.</li>
          </ol>
          <div><button className="btn btn-primary btn-sm" disabled={rotate.isLoading || s.status === "waiting_key" || k.hasPassphrase} onClick={() => rotate.mutate({ id: k.id })}>{rotate.isLoading ? <Spinner size={13} /> : <RefreshCw size={13} />} Rotate</button></div>
          {k.hasPassphrase && <div className="faint">A key with a passphrase cannot be rotated from here.</div>}
        </div>
      </section>
    </div>
  );
}

function AccessTab({ s }: { s: any }) {
  const utils = trpc.useContext();
  const [rules, setRules] = useState<Rules>(s.rules);
  const save = trpc.servers.setRules.useMutation({ onSuccess: () => { toast.success("Access rules saved. They apply to the next terminal."); utils.servers.get.invalidate({ id: s.id }); }, onError });
  const changed = JSON.stringify(rules) !== JSON.stringify(s.rules);
  return (
    <section className="card" style={{ maxWidth: 760 }}>
      <div className="card-head"><h3>Access rules for this server</h3></div>
      <div className="card-body">
        <RulesEditor value={rules} onChange={setRules} />
        <div className="row" style={{ marginTop: 12 }}><button className="btn btn-primary" disabled={!changed || save.isLoading} onClick={() => save.mutate({ id: s.id, rules })}>Save</button></div>
      </div>
    </section>
  );
}

function ActivityTab({ s }: { s: any }) {
  const [replay, setReplay] = useState<string | null>(null);
  const act = trpc.servers.activity.useQuery({ id: s.id, limit: 100 });
  const list = (act.data as any[]) ?? [];
  return (
    <div className="side-layout">
      <section className="card">
        <div className="card-head"><h3>Activity</h3><span className="right small faint">Every action on this server, newest first</span></div>
        {act.isLoading ? <div className="card-body"><Skeleton h={120} /></div> : list.length === 0 ? <div className="card-body small muted">Nothing yet.</div> : list.map((a) => (
          <div key={a.id} className="attn-row">
            <div className="grow" style={{ minWidth: 0 }}>
              <div><span className="strong">{a.actor ?? "Deploy King"}</span> {a.metadata?.replay ? "replayed a session" : ACTION_TEXT[a.action] ?? a.action}{a.action === "ssh_test" && a.metadata && <span className={cx("small", a.metadata.ok ? "ok-text" : "bad-text")}> · {a.metadata.ok ? "passed" : "failed"}</span>}</div>
              <div className="small muted">{new Date(a.createdAt).toLocaleString()}{a.ip ? ` · from ${a.ip}` : ""}{a.metadata?.reason ? ` · ${a.metadata.reason}` : ""}{a.metadata?.commands != null ? ` · ${a.metadata.commands} commands` : ""}</div>
            </div>
          </div>
        ))}
      </section>
      <section className="card">
        <div className="card-head"><h3>Terminal sessions</h3><span className="right small faint">Recordings are kept 30 days</span></div>
        <Sessions id={s.id} limit={50} onReplay={setReplay} />
      </section>
      {replay && <Replay sessionId={replay} onClose={() => setReplay(null)} />}
    </div>
  );
}

function HostKeyChanged({ s }: { s: any }) {
  const utils = trpc.useContext();
  const [shown, setShown] = useState<any>(null);
  const probe = trpc.servers.probe.useMutation({ onError });
  const trust = trpc.servers.trust.useMutation({ onSuccess: () => { toast.success("New fingerprint trusted"); utils.servers.get.invalidate({ id: s.id }); }, onError });
  const look = () => probe.mutate({ id: s.id, fresh: true }, { onSuccess: (r: any) => setShown(r) });
  return (
    <div className="notice bad" style={{ marginBottom: 16 }}>
      <AlertTriangle size={16} />
      <div className="grow stack" style={{ gap: 8 }}>
        <div><b>Deploy King refused to connect.</b> {s.statusNote}</div>
        <div className="small">This happens when the server was reinstalled, or when something else answers at its address. Do not trust the new fingerprint unless you know why it changed: check it on the server with <code className="inline-code">ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>.</div>
        {!shown ? <div><button className="btn btn-sm" disabled={probe.isLoading} onClick={look}>Review</button></div> : (
          <div className="row" style={{ gap: 8 }}>
            <span className="small">The server shows now: <span className="mono">{shown.type} {shown.fingerprint}</span></span>
            {!shown.trusted && <button className="btn btn-sm btn-danger" disabled={trust.isLoading} onClick={() => trust.mutate({ id: s.id, fingerprint: shown.fingerprint, replace: true })}>I know why it changed. Trust the new fingerprint</button>}
          </div>
        )}
      </div>
    </div>
  );
}

function ServerInner() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const utils = trpc.useContext();
  const q = trpc.servers.get.useQuery({ id }, { retry: false, refetchInterval: 30_000 });
  const s = q.data as any;
  useCrumbs([{ label: "Servers", href: "/servers" }, { label: s?.name ?? "Server" }]);
  const tab = ((params.get("tab") as Tab) || "terminal") as Tab;
  const go = (t: Tab) => router.replace(t === "terminal" ? `/servers/${id}` : `/servers/${id}?tab=${t}`, { scroll: false });
  const [result, setResult] = useState<any>(null);
  const test = trpc.servers.test.useMutation({
    onSuccess: (r: any) => { setResult(r); utils.servers.get.invalidate({ id }); (r.ok ? toast.success : toast.error)(r.ok ? "Checks passed" : r.checks.find((c: any) => c.state === "bad")?.detail ?? "Checks failed"); },
    onError,
  });
  const disconnect = trpc.servers.disconnect.useMutation({ onSuccess: (r: any) => { toast.success(r.closed ? `${r.closed} session${r.closed === 1 ? "" : "s"} ended` : "No session was open"); utils.servers.get.invalidate({ id }); }, onError });
  useEffect(() => { if (tab === "overview" && !result && s?.hostKey && !test.isLoading && !s.key?.hasPassphrase) test.mutate({ id }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [tab, s?.id]);

  if (q.error) return <div className="page"><Empty icon={<Server size={20} />} title={(q.error as any).data?.code === "FORBIDDEN" ? "Servers are managed by admins" : "Server not found"}><Link href="/servers">Back to Servers</Link></Empty></div>;
  if (!s) return <div className="page"><Skeleton h={40} w={320} /><Skeleton h={300} style={{ marginTop: 20 }} /></div>;
  const si = signIn(s);

  return (
    <div className="page" style={{ maxWidth: 1280 }}>
      <div className="ph">
        <div className="grow row" style={{ gap: 14, minWidth: 260 }}>
          <Tile name={s.name} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 10 }}><h1 className="mono">{s.name}</h1><ServerStatus status={s.status} /></div>
            <p className="mono small" style={{ marginTop: 4 }}>{[`${s.username}@${s.host}:${s.port}`, s.system?.os, si.text].filter(Boolean).join(" · ")}</p>
          </div>
        </div>
        <div className="actions">
          <button className="btn" disabled={test.isLoading || !s.hostKey} onClick={() => test.mutate({ id })}>{test.isLoading ? <Spinner /> : <RefreshCw size={15} />} Run checks</button>
          <button className="btn" disabled={!s.live?.length || disconnect.isLoading} onClick={() => disconnect.mutate({ id })}><Power size={15} /> Disconnect</button>
        </div>
      </div>

      {s.status === "host_key_changed" && <HostKeyChanged s={s} />}
      {!s.setupDone && s.status !== "host_key_changed" && <div className="notice warn small" style={{ marginBottom: 16 }}><AlertTriangle size={15} /> <span>Setup not finished. <Link href={`/servers/new?id=${s.id}&step=${s.status === "waiting_key" ? 2 : 3}`}>Finish setup</Link></span></div>}

      <div className="tabs">
        {([["terminal", "Terminal"], ["overview", "Overview"], ["keys", "Keys"], ["access", "Access"], ["activity", "Activity"]] as const).map(([k, l]) => (
          <button key={k} className={cx("tab", tab === k && "on")} onClick={() => go(k)}>{l}</button>
        ))}
      </div>
      {tab === "terminal" && <TerminalTab s={s} />}
      {tab === "overview" && <OverviewTab s={s} result={result} testing={test.isLoading} onTest={() => test.mutate({ id })} />}
      {tab === "keys" && <KeysTab s={s} />}
      {tab === "access" && <AccessTab key={JSON.stringify(s.rules)} s={s} />}
      {tab === "activity" && <ActivityTab s={s} />}
    </div>
  );
}

export default function ServerPage() {
  return <Suspense><ServerInner /></Suspense>;
}
