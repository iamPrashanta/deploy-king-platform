"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Check, X } from "lucide-react";
import { trpc } from "@/utils/trpc";
import { Dialog, Empty, Skeleton, Spinner, cx, errMsg } from "@/components/ui";
import { EngineTile, size, type TargetRef } from "./shared";

/**
 * Restore a database or a volume (design: RestoreDialog). Pick a backup, full or data only, and the target:
 * a new copy (recommended) or the live data. The checksum is checked and a safety backup taken first;
 * the app can be stopped while it runs. After starting, the dialog follows the restore step by step.
 */

const fmt = (d: string | Date | null) => {
  if (!d) return "";
  const t = new Date(d);
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(t).setHours(0, 0, 0, 0)) / 86_400_000);
  const hm = t.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const ago = Math.round((Date.now() - t.getTime()) / 3_600_000);
  if (days === 0) return `Today ${hm}${ago >= 1 ? ` · ${ago} h ago` : ""}`;
  if (days === 1) return `Yesterday ${hm}`;
  return `${t.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${hm}`;
};

function Choice({ on, title, text, disabled, onPick, name }: { on: boolean; title: string; text: string; disabled?: string | false; onPick: () => void; name: string }) {
  return (
    <label className={cx("choice", on && "on")} style={disabled ? { opacity: 0.55, cursor: "not-allowed" } : undefined} title={disabled || undefined}>
      <input type="radio" name={name} checked={on} disabled={!!disabled} onChange={onPick} />
      <span><span style={{ fontWeight: 600, fontSize: 13 }}>{title}</span><span className="small muted" style={{ lineHeight: 1.5 }}>{disabled || text}</span></span>
    </label>
  );
}

export function RestoreDialog({ target, backupId, onClose }: { target: TargetRef; backupId?: string | null; onClose: () => void }) {
  const utils = trpc.useContext();
  const q = trpc.backup.restorable.useQuery({ target: target as any });
  const d: any = q.data;
  const [picked, setPicked] = useState<string | null>(backupId ?? null);
  const [mode, setMode] = useState<"full" | "data">("full");
  const [into, setInto] = useState<"new" | "replace">("new");
  const [verify, setVerify] = useState(true);
  const [safety, setSafety] = useState(true);
  const [stopApp, setStopApp] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (!picked && d?.backups?.length) setPicked(d.backups[0].id); }, [d, picked]);
  const files = d?.target.type === "volume";
  useEffect(() => { if (into === "new" || files) setMode("full"); }, [into, files]);
  useEffect(() => setConfirm(false), [into, mode, picked]);

  const start = trpc.backup.restore.useMutation({ onSuccess: (r: any) => setRestoreId(r.id), onError: (e) => setError(errMsg(e)) });
  const status = trpc.backup.restoreStatus.useQuery({ id: restoreId ?? "" }, { enabled: !!restoreId, refetchInterval: (data: any) => (data && ["ok", "failed"].includes(data.status) ? false : 1500) });
  const r: any = status.data;
  useEffect(() => {
    if (r && ["ok", "failed"].includes(r.status)) { utils.backup.history.invalidate(); utils.database.list.invalidate(); utils.backup.overview.invalidate(); }
  }, [r?.status, utils]);

  const name = d?.target.name ?? "";
  const app = d?.target.app;
  const go = () => {
    if (into === "replace" && !confirm) return setConfirm(true);
    setError(null);
    start.mutate({ backupId: picked!, mode, into, verifyChecksum: verify, safetyBackup: safety, stopApp });
  };
  const title = <span className="row" style={{ gap: 12 }}>{d && <EngineTile engine={d.target.engine} size={40} />}<span>Restore {name || "…"}</span></span>;
  const subtitle = d ? `${d.target.kind}${app ? ` · used by ${app.name}` : ""}` : undefined;

  // ── following a restore that has started ──
  if (restoreId) {
    const done = r && ["ok", "failed"].includes(r.status);
    return (
      <Dialog open onClose={onClose} width={560} title={title} subtitle={subtitle} footer={<button className={cx("btn", done && "btn-primary")} onClick={onClose}>{done ? "Close" : "Close (it keeps going)"}</button>}>
        <div className="stack" style={{ gap: 12 }}>
          {!r || !done ? <div className="row muted"><Spinner /> {r?.status === "running" ? "Restoring…" : "Waiting for the worker…"}</div> : null}
          <ul className="can-list">
            {(r?.steps ?? []).map((s: any, i: number) => (
              <li key={i}>{s.ok === false ? <X size={14} className="bad-text" /> : <Check size={14} className="ok-text" />}<span className={cx(s.ok === false && "bad-text")}>{s.text}</span></li>
            ))}
          </ul>
          {r?.status === "ok" && (
            <div className="notice ok small">
              <Check size={14} />
              <span>
                Restored.{" "}
                {r.into === "new" && r.resultDbInstanceId ? <>The copy is <Link className="link mono" href={`/databases?id=${r.resultDbInstanceId}`}>{r.newName}</Link>. {app ? `Point ${app.name} at it from its Environment when you are happy with it.` : ""}</> : null}
                {r.into === "new" && files ? <>The files are in the folder <Link className="link mono" href={`/files?site=${(target as any).siteId}&volume=${(target as any).volume}&path=/${r.newName}`}>{r.newName}</Link> inside the volume.</> : null}
              </span>
            </div>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      width={560}
      title={title}
      subtitle={subtitle}
      footer={
        <>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={cx("btn", into === "replace" && confirm ? "btn-danger" : "btn-primary")} disabled={!picked || start.isLoading || !d?.restoreAvailable} onClick={go}>
            {start.isLoading ? <Spinner /> : into === "new" ? (files ? "Restore to a new folder" : "Restore to new copy") : confirm ? `Yes, replace ${name}` : "Replace live data"}
          </button>
        </>
      }
    >
      {q.isLoading ? <Skeleton h={300} /> : q.error ? <div className="notice bad small"><AlertTriangle size={14} />{errMsg(q.error)}</div> : !d.backups.length ? (
        <Empty title="Nothing to restore yet">There is no finished backup of {name} with a copy left. Make one from the Backups page.</Empty>
      ) : (
        <div className="stack" style={{ gap: 20 }}>
          {!d.restoreAvailable && <div className="notice warn small"><AlertTriangle size={14} />Restoring this engine is not available yet.</div>}
          <fieldset className="plain stack" style={{ gap: 8 }}>
            <legend className="label">Backup</legend>
            {d.backups.slice(0, 6).map((b: any) => (
              <label key={b.id} className={cx("choice", picked === b.id && "on")} style={{ alignItems: "center" }}>
                <input type="radio" name="backup" checked={picked === b.id} onChange={() => setPicked(b.id)} />
                <span className="grow"><span style={{ fontWeight: 600, fontSize: 13 }}>{fmt(b.finishedAt ?? b.createdAt)}{b.trigger === "safety" ? " · safety backup" : ""}</span><span className="small muted mono">{size(b.sizeBytes)} · {b.copies.filter((c: any) => c.ok && !c.removed).map((c: any) => c.name).join(", ")}</span></span>
                {b.copies.some((c: any) => c.verified && !c.removed) ? <span className="badge ok">sha256 ✓</span> : <span className="badge warn">not verified</span>}
              </label>
            ))}
          </fieldset>

          {!files && (
            <fieldset className="plain stack" style={{ gap: 8 }}>
              <legend className="label">How</legend>
              <Choice name="mode" on={mode === "full"} onPick={() => setMode("full")} title="Full restore" text="Drops and recreates the schema, then loads the data." />
              <Choice name="mode" on={mode === "data"} onPick={() => setMode("data")} title="Data only" text="Keeps the current schema (run your migrations first), reloads rows and fixes sequences." disabled={into === "new" && "A new copy has no schema yet, so it always gets a full restore."} />
            </fieldset>
          )}

          <div>
            <label className="label" htmlFor="restore-into">Restore into</label>
            <select id="restore-into" className="input select" value={into} onChange={(e) => setInto(e.target.value as any)}>
              <option value="new">{files ? `A new folder in the volume: ${d.newName} (recommended)` : `A new copy: ${d.newName} (recommended)`}</option>
              <option value="replace">{files ? `${name} (replace the files)` : `${name} (replace live data)`}</option>
            </select>
          </div>

          <div className="stack" style={{ gap: 10 }}>
            <label className="check small"><input type="checkbox" checked={verify} onChange={(e) => setVerify(e.target.checked)} />Verify the checksum before restoring</label>
            <label className="check small" style={into === "new" ? { opacity: 0.55 } : undefined} title={into === "new" ? "A new copy leaves the live data untouched, so nothing needs saving first." : undefined}>
              <input type="checkbox" checked={into === "replace" && safety} disabled={into === "new"} onChange={(e) => setSafety(e.target.checked)} />Take a safety backup of the target first
            </label>
            {app && <label className="check small"><input type="checkbox" checked={stopApp} onChange={(e) => setStopApp(e.target.checked)} />Stop {app.name} while restoring</label>}
          </div>

          {into === "new" ? (
            <div className="notice warn small"><AlertTriangle size={14} /><span>{files ? "Restoring into a new folder leaves the live files untouched. Move what you need with Files." : `Restoring into a new copy leaves live data untouched.${app ? ` Point ${app.name} at it from Environment when you are happy with it.` : ""}`}</span></div>
          ) : (
            <div className="notice bad small"><AlertTriangle size={14} /><span>This replaces {files ? "every file in the volume" : `the data in ${name}`} with the backup.{safety ? " A safety backup is taken first, so you can go back." : " Without a safety backup there is no way back."}</span></div>
          )}
          {error && <div className="notice bad small"><AlertTriangle size={14} />{error}</div>}
        </div>
      )}
    </Dialog>
  );
}
