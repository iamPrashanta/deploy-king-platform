"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Copy, Mail, Plus, ShieldCheck, Users } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Dialog, Empty, PageHeader, Skeleton, Spinner, copyText, cx, errMsg, timeAgo } from "@/components/ui";
import { AccessEditor, ROLE_LABEL, ROLE_TONE, Summary, emptyAccess, type Access } from "@/components/TeamAccess";

/**
 * Team: who can work in this panel, with which role, on which apps, and the team rules.
 * A role says what a member may do; the app list says where. Everything they do is recorded under their own name.
 */

type Link_ = { email: string; path: string; expiresAt: string | Date; emailed?: boolean; emailError?: string };

const daysLeft = (d: string | Date) => Math.max(0, Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000));
const origin = () => (typeof window !== "undefined" ? window.location.origin : undefined);

/** After inviting: who was emailed, and the links to copy. A link is shown only once. */
function LinkBox({ links, onClose }: { links: Link_[]; onClose: () => void }) {
  const url = (p: string) => `${window.location.origin}${p}`;
  const emailed = links.filter((l) => l.emailed);
  const notSetUp = links.some((l) => !l.emailed && !l.emailError);
  return (
    <Dialog
      open
      onClose={onClose}
      title={emailed.length === links.length ? "Invitation sent" : "Send this link"}
      subtitle="The link is shown only once. It works one time, for that address, until it expires."
      footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}
    >
      <div className="stack">
        {links.map((l) => (
          <div key={l.email}>
            <div className="label row" style={{ gap: 6 }}>{l.email}{l.emailed && <span className="badge ok">Emailed</span>}</div>
            <div className="input-group">
              <input className="input mono" readOnly value={url(l.path)} onFocus={(e) => e.currentTarget.select()} />
              <button className="btn" style={{ borderRadius: "0 7px 7px 0", marginLeft: -1 }} onClick={() => { copyText(url(l.path)); toast.success("Link copied"); }}><Copy size={14} /> Copy link</button>
            </div>
            {l.emailError && <div className="hint bad-text">The email could not be sent: {l.emailError}</div>}
          </div>
        ))}
        {notSetUp && (
          <div className="notice info small"><Mail size={15} /> <span>Email is not set up, so nothing was sent. Copy the link and send it yourself, or <Link href="/settings?tab=email" className="link">set up email</Link>.</span></div>
        )}
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
  const rules = trpc.team.rules.useQuery(undefined, { retry: false });
  const sites = trpc.sites.list.useQuery();
  const apps = useMemo(() => ((sites.data as any[]) ?? []).filter((s) => !s.isPreview).map((s) => ({ id: s.id, domain: s.domain })), [sites.data]);
  const isOwner = me.data?.role === "owner";

  const [inviting, setInviting] = useState(false);
  const [emails, setEmails] = useState("");
  const [note, setNote] = useState("");
  const [days, setDays] = useState<1 | 3 | 7 | 14>(7);
  const [access, setAccess] = useState<Access>(emptyAccess);
  const [links, setLinks] = useState<Link_[] | null>(null);

  const refresh = () => { utils.team.members.invalidate(); utils.team.invitations.invalidate(); utils.team.requests.invalidate(); utils.team.rules.invalidate(); };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const invite = trpc.team.invite.useMutation({ onSuccess: (out) => { setInviting(false); setEmails(""); setNote(""); setDays(7); setAccess(emptyAccess); setLinks(out as any); refresh(); }, onError });
  const renew = trpc.team.renewInvite.useMutation({
    onSuccess: (out: any, v: any) => {
      if (v?.send && out.emailed) toast.success(`Sent again to ${out.email}. The old link no longer works.`);
      else setLinks([out]);
      refresh();
    },
    onError,
  });
  const cancel = trpc.team.cancelInvite.useMutation({ onSuccess: () => { toast.success("Invitation cancelled"); refresh(); }, onError });
  const decide = trpc.team.decideRequest.useMutation({ onSuccess: (out: any) => { if (out.approved) setLinks([out]); else toast.success("Request declined"); refresh(); }, onError });
  const setRules = trpc.team.setRules.useMutation({ onSuccess: (r: any) => { toast.success(r.requireTwoFactor ? "2-step sign-in is now required. Members without it set it up at their next sign-in." : "2-step sign-in is no longer required"); refresh(); }, onError });

  const emailList = emails.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean);
  const emailsOk = emailList.length > 0 && emailList.length <= 20 && emailList.every((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));

  if (members.error) {
    return <div className="page"><Empty icon={<Users size={20} />} title="The team is managed by the owner and admins">Ask one of them if you need different access.</Empty></div>;
  }
  const list = (members.data as any[]) ?? [];
  const pending = (invites.data as any[]) ?? [];
  const asking = (requests.data as any[]) ?? [];
  const r = rules.data as any;
  const waiting = pending.filter((i) => i.state === "waiting");
  const expired = pending.filter((i) => i.state === "expired");
  const by = (role: string) => list.filter((m) => m.role === role).length;
  const counts = [["owner", "owner"], ["admin", "admin"], ["developer", "developer"], ["viewer", "viewer"], ["member", "member"]]
    .map(([k, w]) => [by(k), w] as const)
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}${n === 1 ? "" : "s"}`)
    .join(" · ");
  const withoutTwoStep = list.filter((m) => !m.twoFactor && !m.suspended);

  return (
    <div className="page">
      <PageHeader
        title="Team"
        description="People who can work in this panel. Everything they do is recorded under their own name."
        actions={<><Link href="/team/roles" className="btn">Roles</Link><button className="btn btn-primary" onClick={() => setInviting(true)}><Plus size={15} /> Invite member</button></>}
      />

      <div className="grid g3" style={{ marginBottom: 16 }}>
        <div className="card card-pad stat">
          <div className="k"><Users size={14} /> Members</div>
          <div className="v">{members.isLoading ? "…" : list.length}</div>
          <div className="s">{counts || "Nobody yet"}</div>
        </div>
        <div className="card card-pad stat">
          <div className="k"><Mail size={14} /> Invitations waiting</div>
          <div className="v">{waiting.length}</div>
          <div className="s ellipsis">{waiting[0] ? `${waiting[0].email} · ${daysLeft(waiting[0].expiresAt)} day${daysLeft(waiting[0].expiresAt) === 1 ? "" : "s"} left` : "None"}</div>
        </div>
        <div className="card card-pad stat">
          <div className="k"><ShieldCheck size={14} /> 2-step sign-in</div>
          <div className="v">{list.filter((m) => m.twoFactor).length} of {list.length}</div>
          <div className={cx("s", withoutTwoStep.length > 0 && "warn-text")}>{withoutTwoStep.length === 0 ? "Everyone has set it up" : withoutTwoStep.length === 1 ? `${withoutTwoStep[0].username} has not set it up` : `${withoutTwoStep.length} people have not set it up`}</div>
        </div>
      </div>

      {asking.length > 0 && (
        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card-head"><h3>Asking for access</h3><span className="badge warn">{asking.length}</span></div>
          {asking.map((a) => (
            <div key={a.id} className="attn-row">
              <div className="grow">
                <div style={{ fontWeight: 550 }}>{a.name} <span className="muted" style={{ fontWeight: 400 }}>· {a.email}</span></div>
                <div className="small muted">{a.message || "No message"} · {timeAgo(a.createdAt)}</div>
              </div>
              <button className="btn btn-sm" disabled={decide.isLoading} onClick={() => decide.mutate({ id: a.id, approve: false })}>Decline</button>
              <button className="btn btn-sm btn-primary" disabled={decide.isLoading} onClick={() => decide.mutate({ id: a.id, approve: true, origin: origin() })}>Approve</button>
            </div>
          ))}
          <div className="card-body small faint" style={{ borderTop: "1px solid var(--border)" }}>Approving gives the person a link to create their account. They can create and run their own apps and see nobody else&apos;s.</div>
        </section>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Members</h3><span className="right small faint">{list.length} {list.length === 1 ? "person" : "people"}</span></div>
        {members.isLoading ? <div className="card-body"><Skeleton h={120} /></div> : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 820 }}>
              <thead><tr><th>Member</th><th>Role</th><th>Can work on</th><th>2-step sign-in</th><th>Last active</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id}>
                    <td>
                      <div className="row">
                        <span className="avatar">{m.username.slice(0, 2).toUpperCase()}</span>
                        <div><div style={{ fontWeight: 550 }}>{m.username}</div><div className="small muted">{m.email}</div></div>
                      </div>
                    </td>
                    <td><span className={cx("badge", ROLE_TONE[m.role])}>{ROLE_LABEL[m.role] ?? m.role}</span>{m.suspended && <span className="badge bad" style={{ marginLeft: 6 }}>Suspended</span>}</td>
                    <td className="muted">{m.role === "owner" || m.role === "admin" ? "Everything" : m.allApps ? (m.role === "viewer" ? "All apps, read only" : "All apps") : `${m.sharedApps + m.ownApps} app${m.sharedApps + m.ownApps === 1 ? "" : "s"}`}</td>
                    <td>{m.twoFactor ? <span className="badge ok">On</span> : <span className="badge warn">Not set up</span>}</td>
                    <td className="muted">{m.you ? "Now" : m.lastActiveAt ? timeAgo(m.lastActiveAt) : "Never"}</td>
                    <td style={{ textAlign: "right" }}>{m.you ? <span className="small faint">You</span> : <Link href={`/team/${m.id}`} className="btn btn-sm">Manage</Link>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card" style={{ marginBottom: 16 }}>
        <div className="card-head"><h3>Invitations</h3><span className="right small faint">{waiting.length} waiting{expired.length ? ` · ${expired.length} expired` : ""}</span></div>
        {pending.length === 0 ? (
          <div className="card-body small muted">Nobody is waiting on an invitation.</div>
        ) : pending.map((i) => (
          <div key={i.id} className="attn-row">
            <span className="attn-ic"><Mail size={15} /></span>
            <div className="grow">
              <div style={{ fontWeight: 550 }}>{i.email} {i.state === "expired" && <span className="badge warn" style={{ marginLeft: 4 }}>Expired</span>}</div>
              <div className={cx("small", i.state === "expired" ? "warn-text" : "muted")}>
                {i.state === "expired"
                  ? `Expired ${timeAgo(i.expiresAt)}. The old link no longer works.`
                  : `${i.role === "admin" || i.allApps ? "all apps" : `${i.apps} app${i.apps === 1 ? "" : "s"}`} · sent ${timeAgo(i.createdAt)}${i.invitedBy ? ` by ${i.invitedBy}` : ""} · expires in ${daysLeft(i.expiresAt)} day${daysLeft(i.expiresAt) === 1 ? "" : "s"}`}
              </div>
            </div>
            <span className="badge">{ROLE_LABEL[i.role]}</span>
            {i.state === "expired" ? (
              <>
                <button className="btn btn-sm" disabled={renew.isLoading} onClick={() => renew.mutate({ id: i.id, send: true, origin: origin() })}>Send a new one</button>
                <button className="btn btn-sm btn-ghost" disabled={cancel.isLoading} onClick={() => cancel.mutate({ id: i.id })}>Remove</button>
              </>
            ) : (
              <>
                <button className="btn btn-sm" disabled={renew.isLoading} onClick={() => renew.mutate({ id: i.id, send: true, origin: origin() })}>Send again</button>
                <button className="btn btn-sm" disabled={renew.isLoading} title="Makes a new link; the one sent before stops working" onClick={() => renew.mutate({ id: i.id, send: false })}><Copy size={13} /> Copy link</button>
                <button className="btn btn-sm btn-ghost" disabled={cancel.isLoading} onClick={() => cancel.mutate({ id: i.id })}>Cancel</button>
              </>
            )}
          </div>
        ))}
      </section>

      <div className="grid g2">
        <section className="card">
          <div className="card-head"><h3>Team rules</h3></div>
          <div className="card-body">
            <label className="rule-row">
              <span className="grow">
                <span style={{ fontWeight: 550 }}>Everyone must use 2-step sign-in</span>
                <span className="small muted" style={{ display: "block" }}>Members without it are asked to set it up at their next sign-in.</span>
              </span>
              <span className="switch">
                <input type="checkbox" aria-label="Everyone must use 2-step sign-in" checked={!!r?.requireTwoFactor} disabled={!r || setRules.isLoading} onChange={(e) => setRules.mutate({ requireTwoFactor: e.target.checked })} />
                <span />
              </span>
            </label>
            {r?.requireTwoFactor === false && withoutTwoStep.some((m) => m.you) && <div className="notice warn small" style={{ margin: "4px 0 8px" }}><AlertTriangle size={14} className="warn-text" /><span>You have not set it up yourself. <Link href="/settings?tab=signin" className="link">Set it up first</Link>, or you will be asked at your next sign-in.</span></div>}
            <div className="rule-row" style={{ cursor: "default" }}>
              <span className="grow">
                <span style={{ fontWeight: 550 }}>Only the owner and admins can invite</span>
                <span className="small muted" style={{ display: "block" }}>Developers and viewers cannot add people.</span>
              </span>
              <span className="badge square">Always</span>
            </div>
            <div className="rule-row" style={{ cursor: "default" }}>
              <span className="grow">
                <span style={{ fontWeight: 550 }}>Sign out after 30 minutes without activity</span>
                <span className="small muted" style={{ display: "block" }}>And after 7 days in any case. The member signs in again to continue.</span>
              </span>
              <span className="badge square">Always</span>
            </div>
          </div>
        </section>
        <section className="card">
          <div className="card-head"><h3>How access works</h3></div>
          <div className="card-body stack small muted" style={{ gap: 10 }}>
            <div>A role sets what a member may do. Apps set where they may do it.</div>
            <div>Nobody can give more access than they have themselves.</div>
            <div>An AI agent token made by a member can never do more than that member.</div>
            <div><Link href="/team/roles" className="link">See every role&apos;s permissions</Link></div>
          </div>
        </section>
      </div>

      <Dialog
        open={inviting}
        onClose={() => setInviting(false)}
        width={720}
        title="Invite a member"
        subtitle="They get an email with a link. The link works once, only for that address."
        footer={
          <>
            <button className="btn" onClick={() => setInviting(false)}>Cancel</button>
            <button className="btn btn-primary" disabled={!emailsOk || invite.isLoading} onClick={() => invite.mutate({ emails: emailList, note: note.trim() || undefined, expiresInDays: days, origin: origin(), ...access })}>
              {invite.isLoading ? <Spinner /> : <><Mail size={14} /> Send invitation</>}
            </button>
          </>
        }
      >
        <div className="stack" style={{ gap: 20 }}>
          <div>
            <label className="label" htmlFor="inv-emails">Email addresses</label>
            <input id="inv-emails" className="input" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="lena@example.com, sam@example.com" autoFocus />
            <div className="hint">Separate several addresses with a comma. Each person gets their own invitation.</div>
          </div>
          <div>
            <label className="label" htmlFor="inv-note">Note in the email (optional)</label>
            <input id="inv-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Welcome! Start with shop-api." />
          </div>
          <AccessEditor value={access} onChange={setAccess} apps={apps} canMakeAdmin={isOwner} />
          <div>
            <span className="label">The invitation expires after</span>
            <div className="seg">
              {([[7, "7 days"], [1, "24 hours"], [3, "3 days"], [14, "14 days"]] as const).map(([v, l]) => (
                <button key={v} type="button" className={cx(days === v && "on")} onClick={() => setDays(v)}>{l}</button>
              ))}
            </div>
          </div>
          {r?.requireTwoFactor && <div className="notice info small"><ShieldCheck size={15} /> <span>This team requires 2-step sign-in. {emailList.length === 1 ? emailList[0] : "They"} set{emailList.length === 1 ? "s" : ""} it up right after accepting.</span></div>}
          <Summary access={access} />
          <div className="small faint">Emails are sent with the mail settings under <Link href="/settings?tab=email" className="link">Settings › Email</Link>. If email is not set up, you get a link to pass on yourself.</div>
        </div>
      </Dialog>

      {links && <LinkBox links={links} onClose={() => setLinks(null)} />}
    </div>
  );
}
