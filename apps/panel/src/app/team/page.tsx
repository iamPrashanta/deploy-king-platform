"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Mail, Plus, ShieldCheck, UserMinus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Dialog, Empty, PageHeader, Skeleton, Spinner, copyText, cx, errMsg, timeAgo } from "@/components/ui";

/**
 * Team: who can work in this panel, with which role, on which apps.
 * A role says what a member may do; the app list says where. Everything they do is recorded under their own name.
 */

type Role = "admin" | "developer" | "viewer";
type Grants = { createApps?: boolean; deleteApps?: boolean; terminal?: boolean; agentTokens?: boolean; restoreBackups?: boolean };
type Access = { role: Role; allApps: boolean; siteIds: string[]; grants: Grants };

const ROLES: Array<{ v: Role; label: string; text: string }> = [
  { v: "admin", label: "Admin", text: "Everything, including the team and settings. Cannot change the owner." },
  { v: "developer", label: "Developer", text: "Deploys and looks after the apps they are given. No servers, team or settings." },
  { v: "viewer", label: "Viewer", text: "Sees status, logs and history. Changes nothing." },
];
const EXTRAS: Array<{ k: keyof Grants; label: string; text: string }> = [
  { k: "createApps", label: "Create apps", text: "New apps of their own. The server still checks that each one fits." },
  { k: "deleteApps", label: "Delete apps", text: "Deleting also removes the app's storage." },
  { k: "terminal", label: "Open a terminal inside their apps", text: "Runs commands in the app's own container, not on the server." },
  { k: "agentTokens", label: "Create AI agent tokens", text: "A token can never do more than the member who made it." },
  { k: "restoreBackups", label: "Restore backups", text: "Into a new copy or over live data of their apps. Making backups needs no extra." },
];
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", developer: "Developer", viewer: "Viewer", member: "Member" };
const ROLE_TONE: Record<string, string> = { owner: "purple", admin: "info", developer: "", viewer: "", member: "" };
const emptyAccess: Access = { role: "developer", allApps: false, siteIds: [], grants: {} };

/** In words, what this access allows and what it does not. Shown before an invitation is sent. */
function summary(a: Access, appCount: number) {
  const where = a.role === "admin" ? "every app" : a.allApps ? "every app, including ones added later" : appCount ? `${appCount} app${appCount === 1 ? "" : "s"}` : "no apps yet, only ones they create";
  if (a.role === "admin") return { can: ["Do everything an admin can", "Invite and manage members", "Change settings"], cannot: ["Change or remove the owner"] };
  if (a.role === "viewer") return { can: [`See status, logs and deploy history of ${where}`], cannot: ["Deploy, change or delete anything", "See servers, team or settings"] };
  const can = [`Deploy and roll back ${where}`, "Add and replace variables", "Read logs and deploy history"];
  const cannot = ["See servers, team or settings"];
  for (const e of EXTRAS) (a.grants[e.k] ? can : cannot).push(e.label);
  return { can, cannot };
}

function AccessEditor({ value, onChange, apps, canMakeAdmin }: { value: Access; onChange: (a: Access) => void; apps: Array<{ id: string; domain: string }>; canMakeAdmin: boolean }) {
  const toggleApp = (id: string) => onChange({ ...value, siteIds: value.siteIds.includes(id) ? value.siteIds.filter((x) => x !== id) : [...value.siteIds, id] });
  return (
    <div className="stack" style={{ gap: 20 }}>
      <fieldset className="plain">
        <legend className="label">Role</legend>
        <div className="choice-grid">
          {ROLES.filter((r) => r.v !== "admin" || canMakeAdmin || value.role === "admin").map((r) => (
            <label key={r.v} className={cx("choice", value.role === r.v && "on")}>
              <input type="radio" name="role" checked={value.role === r.v} onChange={() => onChange({ ...value, role: r.v })} />
              <span>
                <strong>{r.label}</strong>
                <span className="small muted">{r.text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {value.role !== "admin" && (
        <fieldset className="plain">
          <legend className="label">Which apps</legend>
          <div className="choice-grid two">
            <label className={cx("choice", value.allApps && "on")}>
              <input type="radio" name="apps" checked={value.allApps} onChange={() => onChange({ ...value, allApps: true })} />
              <span><strong>All apps</strong><span className="small muted">Including apps added later.</span></span>
            </label>
            <label className={cx("choice", !value.allApps && "on")}>
              <input type="radio" name="apps" checked={!value.allApps} onChange={() => onChange({ ...value, allApps: false })} />
              <span><strong>Only selected apps</strong><span className="small muted">Plus any app they create themselves.</span></span>
            </label>
          </div>
          {!value.allApps && (
            <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
              {apps.length === 0 && <span className="small faint">There are no apps yet.</span>}
              {apps.map((a) => {
                const on = value.siteIds.includes(a.id);
                return (
                  <button key={a.id} type="button" role="checkbox" aria-checked={on} className={cx("chip-btn mono", on && "on")} onClick={() => toggleApp(a.id)}>
                    {on && <Check size={12} />} {a.domain}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
      )}

      {value.role === "developer" && (
        <fieldset className="plain">
          <legend className="label">Extras, off unless switched on</legend>
          {EXTRAS.map((e) => (
            <label key={e.k} className="rule-row">
              <span className="grow">
                <span style={{ fontWeight: 550 }}>{e.label}</span>
                <span className="small muted" style={{ display: "block" }}>{e.text}</span>
              </span>
              <span className="switch">
                <input type="checkbox" checked={!!value.grants[e.k]} onChange={(ev) => onChange({ ...value, grants: { ...value.grants, [e.k]: ev.target.checked } })} />
                <span />
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

function Summary({ access }: { access: Access }) {
  const s = summary(access, access.siteIds.length);
  return (
    <div className="card card-pad" style={{ background: "var(--card-2)" }}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>Will be able to</div>
      <ul className="can-list">{s.can.map((t) => <li key={t}><Check size={13} className="ok-text" /> {t}</li>)}</ul>
      <div className="small" style={{ fontWeight: 600, margin: "12px 0 8px" }}>Will not be able to</div>
      <ul className="can-list">{s.cannot.map((t) => <li key={t} className="muted"><X size={13} /> {t}</li>)}</ul>
    </div>
  );
}

/** A link is shown once. Until email sending exists, the person inviting passes it on. */
function LinkBox({ links, onClose }: { links: Array<{ email: string; path: string; expiresAt: string | Date }>; onClose: () => void }) {
  const url = (p: string) => `${window.location.origin}${p}`;
  return (
    <Dialog open onClose={onClose} title="Send this link" subtitle="It is shown only once. It works one time, for that address, until it expires." footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
      <div className="stack">
        {links.map((l) => (
          <div key={l.email}>
            <div className="label">{l.email}</div>
            <div className="input-group">
              <input className="input mono" readOnly value={url(l.path)} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" style={{ borderRadius: "0 7px 7px 0", marginLeft: -1 }} onClick={() => { copyText(url(l.path)); toast.success("Link copied"); }}><Copy size={14} /> Copy</button>
            </div>
          </div>
        ))}
        <div className="notice info small"><Mail size={15} /> <span>The panel does not send email yet. Copy the link and send it yourself.</span></div>
      </div>
    </Dialog>
  );
}

export default function TeamPage() {
  useCrumbs([{ label: "Team" }]);
  const utils = trpc.useContext();
  const me = trpc.team.me.useQuery();
  const members = trpc.team.members.useQuery(undefined, { retry: false });
  const invites = trpc.team.invitations.useQuery(undefined, { retry: false });
  const requests = trpc.team.requests.useQuery(undefined, { retry: false });
  const sites = trpc.sites.list.useQuery();
  const apps = useMemo(() => ((sites.data as any[]) ?? []).filter((s) => !s.isPreview).map((s) => ({ id: s.id, domain: s.domain })), [sites.data]);
  const isOwner = me.data?.role === "owner";

  const [inviting, setInviting] = useState(false);
  const [emails, setEmails] = useState("");
  const [note, setNote] = useState("");
  const [access, setAccess] = useState<Access>(emptyAccess);
  const [links, setLinks] = useState<Array<{ email: string; path: string; expiresAt: string | Date }> | null>(null);
  const [editing, setEditing] = useState<{ id: string; username: string; email: string; suspended: boolean; access: Access } | null>(null);
  const [removing, setRemoving] = useState("");

  const refresh = () => { utils.team.members.invalidate(); utils.team.invitations.invalidate(); utils.team.requests.invalidate(); };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const invite = trpc.team.invite.useMutation({ onSuccess: (out) => { setInviting(false); setEmails(""); setNote(""); setAccess(emptyAccess); setLinks(out as any); refresh(); }, onError });
  const renew = trpc.team.renewInvite.useMutation({ onSuccess: (out) => { setLinks([out as any]); refresh(); }, onError });
  const cancel = trpc.team.cancelInvite.useMutation({ onSuccess: () => { toast.success("Invitation cancelled"); refresh(); }, onError });
  const decide = trpc.team.decideRequest.useMutation({ onSuccess: (out: any) => { if (out.approved) setLinks([out]); else toast.success("Request declined"); refresh(); }, onError });
  const update = trpc.team.updateMember.useMutation({ onSuccess: () => { toast.success("Access saved. It applies at once."); setEditing(null); refresh(); }, onError });
  const suspend = trpc.team.setSuspended.useMutation({ onSuccess: (_d, v) => { toast.success((v as any)?.suspended ? "Member suspended and signed out" : "Suspension lifted"); setEditing(null); refresh(); }, onError });
  const remove = trpc.team.remove.useMutation({ onSuccess: (out: any) => { toast.success(out.appsHandedOver ? `Member removed. ${out.appsHandedOver} app${out.appsHandedOver === 1 ? " is" : "s are"} now yours.` : "Member removed"); setEditing(null); setRemoving(""); refresh(); }, onError });

  const emailList = emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const emailsOk = emailList.length > 0 && emailList.length <= 20 && emailList.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

  const openMember = async (m: any) => {
    try {
      const d: any = await utils.team.member.fetch({ id: m.id });
      setRemoving("");
      setEditing({ id: d.id, username: d.username, email: d.email, suspended: d.suspended, access: { role: d.role === "member" ? "developer" : d.role, allApps: d.allApps, siteIds: d.siteIds, grants: d.grants } });
    } catch (e) { onError(e); }
  };

  if (members.error) {
    return <div className="page"><Empty icon={<Users size={20} />} title="The team is managed by the owner and admins">Ask one of them if you need different access.</Empty></div>;
  }
  const list = (members.data as any[]) ?? [];
  const pending = (invites.data as any[]) ?? [];
  const asking = (requests.data as any[]) ?? [];
  const canManage = (m: any) => !m.you && m.role !== "owner" && (m.role !== "admin" || isOwner);

  return (
    <div className="page">
      <PageHeader
        title="Team"
        description="People who can work in this panel. Everything they do is recorded under their own name."
        actions={<button className="btn btn-primary" onClick={() => setInviting(true)}><Plus size={15} /> Invite member</button>}
      />

      {asking.length > 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>Asking for access</h3><span className="badge warn">{asking.length}</span></div>
          {asking.map((r) => (
            <div key={r.id} className="attn-row">
              <div className="grow">
                <div style={{ fontWeight: 550 }}>{r.name} <span className="muted" style={{ fontWeight: 400 }}>· {r.email}</span></div>
                <div className="small muted">{r.message || "No message"} · {timeAgo(r.createdAt)}</div>
              </div>
              <button className="btn btn-sm" disabled={decide.isLoading} onClick={() => decide.mutate({ id: r.id, approve: false })}>Decline</button>
              <button className="btn btn-sm btn-primary" disabled={decide.isLoading} onClick={() => decide.mutate({ id: r.id, approve: true })}>Approve</button>
            </div>
          ))}
          <div className="card-body small faint" style={{ borderTop: "1px solid var(--border)" }}>Approving gives the person a link to create their account. They can create and run their own apps and see nobody else's.</div>
        </section>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Members</h3><span className="right small faint">{list.length} {list.length === 1 ? "person" : "people"}</span></div>
        {members.isLoading ? <div className="card-body"><Skeleton h={120} /></div> : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 720 }}>
              <thead><tr><th>Member</th><th>Role</th><th>Can work on</th><th>Last active</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="row">
                        <span className="avatar">{m.username.slice(0, 2).toUpperCase()}</span>
                        <div><div style={{ fontWeight: 550 }}>{m.username}{m.you && <span className="faint" style={{ fontWeight: 400 }}> (you)</span>}</div><div className="small muted">{m.email}</div></div>
                      </div>
                    </td>
                    <td><span className={cx("badge", ROLE_TONE[m.role])}>{ROLE_LABEL[m.role] ?? m.role}</span>{m.suspended && <span className="badge bad" style={{ marginLeft: 6 }}>Suspended</span>}</td>
                    <td className="muted">{m.role === "owner" || m.role === "admin" ? "Everything" : m.allApps ? (m.role === "viewer" ? "All apps, read only" : "All apps") : `${m.sharedApps + m.ownApps} app${m.sharedApps + m.ownApps === 1 ? "" : "s"}`}</td>
                    <td className="muted">{m.lastActiveAt ? timeAgo(m.lastActiveAt) : "Never"}</td>
                    <td style={{ textAlign: "right" }}>{canManage(m) && <button className="btn btn-sm" onClick={() => openMember(m)}>Manage</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head"><h3>Invitations</h3><span className="right small faint">{pending.filter((i) => i.state === "waiting").length} waiting</span></div>
        {pending.length === 0 ? (
          <div className="card-body small muted">Nobody is waiting on an invitation.</div>
        ) : pending.map((i) => (
          <div key={i.id} className="attn-row">
            <span className="attn-ic"><Mail size={15} /></span>
            <div className="grow">
              <div style={{ fontWeight: 550 }}>{i.email}</div>
              <div className={cx("small", i.state === "expired" ? "warn-text" : "muted")}>
                {ROLE_LABEL[i.role]} · {i.role === "admin" || i.allApps ? "all apps" : `${i.apps} app${i.apps === 1 ? "" : "s"}`} · {i.state === "expired" ? "expired; the old link no longer works" : `sent ${timeAgo(i.createdAt)}${i.invitedBy ? ` by ${i.invitedBy}` : ""}`}
              </div>
            </div>
            <button className="btn btn-sm" disabled={renew.isLoading} onClick={() => renew.mutate({ id: i.id })}>New link</button>
            <button className="btn btn-sm btn-ghost" disabled={cancel.isLoading} onClick={() => cancel.mutate({ id: i.id })}>Cancel</button>
          </div>
        ))}
      </section>

      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        width={720}
        title="Invite a member"
        subtitle="Each person gets their own link. It works once, only for that address."
        footer={
          <>
            <button className="btn" onClick={() => setInviting(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!emailsOk || invite.isLoading} onClick={() => invite.mutate({ emails: emailList, note: note.trim() || undefined, expiresInDays: 7, ...access })}>
              {invite.isLoading ? <Spinner /> : <><Mail size={14} /> Create invitation</>}
            </button>
          </>
        }
      >
        <div className="stack" style={{ gap: 20 }}>
          <div>
            <label className="label" htmlFor="inv-emails">Email addresses</label>
            <input id="inv-emails" className="input" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="lena@example.com, sam@example.com" autoFocus />
            <div className="hint">Separate several addresses with a comma. The invitation expires after 7 days.</div>
          </div>
          <AccessEditor value={access} onChange={setAccess} apps={apps} canMakeAdmin={isOwner} />
          <Summary access={access} />
        </div>
      </Dialog>

      <Dialog
        open={!!editing}
        onClose={() => setEditing(null)}
        width={720}
        title={editing ? `${editing.username}'s access` : ""}
        subtitle={editing?.email}
        footer={
          editing && (
            <>
              <button className="btn" disabled={suspend.isLoading} onClick={() => suspend.mutate({ id: editing.id, suspended: !editing.suspended })}>{editing.suspended ? "Lift suspension" : "Suspend"}</button>
              <span className="grow" />
              <button className="btn" onClick={() => setEditing(null)}>Cancel</button>
              <button className="btn btn-primary" disabled={update.isLoading} onClick={() => update.mutate({ id: editing.id, ...editing.access })}>{update.isLoading ? <Spinner /> : <><ShieldCheck size={14} /> Save access</>}</button>
            </>
          )
        }
      >
        {editing && (
          <div className="stack" style={{ gap: 20 }}>
            <AccessEditor value={editing.access} onChange={(a) => setEditing({ ...editing, access: a })} apps={apps} canMakeAdmin={isOwner} />
            <Summary access={editing.access} />
            <div className="notice bad">
              <UserMinus size={16} className="bad-text" />
              <div className="grow">
                <strong>Remove from the team</strong>
                <div className="small muted" style={{ margin: "4px 0 10px" }}>Their account and agent tokens are deleted. Apps they created keep running and become yours. Type <span className="mono">{editing.username}</span> to confirm.</div>
                <div className="row">
                  <input className="input" style={{ maxWidth: 220 }} value={removing} onChange={(e) => setRemoving(e.target.value)} aria-label="Type the username to confirm" />
                  <button className="btn btn-danger" disabled={removing !== editing.username || remove.isLoading} onClick={() => remove.mutate({ id: editing.id, confirm: removing })}>Remove</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Dialog>

      {links && <LinkBox links={links} onClose={() => setLinks(null)} />}
    </div>
  );
}
