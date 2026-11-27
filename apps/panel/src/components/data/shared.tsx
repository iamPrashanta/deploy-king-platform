"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { Dialog, Spinner, cx, errMsg, timeAgo } from "@/components/ui";

/**
 * Pieces shared by Data · Databases, Backups and Files: tiles, sizes, the schedule editor and "Back up now".
 */

export type TargetRef = { type: "database"; id: string } | { type: "volume"; siteId: string; volume: string };

export const keyOf = (t: TargetRef) => (t.type === "database" ? `db:${t.id}` : `vol:${t.siteId}:${t.volume}`);
export function refOf(key: string): TargetRef | null {
  const d = /^db:(.+)$/.exec(key);
  if (d) return { type: "database", id: d[1]! };
  const v = /^vol:([^:]+):(.+)$/.exec(key);
  return v ? { type: "volume", siteId: v[1]!, volume: v[2]! } : null;
}

export function size(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(n < 10 * 1024 ** 2 ? 1 : 0)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function took(ms: number | null | undefined) {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const TILES: Record<string, { mono: string; color: string }> = {
  pgsql: { mono: "PG", color: "var(--blue)" },
  mysql: { mono: "MY", color: "var(--amber)" },
  files: { mono: "FS", color: "var(--green)" },
};

/** The two-letter engine tile of the design (PG, MY), FS for volumes. */
export function EngineTile({ engine, size: px = 36 }: { engine: string; size?: number }) {
  const t = TILES[engine] ?? TILES.pgsql!;
  return (
    <span className="mono" aria-hidden style={{ width: px, height: px, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0, fontSize: 12, fontWeight: 700, color: t.color, background: `color-mix(in srgb, ${t.color} 14%, transparent)` }}>
      {t.mono}
    </span>
  );
}

export const backupTone = (s: string | null | undefined) => (s === "ok" ? "ok" : s === "failed" ? "bad" : s === "partial" ? "warn" : "info");
export const backupLabel: Record<string, string> = { ok: "Done", partial: "Some copies failed", failed: "Failed", queued: "Waiting", running: "Running" };

export function LastBackup({ last, running }: { last: { status: string; at: string | Date | null; error?: string | null } | null; running?: boolean }) {
  if (running) return <span className="row small" style={{ gap: 7 }}><span className="dot info pulse" />Backing up…</span>;
  if (!last) return <span className="small faint">Never backed up</span>;
  return (
    <span className={cx("row small", last.status === "failed" && "bad-text")} style={{ gap: 7 }} title={last.error ?? undefined}>
      <span className={cx("dot", backupTone(last.status))} />
      {last.status === "failed" ? `Failed ${timeAgo(last.at)}` : timeAgo(last.at)}
    </span>
  );
}

// ─── Schedule editor ──────────────────────────────────────────────────────────

const two = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const browserTz = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; } })();
const ZONES = Array.from(new Set(["UTC", browserTz, "Asia/Kolkata", "Asia/Singapore", "Europe/London", "Europe/Berlin", "America/New_York", "America/Los_Angeles", "Australia/Sydney"]));
type Kind = "hourly" | "daily" | "weekly" | "monthly" | "custom";
type Pick = { kind: Kind; minute: number; time: string; day: number; dom: number; custom: string };

function fromCron(cron: string): Pick {
  const base: Pick = { kind: "custom", minute: 0, time: "02:00", day: 0, dom: 1, custom: cron };
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return base;
  const [mi, h, dom, mo, dow] = p as [string, string, string, string, string];
  const num = (x: string) => (/^\d+$/.test(x) ? Number(x) : null);
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
    case "hourly": return `${p.minute} * * * *`;
    case "daily": return `${m} ${h} * * *`;
    case "weekly": return `${m} ${h} * * ${p.day}`;
    case "monthly": return `${m} ${h} ${p.dom} * *`;
    default: return p.custom.trim();
  }
}

const KINDS: Array<[Kind, string]> = [["hourly", "Every hour"], ["daily", "Every day"], ["weekly", "Every week"], ["monthly", "Every month"], ["custom", "Custom"]];

/** The databases and volumes this person can choose from, for "New schedule" and "Back up now". */
function useTargets(enabled: boolean) {
  const dbs = trpc.database.list.useQuery(undefined, { enabled, staleTime: 30_000 });
  const roots = trpc.files.roots.useQuery(undefined, { enabled, staleTime: 30_000, retry: false });
  return useMemo(() => {
    const out: Array<{ key: string; label: string; group: string; disabled?: string }> = [];
    for (const d of (dbs.data ?? []) as any[]) out.push({ key: `db:${d.id}`, label: `${d.name}${d.app ? ` · ${d.app.name}` : ""}`, group: "Databases", ...(d.type === "mysql" ? { disabled: "MySQL backups are not available yet" } : {}) });
    for (const v of ((roots.data as any)?.volumes ?? []) as any[]) out.push({ key: `vol:${v.siteId}:${v.volume}`, label: `${v.app} · ${v.volume}`, group: "App volumes" });
    return { list: out, loading: dbs.isLoading };
  }, [dbs.data, dbs.isLoading, roots.data]);
}

export function TargetSelect({ value, onChange, id }: { value: string; onChange: (k: string) => void; id: string }) {
  const t = useTargets(true);
  const groups = ["Databases", "App volumes"];
  return (
    <select id={id} className="input select" value={value} onChange={(e) => onChange(e.target.value)} disabled={t.loading}>
      <option value="">{t.loading ? "Loading…" : "Choose a database or volume"}</option>
      {groups.map((g) => {
        const items = t.list.filter((x) => x.group === g);
        return items.length ? (
          <optgroup key={g} label={g}>
            {items.map((x) => <option key={x.key} value={x.key} disabled={!!x.disabled}>{x.label}{x.disabled ? ` (${x.disabled})` : ""}</option>)}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

/**
 * New schedule, or edit one. `target` fixes what it is for (from a database or volume); without it the person chooses.
 */
export function ScheduleDialog({ target, targetName, policy, onClose }: { target?: TargetRef | null; targetName?: string; policy?: any; onClose: () => void }) {
  const utils = trpc.useContext();
  const fixed = target ?? (policy ? refOf(policy.targetKey) : null);
  const [key, setKey] = useState(fixed ? keyOf(fixed) : "");
  const [pick, setPick] = useState<Pick>(fromCron(policy?.schedule ?? "0 2 * * *"));
  const [tz, setTz] = useState<string>(policy?.timezone ?? browserTz);
  const [keep, setKeep] = useState<number>(policy?.keep ?? 14);
  const [enabled, setEnabled] = useState<boolean>(policy?.enabled ?? true);
  const dests = trpc.backup.destinations.useQuery();
  const all: any[] = dests.data?.destinations ?? [];
  const [chosen, setChosen] = useState<string[] | null>(policy?.destinationIds ?? null);
  useEffect(() => { if (chosen === null && all.length) setChosen(all.filter((d) => d.builtIn).map((d) => d.id)); }, [all, chosen]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cron = toCron(pick);
  const [asked, setAsked] = useState({ cron, tz });
  useEffect(() => { const t = setTimeout(() => setAsked({ cron, tz }), 300); return () => clearTimeout(t); }, [cron, tz]);
  const prev = trpc.cron.preview.useQuery({ schedule: asked.cron, timezone: asked.tz }, { keepPreviousData: true, enabled: asked.cron.length > 0 });
  const pv: any = prev.data;

  const done = (m: string) => {
    toast.success(m);
    utils.backup.policies.invalidate();
    utils.backup.policyFor.invalidate();
    utils.backup.overview.invalidate();
    utils.database.list.invalidate();
    onClose();
  };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const save = trpc.backup.savePolicy.useMutation({ onSuccess: () => done("Backup schedule saved"), onError });
  const remove = trpc.backup.deletePolicy.useMutation({ onSuccess: () => done("Backup schedule removed"), onError });
  const ref = refOf(key);
  const ready = !!ref && pv?.valid && cron === asked.cron && (chosen?.length ?? 0) > 0 && keep >= 1;
  const busy = save.isLoading || remove.isLoading;

  return (
    <Dialog
      open
      onClose={onClose}
      width={620}
      title={policy ? "Edit backup schedule" : "New backup schedule"}
      subtitle={targetName ?? (policy?.targetName ? policy.targetName : "Checked with SHA-256, tried up to 3 times, copied to every destination you tick.")}
      footer={
        <>
          {policy && (confirmDelete
            ? <button className="btn btn-danger" disabled={busy} onClick={() => remove.mutate({ id: policy.id })}>Yes, remove the schedule</button>
            : <button className="btn btn-ghost btn-danger" onClick={() => setConfirmDelete(true)}>Remove schedule</button>)}
          <span className="grow" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => ref && save.mutate({ target: ref as any, schedule: cron, timezone: tz, keep, destinationIds: chosen ?? [], enabled })}>{busy ? <Spinner /> : "Save schedule"}</button>
        </>
      }
    >
      <div className="stack" style={{ gap: 18 }}>
        {!fixed && (
          <div>
            <label className="label" htmlFor="sch-target">Back up</label>
            <TargetSelect id="sch-target" value={key} onChange={setKey} />
          </div>
        )}
        <fieldset className="plain">
          <legend className="label">When</legend>
          <div className="row wrap" style={{ gap: 8 }} role="radiogroup" aria-label="How often">
            {KINDS.map(([k, l]) => (
              <button key={k} type="button" role="radio" aria-checked={pick.kind === k} className={cx("chip-btn", pick.kind === k && "on")} onClick={() => setPick({ ...pick, kind: k, custom: k === "custom" && pick.kind !== "custom" ? cron : pick.custom })}>{l}</button>
            ))}
          </div>
          <div className="row wrap" style={{ gap: 12, marginTop: 12, alignItems: "flex-end" }}>
            {pick.kind === "hourly" && <div><label className="label" htmlFor="sch-min">At minute</label><input id="sch-min" className="input mono" type="number" min={0} max={59} style={{ width: 110 }} value={pick.minute} onChange={(e) => setPick({ ...pick, minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })} /></div>}
            {pick.kind === "weekly" && <div><label className="label" htmlFor="sch-day">On</label><select id="sch-day" className="input select" value={pick.day} onChange={(e) => setPick({ ...pick, day: Number(e.target.value) })}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></div>}
            {pick.kind === "monthly" && <div><label className="label" htmlFor="sch-dom">On day</label><select id="sch-dom" className="input select" value={pick.dom} onChange={(e) => setPick({ ...pick, dom: Number(e.target.value) })}>{Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}</select></div>}
            {["daily", "weekly", "monthly"].includes(pick.kind) && <div><label className="label" htmlFor="sch-time">At</label><input id="sch-time" className="input mono" type="time" style={{ width: 130 }} value={pick.time} onChange={(e) => setPick({ ...pick, time: e.target.value || "00:00" })} /></div>}
            {pick.kind === "custom" && <div className="grow"><label className="label" htmlFor="sch-cron">Cron expression</label><input id="sch-cron" className="input mono" value={pick.custom} onChange={(e) => setPick({ ...pick, custom: e.target.value })} placeholder="30 2 * * 0" /></div>}
            <div className="grow" style={{ minWidth: 200 }}>
              <label className="label" htmlFor="sch-tz">Time zone</label>
              <select id="sch-tz" className="input select" value={tz} onChange={(e) => setTz(e.target.value)}>
                {Array.from(new Set([tz, ...ZONES])).map((z) => <option key={z} value={z}>{z === "UTC" ? "UTC (server time)" : z}</option>)}
              </select>
            </div>
          </div>
          <div className="card card-pad small" style={{ marginTop: 12, background: "var(--card-2)" }}>
            {pv && !pv.valid ? (
              <span className="bad-text row" style={{ gap: 6 }}><AlertTriangle size={14} /> {pv.error}</span>
            ) : (
              <span className="muted">{pv?.words && pv.words !== "Custom schedule" ? `${pv.words}. ` : ""}Next: <span style={{ color: "var(--text)" }}>{(pv?.next ?? []).map((n: string) => new Date(n).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: tz })).join(" · ") || "…"}</span></span>
            )}
          </div>
        </fieldset>
        <div>
          <label className="label" htmlFor="sch-keep">Keep</label>
          <div className="row" style={{ gap: 10 }}>
            <input id="sch-keep" className="input mono" type="number" min={1} max={365} style={{ width: 110 }} value={keep} onChange={(e) => setKeep(Math.min(365, Math.max(1, Number(e.target.value) || 1)))} />
            <span className="small muted">most recent backups; older ones are removed from every destination. The newest good one is never removed.</span>
          </div>
        </div>
        <fieldset className="plain">
          <legend className="label">Copy to</legend>
          {dests.isLoading ? <Spinner /> : (
            <div className="stack" style={{ gap: 8 }}>
              {all.map((d) => {
                const on = !!chosen?.includes(d.id);
                return (
                  <label key={d.id} className={cx("choice", on && "on")}>
                    <input type="checkbox" checked={on} onChange={(e) => setChosen((c) => (e.target.checked ? [...(c ?? []), d.id] : (c ?? []).filter((x) => x !== d.id)))} />
                    <span><span style={{ fontWeight: 550 }}>{d.name}</span><span className="small muted">{d.kind === "local" ? "A folder on this server" : "rclone remote"}{d.keepLast ? ` · keeps the last ${d.keepLast}` : ""}</span></span>
                  </label>
                );
              })}
              {(chosen?.length ?? 0) === 1 && all.find((d) => d.id === chosen![0])?.kind === "local" && (
                <div className="notice warn small"><AlertTriangle size={14} />Only on this server: a disk failure would take the backups with it. Add a destination off the server on the Backups page.</div>
              )}
            </div>
          )}
        </fieldset>
        <label className="rule-row" style={{ borderTop: 0, paddingTop: 0 }}>
          <span className="grow"><span style={{ fontWeight: 550 }}>On</span><span className="small muted" style={{ display: "block" }}>Off keeps the settings without running.</span></span>
          <span className="switch"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /><span /></span>
        </label>
      </div>
    </Dialog>
  );
}

/** "Back up now" from the Backups page: choose what, then it is queued. */
export function BackupNowDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useContext();
  const [key, setKey] = useState("");
  const run = trpc.backup.runNow.useMutation({
    onSuccess: () => { toast.success("Backup started"); utils.backup.history.invalidate(); utils.backup.overview.invalidate(); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const ref = refOf(key);
  return (
    <Dialog open onClose={onClose} title="Back up now" subtitle="Goes to the destinations of its schedule, or to This server when it has none."
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!ref || run.isLoading} onClick={() => ref && run.mutate({ target: ref as any })}>{run.isLoading ? <Spinner /> : "Back up now"}</button></>}>
      <label className="label" htmlFor="now-target">Back up</label>
      <TargetSelect id="now-target" value={key} onChange={setKey} />
    </Dialog>
  );
}
