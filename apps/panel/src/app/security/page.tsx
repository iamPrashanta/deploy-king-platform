"use client";

import { useMemo, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, Eye, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Code, Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";

/**
 * Security: what is on the server that someone could use to get in or to stay in, and what changed
 * since the admin last accepted it. The server is scanned every five minutes (scripts/host-scan.py).
 * Anything new or changed is listed here until the admin says it is expected.
 */

const KIND: Record<string, { one: string; many: string }> = {
  user: { one: "User", many: "Users" },
  admin: { one: "Admin rights", many: "Admin rights" },
  ssh_key: { one: "SSH key", many: "SSH keys" },
  sshd: { one: "SSH setting", many: "SSH settings" },
  cron: { one: "Scheduled job", many: "Scheduled jobs" },
  unit: { one: "Service", many: "Services and timers" },
  startup: { one: "Startup file", many: "Startup files" },
  port: { one: "Listening port", many: "Listening ports" },
  process: { one: "Running program", many: "Running programs" },
  outbound: { one: "Outgoing connection", many: "Outgoing connections" },
  container: { one: "Container", many: "Containers" },
};
const ORDER = ["process", "outbound", "admin", "user", "ssh_key", "sshd", "cron", "unit", "startup", "container", "port"];
const SIGN: Record<string, string> = {
  miner: "coin miner", temp: "runs from a temporary folder", "fake-kernel": "looks like a kernel thread", deleted: "its file was deleted",
  hidden: "hidden folder", cpu: "keeps a CPU core busy", "old-copy": "old copy after an update",
};
const LEVEL: Record<string, { label: string; tone: string }> = { urgent: { label: "Urgent", tone: "bad" }, check: { label: "Check", tone: "warn" }, note: { label: "Note", tone: "" } };

/** The few facts worth reading for each kind of thing, as one line. */
function facts(kind: string, d: any): string {
  const parts: Array<string | false | null | undefined> =
    kind === "user" ? [`user id ${d.uid}`, d.login ? `signs in with ${d.shell}` : "cannot sign in", d.emptyPassword ? "NO password" : d.hasPassword ? "has a password" : "no password set", d.passwordChanged && `password changed ${d.passwordChanged}`]
    : kind === "admin" ? [d.rule ?? d.via, d.file]
    : kind === "ssh_key" ? [d.type, d.fingerprint, d.restricted && "restricted", d.file]
    : kind === "sshd" ? [`${d.setting} = ${d.value}`, d.isDefault && "the default"]
    : kind === "cron" ? [d.schedule, `as ${d.user}`, d.command, d.file]
    : kind === "unit" ? [d.runs, d.user && `as ${d.user}`, d.when, d.enabled ? "starts at boot" : "not started at boot", d.origin === "package" ? "from a package" : d.origin === "home" ? "in a user's folder" : "added by hand", d.file]
    : kind === "startup" ? [d.loads?.length ? `loads ${d.loads.join(", ")}` : null, `${d.size ?? "?"} characters`]
    : kind === "port" ? [d.program ?? "unknown program", d.public ? "open to the outside" : "this server only", (d.addresses ?? []).join(", ")]
    : kind === "process" ? [(d.signs ?? []).map((x: string) => SIGN[x] ?? x).join(", "), d.cpuPct != null && `${d.cpuPct}% CPU for ${d.minutes} min`, d.count > 1 ? `${d.count} running` : `process ${d.pids?.[0] ?? "?"}`, d.user && `as ${d.user}`, d.container && `in container ${d.container}`, d.command]
    : kind === "outbound" ? [d.program ? `${d.program}${d.pid ? ` (process ${d.pid})` : ""}` : "unknown program", d.kind === "pool" ? "mining-pool port" : d.kind === "chat" ? "chat-control port" : "a port pools often use"]
    : kind === "container" ? [d.image, d.running ? "running" : "stopped", d.privileged && "FULL ACCESS", d.hostPid && "sees the server's processes", d.hostNetwork && "on the server's network", d.riskyMounts?.length && `mounts ${d.riskyMounts.join(", ")}`, d.restart && d.restart !== "no" && `restarts: ${d.restart}`, d.runtime]
    : [];
  return parts.filter(Boolean).join(" · ");
}

function ItemLine({ item }: { item: any }) {
  return (
    <div className="attn-row" style={{ alignItems: "flex-start" }}>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="mono" style={{ fontWeight: 550, overflowWrap: "anywhere" }}>
          {item.label}
          {item.severity === "urgent" && <span className="badge bad" style={{ marginLeft: 8 }}>Look at this one</span>}
        </div>
        <div className="small muted" style={{ overflowWrap: "anywhere" }}>{facts(item.kind, item.detail)}</div>
        {item.severity === "urgent" && item.reason && <div className="small bad-text" style={{ marginTop: 2 }}>{item.reason}</div>}
      </div>
    </div>
  );
}

/** Items of one kind, folded when there are many. Services from packages are folded on their own: there are hundreds. */
function Group({ kind, items, startOpen }: { kind: string; items: any[]; startOpen?: boolean }) {
  const [open, setOpen] = useState(!!startOpen);
  const [all, setAll] = useState(false);
  const own = kind === "unit" ? items.filter((i) => i.detail?.origin !== "package" || i.severity === "urgent") : items;
  const packaged = items.length - own.length;
  const shown = all ? items : own;
  return (
    <section className="card" style={{ marginBottom: 12 }}>
      <button type="button" className="card-head" style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "none", border: 0 }} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <h3>{KIND[kind]?.many ?? kind}</h3>
        <span className="right small faint">{items.length}{items.some((i) => i.severity === "urgent") ? " · some need a look" : ""}</span>
      </button>
      {open && (
        <>
          {shown.map((i) => <ItemLine key={i.id} item={i} />)}
          {packaged > 0 && (
            <div className="card-body small" style={{ borderTop: "1px solid var(--border)" }}>
              <button type="button" className="link" onClick={() => setAll(!all)}>{all ? "Hide" : "Show"} the {packaged} that came with packages</button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/** What happened to the last Remove for this finding, with Undo while it is possible. */
function ActionState({ a, onUndo, busy }: { a?: any; onUndo: (id: string) => void; busy: boolean }) {
  if (!a) return null;
  const line = (tone: string, text: React.ReactNode, extra?: React.ReactNode) => (
    <div className={cx("small", tone)} style={{ marginTop: 6, overflowWrap: "anywhere" }}>{text}{extra}</div>
  );
  if (a.status === "pending") return line("muted", <><Spinner size={11} /> Sent to the server, waiting for the helper…</>);
  if (a.status === "undo-pending") return line("muted", <><Spinner size={11} /> Undoing on the server…</>);
  if (a.status === "failed") return line("bad-text", a.message || "The server could not do it.");
  if (a.status === "undone") return line("muted", `Removed, then undone ${timeAgo(a.undoAt)}. ${a.undoMessage ?? ""}`);
  return line("ok-text", `${a.message || "Removed."} `, a.canUndo ? <button type="button" className="link" disabled={busy} onClick={() => onUndo(a.id)}>Undo</button> : null);
}

const byKind = (items: any[]) => ORDER.map((k) => ({ kind: k, items: items.filter((i) => i.kind === k) })).filter((g) => g.items.length);

export default function SecurityPage() {
  useCrumbs([{ label: "Security" }]);
  const utils = trpc.useContext();
  const summary = trpc.host.summary.useQuery(undefined, { retry: false, refetchInterval: 60_000 });
  const s = summary.data as any;
  const findings = trpc.host.findings.useQuery(undefined, { retry: false, enabled: !!s?.installed, refetchInterval: 60_000 });
  const initial = trpc.host.initial.useQuery(undefined, { retry: false, enabled: !!s?.toReview });
  const [tab, setTab] = useState<"changes" | "removed" | "baseline">("changes");
  const baseline = trpc.host.baseline.useQuery(undefined, { retry: false, enabled: tab === "baseline" && !!s?.installed });
  const [accepting, setAccepting] = useState<any>(null);
  const [note, setNote] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [removing, setRemoving] = useState<any>(null);
  const helper = trpc.host.helper.useQuery(undefined, { retry: false, enabled: !!s?.installed, refetchInterval: 60_000 });
  const canRemove = !!(helper.data as any)?.running;
  const actions = trpc.host.actions.useQuery(undefined, {
    retry: false,
    enabled: !!s?.installed,
    // While the server is working on something, look again every few seconds.
    refetchInterval: (data: any) => (data?.some((a: any) => a.status === "pending" || a.status === "undo-pending") ? 3000 : 60_000),
    onSuccess: (data: any) => {
      for (const a of data ?? []) {
        const was = seenStatus.current.get(a.id);
        if (was && was !== a.status) {
          if (a.status === "done") toast.success(a.message || "Done on the server");
          else if (a.status === "failed") toast.error(a.message || "The server could not do it");
          else if (a.status === "undone") toast.success(a.undoMessage || "Undone");
          refresh();
        }
        seenStatus.current.set(a.id, a.status);
      }
    },
  });
  const seenStatus = useRef(new Map<string, string>());
  const latestFor = useMemo(() => {
    const m = new Map<string, any>();
    for (const a of ((actions.data as any[]) ?? [])) if (!m.has(a.itemKey)) m.set(a.itemKey, a);
    return m;
  }, [actions.data]);

  const refresh = () => { utils.host.invalidate(); utils.system.overview.invalidate(); };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const remove = trpc.host.remove.useMutation({ onSuccess: () => { toast.success("Sent to the server. It is usually done within a few seconds."); setRemoving(null); utils.host.actions.invalidate(); }, onError });
  const undo = trpc.host.undo.useMutation({ onSuccess: () => { toast.success("Undo sent to the server."); utils.host.actions.invalidate(); }, onError });
  const decide = trpc.host.decide.useMutation({ onSuccess: (_d, v: any) => { toast.success(v.answer === "expected" ? "Added to the baseline" : v.answer === "dismiss" ? "Cleared. If it comes back, it will be shown again." : "Hidden until tomorrow"); setAccepting(null); setNote(""); refresh(); }, onError });
  const acceptAll = trpc.host.acceptInitial.useMutation({ onSuccess: (d: any) => { toast.success(`${d.accepted} things are now the baseline. Changes from here on will be shown.`); refresh(); }, onError });

  const list = (findings.data as any[]) ?? [];
  const first = (initial.data as any[]) ?? [];
  const firstUrgent = useMemo(() => first.filter((i) => i.severity === "urgent"), [first]);

  if (summary.error) return <div className="page"><Empty icon={<ShieldCheck size={20} />} title="Security is for admins">Ask the owner of this panel if something on the server worries you.</Empty></div>;
  if (summary.isLoading) return <div className="page"><Skeleton h={200} /></div>;

  if (!s.installed) {
    return (
      <div className="page">
        <PageHeader title="Security" description="Shows what changed on the server: new users, SSH keys, scheduled jobs, services, open ports, containers, and programs or connections that look wrong." />
        <div className="card card-pad">
          <div className="row top">
            <Eye size={18} className="faint" style={{ marginTop: 2 }} />
            <div className="grow">
              <strong>The server watch is not running yet</strong>
              <p className="muted" style={{ margin: "4px 0 12px", maxWidth: 640 }}>
                A small script on the server lists what is there every five minutes. It only reads; it changes nothing and copies no passwords or keys. Turn it on once, on the server, as root:
              </p>
              <Code label="shell">sudo bash /opt/dbbkp/scripts/install-scan.sh</Code>
              <p className="small faint" style={{ marginTop: 10 }}>The first list appears here within a minute or two of running it.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Security" description={`What changed on ${s.hostname || "the server"} since you last accepted its state. Checked every five minutes.`} />

      {s.silent && (
        <div className="notice bad" style={{ marginBottom: 16 }}>
          <AlertTriangle size={16} className="bad-text" />
          <div>
            <strong>The server watch has stopped reporting.</strong> The last report is from {timeAgo(s.lastReportAt)}. Someone who breaks in stops the watcher first, so check this before anything else:
            <div style={{ marginTop: 8 }}><Code label="shell">sudo systemctl status dbbkp-scan.timer dbbkp-scan.service</Code></div>
          </div>
        </div>
      )}
      {!s.asRoot && <div className="notice warn small" style={{ marginBottom: 16 }}><AlertTriangle size={15} className="warn-text" /> <span>The scan does not run as root, so it cannot read other users&apos; SSH keys or which accounts have a password.</span></div>}

      {s.toReview > 0 ? (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="row top">
              <ShieldAlert size={18} className="warn-text" style={{ marginTop: 2 }} />
              <div className="grow">
                <strong>We found these on your server</strong>
                <p className="muted" style={{ margin: "4px 0 12px", maxWidth: 680 }}>
                  This is everything on the server that lets someone in or starts by itself, plus anything running that looks wrong: {s.toReview} things. Look through it once. When you accept it, it becomes the baseline, and from then on anything new or changed is shown to you.
                  {firstUrgent.length > 0 && <> <strong className="bad-text">{firstUrgent.length} of them deserve a close look first.</strong></>}
                </p>
                <button className="btn btn-primary" disabled={acceptAll.isLoading || initial.isLoading} onClick={() => acceptAll.mutate()}>
                  {acceptAll.isLoading ? <Spinner /> : <><CheckCircle2 size={14} /> This is my server. Accept all {s.toReview}</>}
                </button>
                <span className="small faint" style={{ marginLeft: 12 }}>Nothing on the server is changed by accepting.</span>
              </div>
            </div>
          </div>
          {initial.isLoading ? <Skeleton h={160} /> : byKind(first).map((g) => <Group key={g.kind} kind={g.kind} items={g.items} startOpen={g.items.some((i) => i.severity === "urgent") || g.items.length <= 12} />)}
        </>
      ) : (
        <>
          <div className="tabs">
            <button className={cx("tab", tab === "changes" && "on")} onClick={() => setTab("changes")}>Changes {s.urgent + s.check + s.note > 0 && <span className="count">{s.urgent + s.check + s.note}</span>}</button>
            <button className={cx("tab", tab === "removed" && "on")} onClick={() => setTab("removed")}>Removed {(actions.data as any[])?.length ? <span className="count">{(actions.data as any[]).length}</span> : null}</button>
            <button className={cx("tab", tab === "baseline" && "on")} onClick={() => setTab("baseline")}>Accepted <span className="count">{s.baseline}</span></button>
            <span className="right small faint">Last report {timeAgo(s.lastReportAt)}</span>
          </div>

          {tab === "changes" && (findings.isLoading ? <Skeleton h={160} /> : list.length === 0 ? (
            <Empty icon={<ShieldCheck size={20} />} title="Nothing has changed">Users, keys, scheduled jobs, services, ports and containers are as you accepted them, and no running program or connection looks wrong.</Empty>
          ) : (
            <section className="card">
              {list.map((f) => {
                const open = openId === f.id;
                return (
                  <div key={f.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <div className="attn-row" style={{ alignItems: "flex-start", borderBottom: 0 }}>
                      <span className={cx("badge", LEVEL[f.severity]?.tone)} style={{ marginTop: 2 }}>{LEVEL[f.severity]?.label ?? f.severity}</span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 550, overflowWrap: "anywhere" }}>
                          {f.status === "changed" ? "Changed" : "New"} {(KIND[f.kind]?.one ?? f.kind).toLowerCase()}: <span className="mono">{f.label}</span>
                          {!f.present && <span className="badge" style={{ marginLeft: 8 }}>Gone again</span>}
                        </div>
                        <div className="small" style={{ marginTop: 2 }}>{f.reason}</div>
                        <div className="small muted" style={{ marginTop: 2, overflowWrap: "anywhere" }}>{facts(f.kind, f.detail)}</div>
                        {f.status === "changed" && f.previous && <div className="small faint" style={{ marginTop: 2, overflowWrap: "anywhere" }}>Before: {facts(f.kind, f.previous)}</div>}
                        <div className="small faint" style={{ marginTop: 4 }}><Clock size={11} style={{ verticalAlign: -1 }} /> first seen {timeAgo(f.changedAt ?? f.firstSeenAt)}</div>
                        <ActionState a={latestFor.get(f.key)} onUndo={(id) => undo.mutate({ actionId: id })} busy={undo.isLoading} />
                      </div>
                      {f.present ? (
                        <>
                          {f.autoRemove && canRemove ? (
                            <button className="btn btn-sm btn-danger" disabled={["pending", "undo-pending"].includes(latestFor.get(f.key)?.status)} onClick={() => setRemoving(f)}>Remove…</button>
                          ) : null}
                          <button className="btn btn-sm" onClick={() => setOpenId(open ? null : f.id)} aria-expanded={open}>{f.autoRemove && canRemove ? "By hand" : "How to remove"}</button>
                          <button className="btn btn-sm btn-ghost" disabled={decide.isLoading} onClick={() => decide.mutate({ ids: [f.id], answer: "later" })}>Later</button>
                          <button className="btn btn-sm" onClick={() => { setAccepting(f); setNote(""); }}>Expected</button>
                        </>
                      ) : (
                        <button className="btn btn-sm" disabled={decide.isLoading} onClick={() => decide.mutate({ ids: [f.id], answer: "dismiss" })}>It is gone, clear it</button>
                      )}
                    </div>
                    {open && f.present && (
                      <div className="card-body" style={{ paddingTop: 0 }}>
                        <div className="notice small" style={{ display: "block" }}>
                          <div style={{ marginBottom: f.remove.command ? 8 : 0 }}>{f.remove.text}</div>
                          {f.remove.command && <Code label="on the server">{f.remove.command}</Code>}
                          <div className="faint" style={{ marginTop: 8 }}>
                            {!f.autoRemove
                              ? "This kind is fixed by hand only: a mistake here could lock you out of the server."
                              : !canRemove
                                ? "The helper that removes things from the panel is not running on this server (it comes with install-scan.sh). Run this yourself."
                                : "Or run this yourself."}{" "}
                            Within five minutes of it being gone, the finding is marked &ldquo;Gone again&rdquo; and you can clear it.
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          ))}

          {tab === "removed" && (actions.isLoading ? <Skeleton h={120} /> : !(actions.data as any[])?.length ? (
            <Empty icon={<ShieldCheck size={20} />} title="Nothing removed yet">Things you remove from this page are listed here, with an undo for 30 days.</Empty>
          ) : (
            <section className="card">
              {(actions.data as any[]).map((a) => (
                <div key={a.id} className="attn-row" style={{ alignItems: "flex-start" }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 550, overflowWrap: "anywhere" }}>{KIND[a.kind]?.one ?? a.kind}: <span className="mono">{a.itemLabel}</span></div>
                    <div className="small muted" style={{ overflowWrap: "anywhere" }}>{a.plan}</div>
                    <div className="small faint">{a.requestedByName ?? "someone"} · {timeAgo(a.requestedAt)}</div>
                    <ActionState a={a} onUndo={(id) => undo.mutate({ actionId: id })} busy={undo.isLoading} />
                  </div>
                </div>
              ))}
            </section>
          ))}

          {tab === "baseline" && (baseline.isLoading ? <Skeleton h={160} /> : byKind((baseline.data as any[]) ?? []).map((g) => <Group key={g.kind} kind={g.kind} items={g.items} />))}
        </>
      )}

      <Dialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        title="Remove this from the server?"
        subtitle="A copy is kept first, so you can undo it for 30 days."
        footer={
          <>
            <button className="btn" onClick={() => setRemoving(null)}>Cancel</button>
            <button className="btn btn-danger" disabled={remove.isLoading} onClick={() => remove.mutate({ id: removing.id })}>{remove.isLoading ? <Spinner /> : "Remove"}</button>
          </>
        }
      >
        {removing?.autoRemove && (
          <div className="stack">
            <div className="mono small" style={{ overflowWrap: "anywhere" }}>{removing.label}<div className="muted">{facts(removing.kind, removing.detail)}</div></div>
            <div><strong>What happens:</strong> {removing.autoRemove.text}</div>
            {removing.autoRemove.warning && <div className="notice warn small"><AlertTriangle size={15} className="warn-text" /> <span>{removing.autoRemove.warning}</span></div>}
            <div className="small faint">Done by the helper on the server, as root. It checks the request again and refuses anything protected (root, SSH, Docker, the panel itself).</div>
          </div>
        )}
      </Dialog>

      <Dialog
        open={!!accepting}
        onClose={() => setAccepting(null)}
        title="Mark as expected?"
        subtitle="It joins the baseline and is not shown again unless it changes."
        footer={
          <>
            <button className="btn" onClick={() => setAccepting(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={decide.isLoading} onClick={() => decide.mutate({ ids: [accepting.id], answer: "expected", note: note.trim() || undefined })}>{decide.isLoading ? <Spinner /> : "Yes, this is expected"}</button>
          </>
        }
      >
        {accepting && (
          <div className="stack">
            {accepting.severity === "urgent" && <div className="notice bad small"><AlertTriangle size={15} className="bad-text" /> <span>{accepting.reason} Accept it only if you or someone you trust did this.</span></div>}
            <div className="mono small" style={{ overflowWrap: "anywhere" }}>{accepting.label}<div className="muted">{facts(accepting.kind, accepting.detail)}</div></div>
            <div>
              <label className="label" htmlFor="sec-note">Note for later (optional)</label>
              <input id="sec-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Who added it and why" />
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
