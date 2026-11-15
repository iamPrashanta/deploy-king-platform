"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, ExternalLink, GitBranch, GitCommit, History, Pause, Play, RotateCcw, Rocket, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Dialog, Empty, Skeleton, Spinner, StatusBadge, Tile, cx, duration, errMsg, isLiveStatus, timeAgo } from "@/components/ui";
import { appUrl, sourceLabel, RUNTIME } from "@/components/apps";
import { EnvEditor, type EnvRow } from "@/components/EnvEditor";

type Tab = "deployments" | "logs" | "variables" | "settings";

// ── Build log ────────────────────────────────────────────────────────────────
function LogView({ text, follow }: { text: string; follow: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [text, follow]);
  const lines = useMemo(() => (text || "").split("\n").slice(-4000), [text]);
  return (
    <pre className="log" ref={ref} style={{ maxHeight: 560 }}>
      {lines.map((l, i) => {
        const m = l.match(/^\[(\d{4}-\d\d-\d\dT[\d:.]+Z)\] (.*)$/);
        const msg = m ? m[2] : l;
        const cls = /failed|error|ERR!|exited/i.test(msg) ? "err" : /Health check passed|Deployment live|Answer:/.test(msg) ? "okl" : m ? "step" : undefined;
        return (
          <div key={i}>
            {m && <span className="ts">{new Date(m[1]).toLocaleTimeString()} </span>}
            <span className={cls}>{msg}</span>
          </div>
        );
      })}
    </pre>
  );
}

// ── Mid-deploy question ──────────────────────────────────────────────────────
function PromptCard({ deployment, onAnswered }: { deployment: any; onAnswered: () => void }) {
  const p = deployment.prompt;
  const [choice, setChoice] = useState<string>(p?.default ?? "");
  const answer = trpc.sites.answer.useMutation({ onSuccess: onAnswered, onError: (e) => toast.error(errMsg(e)) });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (!p) return null;
  const left = Math.max(0, new Date(p.expiresAt).getTime() - now);
  const send = (value: string) => answer.mutate({ deploymentId: deployment.id, promptId: p.id, value });
  return (
    <div className="prompt-card">
      <div className="row top">
        <AlertTriangle size={18} className="warn-text" style={{ marginTop: 2 }} />
        <div className="grow">
          <div className="row">
            <span className="strong" style={{ fontSize: 15 }}>{p.title}</span>
            <span className="right faint small">Waiting {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}</span>
          </div>
          {p.detail && <div className="muted" style={{ marginTop: 2 }}>{p.detail}</div>}
          {p.kind === "confirm" ? (
            <div className="row wrap" style={{ marginTop: 12 }}>
              {(p.options ?? [{ value: "yes", label: "Yes" }, { value: "no", label: "No" }]).map((o: any) => (
                <button key={o.value} className={cx("btn", o.value === p.default && "btn-primary")} disabled={answer.isLoading} onClick={() => send(o.value)}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : (
            <div className="row wrap" style={{ marginTop: 12 }}>
              <select className="select" style={{ maxWidth: 320 }} value={choice} onChange={(e) => setChoice(e.target.value)}>
                {(p.options ?? []).map((o: any) => (
                  <option key={o.value} value={o.value}>{o.label}{o.detail ? ` (${o.detail})` : ""}</option>
                ))}
              </select>
              <button className="btn btn-primary" disabled={answer.isLoading || !choice} onClick={() => send(choice)}>
                {answer.isLoading ? <Spinner /> : "Continue"}
              </button>
            </div>
          )}
          <div className="faint small" style={{ marginTop: 10 }}>The current release keeps serving while the deploy waits. With no answer, the deploy stops.</div>
        </div>
      </div>
    </div>
  );
}

function Deployments({ site, selectedId, onSelect }: { site: any; selectedId: string | null; onSelect: (id: string) => void }) {
  const utils = trpc.useContext();
  const list = trpc.sites.deployments.useQuery(
    { id: site.id, limit: 30 },
    { refetchInterval: (data: any) => (data?.some((d: any) => isLiveStatus(d.status)) ? 1500 : 10_000) }
  );
  const current = selectedId ?? list.data?.[0]?.id ?? null;
  const dep = trpc.sites.deployment.useQuery(
    { deploymentId: current! },
    { enabled: !!current, refetchInterval: (data: any) => (data && isLiveStatus(data.status) ? 1200 : false) }
  );
  const rollback = trpc.sites.rollback.useMutation({
    onSuccess: (r: any) => {
      toast.success("Rolling back: re-running the earlier image");
      utils.sites.deployments.invalidate({ id: site.id });
      onSelect(r.deploymentId);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const activeId = list.data?.find((d: any) => d.status === "active")?.id;

  if (list.isLoading) return <div className="stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={52} />)}</div>;
  if (!list.data?.length)
    return (
      <div className="card">
        <Empty icon={<Rocket size={18} />} title="No deployments yet">
          {site.source === "zip" ? "Upload a ZIP to start the first deploy." : "Press Redeploy to start the first one."}
        </Empty>
      </div>
    );

  const d = dep.data as any;
  return (
    <div className="grid" style={{ gridTemplateColumns: "minmax(0, 330px) minmax(0, 1fr)", gap: 16, alignItems: "start" }}>
      <div className="card" style={{ overflow: "hidden" }}>
        <div className="list" style={{ maxHeight: 640, overflowY: "auto" }}>
          {list.data.map((x: any) => (
            <button key={x.id} onClick={() => onSelect(x.id)} style={{ display: "block", width: "100%", textAlign: "left", padding: "11px 14px", background: x.id === current ? "var(--active)" : undefined }}>
              <div className="row">
                <StatusBadge status={x.status} />
                {x.id === activeId && <span className="badge square ok tiny" style={{ height: 18 }}>Live</span>}
                <span className="right faint small">{timeAgo(x.createdAt)}</span>
              </div>
              <div className="small ellipsis" style={{ marginTop: 6 }}>
                {x.commitSha && <span className="mono faint" style={{ marginRight: 6 }}>{x.commitSha.slice(0, 7)}</span>}
                {x.commitMessage || (x.trigger === "rollback" ? "Rollback" : "Deploy")}
              </div>
              <div className="faint tiny" style={{ marginTop: 2 }}>{x.trigger}{x.durationMs ? ` · ${duration(x.durationMs)}` : ""}{x.runtime ? ` · ${RUNTIME[x.runtime] ?? x.runtime}` : ""}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="stack" style={{ gap: 14, minWidth: 0 }}>
        {!d ? (
          <Skeleton h={300} />
        ) : (
          <>
            <div className="card card-pad">
              <div className="row wrap">
                <StatusBadge status={d.status} />
                <span className="strong ellipsis" style={{ maxWidth: 420 }}>{d.commitMessage || "Deployment"}</span>
                <span className="right row" style={{ gap: 6 }}>
                  {d.imageTag && d.status !== "active" && ["superseded", "active"].includes(d.status) && (
                    <button className="btn btn-sm" disabled={rollback.isLoading} onClick={() => rollback.mutate({ id: site.id, deploymentId: d.id })}>
                      <RotateCcw size={13} /> Roll back to this
                    </button>
                  )}
                </span>
              </div>
              <div className="faint small row wrap" style={{ gap: 14, marginTop: 8 }}>
                {d.commitSha && <span className="row" style={{ gap: 5 }}><GitCommit size={13} /><span className="mono">{d.commitSha.slice(0, 7)}</span></span>}
                <span>Started {timeAgo(d.startedAt || d.createdAt)}</span>
                {d.durationMs && <span>Took {duration(d.durationMs)}</span>}
                {d.port && <span>Port {d.port}</span>}
                <span>Trigger: {d.trigger}</span>
              </div>
            </div>
            {d.status === "waiting_input" && d.prompt && <PromptCard deployment={d} onAnswered={() => dep.refetch()} />}
            {d.status === "failed" && d.error && (
              <div className="notice bad">
                <AlertTriangle size={16} className="bad-text" />
                <div style={{ minWidth: 0 }}>
                  <div className="strong">Deploy failed</div>
                  <div className="small mono" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{String(d.error).split("\n--- last output ---")[0]}</div>
                </div>
              </div>
            )}
            <div>
              <div className="row" style={{ marginBottom: 8 }}>
                <h3>Build log</h3>
                {isLiveStatus(d.status) && <span className="badge info"><span className="dot info pulse" />Live</span>}
              </div>
              <LogView text={d.log || (isLiveStatus(d.status) ? "Waiting for the worker…" : "No log.")} follow={isLiveStatus(d.status)} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function RuntimeLogs({ site }: { site: any }) {
  const [live, setLive] = useState(true);
  const logs = trpc.sites.logs.useQuery({ id: site.id, tail: 400 }, { refetchInterval: live ? 3000 : false });
  const text = (logs.data?.lines ?? []).map((l: any) => (l.ts ? `[${l.ts.replace(/\.\d+Z$/, ".000Z")}] ` : "") + l.text).join("\n");
  return (
    <div className="stack" style={{ gap: 10 }}>
      <div className="row">
        <span className="muted small">{logs.data?.container ? <>Container <span className="mono">{logs.data.container}</span> · {logs.data.running ? "running" : "stopped"}</> : "No container yet"}</span>
        <button className="btn btn-sm right" onClick={() => setLive((l) => !l)}>
          {live ? <Pause size={13} /> : <Play size={13} />} {live ? "Pause" : "Follow"}
        </button>
      </div>
      {logs.isLoading ? <Skeleton h={300} /> : <LogView text={text || "The app has not written anything yet."} follow={live} />}
    </div>
  );
}

function Variables({ site }: { site: any }) {
  const utils = trpc.useContext();
  const list = trpc.sites.envList.useQuery({ id: site.id });
  const [rows, setRows] = useState<EnvRow[]>([]);
  const setMany = trpc.sites.envSetMany.useMutation();
  const unset = trpc.sites.envUnset.useMutation();
  const redeploy = trpc.sites.redeploy.useMutation();
  const done = () => utils.sites.envList.invalidate({ id: site.id });

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 860 }}>
      <div className="notice info small">Values are encrypted on the server and never shown again. Changes apply on the next deploy.</div>
      <div className="card">
        <div className="card-head"><h3>Set variables</h3><span className="right faint small">{list.data?.length ?? 0} stored</span></div>
        {list.data && list.data.length > 0 && (
          <div className="list">
            {list.data.map((v: any) => (
              <div key={v.key} className="row" style={{ padding: "10px 18px" }}>
                <span className="mono small strong grow ellipsis">{v.key}</span>
                <span className="mono faint small">••••••••</span>
                <span className="faint small" style={{ width: 90, textAlign: "right" }}>{timeAgo(v.updatedAt)}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setRows((r) => [...r.filter((x) => x.key !== v.key), { key: v.key, value: "" }])}>Change</button>
                <button className="icon-btn" aria-label={`Remove ${v.key}`} onClick={() => unset.mutate({ id: site.id, key: v.key }, { onSuccess: done })}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="card-body" style={{ borderTop: list.data?.length ? "1px solid var(--border)" : undefined }}>
          <EnvEditor rows={rows} onChange={setRows} />
          {rows.length > 0 && (
            <div className="row" style={{ marginTop: 14 }}>
              <button
                className="btn btn-primary"
                disabled={setMany.isLoading || rows.some((r) => !r.key)}
                onClick={() =>
                  setMany.mutate(
                    { id: site.id, vars: rows.map((r) => ({ key: r.key, value: r.value })) },
                    {
                      onSuccess: () => {
                        setRows([]);
                        done();
                        toast.success("Saved. Redeploy to apply.", { action: { label: "Redeploy", onClick: () => redeploy.mutate({ id: site.id }) } });
                      },
                      onError: (e) => toast.error(errMsg(e)),
                    }
                  )
                }
              >
                <Save size={14} /> Save {rows.length} variable{rows.length === 1 ? "" : "s"}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Settings({ site }: { site: any }) {
  const utils = trpc.useContext();
  const router = useRouter();
  const [form, setForm] = useState({
    domain: site.domain,
    branch: site.branch ?? "main",
    image: site.image ?? "",
    port: site.port ? String(site.port) : "",
    buildCommand: site.buildCommand ?? "",
    startCommand: site.startCommand ?? "",
    autoDeploy: site.autoDeploy !== false,
    memoryLimit: String(site.memoryLimit ?? 512),
    cpuLimit: String(site.cpuLimit ?? 1),
  });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [typed, setTyped] = useState("");
  const update = trpc.sites.update.useMutation();
  const del = trpc.sites.delete.useMutation();
  const set = (k: keyof typeof form) => (e: any) => setForm((f) => ({ ...f, [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value }));

  const save = () =>
    update.mutate(
      {
        id: site.id,
        domain: form.domain !== site.domain ? form.domain : undefined,
        ...(site.source === "git" ? { branch: form.branch, buildCommand: form.buildCommand || null, startCommand: form.startCommand || null, autoDeploy: form.autoDeploy } : {}),
        ...(site.source === "image" ? { image: form.image } : {}),
        port: form.port ? Number(form.port) : null,
        memoryLimit: Number(form.memoryLimit) || 512,
        cpuLimit: Number(form.cpuLimit) || 1,
      } as any,
      {
        onSuccess: () => {
          utils.sites.get.invalidate({ id: site.id });
          toast.success("Saved. Redeploy to apply build and runtime changes.");
        },
        onError: (e) => toast.error(errMsg(e)),
      }
    );

  return (
    <div className="stack" style={{ gap: 16, maxWidth: 860 }}>
      <div className="card">
        <div className="card-head"><h3>General</h3></div>
        <div className="card-body grid g2">
          <div className="field"><label className="label">Domain</label><input className="input" value={form.domain} onChange={set("domain")} /></div>
          <div className="field"><label className="label">Port</label><input className="input" inputMode="numeric" value={form.port} onChange={set("port")} placeholder="Detected" /></div>
          {site.source === "git" && (
            <>
              <div className="field"><label className="label">Branch</label><input className="input mono" value={form.branch} onChange={set("branch")} /></div>
              <div className="field"><label className="label">Build command</label><input className="input mono" value={form.buildCommand} onChange={set("buildCommand")} placeholder="Detected" /></div>
              <div className="field"><label className="label">Start command</label><input className="input mono" value={form.startCommand} onChange={set("startCommand")} placeholder="Detected" /></div>
            </>
          )}
          {site.source === "image" && <div className="field"><label className="label">Image</label><input className="input mono" value={form.image} onChange={set("image")} /></div>}
          <div className="field"><label className="label">Memory limit (MB)</label><input className="input" inputMode="numeric" value={form.memoryLimit} onChange={set("memoryLimit")} /></div>
          <div className="field"><label className="label">CPU cores</label><input className="input" inputMode="numeric" value={form.cpuLimit} onChange={set("cpuLimit")} /></div>
        </div>
        <div className="card-body" style={{ borderTop: "1px solid var(--border)" }}>
          {site.source === "git" && (
            <label className="check small" style={{ marginBottom: 14 }}>
              <input type="checkbox" checked={form.autoDeploy} onChange={set("autoDeploy")} />
              <span>Redeploy automatically on every push to <span className="mono">{form.branch}</span></span>
            </label>
          )}
          <button className="btn btn-primary" onClick={save} disabled={update.isLoading}>{update.isLoading ? <Spinner /> : <><Save size={14} /> Save</>}</button>
        </div>
      </div>

      {Array.isArray(site.volumes) && site.volumes.length > 0 && (
        <div className="card">
          <div className="card-head"><h3>Volumes</h3><span className="right faint small">Kept across deploys, removed with the app</span></div>
          <div className="list">
            {site.volumes.map((v: any) => (
              <div key={v.name} className="row small" style={{ padding: "10px 18px" }}>
                <span className="mono strong">{v.name}</span><span className="faint">→</span><span className="mono muted">{v.mountPath}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="card" style={{ borderColor: "color-mix(in srgb, var(--red) 35%, var(--border))" }}>
        <div className="card-head"><h3 className="bad-text">Delete application</h3></div>
        <div className="card-body row wrap">
          <span className="muted grow">Stops the container and removes its images, volumes and deployment history. This cannot be undone.</span>
          <button className="btn btn-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Delete</button>
        </div>
      </div>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${site.domain}?`}
        subtitle="The container, images, volumes and history are removed for good."
        footer={
          <>
            <button className="btn" onClick={() => setConfirmDelete(false)}>Cancel</button>
            <button
              className="btn btn-danger"
              disabled={typed !== site.domain || del.isLoading}
              onClick={() =>
                del.mutate({ id: site.id }, {
                  onSuccess: () => {
                    toast.success(`${site.domain} is being deleted`);
                    utils.sites.list.invalidate();
                    router.push("/apps");
                  },
                  onError: (e) => toast.error(errMsg(e)),
                })
              }
            >
              Delete for good
            </button>
          </>
        }
      >
        <label className="label">Type <span className="mono">{site.domain}</span> to confirm</label>
        <input className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </Dialog>
    </div>
  );
}

const mb = (m: number) => (m >= 1024 ? `${m / 1024} GB` : `${m} MB`);

/** Shown when the running container keeps restarting, with a one-click fix for out-of-memory crashes. */
function CrashBanner({ site, onRestarted, onLogs }: { site: any; onRestarted: (deploymentId: string) => void; onLogs: () => void }) {
  const live = isLiveStatus(site.status);
  const rt = trpc.sites.runtime.useQuery({ id: site.id }, { enabled: !live && !!site.pm2Name, refetchInterval: 10_000 });
  const update = trpc.sites.update.useMutation();
  const redeploy = trpc.sites.redeploy.useMutation();
  const [choice, setChoice] = useState<number | null>(null);
  const r: any = rt.data;
  if (live || !r || r.missing || (r.restarts === 0 && r.running)) return null;
  const choices = [1024, 2048, 4096, 8192].filter((m) => m > r.memoryLimitMb);
  const pick = choice ?? choices[0];
  const busy = update.isLoading || redeploy.isLoading;
  const restart = async () => {
    try {
      if (r.outOfMemory && pick) await update.mutateAsync({ id: site.id, memoryLimit: pick } as any);
      const res: any = await redeploy.mutateAsync({ id: site.id, restartOnly: true } as any);
      toast.success(r.outOfMemory ? `Restarting with ${mb(pick)}` : "Restarting");
      onRestarted(res.deploymentId);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };
  return (
    <div className="notice bad" style={{ marginBottom: 18, alignItems: "flex-start" }}>
      <AlertTriangle size={17} className="bad-text" style={{ marginTop: 2 }} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="strong">
          {r.running ? "This app keeps crashing" : "This app has stopped"}
          <span className="muted" style={{ fontWeight: 400 }}>
            {r.restarts ? ` · restarted ${r.restarts} time${r.restarts === 1 ? "" : "s"}` : ""}
            {r.outOfMemory ? ` · out of memory with the ${mb(r.memoryLimitMb)} limit` : r.exitCode ? ` · last exit code ${r.exitCode}` : ""}
          </span>
        </div>
        <div className="muted small" style={{ marginTop: 2 }}>
          {r.outOfMemory
            ? "It needs more memory than it has. Give it more and restart it; the image is reused, nothing is rebuilt."
            : "The release passed its health check but stops afterwards. The last lines it printed usually say why."}
        </div>
        {r.lastOutput && (
          <details style={{ marginTop: 8 }}>
            <summary className="small link" style={{ cursor: "pointer" }}>Last output</summary>
            <pre className="log" style={{ minHeight: 0, maxHeight: 220, marginTop: 6 }}>{r.lastOutput}</pre>
          </details>
        )}
        <div className="row wrap" style={{ marginTop: 10 }}>
          {r.outOfMemory && choices.length > 0 && (
            <select className="select" style={{ width: 150, height: 32 }} value={pick} onChange={(e) => setChoice(Number(e.target.value))}>
              {choices.map((m) => <option key={m} value={m}>{mb(m)}</option>)}
            </select>
          )}
          <button className="btn btn-primary btn-sm" style={{ height: 32 }} disabled={busy} onClick={restart}>
            {busy ? <Spinner size={14} /> : <RotateCcw size={13} />} {r.outOfMemory && pick ? `Restart with ${mb(pick)}` : "Restart"}
          </button>
          <button className="btn btn-sm" style={{ height: 32 }} onClick={onLogs}>View logs</button>
        </div>
      </div>
    </div>
  );
}

function AppDetail() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const utils = trpc.useContext();
  const [tab, setTab] = useState<Tab>((params.get("tab") as Tab) || "deployments");
  const [selected, setSelected] = useState<string | null>(params.get("deployment"));
  const site = trpc.sites.get.useQuery({ id }, { refetchInterval: (d: any) => (d && isLiveStatus(d.status) ? 2000 : 15_000) });
  const info = trpc.system.info.useQuery(undefined, { staleTime: 5 * 60_000 });
  const redeploy = trpc.sites.redeploy.useMutation({
    onSuccess: (r: any) => {
      toast.success("Deploy started");
      setTab("deployments");
      setSelected(r.deploymentId);
      utils.sites.deployments.invalidate({ id });
      utils.sites.get.invalidate({ id });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const s: any = site.data;
  useCrumbs([{ label: "Applications", href: "/apps" }, { label: s ? s.domain.split(".")[0] : "…" }]);

  useEffect(() => {
    const q = new URLSearchParams();
    if (tab !== "deployments") q.set("tab", tab);
    if (selected && tab === "deployments") q.set("deployment", selected);
    router.replace(`/apps/${id}${q.toString() ? `?${q}` : ""}`, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selected]);

  if (site.error) return <div className="page"><div className="notice bad">{site.error.message}</div></div>;
  if (!s) return <div className="page stack"><Skeleton h={60} /><Skeleton h={400} /></div>;
  const src = sourceLabel(s);
  const url = appUrl(s.domain, info.data);

  return (
    <div className="page wide" style={{ maxWidth: 1360 }}>
      <div className="ph">
        <div className="row grow" style={{ gap: 14, minWidth: 260 }}>
          <Tile name={s.domain} size={44} />
          <div style={{ minWidth: 0 }}>
            <div className="row" style={{ gap: 10 }}>
              <h1 className="ellipsis">{s.domain.split(".")[0]}</h1>
              <StatusBadge status={s.status} />
            </div>
            <div className="row wrap muted small" style={{ gap: 14, marginTop: 4 }}>
              <a className="link row" style={{ gap: 5 }} href={url} target="_blank" rel="noreferrer">{s.domain}<ExternalLink size={12} /></a>
              <span className="row" style={{ gap: 5 }}>{src.icon}{src.text}</span>
              <span>{RUNTIME[s.type] ?? s.type}{s.port ? ` · port ${s.port}` : ""}</span>
            </div>
          </div>
        </div>
        <div className="actions">
          {s.status === "active" && <a className="btn" href={url} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open</a>}
          {s.source !== "zip" && (
            <button className="btn btn-primary" disabled={redeploy.isLoading} onClick={() => redeploy.mutate({ id })}>
              {redeploy.isLoading ? <Spinner /> : <Rocket size={14} />} Redeploy
            </button>
          )}
        </div>
      </div>

      <CrashBanner
        site={s}
        onLogs={() => setTab("logs")}
        onRestarted={(dep) => {
          setTab("deployments");
          setSelected(dep);
          utils.sites.deployments.invalidate({ id });
          utils.sites.get.invalidate({ id });
          utils.sites.runtime.invalidate({ id });
        }}
      />

      <div className="tabs">
        {([
          ["deployments", "Deployments", <History key="h" size={14} />],
          ["logs", "Logs", null],
          ["variables", "Variables", null],
          ["settings", "Settings", null],
        ] as const).map(([k, l, ic]) => (
          <button key={k} className={cx("tab", tab === k && "on")} onClick={() => setTab(k)}>{ic}{l}</button>
        ))}
        {s.source === "git" && (
          <span className="right faint small row" style={{ gap: 6, paddingRight: 4 }}>
            <GitBranch size={13} /> {s.autoDeploy !== false ? "Deploys on push" : "Manual deploys"}
          </span>
        )}
      </div>

      {tab === "deployments" && <Deployments site={s} selectedId={selected} onSelect={setSelected} />}
      {tab === "logs" && <RuntimeLogs site={s} />}
      {tab === "variables" && <Variables site={s} />}
      {tab === "settings" && <Settings key={s.updatedAt} site={s} />}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <AppDetail />
    </Suspense>
  );
}
