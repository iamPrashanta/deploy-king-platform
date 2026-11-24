"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Info, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { Dialog, Empty, Skeleton, Spinner, copyText, cx, duration, errMsg, timeAgo } from "@/components/ui";
import { useCan } from "@/components/useCan";

/**
 * The "Scheduled jobs" tab of an app: commands that run inside it on a schedule.
 * The schedule is cron text underneath; the editor offers plain choices and shows the next runs.
 */

type Job = any;
const two = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const STATUS: Record<string, { tone: string; label: string }> = {
  ok: { tone: "ok", label: "Succeeded" }, failed: { tone: "bad", label: "Failed" }, timeout: { tone: "bad", label: "Ran past its limit" },
  skipped: { tone: "", label: "Skipped" }, running: { tone: "info", label: "Running" },
};
const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const ZONES = Array.from(new Set(["UTC", browserTz, "Asia/Kolkata", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Los_Angeles", "Australia/Sydney"]));
const LIMITS = [[60, "1 minute"], [300, "5 minutes"], [600, "10 minutes"], [1800, "30 minutes"], [3600, "1 hour"]] as const;

function when(iso: string | null | undefined, tz: string) {
  if (!iso) return "";
  const d = new Date(iso);
  const diff = d.getTime() - Date.now();
  if (diff > 0 && diff < 60 * 60_000) return `in ${Math.max(1, Math.round(diff / 60_000))} min`;
  if (diff > 0 && diff < 36 * 60 * 60_000) return `in ${Math.round(diff / 3_600_000)} h`;
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz });
}

function LastRun({ j }: { j: Job }) {
  if (!j.lastStatus) return <span className="faint">Not run yet</span>;
  const st = STATUS[j.lastStatus] ?? { tone: "", label: j.lastStatus };
  return (
    <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <span className={cx("row small", st.tone === "bad" && "bad-text", st.tone === "ok" && "ok-text")} style={{ gap: 6 }}>
        <span className={cx("dot", st.tone)} />{st.label}{j.lastExitCode != null && j.lastStatus !== "ok" ? ` · exit ${j.lastExitCode}` : ""}
      </span>
      <span className="small faint">{timeAgo(j.lastRunAt)}{j.lastDurationMs != null ? ` · ${duration(j.lastDurationMs)}` : ""}</span>
    </span>
  );
}

// ─── The schedule picker ─────────────────────────────────────────────────────
type Kind = "5m" | "15m" | "hourly" | "daily" | "weekly" | "monthly" | "custom";
type Pick = { kind: Kind; minute: number; time: string; day: number; dom: number; custom: string };

/** Reads stored cron text back into the plain choices, when it is one of them. */
function fromCron(cron: string): Pick {
  const base: Pick = { kind: "custom", minute: 0, time: "06:00", day: 1, dom: 1, custom: cron };
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return base;
  const [mi, h, dom, mo, dow] = p;
  const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : null);
  if (cron === "*/5 * * * *") return { ...base, kind: "5m" };
  if (cron === "*/15 * * * *") return { ...base, kind: "15m" };
  if (num(mi) !== null && h === "*" && dom === "*" && mo === "*" && dow === "*") return { ...base, kind: "hourly", minute: num(mi)! };
  if (num(mi) !== null && num(h) !== null && mo === "*") {
    const time = `${two(num(h)!)}:${two(num(mi)!)}`;
    if (dom === "*" && dow === "*") return { ...base, kind: "daily", time };
    if (dom === "*" && num(dow) !== null) return { ...base, kind: "weekly", time, day: num(dow)! % 7 };
    if (num(dom) !== null && dow === "*") return { ...base, kind: "monthly", time, dom: num(dom)! };
  }
  return base;
}

function toCron(p: Pick): string {
  const [h, m] = p.time.split(":").map((x) => Number(x) || 0);
  switch (p.kind) {
    case "5m": return "*/5 * * * *";
    case "15m": return "*/15 * * * *";
    case "hourly": return `${p.minute} * * * *`;
    case "daily": return `${m} ${h} * * *`;
    case "weekly": return `${m} ${h} * * ${p.day}`;
    case "monthly": return `${m} ${h} ${p.dom} * *`;
    default: return p.custom.trim();
  }
}

const KINDS: Array<[Kind, string]> = [["5m", "Every 5 minutes"], ["15m", "Every 15 minutes"], ["hourly", "Every hour"], ["daily", "Every day"], ["weekly", "Every week"], ["monthly", "Every month"], ["custom", "Custom"]];

function JobEditor({ site, job, workers, onClose, canDelete }: { site: any; job: Job | null; workers: string[]; onClose: () => void; canDelete: boolean }) {
  const utils = trpc.useContext();
  const [name, setName] = useState(job?.name ?? "");
  const [command, setCommand] = useState(job?.command ?? "");
  const [runIn, setRunIn] = useState<string>(job?.runIn ?? "web");
  const [pick, setPick] = useState<Pick>(fromCron(job?.schedule ?? "0 6 * * *"));
  const [tz, setTz] = useState<string>(job?.timezone ?? "UTC");
  const [timeoutSec, setTimeoutSec] = useState<number>(job?.timeoutSec ?? 600);
  const [notify, setNotify] = useState<boolean>(job?.notifyOnFailure ?? true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cron = toCron(pick);
  // Ask the server what the schedule means only once typing pauses.
  const [asked, setAsked] = useState({ cron, tz });
  useEffect(() => { const t = setTimeout(() => setAsked({ cron, tz }), 300); return () => clearTimeout(t); }, [cron, tz]);
  const prev = trpc.cron.preview.useQuery({ schedule: asked.cron, timezone: asked.tz }, { keepPreviousData: true, enabled: asked.cron.length > 0 });
  const pv: any = prev.data;

  const done = (msg: string) => { toast.success(msg); utils.cron.list.invalidate({ siteId: site.id }); onClose(); };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const create = trpc.cron.create.useMutation({ onSuccess: (_d, v) => done((v as any)?.runNow ? "Saved. The first run has started." : "Scheduled job saved"), onError });
  const update = trpc.cron.update.useMutation({ onSuccess: () => done("Scheduled job saved"), onError });
  const remove = trpc.cron.delete.useMutation({ onSuccess: () => done("Scheduled job removed"), onError });
  const busy = create.isLoading || update.isLoading || remove.isLoading;
  const fields = { name: name.trim(), command: command.trim(), schedule: cron, timezone: tz, runIn, timeoutSec, notifyOnFailure: notify };
  const ready = fields.name && fields.command && pv?.valid && cron === asked.cron;
  const save = (runNow = false) => (job ? update.mutate({ id: job.id, ...fields }) : create.mutate({ siteId: site.id, ...fields, runNow }));

  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title={job ? "Edit scheduled job" : "New scheduled job"}
      subtitle={`${site.domain.split(".")[0]} · runs inside the app`}
      footer={
        <>
          {job && canDelete ? (
            confirmDelete ? (
              <button className="btn btn-danger" disabled={busy} onClick={() => remove.mutate({ id: job.id })}><Trash2 size={14} /> Yes, remove it</button>
            ) : (
              <button className="btn btn-ghost btn-danger" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Remove</button>
            )
          ) : (
            !job && <button className="btn" disabled={!ready || busy} onClick={() => save(true)}><Play size={14} /> Save and run once</button>
          )}
          <span className="grow" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => save(false)}>{busy ? <Spinner /> : "Save job"}</button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        <div className="field" style={{ margin: 0 }}>
          <label className="label" htmlFor="job-name">Name</label>
          <input id="job-name" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} placeholder="Send daily report" autoFocus={!job} />
        </div>
        <div className="field" style={{ margin: 0 }}>
          <label className="label" htmlFor="job-cmd">Command</label>
          <textarea id="job-cmd" className="input textarea mono" rows={2} style={{ minHeight: 60 }} value={command} onChange={(e) => setCommand(e.target.value)} maxLength={2000} placeholder="node scripts/daily-report.js" />
          <div className="hint">Runs with <span className="mono">sh -c</span> inside the app, from its working folder, with all its variables.</div>
        </div>
        {workers.length > 0 && (
          <div>
            <div className="label">Run in</div>
            <div className="seg" role="radiogroup">
              {[["web", "Web container"], ...workers.map((w) => [`worker:${w}`, `Worker: ${w}`])].map(([v, l]) => (
                <button key={v} type="button" role="radio" aria-checked={runIn === v} className={cx(runIn === v && "on")} onClick={() => setRunIn(v)}>{l}</button>
              ))}
            </div>
          </div>
        )}
        <fieldset className="plain">
          <legend className="label">Schedule</legend>
          <div className="row wrap" style={{ gap: 8 }} role="radiogroup" aria-label="How often">
            {KINDS.map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={pick.kind === k} className={cx("chip-btn", pick.kind === k && "on")} onClick={() => setPick({ ...pick, kind: k, custom: k === "custom" && pick.kind !== "custom" ? cron : pick.custom })}>{l}</button>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 12, marginTop: 12, alignItems: "flex-end" }}>
            {pick.kind === "hourly" && (
              <div><label className="label" htmlFor="job-min">At minute</label><input id="job-min" className="input mono" type="number" min={0} max={59} style={{ width: 110 }} value={pick.minute} onChange={(e) => setPick({ ...pick, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} /></div>
            )}
            {pick.kind === "weekly" && (
              <div><label className="label" htmlFor="job-day">On</label><select id="job-day" className="input select" value={pick.day} onChange={(e) => setPick({ ...pick, day: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>
            )}
            {pick.kind === "monthly" && (
              <div><label className="label" htmlFor="job-dom">On day</label><select id="job-dom" className="input select" value={pick.dom} onChange={(e) => setPick({ ...pick, dom: Number(e.target.value) })}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></div>
            )}
            {["daily", "weekly", "monthly"].includes(pick.kind) && (
              <div><label className="label" htmlFor="job-time">At</label><input id="job-time" className="input mono" type="time" style={{ width: 130 }} value={pick.time} onChange={(e) => setPick({ ...pick, time: e.target.value || "00:00" })} /></div>
            )}
            {pick.kind === "custom" && (
              <div className="grow"><label className="label" htmlFor="job-cron">Cron expression</label><input id="job-cron" className="input mono" value={pick.custom} onChange={(e) => setPick({ ...pick, custom: e.target.value })} placeholder="*/10 8-18 * * 1-5" /></div>
            )}
            <div className="grow" style={{ minWidth: 200 }}>
              <label className="label" htmlFor="job-tz">Time zone</label>
              <select id="job-tz" className="input select" value={tz} onChange={(e) => setTz(e.target.value)}>
                {Array.from(new Set([tz, ...ZONES])).map((z) => <option key={z} value={z}>{z === "UTC" ? "UTC (server time)" : z}</option>)}
              </select>
            </div>
          </div>
          <div className="card card-pad small" style={{ marginTop: 12, background: "var(--card-2)" }}>
            {pv && !pv.valid ? (
              <span className="bad-text row" style={{ gap: 6 }}><AlertTriangle size={14} /> {pv.error}</span>
            ) : (
              <div className="stack" style={{ gap: 4 }}>
                <span className="muted">As cron <span className="mono" style={{ color: "var(--text)" }}>{pv?.cron ?? cron}</span>{pv?.words && pv.words !== "Custom schedule" ? ` · ${pv.words}` : ""}</span>
                <span className="muted">Next runs: <span style={{ color: "var(--text)" }}>{(pv?.next ?? []).map((n: string) => new Date(n).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz })).join(" · ") || "…"}</span></span>
              </div>
            )}
          </div>
        </fieldset>
        <div className="row wrap" style={{ gap: 12 }}>
          <div className="grow"><label className="label" htmlFor="job-limit">Stop a run after</label>
            <select id="job-limit" className="input select" value={timeoutSec} onChange={(e) => setTimeoutSec(Number(e.target.value))}>
              {Array.from(new Set([timeoutSec, ...LIMITS.map((l) => l[0])])).sort((a, b) => a - b).map((v) => <option key={v} value={v}>{LIMITS.find((l) => l[0] === v)?.[1] ?? `${Math.round(v / 60)} minutes`}</option>)}
            </select>
          </div>
          <div className="grow"><span className="label">If the last run is still going</span><div className="input row muted" style={{ cursor: "default" }}>This run is skipped</div></div>
        </div>
        <label className="rule-row" style={{ borderTop: 0, paddingTop: 0 }}>
          <span className="grow"><span style={{ fontWeight: 550 }}>Tell me when it fails</span><span className="small muted" style={{ display: "block" }}>A failed run shows in Needs attention on the Overview.</span></span>
          <span className="switch"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span /></span>
        </label>
      </div>
    </Dialog>
  );
}

// ─── One run's output ────────────────────────────────────────────────────────
function RunOutput({ runId, onClose, onEdit }: { runId: string; onClose: () => void; onEdit: (job: Job) => void }) {
  const q = trpc.cron.run.useQuery({ runId }, { refetchInterval: (d: any) => (d?.status === "running" ? 2000 : false) });
  const r: any = q.data;
  const st = r ? STATUS[r.status] ?? { tone: "", label: r.status } : null;
  return (
    <Dialog
      open
      onClose={onClose}
      width={860}
      title={r ? r.job.name || "Scheduled job" : "Run"}
      subtitle={r ? r.job.command : undefined}
      footer={r && (
        <>
          <button className="btn" onClick={() => { copyText(r.output ?? ""); toast.success("Output copied"); }}>Copy output</button>
          <span className="grow" />
          <button className="btn" onClick={() => onEdit(r.job)}><Pencil size={14} /> Edit job</button>
          <button className="btn btn-primary" onClick={onClose}>Close</button>
        </>
      )}
    >
      {!r ? <Skeleton h={200} /> : (
        <div className="stack">
          <div className="row wrap" style={{ gap: 8 }}>
            <span className={cx("badge", st!.tone)}>{st!.label}{r.exitCode != null && r.status !== "ok" ? ` · exit ${r.exitCode}` : ""}</span>
            <span className="small muted">{new Date(r.startedAt).toLocaleString()} · {r.durationMs != null ? duration(r.durationMs) : "still running"}</span>
            <span className="small muted">· {r.trigger === "manual" ? `Run now${r.by ? ` by ${r.by}` : ""}` : `Schedule (${r.job.schedule})`}</span>
            {r.container && <span className="small faint mono">· {r.container}</span>}
          </div>
          <pre className="log" style={{ maxHeight: 460, minHeight: 120 }}>{(r.output ?? "").split("\n").map((line: string, i: number) => (
            <div key={i} className={cx(/error|fail|fatal|exception|denied|refused/i.test(line) && "err")}>{line || " "}</div>
          ))}{r.status === "running" && <div className="ts">…</div>}</pre>
          <div className="small faint row" style={{ gap: 6 }}><Info size={13} /> The last 64 KB of output is kept per run, for 30 days. Values of the app&apos;s variables are hidden in it.</div>
        </div>
      )}
    </Dialog>
  );
}

function Runs({ job, onOpen }: { job: Job; onOpen: (id: string) => void }) {
  const q = trpc.cron.runs.useQuery({ jobId: job.id, limit: 24 }, { refetchInterval: 10_000 });
  const runs = (q.data as any[]) ?? [];
  return (
    <section className="card" style={{ flex: "1 1 560px", minWidth: 0 }}>
      <div className="card-head"><h3>Recent runs · {job.name}</h3><span className="right small faint">Kept for 30 days</span></div>
      {runs.length > 0 && (
        <div className="row" style={{ gap: 3, padding: "0 16px 14px" }} aria-label={`Last ${runs.length} runs`}>
          {[...runs].reverse().map((r) => (
            <button key={r.id} type="button" title={`${STATUS[r.status]?.label ?? r.status} · ${new Date(r.startedAt).toLocaleString()}`} onClick={() => onOpen(r.id)}
              style={{ flex: 1, height: 22, borderRadius: 3, border: 0, cursor: "pointer", background: r.status === "ok" ? "var(--green)" : r.status === "skipped" ? "var(--border-strong)" : r.status === "running" ? "var(--blue)" : "var(--red)", opacity: r.status === "ok" ? 0.55 : 1 }} />
          ))}
        </div>
      )}
      {q.isLoading ? <div className="card-body"><Skeleton h={80} /></div> : runs.length === 0 ? <div className="card-body small muted">No runs yet. Use Run now to try it.</div> : runs.slice(0, 8).map((r) => (
        <button key={r.id} type="button" className="attn-row" style={{ width: "100%", textAlign: "left", background: "none", border: 0, borderBottom: "1px solid var(--border)", cursor: "pointer", color: "inherit", font: "inherit" }} onClick={() => onOpen(r.id)}>
          <span className="grow" style={{ minWidth: 0 }}>
            <span className={cx("row small", r.status !== "ok" && r.status !== "skipped" && r.status !== "running" && "bad-text")} style={{ gap: 6 }}><span className={cx("dot", STATUS[r.status]?.tone)} />{STATUS[r.status]?.label ?? r.status}</span>
            <span className="small faint">{new Date(r.startedAt).toLocaleString()}</span>
          </span>
          <span className="small muted">{r.trigger === "manual" ? `Run now${r.by ? ` · ${r.by}` : ""}` : "Schedule"}</span>
          <span className="small muted mono" style={{ width: 64, textAlign: "right" }}>{r.durationMs != null ? duration(r.durationMs) : "…"}</span>
          <span className={cx("small mono", r.exitCode ? "bad-text" : "faint")} style={{ width: 40, textAlign: "right" }}>{r.exitCode ?? "–"}</span>
        </button>
      ))}
    </section>
  );
}

export function JobsTab({ site, initialJob }: { site: any; initialJob?: string | null }) {
  const utils = trpc.useContext();
  const can = useCan();
  const mayEdit = can("cron.create");
  const list = trpc.cron.list.useQuery({ siteId: site.id }, { refetchInterval: 15_000 });
  const workers = trpc.workers.list.useQuery({ siteId: site.id }, { staleTime: 30_000 });
  const workerNames = ((workers.data as any)?.workers ?? []).filter((w: any) => w.enabled).map((w: any) => w.name);
  const jobs = (list.data as Job[]) ?? [];
  const [editing, setEditing] = useState<Job | "new" | null>(null);
  const [selected, setSelected] = useState<string | null>(initialJob ?? null);
  const [runId, setRunId] = useState<string | null>(null);
  const onError = (e: unknown) => toast.error(errMsg(e));
  const refresh = () => { utils.cron.list.invalidate({ siteId: site.id }); utils.cron.runs.invalidate(); };
  const runNow = trpc.cron.runNow.useMutation({ onSuccess: () => { toast.success("Started. It shows under Recent runs in a moment."); setTimeout(refresh, 1500); }, onError });
  const setActive = trpc.cron.setActive.useMutation({ onSuccess: (j: any) => { toast.success(j.active ? "Resumed" : "Paused: no runs until resumed"); refresh(); }, onError });
  const current = useMemo(() => jobs.find((j) => j.id === selected) ?? jobs.find((j) => j.failStreak > 0) ?? jobs[0], [jobs, selected]);
  const failing = jobs.filter((j) => j.active && j.failStreak >= 2);

  if (site.type === "static") {
    return <Empty icon={<Clock size={20} />} title="Static sites have no scheduled jobs">A static site has no container to run commands in.</Empty>;
  }

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row wrap" style={{ gap: 12, justifyContent: "space-between", alignItems: "flex-end" }}>
        <p className="muted small" style={{ margin: 0, maxWidth: 680 }}>Commands that run inside {site.domain.split(".")[0]} on a schedule, with the app&apos;s variables. Each job has its own time zone; UTC is the server&apos;s time.</p>
        {mayEdit && <button className="btn btn-primary" onClick={() => setEditing("new")}><Plus size={15} /> New job</button>}
      </div>

      {failing.map((j) => (
        <div key={j.id} className="notice bad" role="status">
          <AlertTriangle size={16} className="bad-text" />
          <div className="grow"><strong>{j.name} failed {j.failStreak} times in a row.</strong> <span className="muted">The last run {j.lastStatus === "timeout" ? "ran past its time limit" : `stopped with exit code ${j.lastExitCode ?? "unknown"}`}.</span></div>
          <button className="btn btn-sm" onClick={() => setSelected(j.id)}>See the runs</button>
        </div>
      ))}

      <section className="card">
        {list.isLoading ? <div className="card-body"><Skeleton h={120} /></div> : jobs.length === 0 ? (
          <Empty icon={<Clock size={20} />} title="No scheduled jobs yet">Run a command every hour, every night or every Monday: clean-ups, reports, syncs, backups.</Empty>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 860 }}>
              <thead><tr><th>Job</th><th>Schedule</th><th>Next run</th><th>Last run</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {jobs.map((j) => (
                  <tr key={j.id} className="click" onClick={() => setSelected(j.id)} style={j.failStreak > 0 && j.active ? { background: "color-mix(in srgb, var(--red) 5%, transparent)" } : current?.id === j.id ? { background: "var(--hover)" } : undefined}>
                    <td>
                      <div className="row" style={{ gap: 8 }}><span style={{ fontWeight: 550 }}>{j.name || "Unnamed job"}</span>{!j.active && <span className="badge">Paused</span>}{j.runIn !== "web" && <span className="badge">{j.runIn.replace("worker:", "worker ")}</span>}</div>
                      <div className="mono small muted ellipsis" style={{ maxWidth: 360 }}>{j.command}</div>
                    </td>
                    <td><div>{j.words}</div><div className="mono small faint">{j.schedule}{j.timezone !== "UTC" ? ` · ${j.timezone}` : ""}</div></td>
                    <td className="muted" style={{ whiteSpace: "nowrap" }}>{j.active ? when(j.nextRunAt, j.timezone) : "Paused"}</td>
                    <td><LastRun j={j} /></td>
                    <td style={{ textAlign: "right", whiteSpace: "nowrap" }} onClick={(e) => e.stopPropagation()}>
                      {mayEdit && (
                        <span className="row" style={{ gap: 6, justifyContent: "flex-end" }}>
                          <button className="btn btn-sm" disabled={runNow.isLoading} onClick={() => runNow.mutate({ id: j.id })}><Play size={13} /> Run now</button>
                          <button className="btn btn-sm btn-ghost" title={j.active ? "Pause" : "Resume"} aria-label={j.active ? "Pause" : "Resume"} disabled={setActive.isLoading} onClick={() => setActive.mutate({ id: j.id, active: !j.active })}>{j.active ? <Pause size={14} /> : <CheckCircle2 size={14} />}</button>
                          <button className="btn btn-sm btn-ghost" title="Edit" aria-label="Edit" onClick={() => setEditing(j)}><Pencil size={14} /></button>
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {current && (
        <div className="row wrap" style={{ gap: 16, alignItems: "flex-start" }}>
          <Runs job={current} onOpen={setRunId} />
          <aside className="card card-pad" style={{ flex: "1 1 280px" }}>
            <h3 style={{ marginBottom: 10 }}>How jobs run</h3>
            <ul className="can-list">
              <li><CheckCircle2 size={13} className="ok-text" /> Inside the app&apos;s running container (or the chosen worker), with its variables and files.</li>
              <li><CheckCircle2 size={13} className="ok-text" /> If a run is still going when the next is due, the next one is skipped.</li>
              <li><CheckCircle2 size={13} className="ok-text" /> A run is stopped at its time limit.</li>
              <li><CheckCircle2 size={13} className="ok-text" /> A failed run shows in Needs attention on the Overview.</li>
            </ul>
          </aside>
        </div>
      )}

      {editing && <JobEditor site={site} job={editing === "new" ? null : editing} workers={workerNames} onClose={() => setEditing(null)} canDelete={mayEdit} />}
      {runId && <RunOutput runId={runId} onClose={() => setRunId(null)} onEdit={(j) => { setRunId(null); setEditing(j); }} />}
    </div>
  );
}
