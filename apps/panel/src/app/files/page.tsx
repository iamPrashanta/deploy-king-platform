"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, Download, File as FileIcon, Folder, FolderOpen, MoreHorizontal, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { useCan } from "@/components/useCan";
import { Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg, timeAgo, useClickAway } from "@/components/ui";
import { size } from "@/components/data/shared";

/**
 * Data · Files: an app's volumes as folders, with upload, download as ZIP, back up, and an editor for one file.
 * The app's source is shown read only: it changes with each deploy.
 */

const token = () => (typeof window === "undefined" ? null : localStorage.getItem("token"));

async function download(siteId: string, volume: string | null, path: string) {
  const qs = new URLSearchParams({ siteId, path, ...(volume ? { volume } : {}) });
  const res = await fetch(`/api/files/download?${qs}`, { headers: { authorization: `Bearer ${token()}` } });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `Download failed (${res.status})`);
  const name = decodeURIComponent(/filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "download");
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

async function upload(siteId: string, volume: string, path: string, files: FileList, overwrite: boolean) {
  const body = new FormData();
  for (const f of Array.from(files)) body.append("files", f, f.name);
  const qs = new URLSearchParams({ siteId, volume, path, ...(overwrite ? { overwrite: "1" } : {}) });
  const res = await fetch(`/api/files/upload?${qs}`, { method: "POST", headers: { authorization: `Bearer ${token()}` }, body });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function RowMenu({ onDownload, onDelete }: { onDownload: () => void; onDelete?: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label="More actions" onClick={() => setOpen((o) => !o)}><MoreHorizontal size={15} /></button>
      {open && (
        <div className="menu" style={{ minWidth: 170 }}>
          <button className="mi" onClick={() => { setOpen(false); onDownload(); }}><Download size={14} /> Download</button>
          {onDelete && <button className="mi" style={{ color: "var(--red)" }} onClick={() => { setOpen(false); onDelete(); }}><Trash2 size={14} /> Delete</button>}
        </div>
      )}
    </div>
  );
}

function Editor({ siteId, volume, path, onSaved }: { siteId: string; volume: string | null; path: string; onSaved: () => void }) {
  const q = trpc.files.read.useQuery({ siteId, volume, path }, { refetchOnWindowFocus: false });
  const f: any = q.data;
  const [text, setText] = useState<string | null>(null);
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => { if (f?.content != null) { setText(f.content); setBase(f.modifiedAt ? new Date(f.modifiedAt).toISOString() : null); } }, [f?.content, f?.modifiedAt]);
  const save = trpc.files.write.useMutation({
    onSuccess: (r: any) => { toast.success("Saved to the volume"); setBase(new Date(r.modifiedAt).toISOString()); q.refetch(); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const name = path.split("/").pop();
  const dirty = f?.content != null && text !== f.content;
  return (
    <aside aria-label="Preview" className="card" style={{ flex: "1 1 300px", minWidth: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}>
      <div className="card-head">
        <span className="grow mono ellipsis" style={{ fontSize: 13, fontWeight: 600 }}>{name}</span>
        {f?.readOnly ? <span className="badge">Read only</span> : f?.content != null && (
          <button className="btn btn-primary btn-sm" disabled={!dirty || save.isLoading} onClick={() => save.mutate({ siteId, volume, path, content: text ?? "", expectedModifiedAt: base })}>{save.isLoading ? <Spinner size={12} /> : "Save"}</button>
        )}
      </div>
      {q.isLoading ? <div className="card-body"><Skeleton h={220} /></div> : q.error ? <div className="card-body small bad-text">{errMsg(q.error)}</div> : f.content == null ? (
        <div className="card-body stack small muted" style={{ gap: 10 }}>
          <span>{f.reason}</span>
          <button className="btn btn-sm" style={{ alignSelf: "flex-start" }} onClick={() => download(siteId, volume, path).catch((e) => toast.error(errMsg(e)))}><Download size={13} /> Download</button>
        </div>
      ) : (
        <textarea
          aria-label={`Contents of ${name}`}
          className="mono"
          spellCheck={false}
          readOnly={f.readOnly}
          value={text ?? ""}
          onChange={(e) => setText(e.target.value)}
          style={{ flex: 1, minHeight: 300, margin: 0, padding: "14px 16px", border: 0, outline: "none", resize: "vertical", background: "var(--code-bg)", color: "var(--text)", fontSize: 12, lineHeight: 1.7, whiteSpace: "pre", overflow: "auto" }}
        />
      )}
      {f && (
        <div className="small muted stack" style={{ gap: 6, padding: "12px 16px", borderTop: "1px solid var(--border)" }}>
          <span>{size(f.size)} · edited {timeAgo(f.modifiedAt)}</span>
          <span>{f.readOnly ? "The app's source changes with each deploy; change it in the repository." : "Edits are written straight to the volume. Take a backup first for anything important."}</span>
        </div>
      )}
    </aside>
  );
}

function FilesInner() {
  useCrumbs([{ label: "Data" }, { label: "Files" }]);
  const can = useCan();
  const router = useRouter();
  const params = useSearchParams();
  const utils = trpc.useContext();
  // Files need the right to deploy (viewers do not have it): ask only once we know.
  const me = trpc.team.me.useQuery(undefined, { staleTime: 60_000 });
  const mayOpen = me.data ? can("site.deploy") : null;
  const roots = trpc.files.roots.useQuery(undefined, { retry: false, enabled: mayOpen === true });
  const r: any = roots.data;
  const first = r?.volumes?.[0] ?? null;
  const siteId = params.get("site") ?? first?.siteId ?? r?.sources?.[0]?.siteId ?? null;
  const volume = params.get("site") ? params.get("volume") : first?.volume ?? null; // null: the source
  const path = params.get("path") ?? "/";
  const file = params.get("file");
  const go = (next: { site?: string; volume?: string | null; path?: string; file?: string | null }) => {
    const q = new URLSearchParams();
    q.set("site", next.site ?? siteId ?? "");
    const v = next.volume !== undefined ? next.volume : volume;
    if (v) q.set("volume", v);
    q.set("path", next.path ?? path);
    const f = next.file !== undefined ? next.file : null;
    if (f) q.set("file", f);
    router.replace(`/files?${q}`);
  };
  const browse = trpc.files.browse.useQuery({ siteId: siteId ?? "", volume, path }, { enabled: !!siteId, retry: false });
  const usage = trpc.files.usage.useQuery({ siteId: siteId ?? "", volume }, { enabled: !!siteId && !!volume && !browse.error, staleTime: 60_000, retry: false });
  const b: any = browse.data;
  const current = r?.volumes?.find((v: any) => v.siteId === siteId && v.volume === volume);
  const source = !volume ? r?.sources?.find((s: any) => s.siteId === siteId) : null;
  const onError = (e: unknown) => toast.error(errMsg(e));
  const refresh = () => { browse.refetch(); usage.refetch(); };
  const remove = trpc.files.remove.useMutation({ onSuccess: () => { toast.success("Deleted"); refresh(); }, onError });
  const mkdir = trpc.files.mkdir.useMutation({ onSuccess: () => { toast.success("Folder made"); setNewFolder(null); refresh(); }, onError });
  // Back up volume: follow the backup until it is done, then show it in the footer.
  const [pendingBackup, setPendingBackup] = useState<string | null>(null);
  const backup = trpc.backup.runNow.useMutation({ onSuccess: (r: any) => { toast.success("Backup of the volume started"); setPendingBackup(r.id); utils.backup.history.invalidate(); }, onError });
  const followed = trpc.backup.get.useQuery({ id: pendingBackup ?? "" }, { enabled: !!pendingBackup, refetchInterval: 2000 });
  const followedStatus = (followed.data as any)?.status as string | undefined;
  useEffect(() => {
    if (!pendingBackup || !followedStatus || followedStatus === "queued" || followedStatus === "running") return;
    if (followedStatus === "failed") toast.error(`The backup failed: ${(followed.data as any)?.error ?? "see Backups"}`);
    else toast.success(followedStatus === "ok" ? "Volume backed up" : "Volume backed up, but a copy failed: see Backups");
    setPendingBackup(null);
    browse.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [followedStatus, pendingBackup]);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const writable = !!volume && !b?.readOnly && can("site.deploy");

  const doUpload = async (files: FileList | null) => {
    if (!files?.length || !siteId || !volume) return;
    setBusy(true);
    try {
      let res = await upload(siteId, volume, path, files, false);
      if (res.status === 409 && window.confirm(`${res.data.exists ?? "A file"} is already there. Replace it?`)) res = await upload(siteId, volume, path, files, true);
      if (res.status === 200) toast.success(`Uploaded ${res.data.saved.length} file${res.data.saved.length === 1 ? "" : "s"}`);
      else if (res.status !== 409) toast.error(res.data.error ?? `Upload failed (${res.status})`);
      refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };

  const crumbs = path.split("/").filter(Boolean);
  const rootLabel = volume ?? "source";

  if (roots.error || mayOpen === false) {
    const forbidden = mayOpen === false || (roots.error as any)?.data?.code === "FORBIDDEN";
    return (
      <div className="page">
        <PageHeader title="Files" />
        {forbidden
          ? <div className="card"><Empty icon={<FolderOpen size={20} />} title="Files need deploy access">An app's files can hold secrets, so opening them needs the right to deploy that app. Ask an admin on the Team page.</Empty></div>
          : <div className="notice bad"><AlertTriangle size={15} />{errMsg(roots.error)}</div>}
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Files" description="Your apps' volumes as folders: upload, download as ZIP, back up, and edit a single file." />
      {roots.isLoading || !r ? <Skeleton h={360} /> : !r.volumes.length && !r.sources.length ? (
        <div className="card"><Empty icon={<FolderOpen size={20} />} title="No files to show yet">Volumes are added in an app's settings (for example <span className="mono">/app/uploads</span>); they show here after its first deploy.</Empty></div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 20, alignItems: "flex-start" }}>
          <nav aria-label="Storage" className="stack" style={{ flex: "1 1 200px", maxWidth: 240, gap: 14 }}>
            <div className="stack" style={{ gap: 2 }}>
              <span className="small faint" style={{ padding: "0 10px 6px", fontWeight: 550 }}>Volumes</span>
              {r.volumes.length === 0 && <span className="small faint" style={{ padding: "0 10px" }}>None yet. Add one in an app's settings.</span>}
              {r.volumes.map((v: any) => {
                const on = v.siteId === siteId && v.volume === volume;
                return (
                  <button key={`${v.siteId}:${v.volume}`} onClick={() => go({ site: v.siteId, volume: v.volume, path: "/", file: null })} style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", borderRadius: 8, textAlign: "left", background: on ? "var(--active)" : undefined }}>
                    <span style={{ fontSize: 13, fontWeight: 500 }}>{v.app} · {v.volume}</span>
                    <span className="small muted mono">{v.mountPath}</span>
                  </button>
                );
              })}
            </div>
            <div className="stack" style={{ gap: 2 }}>
              <span className="small faint" style={{ padding: "0 10px 6px", fontWeight: 550 }}>Source (read-only)</span>
              {r.sources.map((s: any) => {
                const on = s.siteId === siteId && !volume;
                return <button key={s.siteId} className="ellipsis" onClick={() => go({ site: s.siteId, volume: null, path: "/", file: null })} style={{ height: 34, padding: "0 10px", borderRadius: 8, textAlign: "left", fontSize: 13, color: on ? "var(--text)" : "var(--muted)", background: on ? "var(--active)" : undefined }}>{s.app}{s.commit ? <span className="mono"> @ {s.commit}</span> : ""}</button>;
              })}
            </div>
          </nav>

          <section aria-label="Files" className="card" style={{ flex: "999 1 520px", minWidth: 0 }}>
            <div className="card-head">
              <nav aria-label="Path" className="row mono grow" style={{ gap: 6, fontSize: 13, minWidth: 0, flexWrap: "wrap" }}>
                <button className={cx(crumbs.length ? "muted" : "")} onClick={() => go({ path: "/" })}>{current ? current.app : source?.app}/{rootLabel}</button>
                {crumbs.map((c, i) => (
                  <span key={i} className="row" style={{ gap: 6 }}><span className="faint">/</span>{i === crumbs.length - 1 ? <span>{c}</span> : <button className="muted" onClick={() => go({ path: "/" + crumbs.slice(0, i + 1).join("/") })}>{c}</button>}</span>
                ))}
              </nav>
            </div>
            <div className="row wrap" style={{ gap: 8, padding: "10px 18px", borderBottom: "1px solid var(--border)" }}>
              {writable && <>
                <input ref={picker} type="file" multiple hidden onChange={(e) => doUpload(e.target.files)} />
                <button className="btn btn-sm" disabled={busy} onClick={() => picker.current?.click()}>{busy ? <Spinner size={12} /> : <Upload size={13} />} Upload</button>
                <button className="btn btn-sm" onClick={() => setNewFolder("")}>New folder</button>
              </>}
              <button className="btn btn-sm" disabled={!b} onClick={() => siteId && download(siteId, volume, path).catch(onError)}>Download .zip</button>
              <span className="grow" />
              {volume && can("backup.run") && <button className="btn btn-primary btn-sm" disabled={backup.isLoading || !!pendingBackup} onClick={() => siteId && backup.mutate({ target: { type: "volume", siteId, volume } })}>{pendingBackup ? <><Spinner size={12} /> Backing up…</> : "Back up volume"}</button>}
            </div>
            {current && !current.reachable ? (
              <div className="card-body"><div className="notice warn small"><AlertTriangle size={14} />{current.problem}</div></div>
            ) : browse.isLoading ? <div className="card-body"><Skeleton h={220} /></div> : browse.error ? (
              <div className="card-body"><div className="notice bad small"><AlertTriangle size={14} />{errMsg(browse.error)}</div></div>
            ) : (
              <>
                <div style={{ overflowX: "auto" }}>
                  <table className="table" style={{ minWidth: 520 }}>
                    <thead><tr><th>Name</th><th style={{ textAlign: "right" }}>Size</th><th>Modified</th><th><span className="sr-only">Actions</span></th></tr></thead>
                    <tbody>
                      {b.entries.length === 0 && <tr><td colSpan={4} className="muted small" style={{ textAlign: "center", padding: 28 }}>This folder is empty.</td></tr>}
                      {b.entries.map((e: any) => (
                        <tr key={e.path} className="click" style={file === e.path ? { background: "var(--card-2)" } : undefined} onClick={() => (e.isDirectory ? go({ path: e.path, file: null }) : e.isLink ? toast.error("Links are not followed here.") : go({ file: e.path }))}>
                          <td><span className="row mono" style={{ gap: 10, fontSize: 13, minWidth: 0 }}>{e.isDirectory ? <Folder size={16} style={{ color: "var(--blue)", flexShrink: 0 }} /> : <FileIcon size={16} className="faint" style={{ flexShrink: 0 }} />}<span className="ellipsis">{e.name}{e.isLink ? " →" : ""}</span></span></td>
                          <td className="small muted" style={{ textAlign: "right" }}>{e.isDirectory ? "—" : size(e.size)}</td>
                          <td className="small muted">{timeAgo(e.modifiedAt)}</td>
                          <td style={{ width: 44 }}><RowMenu onDownload={() => siteId && download(siteId, volume, e.path).catch(onError)} {...(writable ? { onDelete: () => setConfirmDelete(e) } : {})} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="small muted" style={{ padding: "12px 18px" }}>
                  {b.entries.length} item{b.entries.length === 1 ? "" : "s"} · {size(b.filesBytes)}
                  {volume && usage.data ? ` · volume total ${size((usage.data as any).bytes)}${(usage.data as any).partial ? "+" : ""}` : ""}
                  {volume ? (b.lastBackup ? ` · last backed up ${timeAgo(b.lastBackup.at)}` : " · never backed up") : " · read only"}
                  {volume && <> · <Link className="link" href={`/backups?target=vol:${siteId}:${volume}`}>backups</Link></>}
                </div>
              </>
            )}
          </section>

          {file && siteId ? <Editor key={`${siteId}:${volume}:${file}`} siteId={siteId} volume={volume} path={file} onSaved={refresh} /> : (
            <aside className="card card-pad small muted" style={{ flex: "1 1 280px", minWidth: 0 }}>Choose a file to see it here. Text files up to 1 MB can be edited.</aside>
          )}
        </div>
      )}

      {newFolder !== null && (
        <Dialog open onClose={() => setNewFolder(null)} title="New folder" subtitle={`In ${rootLabel}${path === "/" ? "" : path}`}
          footer={<><button className="btn" onClick={() => setNewFolder(null)}>Cancel</button><button className="btn btn-primary" disabled={!newFolder.trim() || mkdir.isLoading} onClick={() => siteId && mkdir.mutate({ siteId, volume, path, name: newFolder.trim() })}>{mkdir.isLoading ? <Spinner /> : "Make folder"}</button></>}>
          <label className="label" htmlFor="nf-name">Name</label>
          <input id="nf-name" className="input mono" value={newFolder} autoFocus onChange={(e) => setNewFolder(e.target.value)} onKeyDown={(e) => e.key === "Enter" && newFolder.trim() && siteId && mkdir.mutate({ siteId, volume, path, name: newFolder.trim() })} />
        </Dialog>
      )}
      {confirmDelete && (
        <Dialog open onClose={() => setConfirmDelete(null)} title={`Delete ${confirmDelete.name}?`} subtitle={confirmDelete.isDirectory ? "The folder and everything in it are removed from the volume." : "The file is removed from the volume."}
          footer={<><button className="btn" onClick={() => setConfirmDelete(null)}>Cancel</button><button className="btn btn-danger" disabled={remove.isLoading} onClick={() => { siteId && remove.mutate({ siteId, volume, path: confirmDelete.path }); if (file === confirmDelete.path) go({ file: null }); setConfirmDelete(null); }}>Delete</button></>}>
          <span className="small muted">There is no undo except restoring a backup of the volume.</span>
        </Dialog>
      )}
    </div>
  );
}

export default function FilesPage() {
  return <Suspense><FilesInner /></Suspense>;
}
