"use client";

import { useState } from "react";
import Link from "next/link";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { Dialog, Skeleton, Spinner, bytes, cx, errMsg, timeAgo } from "@/components/ui";
import { memText } from "@/components/FitCheck";

/** Settings > Server: what each app uses. Admins only (the query fails for anyone else and the card stays hidden). */
export function UsageTable() {
  const q = trpc.system.usage.useQuery(undefined, { retry: false, refetchOnWindowFocus: false, refetchInterval: 60_000 });
  const d = q.data as any;
  if (q.isError) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h3>Usage by app</h3>
        {d && <span className="right small faint">Images {bytes(d.totals.imagesBytes)} · storage {bytes(d.totals.storageBytes)} · source {bytes(d.totals.sourceBytes)}</span>}
      </div>
      {q.isLoading ? (
        <div className="card-body"><Skeleton h={90} /></div>
      ) : d.apps.length === 0 ? (
        <div className="card-body small muted">No apps yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 760 }}>
            <thead>
              <tr><th>App</th><th>Memory now</th><th>CPU</th><th>Images</th><th>Storage</th><th>Source</th></tr>
            </thead>
            <tbody>
              {d.apps.map((a: any) => {
                const pct = a.memoryMb == null ? null : Math.round((a.memoryMb / a.memoryLimitMb) * 100);
                return (
                  <tr key={a.id}>
                    <td><Link href={`/apps/${a.id}`} className="mono" style={{ color: "var(--link)" }}>{a.domain}</Link></td>
                    <td>
                      {a.memoryMb == null ? (
                        <span className="faint">{a.running ? "–" : "Stopped"} <span className="small">· limit {memText(a.memoryLimitMb)}</span></span>
                      ) : (
                        <span className={cx(pct! >= 90 && "bad-text", pct! >= 75 && pct! < 90 && "warn-text")}>{memText(a.memoryMb)} <span className="small faint">of {memText(a.memoryLimitMb)} ({pct}%)</span></span>
                      )}
                    </td>
                    <td className="muted">{a.cpuPct == null ? "–" : `${a.cpuPct}%`}</td>
                    <td className="muted">{bytes(a.imagesBytes)} <span className="small faint">· {a.images}</span></td>
                    <td className="muted">{a.storageBytes == null ? "Not measured" : bytes(a.storageBytes)}</td>
                    <td className="muted">{bytes(a.sourceBytes)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-body small faint" style={{ borderTop: "1px solid var(--border)" }}>
        Largest on disk first. Images that share layers are counted once per app, so the columns can add up to more than the disk really holds.
      </div>
    </div>
  );
}

const RUN_LABEL: Record<string, string> = { manual: "By hand", weekly: "Weekly", disk: "Disk above 85%" };

/** Settings > Server: what can be freed. Safe items go with one button; anything that may hold data needs its name typed. */
export function CleanupCard() {
  const utils = trpc.useContext();
  const q = trpc.system.cleanupPlan.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const d = q.data as any;
  const [off, setOff] = useState<Record<string, boolean>>({});
  const [target, setTarget] = useState<any>(null);
  const [typed, setTyped] = useState("");
  const done = (run: any) => {
    const errors = (run.results ?? []).flatMap((r: any) => r.errors);
    toast.success(`Freed ${bytes(run.freedBytes)}${errors.length ? `. ${errors.length} item${errors.length === 1 ? "" : "s"} could not be removed.` : ""}`);
    utils.system.cleanupPlan.invalidate();
    utils.system.usage.invalidate();
    utils.system.overview.invalidate();
  };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const clean = trpc.system.cleanup.useMutation({ onSuccess: done, onError });
  const remove = trpc.system.cleanupRemove.useMutation({ onSuccess: (r) => { setTarget(null); setTyped(""); done(r); }, onError });
  const auto = trpc.system.setAutoCleanup.useMutation({ onSuccess: () => utils.system.cleanupPlan.invalidate(), onError });
  if (q.isError) return null;

  const safe = ((d?.items as any[]) ?? []).filter((i) => i.safe);
  const careful = ((d?.items as any[]) ?? []).filter((i) => !i.safe);
  // Shared caches start unticked when other software uses the same engine.
  const on = (i: any) => !(off[i.kind] ?? (i.shared && d.sharedEngine));
  const chosen = safe.filter(on);
  const total = chosen.reduce((n, i) => n + i.bytes, 0);

  return (
    <div className="card">
      <div className="card-head">
        <h3>Cleanup</h3>
        {d && (
          <label className="right row small muted" style={{ gap: 8, cursor: "pointer" }}>
            Clean up automatically
            <span className="switch">
              <input type="checkbox" checked={d.settings.auto} disabled={auto.isLoading} onChange={(e) => auto.mutate({ auto: e.target.checked })} />
              <span />
            </span>
          </label>
        )}
      </div>
      {q.isLoading ? (
        <div className="card-body"><Skeleton h={90} /></div>
      ) : (
        <>
          {safe.length === 0 ? (
            <div className="card-body small muted">Nothing to clean right now.</div>
          ) : (
            <>
              {safe.map((i) => (
                <label key={i.kind} className="attn-row" style={{ cursor: "pointer" }}>
                  <input type="checkbox" checked={on(i)} onChange={(e) => setOff({ ...off, [i.kind]: !e.target.checked })} style={{ accentColor: "var(--link)" }} />
                  <div className="grow">
                    <div style={{ fontWeight: 550 }}>{i.title}{i.shared && d.sharedEngine && <span className="badge warn" style={{ marginLeft: 8 }}>Shared with other software</span>}</div>
                    <div className="small muted">{i.detail}</div>
                  </div>
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>{i.bytes ? bytes(i.bytes) : `${i.count} item${i.count === 1 ? "" : "s"}`}</span>
                </label>
              ))}
              <div className="card-body row" style={{ borderTop: "1px solid var(--border)" }}>
                <span className="small muted grow">Removes only what no app needs. Running apps, their data and the builds kept for rollback are not touched.</span>
                <button className="btn btn-primary" disabled={chosen.length === 0 || clean.isLoading} onClick={() => clean.mutate({ kinds: chosen.map((i) => i.kind) })}>
                  {clean.isLoading ? <Spinner /> : <><Trash2 size={14} /> Clean up{total ? ` (about ${bytes(total)})` : ""}</>}
                </button>
              </div>
            </>
          )}

          {careful.length > 0 && (
            <>
              <div className="card-body small" style={{ borderTop: "1px solid var(--border)", paddingBottom: 6 }}>
                <strong>Belongs to no app</strong> <span className="muted">· may hold data, never removed automatically</span>
              </div>
              {careful.map((i) => (
                <div key={i.kind + i.targets[0]} className="attn-row">
                  <div className="grow">
                    <div className="mono" style={{ fontWeight: 550 }}>{i.targets[0]}</div>
                    <div className="small muted">{i.detail}</div>
                  </div>
                  <span className="muted" style={{ whiteSpace: "nowrap" }}>{i.bytes ? bytes(i.bytes) : "Size unknown"}</span>
                  <button className="btn btn-sm btn-danger" onClick={() => { setTarget(i); setTyped(""); }}>Remove…</button>
                </div>
              ))}
            </>
          )}

          <div className="card-body small faint" style={{ borderTop: "1px solid var(--border)" }}>
            {d.settings.auto ? "Runs once a week, and at once when the disk passes 85%. Safe items only" : "Automatic cleanup is off"}
            {d.settings.auto && d.sharedEngine ? "; build cache and untagged images are left alone because other software uses Docker on this server." : "."}
            {d.runs[0] && <> Last run {timeAgo(d.runs[0].createdAt)} ({RUN_LABEL[d.runs[0].trigger] ?? d.runs[0].trigger}): freed {bytes(d.runs[0].freedBytes)}.</>}
          </div>
        </>
      )}

      <Dialog
        open={!!target}
        onClose={() => setTarget(null)}
        title={target?.kind === "orphan-volume" ? "Remove this storage volume?" : "Remove this folder?"}
        subtitle="This cannot be undone."
        footer={
          <>
            <button className="btn" onClick={() => setTarget(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={!target || typed !== target.targets[0] || remove.isLoading} onClick={() => remove.mutate({ kind: target.kind, target: target.targets[0], confirm: typed })}>
              {remove.isLoading ? <Spinner /> : "Remove for good"}
            </button>
          </>
        }
      >
        {target && (
          <div className="stack">
            <div className="notice bad small">{target.detail} Everything in it is deleted{target.bytes ? ` (${bytes(target.bytes)})` : ""}.</div>
            <div>
              <label className="label" htmlFor="cleanup-confirm">Type <span className="mono">{target.targets[0]}</span> to confirm</label>
              <input id="cleanup-confirm" className="input mono" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
