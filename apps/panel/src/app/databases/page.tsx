"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Database, Eye, Plus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { useAuth } from "@/components/AuthProvider";
import { useCan } from "@/components/useCan";
import { CopyButton, Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg } from "@/components/ui";
import { EngineTile, LastBackup, ScheduleDialog, size } from "@/components/data/shared";
import { RestoreDialog } from "@/components/data/RestoreDialog";

/**
 * Data · Databases: PostgreSQL databases on this server and connected ones, with size, last backup and schedule.
 * The selected one shows its connection string (password hidden), the app that uses it and its backup policy.
 */

function AppPicker({ value, onChange, allowNone }: { value: string; onChange: (v: string) => void; allowNone: boolean }) {
  const sites = trpc.sites.list.useQuery(undefined, { staleTime: 30_000 });
  return (
    <select id="db-app" className="input select" value={value} onChange={(e) => onChange(e.target.value)}>
      {allowNone && <option value="">No app (only admins see it)</option>}
      {!allowNone && <option value="">Choose the app</option>}
      {((sites.data ?? []) as any[]).filter((s) => !s.isPreview).map((s) => <option key={s.id} value={s.id}>{s.domain.split(".")[0]}</option>)}
    </select>
  );
}

function NewDatabaseDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useContext();
  const isAdmin = useAuth().user?.role === "admin";
  const [name, setName] = useState("");
  const [user, setUser] = useState("");
  const [siteId, setSiteId] = useState("");
  const [engine, setEngine] = useState<"pgsql" | "mysql">("pgsql");
  const create = trpc.database.create.useMutation({ onSuccess: () => { utils.database.list.invalidate(); utils.database.count.invalidate(); }, onError: (e) => toast.error(errMsg(e)) });
  const made: any = create.data;
  const rule = /^[a-z0-9_]{3,30}$/;
  if (made) {
    return (
      <Dialog open onClose={onClose} title={`${made.instance.name} is being made`} subtitle="The worker creates it in a few seconds." footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <div className="stack" style={{ gap: 12 }}>
          <div className="notice warn small"><AlertTriangle size={14} />Copy the password now. Deploy King shows it this once and does not keep it; put it in the app's variables.</div>
          <dl className="kv"><dt>User</dt><dd className="mono">{made.credentials.username}</dd><dt>Password</dt><dd className="mono">{made.credentials.password}</dd><dt>Host</dt><dd className="mono">{made.credentials.host}:{made.credentials.port}</dd></dl>
          <div className="row" style={{ gap: 8 }}><code className="inline-code grow ellipsis" style={{ padding: "8px 10px" }}>{made.credentials.url}</code><CopyButton text={made.credentials.url} /></div>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog open onClose={onClose} title="New database" subtitle="On this server's PostgreSQL. Backed up like everything else once it has a schedule."
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!rule.test(name) || !rule.test(user) || (!isAdmin && !siteId) || engine !== "pgsql" || create.isLoading} onClick={() => create.mutate({ name, dbUser: user, type: engine, ...(siteId ? { siteId } : {}) })}>{create.isLoading ? <Spinner /> : "Create database"}</button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <fieldset className="plain"><legend className="label">Engine</legend>
          <div className="choice-grid">
            <label className={cx("choice", engine === "pgsql" && "on")}><input type="radio" name="engine" checked={engine === "pgsql"} onChange={() => setEngine("pgsql")} /><span><span style={{ fontWeight: 550 }}>PostgreSQL</span><span className="small muted">On this server</span></span></label>
            <label className="choice" style={{ opacity: 0.55, cursor: "not-allowed" }} title="Not available yet"><input type="radio" name="engine" disabled /><span><span style={{ fontWeight: 550 }}>MySQL</span><span className="small muted">Not available yet</span></span></label>
          </div>
        </fieldset>
        <div><label className="label" htmlFor="db-name">Name</label><input id="db-name" className="input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="shop_db" autoFocus /><div className="hint">3 to 30 lowercase letters, digits and _.</div></div>
        <div><label className="label" htmlFor="db-user">User</label><input id="db-user" className="input mono" value={user} onChange={(e) => setUser(e.target.value.toLowerCase())} placeholder="shop" /></div>
        <div><label className="label" htmlFor="db-app">For the app</label><AppPicker value={siteId} onChange={setSiteId} allowNone={isAdmin} /></div>
      </div>
    </Dialog>
  );
}

function ConnectDialog({ onClose }: { onClose: () => void }) {
  const utils = trpc.useContext();
  const isAdmin = useAuth().user?.role === "admin";
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [siteId, setSiteId] = useState("");
  const connect = trpc.database.connectExisting.useMutation({
    onSuccess: (r: any) => { toast.success(`Connected: PostgreSQL ${r.version}, ${size(r.sizeBytes)}`); utils.database.list.invalidate(); utils.database.count.invalidate(); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onClose={onClose} title="Connect an existing database" subtitle="Deploy King checks that it answers, then backs it up and restores it like its own."
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!/^[a-z0-9_]{3,30}$/.test(name) || url.length < 10 || (!isAdmin && !siteId) || connect.isLoading} onClick={() => connect.mutate({ name, url, ...(siteId ? { siteId } : {}) })}>{connect.isLoading ? <Spinner /> : "Connect"}</button></>}>
      <div className="stack" style={{ gap: 14 }}>
        <div><label className="label" htmlFor="cx-name">Name in Deploy King</label><input id="cx-name" className="input mono" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} placeholder="analytics" autoFocus /></div>
        <div><label className="label" htmlFor="cx-url">Connection URL</label><input id="cx-url" className="input mono" type="password" autoComplete="off" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="postgres://user:password@host:5432/database" /><div className="hint">Stored encrypted. The panel only ever shows it with the password hidden.</div></div>
        <div><label className="label" htmlFor="db-app">For the app</label><AppPicker value={siteId} onChange={setSiteId} allowNone={isAdmin} /></div>
        <div className="notice small"><AlertTriangle size={14} />PostgreSQL only. MySQL and connecting through an SSH tunnel are not available yet.</div>
      </div>
    </Dialog>
  );
}

function Details({ d, onSchedule, onRestore }: { d: any; onSchedule: () => void; onRestore: () => void }) {
  const can = useCan();
  const isAdmin = useAuth().user?.role === "admin";
  const reveal = trpc.database.revealConnection.useMutation({ onError: (e) => toast.error(errMsg(e)) });
  const shown: any = reveal.data;
  const p = d.policy;
  return (
    <aside aria-label={`${d.name} details`} className="stack" style={{ gap: 16 }}>
      <section className="card card-pad stack" style={{ gap: 14 }}>
        <div className="row"><h2 className="grow mono" style={{ fontSize: 15, fontWeight: 600 }}>{d.name}</h2><span className={cx("badge", d.state === "running" ? "ok" : "bad")}>{d.state === "running" ? "Running" : "Not answering"}</span></div>
        {d.stateError && <div className="small bad-text" style={{ overflowWrap: "anywhere" }}>{d.stateError}</div>}
        <dl className="kv" style={{ gridTemplateColumns: "auto minmax(0, 1fr)" }}>
          <dt>Engine</dt><dd style={{ textAlign: "right" }}>{d.engine}{d.version ? ` ${d.version}` : ""}</dd>
          <dt>Internal host</dt><dd className="mono" style={{ textAlign: "right" }}>{d.host}:{d.port}</dd>
          <dt>User</dt><dd className="mono" style={{ textAlign: "right" }}>{d.dbUser}</dd>
          <dt>Where</dt><dd style={{ textAlign: "right" }}>{d.external ? "Connected by URL" : "This server"}</dd>
          <dt>Size</dt><dd style={{ textAlign: "right" }}>{size(d.sizeBytes)}</dd>
          <dt>Public access</dt><dd className="faint" style={{ textAlign: "right" }} title="Opening a database to the internet from here is not available yet. Deploy King does not change who can reach it.">Not managed here yet</dd>
        </dl>
        <div className="stack" style={{ gap: 8 }}>
          <code className="mono" style={{ padding: "9px 10px", borderRadius: 8, background: "var(--bg)", border: "1px solid var(--border)", fontSize: 11.5, color: "var(--muted)", overflowWrap: "anywhere", lineHeight: 1.5 }} title={shown ? undefined : "The password is hidden"}>{shown?.url ?? d.connection}</code>
          <div className="row" style={{ gap: 8, justifyContent: "flex-end" }}>
            {isAdmin && !shown && <button className="btn btn-sm" onClick={() => reveal.mutate({ id: d.id })} disabled={reveal.isLoading} title="Shows the password (this is written to the audit log)"><Eye size={13} /> Show password</button>}
            <CopyButton text={shown?.url ?? d.connection.replace("••••••", "PASSWORD")} />
          </div>
        </div>
        <span className="small muted">
          {d.variable ? <>Added to <Link className="link" href={`/apps/${d.app?.id}?tab=variables`}>{d.variable.app}</Link> as <span className="mono">{d.variable.key}</span>.</> : d.app ? <>Used by <Link className="link" href={`/apps/${d.app.id}`}>{d.app.name}</Link>; no variable of it holds this URL yet.</> : "Not used by an app."}
          {shown ? ` Shown from ${shown.from}.` : ""}
        </span>
      </section>

      <section className="card card-pad stack" style={{ gap: 12 }}>
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>Backup policy</h2>
        {p ? (
          <span className="small" style={{ lineHeight: 1.6, color: "var(--muted)" }}>
            {p.words}{p.timezone !== "UTC" ? ` (${p.timezone})` : ""} · keep {p.keep} · copied to {p.destinations.join(" and ") || "This server"} · SHA-256 verified{!p.enabled ? " · paused" : ""}
          </span>
        ) : (
          <span className="small muted">No schedule yet. Back up now makes a copy on This server.</span>
        )}
        <div className="row wrap" style={{ gap: 8 }}>
          <Link className="btn" href={`/backups?target=db:${d.id}`}>View backups</Link>
          {can("backup.run") && <button className="btn" onClick={onSchedule}>{p ? "Edit schedule" : "Set a schedule"}</button>}
          {can("backup.restore") && <button className="btn btn-primary" onClick={onRestore} disabled={d.type === "mysql"}>Restore…</button>}
        </div>
      </section>
    </aside>
  );
}

function DatabasesInner() {
  useCrumbs([{ label: "Data" }, { label: "Databases" }]);
  const can = useCan();
  const router = useRouter();
  const params = useSearchParams();
  const utils = trpc.useContext();
  const q = trpc.database.list.useQuery(undefined, { refetchInterval: (data: any) => ((data ?? []).some((d: any) => d.backingUp) ? 3000 : 30_000) });
  const rows: any[] = (q.data as any[]) ?? [];
  const selectedId = params.get("id") ?? rows[0]?.id ?? null;
  const selected = useMemo(() => rows.find((r) => r.id === selectedId) ?? rows[0], [rows, selectedId]);
  const [dialog, setDialog] = useState<null | "new" | "connect" | "schedule" | "restore">(null);
  const backup = trpc.backup.runNow.useMutation({
    onSuccess: () => { toast.success("Backup started"); utils.database.list.invalidate(); utils.backup.history.invalidate(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const mayCreate = can("database.create");
  useEffect(() => { if (params.get("id") && rows.length && !rows.some((r) => r.id === params.get("id"))) router.replace("/databases"); }, [params, rows, router]);

  return (
    <div className="page">
      <PageHeader
        title="Databases"
        description="PostgreSQL and MySQL your apps use: connection details, backups and restores in one place."
        actions={mayCreate ? <><button className="btn btn-lg" onClick={() => setDialog("connect")}>Connect existing</button><button className="btn btn-primary btn-lg" onClick={() => setDialog("new")}><Plus size={16} /> New database</button></> : undefined}
      />
      {q.isLoading ? <Skeleton h={320} /> : q.error ? (
        <div className="notice bad"><AlertTriangle size={15} />{errMsg(q.error)}</div>
      ) : rows.length === 0 ? (
        <div className="card"><Empty icon={<Database size={20} />} title="No databases yet" action={mayCreate ? <button className="btn btn-primary" onClick={() => setDialog("new")}><Plus size={14} /> New database</button> : undefined}>{mayCreate ? "Make one on this server, or connect one you already have." : "Databases of the apps you can see show here."}</Empty></div>
      ) : (
        <div className="side-layout" style={{ gridTemplateColumns: "minmax(0, 1fr) 340px" }}>
          <section aria-label="Databases" className="card" style={{ overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 620 }}>
              <thead><tr><th>Database</th><th>Size</th><th>Last backup</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className="click" aria-selected={selected?.id === d.id} style={selected?.id === d.id ? { background: "var(--card-2)" } : undefined} onClick={() => router.replace(`/databases?id=${d.id}`)}>
                    <td>
                      <span className="row" style={{ gap: 12, minWidth: 0 }}>
                        <EngineTile engine={d.type} />
                        <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                          <span className="mono" style={{ fontWeight: 600 }}>{d.name}</span>
                          <span className="small muted ellipsis">{d.engineLabel} · {d.app ? d.app.name : d.external ? "Connected by URL" : "No app"}</span>
                        </span>
                      </span>
                    </td>
                    <td className="mono small">{d.state === "running" ? size(d.sizeBytes) : <span className="bad-text" title={d.stateError ?? undefined}>Not answering</span>}</td>
                    <td>
                      <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        <LastBackup last={d.lastBackup} running={d.backingUp} />
                        <span className="small faint">{d.policy ? `${d.policy.words}${d.policy.enabled ? "" : " (paused)"} · keep ${d.policy.keep}` : "No schedule"}</span>
                      </span>
                    </td>
                    <td style={{ textAlign: "right" }}>
                      {can("backup.run") && <button className="btn btn-sm" disabled={d.backingUp || d.type === "mysql" || backup.isLoading} title={d.type === "mysql" ? "MySQL backups are not available yet" : undefined} onClick={(e) => { e.stopPropagation(); backup.mutate({ target: { type: "database", id: d.id } }); }}>Back up now</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {selected && <Details d={selected} onSchedule={() => setDialog("schedule")} onRestore={() => setDialog("restore")} />}
        </div>
      )}
      {dialog === "new" && <NewDatabaseDialog onClose={() => setDialog(null)} />}
      {dialog === "connect" && <ConnectDialog onClose={() => setDialog(null)} />}
      {dialog === "schedule" && selected && <ScheduleDialog target={{ type: "database", id: selected.id }} targetName={selected.name} policy={selected.policy} onClose={() => setDialog(null)} />}
      {dialog === "restore" && selected && <RestoreDialog target={{ type: "database", id: selected.id }} onClose={() => setDialog(null)} />}
    </div>
  );
}

export default function DatabasesPage() {
  return <Suspense><DatabasesInner /></Suspense>;
}
