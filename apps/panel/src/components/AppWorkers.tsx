"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Cpu, Info, Minus, Pencil, Plus, RotateCcw, ScrollText, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { Dialog, Empty, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";
import { FitNotice, memText } from "@/components/FitCheck";
import { useCan } from "@/components/useCan";

/**
 * The "Workers" tab of an app: background processes from the same image, with the same variables, and no web
 * traffic (a queue worker, a mailer). They follow every deploy and are restarted when they stop.
 */

const MEMORY = [128, 256, 512, 1024, 2048, 4096];
const STATE: Record<string, { tone: string; label: string }> = {
  running: { tone: "ok", label: "Running" }, crashing: { tone: "bad", label: "Keeps crashing" }, starting: { tone: "info", label: "Starting" },
  stopped: { tone: "warn", label: "Stopped" }, off: { tone: "", label: "Switched off" }, waiting: { tone: "", label: "Starts with the first deploy" },
};

/** The same "will it fit?" state the deploy screens use, for a worker's memory. */
function useWorkerFit(siteId: string, copies: number, memoryLimit: number, workerId?: string, enabled = true) {
  const [override, setOverride] = useState(false);
  const q = trpc.workers.fit.useQuery({ siteId, copies, memoryLimit, workerId }, { enabled, keepPreviousData: true, refetchOnWindowFocus: false });
  const fit: any = enabled ? q.data : undefined;
  const isBlocked = fit?.verdict === "blocked";
  useEffect(() => { if (!isBlocked) setOverride(false); }, [isBlocked]);
  return { fit, override, setOverride, blocked: isBlocked && !override, allowOverCapacity: isBlocked && override ? true : undefined, refetch: q.refetch };
}

function WorkerEditor({ site, worker, release, onClose, canDelete }: { site: any; worker: any | null; release: string | null; onClose: () => void; canDelete: boolean }) {
  const utils = trpc.useContext();
  const [name, setName] = useState(worker?.name ?? "");
  const [command, setCommand] = useState(worker?.command ?? "");
  const [copies, setCopies] = useState<number>(worker?.copies ?? 1);
  const [memoryLimit, setMemory] = useState<number>(worker?.memoryLimit ?? 256);
  const [restart, setRestart] = useState<boolean>(worker?.restart ?? true);
  const [graceful, setGraceful] = useState<boolean>(worker?.gracefulStop ?? true);
  const [enabled, setEnabled] = useState<boolean>(worker?.enabled ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Only more memory than it holds now needs room.
  const holds = worker && worker.enabled ? worker.copies * worker.memoryLimit : 0;
  const fit = useWorkerFit(site.id, copies, memoryLimit, worker?.id, enabled && copies * memoryLimit > holds);
  const nameOk = /^[a-z][a-z0-9-]{0,29}$/.test(name);
  const done = (msg: string) => { toast.success(msg); utils.workers.list.invalidate({ siteId: site.id }); utils.system.overview.invalidate(); onClose(); };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const create = trpc.workers.create.useMutation({ onSuccess: () => done(release ? "Worker added. It starts in a few seconds." : "Worker added. It starts with the first deploy."), onError });
  const update = trpc.workers.update.useMutation({ onSuccess: () => done("Saved. The worker is replaced in a few seconds."), onError });
  const remove = trpc.workers.delete.useMutation({ onSuccess: (r: any) => done(r.jobsMoved ? `Worker removed. ${r.jobsMoved} scheduled job${r.jobsMoved === 1 ? " now runs" : "s now run"} in the web container.` : "Worker removed"), onError });
  const busy = create.isLoading || update.isLoading || remove.isLoading;
  const fields = { command: command.trim(), copies, memoryLimit, restart, gracefulStop: graceful, enabled, allowOverCapacity: fit.allowOverCapacity };
  const ready = nameOk && fields.command && !fit.blocked;

  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title={worker ? `Worker ${worker.name}` : "Add a worker"}
      subtitle={`${site.domain.split(".")[0]} · same image, no web traffic`}
      footer={
        <>
          {worker && canDelete && (confirmDelete
            ? <button className="btn btn-danger" disabled={busy} onClick={() => remove.mutate({ id: worker.id })}><Trash2 size={14} /> Yes, remove it</button>
            : <button className="btn btn-ghost btn-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Remove</button>)}
          <span className="grow" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => (worker ? update.mutate({ id: worker.id, ...fields }) : create.mutate({ siteId: site.id, name, ...fields }))}>
            {busy ? <Spinner /> : worker ? "Save" : "Add worker"}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        <div className="field" style={{ margin: 0 }}>
          <label className="label" htmlFor="w-name">Name</label>
          <input id="w-name" className="input mono" value={name} disabled={!!worker} onChange={(e) => setName(e.target.value.toLowerCase())} maxLength={30} placeholder="queue" autoFocus={!worker} aria-invalid={name.length > 0 && !nameOk} />
          <div className="hint">{worker ? "The name cannot change: scheduled jobs and logs refer to it." : "Lowercase letters, numbers and dashes, starting with a letter."}</div>
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="label" htmlFor="w-cmd">Command</label>
          <textarea id="w-cmd" className="input textarea mono" rows={2} style={{ minHeight: 60 }} value={command} onChange={(e) => setCommand(e.target.value)} maxLength={2000} placeholder="node dist/worker.js" />
          <div className="hint">For example <span className="mono">php artisan queue:work</span> · <span className="mono">celery -A app worker</span> · <span className="mono">bundle exec sidekiq</span>. It must keep running; a command that ends is started again.</div>
        </div>
        <div className="row wrap" style={{ gap: 16, alignItems: "flex-end" }}>
          <div>
            <span className="label">Copies</span>
            <div className="row" style={{ gap: 0 }}>
              <button type="button" className="btn" aria-label="One fewer" style={{ borderRadius: "7px 0 0 7px" }} disabled={copies <= 1} onClick={() => setCopies(copies - 1)}><Minus size={14} /></button>
              <input className="input mono" aria-label="Copies" style={{ width: 56, textAlign: "center", borderRadius: 0, marginLeft: -1, marginRight: -1 }} value={copies} readOnly />
              <button type="button" className="btn" aria-label="One more" style={{ borderRadius: "0 7px 7px 0" }} disabled={copies >= 8} onClick={() => setCopies(copies + 1)}><Plus size={14} /></button>
            </div>
          </div>
          <div className="grow" style={{ minWidth: 180 }}>
            <label className="label" htmlFor="w-mem">Memory per copy</label>
            <select id="w-mem" className="input select" value={memoryLimit} onChange={(e) => setMemory(Number(e.target.value))}>
              {Array.from(new Set([memoryLimit, ...MEMORY])).sort((a, b) => a - b).map((m) => <option key={m} value={m}>{memText(m)}</option>)}
            </select>
          </div>
        </div>
        {copies * memoryLimit > holds && enabled ? <FitNotice state={fit as any} action="Save" /> : (
          <div className="small muted">{copies} × {memText(memoryLimit)} = {memText(copies * memoryLimit)}{holds ? ". No more memory than it holds now, so nothing to check." : ""}</div>
        )}
        <div>
          <label className="rule-row" style={{ borderTop: 0 }}>
            <span className="grow"><span style={{ fontWeight: 550 }}>Restart it when it stops</span><span className="small muted" style={{ display: "block" }}>If it crashes, it is started again. A worker that keeps crashing shows in Needs attention.</span></span>
            <span className="switch"><input type="checkbox" checked={restart} onChange={(e) => setRestart(e.target.checked)} /><span /></span>
          </label>
          <label className="rule-row">
            <span className="grow"><span style={{ fontWeight: 550 }}>Stop it gently on deploy</span><span className="small muted" style={{ display: "block" }}>It gets 30 seconds to finish its current task before the new release replaces it.</span></span>
            <span className="switch"><input type="checkbox" checked={graceful} onChange={(e) => setGraceful(e.target.checked)} /><span /></span>
          </label>
          {worker && (
            <label className="rule-row">
              <span className="grow"><span style={{ fontWeight: 550 }}>Switched on</span><span className="small muted" style={{ display: "block" }}>Off stops all its copies and frees its memory, and keeps its settings.</span></span>
              <span className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span /></span>
            </label>
          )}
        </div>
        <div className="small faint row" style={{ gap: 6 }}><Info size={13} /> {release ? "Starts with the live release. Nothing is rebuilt." : "This app has not been deployed yet: the worker starts with the first deploy."}</div>
      </div>
    </Dialog>
  );
}

function WorkerLogs({ site, worker }: { site: any; worker: any }) {
  const copies: any[] = worker.copiesLive ?? [];
  const [pick, setPick] = useState<string | null>(copies[0]?.id ?? null);
  useEffect(() => { if (!copies.some((c) => c.id === pick)) setPick(copies[0]?.id ?? null); }, [copies, pick]);
  const q = trpc.workers.logs.useQuery({ siteId: site.id, container: pick ?? "0".repeat(12), tail: 300 }, { enabled: !!pick, refetchInterval: 4000 });
  const d: any = q.data;
  return (
    <section className="card">
      <div className="card-head">
        <h3>Logs · {worker.name}</h3>
        {copies.length > 1 && (
          <div className="seg right" role="radiogroup" aria-label="Copy">
            {copies.map((c, i) => <button key={c.id} type="button" role="radio" aria-checked={pick === c.id} className={cx(pick === c.id && "on")} onClick={() => setPick(c.id)}>#{i + 1}</button>)}
          </div>
        )}
      </div>
      {!pick ? <div className="card-body small muted">No container yet.</div> : (
        <pre className="log" style={{ maxHeight: 380, minHeight: 120, margin: 0, borderRadius: 0, border: 0, borderTop: "1px solid var(--border)" }}>
          {(d?.lines ?? []).length === 0 ? <span className="ts">No output yet.</span> : d.lines.map((l: any, i: number) => (
            <div key={i}>{l.ts && <span className="ts">{new Date(l.ts).toLocaleTimeString()} </span>}<span className={cx(l.stream === "stderr" && "err")}>{l.text}</span></div>
          ))}
        </pre>
      )}
    </section>
  );
}

export function WorkersTab({ site }: { site: any }) {
  const utils = trpc.useContext();
  const can = useCan();
  const mayEdit = can("site.deploy");
  const q = trpc.workers.list.useQuery({ siteId: site.id }, { refetchInterval: 8000 });
  const d: any = q.data;
  const workers: any[] = d?.workers ?? [];
  const [editing, setEditing] = useState<any | "new" | null>(null);
  const [logsOf, setLogsOf] = useState<string | null>(null);
  const restart = trpc.workers.restart.useMutation({ onSuccess: () => { toast.success("Restarting. New copies start in a few seconds."); utils.workers.list.invalidate({ siteId: site.id }); }, onError: (e) => toast.error(errMsg(e)) });
  const shown = workers.find((w) => w.id === logsOf) ?? workers.find((w) => w.status === "crashing") ?? workers[0];

  if (site.type === "static") return <Empty icon={<Cpu size={20} />} title="Static sites have no workers">A static site has no image to run a background process from.</Empty>;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 12, justifyContent: "space-between", alignItems: "flex-end" }}>
        <p className="muted small" style={{ margin: 0, maxWidth: 700 }}>Background processes that run from the same image as the app, with its variables, but no web traffic. They are replaced with every deploy and restarted if they stop.</p>
        {mayEdit && <button className="btn btn-primary" onClick={() => setEditing("new")}><Plus size={15} /> Add worker</button>}
      </div>
      <section className="card">
        {q.isLoading ? <div className="card-body"><Skeleton h={120} /></div> : workers.length === 0 ? (
          <Empty icon={<Cpu size={20} />} title="No workers yet">A queue worker, a mailer, a websocket server: anything that keeps running next to the app.</Empty>
        ) : workers.map((w) => {
          const st = STATE[w.status] ?? { tone: "", label: w.status };
          const live: any[] = w.copiesLive ?? [];
          const used = live.map((c) => c.memoryMb).filter((n) => n != null);
          const peak = used.length ? Math.max(...used) : null;
          const restarts = live.reduce((n, c) => n + (c.restarts ?? 0), 0);
          const oom = live.some((c) => c.outOfMemory);
          return (
            <div key={w.id} className="attn-row" style={{ flexWrap: "wrap", gap: "12px 20px", ...(w.status === "crashing" ? { background: "color-mix(in srgb, var(--red) 5%, transparent)" } : {}) }}>
              <span className="attn-ic"><Cpu size={15} /></span>
              <div style={{ flex: "1 1 240px", minWidth: 0 }}>
                <div className="row" style={{ gap: 8 }}><strong>{w.name}</strong>{w.copies > 1 && <span className="badge">{w.copies} copies</span>}</div>
                <div className="mono small muted ellipsis">{w.command}</div>
              </div>
              <div style={{ flex: "0 1 210px" }}>
                <div className={cx("row small", st.tone === "bad" && "bad-text")} style={{ gap: 6 }}><span className={cx("dot", st.tone)} />{st.label}</div>
                <div className="small faint">{w.status === "crashing" && oom ? `ran out of memory · ${restarts} restarts` : live[0]?.startedAt && w.status === "running" ? `up ${timeAgo(live[0].startedAt).replace(" ago", "")} · ${restarts} restarts` : ""}</div>
              </div>
              <div style={{ flex: "0 1 170px", minWidth: 150 }}>
                <div className="small">{peak != null ? `${memText(peak)}` : "–"} <span className="faint">of {memText(w.memoryLimit)}{w.copies > 1 ? " each" : ""}</span></div>
                <div className={cx("meter", peak != null && peak / w.memoryLimit >= 0.9 && "bad", peak != null && peak / w.memoryLimit >= 0.75 && peak / w.memoryLimit < 0.9 && "warn")} style={{ marginTop: 6 }}><i style={{ width: `${peak != null ? Math.min(100, Math.round((peak / w.memoryLimit) * 100)) : 0}%` }} /></div>
              </div>
              <span className="row" style={{ gap: 6 }}>
                {mayEdit && w.status === "crashing" && oom && <button className="btn btn-sm" onClick={() => setEditing(w)}>Raise memory</button>}
                <button className="btn btn-sm" onClick={() => setLogsOf(w.id)}><ScrollText size={13} /> Logs</button>
                {mayEdit && w.enabled && d?.deployed && <button className="btn btn-sm btn-ghost" title="Restart" aria-label="Restart" disabled={restart.isLoading} onClick={() => restart.mutate({ id: w.id })}><RotateCcw size={14} /></button>}
                {mayEdit && <button className="btn btn-sm btn-ghost" title="Edit" aria-label="Edit" onClick={() => setEditing(w)}><Pencil size={14} /></button>}
              </span>
            </div>
          );
        })}
        {workers.length > 0 && (
          <div className="card-body small faint row" style={{ gap: 8, borderTop: "1px solid var(--border)" }}>
            <Info size={13} /> This app&apos;s workers hold <strong style={{ color: "var(--text)", fontWeight: 550 }}>{memText(d.appWorkersMb)}</strong> of the server&apos;s memory, counted in Room left{d.freeToPromiseMb != null ? `. The server can still give out ${memText(Math.max(0, d.freeToPromiseMb))}.` : "."}
          </div>
        )}
      </section>
      {!d?.deployed && workers.length > 0 && <div className="notice warn small"><AlertTriangle size={15} className="warn-text" /> <span>This app has not been deployed yet. Its workers start with the first deploy.</span></div>}
      {shown && shown.enabled && d?.deployed && <WorkerLogs key={shown.id} site={site} worker={shown} />}
      {editing && <WorkerEditor site={site} worker={editing === "new" ? null : editing} release={d?.release ?? null} onClose={() => setEditing(null)} canDelete={mayEdit} />}
    </div>
  );
}
