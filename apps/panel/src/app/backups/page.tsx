"use client";

import { Suspense, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Archive, BookOpen, Pencil, Plus, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { useAuth } from "@/components/AuthProvider";
import { useCan } from "@/components/useCan";
import { Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";
import { BackupNowDialog, ScheduleDialog, backupLabel, backupTone, refOf, size, took, type TargetRef } from "@/components/data/shared";
import { RestoreDialog } from "@/components/data/RestoreDialog";

/**
 * Data · Backups: history, schedules and destinations. Every backup is checked with SHA-256,
 * tried up to 3 times and copied to every destination of its schedule.
 */

const MONO: Record<string, string> = { local: "LO", rclone: "RC", s3: "S3", sftp: "SF" };

function nextLabel(iso: string) {
  const d = new Date(iso);
  const hm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const today = new Date().toDateString() === d.toDateString();
  const tomorrow = new Date(Date.now() + 86_400_000).toDateString() === d.toDateString();
  return { value: hm, when: today ? (d.getHours() >= 18 ? "tonight" : "today") : tomorrow ? "tomorrow" : d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }) };
}

function AddDestinationDialog({ kinds, onClose }: { kinds: any[]; onClose: () => void }) {
  const utils = trpc.useContext();
  const [kind, setKind] = useState("local");
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [keepLast, setKeepLast] = useState<string>("");
  const add = trpc.backup.addDestination.useMutation({
    onSuccess: () => { toast.success("Destination added"); utils.backup.destinations.invalidate(); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const placeholder = kind === "local" ? "/mnt/backup-disk/dbbkp" : "gdrive:dbbkp";
  return (
    <Dialog open onClose={onClose} width={600} title="Add a destination" subtitle="Deploy King writes a test file there, reads it back and removes it before adding it."
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim() || !location.trim() || add.isLoading} onClick={() => add.mutate({ name: name.trim(), kind, location: location.trim(), keepLast: keepLast ? Number(keepLast) : null })}>{add.isLoading ? <Spinner /> : "Check and add"}</button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <fieldset className="plain stack" style={{ gap: 8 }}>
          <legend className="label">Kind</legend>
          {kinds.map((k) => (
            <label key={k.kind} className={cx("choice", kind === k.kind && "on")} style={!k.available ? { opacity: 0.55, cursor: "not-allowed" } : undefined}>
              <input type="radio" name="kind" checked={kind === k.kind} disabled={!k.available} onChange={() => setKind(k.kind)} />
              <span><span style={{ fontWeight: 550 }}>{k.label}</span>{!k.available && <span className="small muted">{k.reason}</span>}</span>
            </label>
          ))}
        </fieldset>
        <div><label className="label" htmlFor="dest-name">Name</label><input id="dest-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === "local" ? "Backup disk" : "Google Drive"} /></div>
        <div>
          <label className="label" htmlFor="dest-loc">{kind === "local" ? "Folder on this server" : "rclone remote and folder"}</label>
          <input id="dest-loc" className="input mono" value={location} onChange={(e) => setLocation(e.target.value)} placeholder={placeholder} />
          <div className="hint">{kind === "local" ? "A folder of its own, ideally on another disk." : <>Set the remote up on the server first with <span className="mono">rclone config</span>; S3, Google Drive, SFTP and Backblaze all work this way.</>}</div>
        </div>
        <div><label className="label" htmlFor="dest-keep">Keep here</label>
          <select id="dest-keep" className="input select" value={keepLast} onChange={(e) => setKeepLast(e.target.value)}>
            <option value="">As many as each schedule keeps</option>
            {[1, 3, 7, 14, 30].map((n) => <option key={n} value={n}>Only the last {n} of each</option>)}
          </select>
        </div>
      </div>
    </Dialog>
  );
}

function EditDestinationDialog({ d, onClose }: { d: any; onClose: () => void }) {
  const utils = trpc.useContext();
  const [name, setName] = useState<string>(d.name);
  const [keepLast, setKeepLast] = useState<string>(d.keepLast ? String(d.keepLast) : "");
  const save = trpc.backup.updateDestination.useMutation({
    onSuccess: () => { toast.success("Destination saved"); utils.backup.destinations.invalidate(); utils.backup.policies.invalidate(); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const options = Array.from(new Set([1, 3, 7, 14, 30, ...(d.keepLast ? [d.keepLast] : [])])).sort((a, b) => a - b);
  return (
    <Dialog open onClose={onClose} title={`Edit ${d.name}`} subtitle={d.location ?? undefined}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!name.trim() || save.isLoading} onClick={() => save.mutate({ id: d.id, name: name.trim(), keepLast: keepLast ? Number(keepLast) : null })}>{save.isLoading ? <Spinner /> : "Save"}</button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <div><label className="label" htmlFor="edit-dest-name">Name</label><input id="edit-dest-name" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div><label className="label" htmlFor="edit-dest-keep">Keep here</label>
          <select id="edit-dest-keep" className="input select" value={keepLast} onChange={(e) => setKeepLast(e.target.value)}>
            <option value="">As many as each schedule keeps</option>
            {options.map((n) => <option key={n} value={n}>Only the last {n} of each</option>)}
          </select>
          <div className="hint">Older copies here are removed after the next backup. The newest good one is never removed.</div>
        </div>
      </div>
    </Dialog>
  );
}

function BackupsInner() {
  useCrumbs([{ label: "Data" }, { label: "Backups" }]);
  const can = useCan();
  const isAdmin = useAuth().user?.role === "admin";
  const params = useSearchParams();
  const router = useRouter();
  const utils = trpc.useContext();
  const targetKey = params.get("target");
  const [kind, setKind] = useState<"all" | "database" | "volume">("all");
  const ov = trpc.backup.overview.useQuery(undefined, { refetchInterval: 30_000 });
  const hist = trpc.backup.history.useQuery({ kind, limit: 60, ...(targetKey ? { targetKey } : {}) }, { refetchInterval: (data: any) => ((data ?? []).some((b: any) => b.status === "queued" || b.status === "running") ? 3000 : 30_000) });
  const pols = trpc.backup.policies.useQuery();
  const dests = trpc.backup.destinations.useQuery();
  const [dialog, setDialog] = useState<null | { kind: "now" } | { kind: "schedule"; policy?: any } | { kind: "dest" } | { kind: "editDest"; d: any } | { kind: "restore"; target: TargetRef; backupId: string }>(null);
  const onError = (e: unknown) => toast.error(errMsg(e));
  const retry = trpc.backup.retry.useMutation({ onSuccess: () => { toast.success("Trying again"); utils.backup.history.invalidate(); }, onError });
  const toggle = trpc.backup.setPolicyEnabled.useMutation({ onSuccess: () => { utils.backup.policies.invalidate(); utils.backup.overview.invalidate(); }, onError });
  const check = trpc.backup.checkDestination.useMutation({ onSuccess: (r: any) => { (r.ok ? toast.success : toast.error)(r.message); utils.backup.destinations.invalidate(); }, onError });
  const removeDest = trpc.backup.removeDestination.useMutation({ onSuccess: () => { toast.success("Destination removed"); utils.backup.destinations.invalidate(); utils.backup.policies.invalidate(); }, onError });
  const [removing, setRemoving] = useState<string | null>(null);
  const o: any = ov.data;
  const history: any[] = (hist.data as any[]) ?? [];
  const policies: any[] = (pols.data as any[]) ?? [];
  const destinations: any[] = dests.data?.destinations ?? [];
  const next = o?.nextRun ? nextLabel(o.nextRun.at) : null;
  const filteredName = targetKey ? history[0]?.targetName ?? policies.find((p) => p.targetKey === targetKey)?.targetName : null;

  const stats = useMemo(() => o ? [
    { label: "Last 24 hours", value: o.last24h.done ? `${o.last24h.ok + o.last24h.partial} of ${o.last24h.done}` : "None", sub: o.last24h.failed ? `${o.last24h.failed} failed · ${o.last24h.failedNames.slice(0, 2).join(", ")}` : o.last24h.partial ? `${o.last24h.partial} with a failed copy` : o.last24h.done ? "all done" : "no backups ran", tone: o.last24h.failed ? "bad" : o.last24h.partial ? "warn" : "" },
    { label: "Stored", value: size(o.storedBytes), sub: `across ${o.destinations} destination${o.destinations === 1 ? "" : "s"}`, tone: "" },
    { label: "Checksums", value: !o.checksums.copies ? "–" : o.checksums.verified === o.checksums.copies ? "All match" : `${o.checksums.copies - o.checksums.verified} not verified`, sub: "verified after upload", tone: !o.checksums.copies ? "" : o.checksums.verified === o.checksums.copies ? "ok" : "warn" },
    { label: "Next run", value: next ? next.value : "–", sub: o.nextRun ? `${o.nextRun.sameDay} schedule${o.nextRun.sameDay === 1 ? "" : "s"} ${next!.when}` : "nothing scheduled", tone: "" },
  ] : [], [o, next]);

  return (
    <div className="page">
      <PageHeader
        title="Backups"
        description="Databases and files, checksummed with SHA-256, retried up to 3 times, copied to every destination."
        actions={can("backup.run") ? <><button className="btn btn-lg" onClick={() => setDialog({ kind: "schedule" })}>New schedule</button><button className="btn btn-primary btn-lg" onClick={() => setDialog({ kind: "now" })}><Archive size={16} /> Back up now</button></> : undefined}
      />

      <div className="grid g4" style={{ marginBottom: 20 }}>
        {ov.isLoading ? [0, 1, 2, 3].map((i) => <Skeleton key={i} h={92} />) : stats.map((s) => (
          <div key={s.label} className="card card-pad stat">
            <div className="k">{s.label}</div>
            <div className="v" style={{ fontSize: 22 }}>{s.value}</div>
            <div className={cx("s", s.tone === "bad" && "bad-text", s.tone === "ok" && "ok-text", s.tone === "warn" && "warn-text")}>{s.sub}</div>
          </div>
        ))}
      </div>

      <div className="side-layout" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px" }}>
        <section aria-label="Backup history" className="card">
          <div className="card-head" style={{ flexWrap: "wrap" }}>
            <h3 className="grow">History{filteredName ? ` · ${filteredName}` : ""}</h3>
            {targetKey && <button className="btn btn-sm btn-ghost" onClick={() => router.replace("/backups")}>Show all</button>}
            <div className="seg" role="group" aria-label="Kind">
              {([["all", "All"], ["database", "Databases"], ["volume", "Files"]] as const).map(([k, l]) => <button key={k} type="button" aria-pressed={kind === k} className={cx(kind === k && "on")} onClick={() => setKind(k)}>{l}</button>)}
            </div>
          </div>
          {hist.isLoading ? <div className="card-body"><Skeleton h={200} /></div> : history.length === 0 ? (
            <Empty icon={<Archive size={20} />} title="No backups yet">{can("backup.run") ? "Back up now, or set a schedule so it happens on its own." : "Backups of the apps you can see show here."}</Empty>
          ) : (
            <div className="list">
              {history.map((h) => {
                const failedRow = h.status === "failed";
                const live = h.status === "queued" || h.status === "running";
                const meta = failedRow ? h.error : live ? (h.status === "queued" ? "Waiting for the worker…" : `Running${h.attempts > 1 ? ` · attempt ${h.attempts} of 3` : ""}…`) :
                  [h.fileName, size(h.sizeBytes), h.copies.some((c: any) => c.verified) ? "sha256 ✓" : "not verified", took(h.durationMs)].filter(Boolean).join(" · ");
                const ref = refOf(h.targetKey);
                return (
                  <div key={h.id} className="row wrap" style={{ gap: "10px 14px", padding: "13px 18px" }}>
                    <span className={cx("dot", backupTone(h.status), live && "pulse")} title={backupLabel[h.status]} />
                    <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 3, flexBasis: 220, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{h.targetName} <span className="muted" style={{ fontWeight: 400 }}>· {h.kind}{h.trigger === "safety" ? " · safety backup" : h.trigger === "schedule" ? "" : h.trigger === "retry" ? " · retry" : ""}</span></span>
                      <span className={cx("small mono ellipsis", failedRow ? "bad-text" : "muted")} title={meta ?? undefined}>{meta}</span>
                      {h.status === "partial" && <span className="small warn-text">{h.error}</span>}
                    </span>
                    <span className="row" style={{ gap: 6 }}>
                      {h.copies.map((c: any) => <span key={c.destinationId} className={cx("badge", !c.ok || !c.verified ? "bad" : "", c.removed && "faint")} title={c.removed ? "Removed by the keep rule" : c.error ?? (c.verified ? "Copied and checked" : "")} style={c.removed ? { textDecoration: "line-through" } : undefined}>{c.name}</span>)}
                    </span>
                    <span className="small muted" style={{ width: 70, textAlign: "right" }}>{timeAgo(h.finishedAt ?? h.createdAt)}</span>
                    {h.restorable && can("backup.restore") && ref && <button className="btn btn-sm" onClick={() => setDialog({ kind: "restore", target: ref, backupId: h.id })}>Restore</button>}
                    {failedRow && can("backup.run") && <button className="btn btn-sm" disabled={retry.isLoading} onClick={() => retry.mutate({ id: h.id })}><RefreshCw size={12} /> Retry</button>}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <div className="stack" style={{ gap: 20 }}>
          <section className="card">
            <div className="card-head"><h3 className="grow">Schedules</h3>{next && <span className="small faint">next {next.value} {next.when}</span>}</div>
            {pols.isLoading ? <div className="card-body"><Skeleton h={80} /></div> : policies.length === 0 ? (
              <div className="card-body small muted">None yet. {can("backup.run") ? <button className="link" onClick={() => setDialog({ kind: "schedule" })}>New schedule</button> : null}</div>
            ) : (
              <div className="list">
                {policies.map((p) => (
                  <div key={p.id} className="row" style={{ gap: 12, padding: "12px 18px" }}>
                    <button className="grow" style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0, textAlign: "left" }} onClick={() => can("backup.run") && setDialog({ kind: "schedule", policy: p })} disabled={!can("backup.run")}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{p.targetName}</span>
                      <span className="small muted">{p.words} · keep {p.keep} · {p.destinations.join(" + ") || "This server"}</span>
                    </button>
                    <span className="switch" title={p.enabled ? "On" : "Paused"}>
                      <input type="checkbox" aria-label={`Schedule for ${p.targetName} enabled`} checked={p.enabled} disabled={!can("backup.run") || toggle.isLoading} onChange={(e) => toggle.mutate({ id: p.id, enabled: e.target.checked })} /><span />
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card">
            <div className="card-head"><h3 className="grow">Destinations</h3>{isAdmin && <button className="btn btn-sm" onClick={() => setDialog({ kind: "dest" })}><Plus size={12} /> Add</button>}</div>
            {dests.isLoading ? <div className="card-body"><Skeleton h={80} /></div> : (
              <div className="list">
                {destinations.map((d) => (
                  <div key={d.id} className="row" style={{ gap: 12, padding: "12px 18px" }}>
                    <span className="mono" aria-hidden style={{ width: 32, height: 32, borderRadius: 8, display: "grid", placeItems: "center", flexShrink: 0, fontSize: 11, fontWeight: 700, background: "var(--active)" }}>{MONO[d.kind] ?? "··"}</span>
                    <span className="grow" style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{d.name}{d.lastCheckOk === false && <span className="badge bad" style={{ marginLeft: 6 }} title={d.lastCheckMessage ?? undefined}>Check failed</span>}</span>
                      <span className="small muted mono ellipsis" title={d.location ?? undefined}>{d.location ?? (d.kind === "local" ? "On this server" : "rclone remote")}{d.keepLast ? ` · last ${d.keepLast} only` : ""}</span>
                    </span>
                    <span className="small muted">{size(d.usedBytes)}</span>
                    {isAdmin && <button className="icon-btn" aria-label={`Check ${d.name}`} title="Check: write a test file, read it back, remove it" disabled={check.isLoading} onClick={() => check.mutate({ id: d.id })}>{check.isLoading && (check.variables as any)?.id === d.id ? <Spinner size={13} /> : <ShieldCheck size={14} />}</button>}
                    {isAdmin && <button className="icon-btn" aria-label={`Edit ${d.name}`} title="Name and how many it keeps" onClick={() => setDialog({ kind: "editDest", d })}><Pencil size={14} /></button>}
                    {isAdmin && !d.builtIn && (removing === d.id
                      ? <button className="btn btn-sm btn-danger" onClick={() => removeDest.mutate({ id: d.id })}>Remove?</button>
                      : <button className="icon-btn" aria-label={`Remove ${d.name}`} title="Remove (files already there stay)" onClick={() => setRemoving(d.id)}><Trash2 size={14} /></button>)}
                  </div>
                ))}
              </div>
            )}
            {destinations.length === 1 && isAdmin && <div className="card-body small"><span className="warn-text row" style={{ gap: 6 }}><AlertTriangle size={13} />Only this server: add a destination somewhere else.</span></div>}
          </section>

          <Link href="/backup-cli" className="card card-pad row small muted hoverable" style={{ gap: 10 }}><BookOpen size={15} /> Backing up databases on other servers? Use the dbbkp command-line tool.</Link>
        </div>
      </div>

      {dialog?.kind === "now" && <BackupNowDialog onClose={() => setDialog(null)} />}
      {dialog?.kind === "schedule" && <ScheduleDialog policy={dialog.policy} onClose={() => setDialog(null)} />}
      {dialog?.kind === "dest" && <AddDestinationDialog kinds={dests.data?.kinds ?? []} onClose={() => setDialog(null)} />}
      {dialog?.kind === "editDest" && <EditDestinationDialog d={dialog.d} onClose={() => setDialog(null)} />}
      {dialog?.kind === "restore" && <RestoreDialog target={dialog.target} backupId={dialog.backupId} onClose={() => setDialog(null)} />}
    </div>
  );
}

export default function BackupsPage() {
  return <Suspense><BackupsInner /></Suspense>;
}
