"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Bot, Check, History, LogOut, Monitor, ShieldCheck, ShieldOff, Smartphone, UserMinus } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useAuth } from "@/components/AuthProvider";
import { useCrumbs } from "@/components/shell/Shell";
import { Dialog, Empty, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";
import { EXTRAS, ROLES, ROLE_LABEL, ROLE_TONE, Summary, type Access, type Grants } from "@/components/TeamAccess";

/**
 * One member's access: role, apps, every permission switch, sign-in details, the devices they are signed in on,
 * their AI agent tokens and what they did last. Changes apply at once; the member does not sign in again.
 */

/** "Chrome on Windows" from a user agent. Good enough to tell devices apart; not a security check. */
function device(ua: string | null | undefined) {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /curl|node|python|Go-http/i.test(ua) ? "A script" : "A browser";
  const os = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows" : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

const ACTION: Record<string, string> = {
  deploy: "Deployed",
  rollback: "Rolled back",
  site_create: "Created the app",
  site_delete: "Deleted the app",
  secret_set: "Changed variables on",
  file_edit: "Edited a file in",
  cron_create: "Added a scheduled job on",
  cron_update: "Changed a scheduled job on",
  cron_delete: "Removed a scheduled job on",
  cron_run: "Ran a scheduled job on",
  worker_change: "Changed workers of",
  api_token_create: "Created the token",
  api_token_revoke: "Revoked the token",
  team_accept: "Joined the team",
  two_factor_enable: "Turned on 2-step sign-in",
  two_factor_disable: "Turned off 2-step sign-in",
  two_factor_recovery_used: "Signed in with a recovery code",
  two_factor_recovery_new: "Made new recovery codes",
  login: "Signed in",
};

/** Always part of the role, whatever the switches say. */
const INCLUDED: Record<string, string[]> = {
  developer: ["Deploy and roll back their apps, and answer deploy questions", "Add and replace variables", "Read logs and deploy history", "Scheduled jobs and workers of their apps", "Files of their apps"],
  viewer: ["See status, logs and deploy history of their apps"],
};

function MemberPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const utils = trpc.useContext();
  const me = trpc.team.me.useQuery();
  const { user } = useAuth();
  const q = trpc.team.member.useQuery({ id }, { retry: false });
  const sites = trpc.sites.list.useQuery();
  const apps = useMemo(() => ((sites.data as any[]) ?? []).filter((s) => !s.isPreview).map((s) => ({ id: s.id, domain: s.domain })), [sites.data]);
  const m = q.data as any;
  useCrumbs([{ label: "Team", href: "/team" }, { label: m?.username ?? "Member" }]);

  const [access, setAccess] = useState<Access | null>(null);
  const [removing, setRemoving] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [resetting, setResetting] = useState(false);
  useEffect(() => {
    if (m) setAccess({ role: m.role === "member" || m.role === "owner" ? (m.role === "owner" ? "admin" : "developer") : m.role, allApps: m.allApps, siteIds: m.siteIds, grants: m.grants });
  }, [m]);

  const refresh = () => { utils.team.member.invalidate({ id }); utils.team.members.invalidate(); };
  const onError = (e: unknown) => toast.error(errMsg(e));
  const update = trpc.team.updateMember.useMutation({ onSuccess: () => { toast.success(`Saved. It applies at once; ${m?.username} does not have to sign in again.`); refresh(); }, onError });
  const suspend = trpc.team.setSuspended.useMutation({ onSuccess: (_d, v: any) => { toast.success(v?.suspended ? "Suspended and signed out everywhere" : "Suspension lifted"); refresh(); }, onError });
  const remove = trpc.team.remove.useMutation({ onSuccess: (out: any) => { toast.success(out.appsHandedOver ? `Removed. ${out.appsHandedOver} app${out.appsHandedOver === 1 ? " is" : "s are"} now yours.` : "Removed from the team"); router.push("/team"); }, onError });
  const signOut = trpc.team.signOutEverywhere.useMutation({ onSuccess: (o: any) => { toast.success(o.sessions ? `Signed out of ${o.sessions} session${o.sessions === 1 ? "" : "s"}` : "There was no session to end"); refresh(); }, onError });
  const reset = trpc.team.resetTwoFactor.useMutation({ onSuccess: () => { toast.success("2-step sign-in was reset. They set it up again at their next sign-in."); setResetting(false); refresh(); }, onError });
  const revoke = trpc.team.revokeMemberToken.useMutation({ onSuccess: () => { toast.success("Token revoked"); refresh(); }, onError });

  if (q.error) return <div className="page"><Empty title={/not found/i.test(q.error.message) ? "Member not found" : "Only the owner and admins manage the team"}><Link href="/team" className="link">Back to the team</Link></Empty></div>;
  if (!m || !access) return <div className="page"><Skeleton h={420} /></div>;

  const isOwner = me.data?.role === "owner";
  const you = m.id === user?.id;
  const locked = you ? "This is you. Nobody can change their own access; your own 2-step sign-in is in Settings › Sign-in." : m.role === "owner" ? "The owner cannot be changed or removed." : m.role === "admin" && !isOwner ? "Only the owner can change or remove admins." : null;
  const canEdit = !locked && !you;
  const dirty = JSON.stringify(access) !== JSON.stringify({ role: m.role === "member" ? "developer" : m.role, allApps: m.allApps, siteIds: m.siteIds, grants: m.grants });
  const toggleApp = (sid: string) => setAccess({ ...access, siteIds: access.siteIds.includes(sid) ? access.siteIds.filter((x) => x !== sid) : [...access.siteIds, sid] });
  const setGrant = (k: keyof Grants, v: boolean) => setAccess({ ...access, grants: { ...access.grants, [k]: v } });
  const first = m.username;

  return (
    <div className="page">
      <div className="row wrap" style={{ gap: 14, marginBottom: 24 }}>
        <span className="avatar" style={{ width: 48, height: 48, fontSize: 16 }}>{m.username.slice(0, 2).toUpperCase()}</span>
        <div className="grow">
          <h1 style={{ fontSize: 24, margin: 0 }}>{m.username}</h1>
          <div className="row wrap small muted" style={{ gap: 8, marginTop: 4 }}>
            {m.email}
            <span className={cx("badge", ROLE_TONE[m.role])}>{ROLE_LABEL[m.role] ?? m.role}</span>
            {m.suspended ? <span className="badge bad">Suspended</span> : <span className="badge ok">Active</span>}
          </div>
        </div>
        {canEdit && (
          <>
            <button className="btn" disabled={suspend.isLoading} onClick={() => suspend.mutate({ id: m.id, suspended: !m.suspended })}>{m.suspended ? "Lift suspension" : "Suspend"}</button>
            <button className="btn btn-danger" onClick={() => { setRemoving(true); setConfirmName(""); }}><UserMinus size={14} /> Remove from team</button>
          </>
        )}
      </div>
      {locked && <div className="notice small" style={{ marginBottom: 16 }}>{locked}</div>}

      <div className="side-layout">
        <div className="stack" style={{ gap: 16 }}>
          <section className="card">
            <div className="card-head"><h3>Role</h3></div>
            <div className="card-body">
              <div className="choice-grid">
                {ROLES.filter((r) => r.v !== "admin" || isOwner || access.role === "admin").map((r) => (
                  <label key={r.v} className={cx("choice", access.role === r.v && "on")}>
                    <input type="radio" name="role" disabled={!canEdit} checked={access.role === r.v} onChange={() => setAccess({ ...access, role: r.v })} />
                    <span><strong>{r.label}</strong><span className="small muted">{r.text}</span></span>
                  </label>
                ))}
              </div>
            </div>
          </section>

          {access.role !== "admin" && (
            <section className="card">
              <div className="card-head"><h3>Apps</h3><span className="right small faint">{access.allApps ? "All apps" : `${access.siteIds.length} of ${apps.length} selected`}</span></div>
              <div className="card-body stack" style={{ gap: 12 }}>
                <label className="check small"><input type="checkbox" disabled={!canEdit} checked={access.allApps} onChange={(e) => setAccess({ ...access, allApps: e.target.checked })} /><span>All apps, including ones added later</span></label>
                {!access.allApps && (
                  <div className="row wrap" style={{ gap: 8 }}>
                    {apps.length === 0 && <span className="small faint">There are no apps yet.</span>}
                    {apps.map((a) => {
                      const on = access.siteIds.includes(a.id);
                      return <button key={a.id} type="button" disabled={!canEdit} role="checkbox" aria-checked={on} className={cx("chip-btn mono", on && "on")} onClick={() => toggleApp(a.id)}>{on && <Check size={12} />} {a.domain}</button>;
                    })}
                  </div>
                )}
                <div className="small faint">Apps they create themselves are always theirs.</div>
              </div>
            </section>
          )}

          {access.role !== "admin" && (
            <section className="card">
              <div className="card-head"><h3>Permissions</h3></div>
              <div className="card-body">
                <div className="label">Included as {ROLE_LABEL[access.role]}</div>
                <ul className="can-list" style={{ marginBottom: 14 }}>{(INCLUDED[access.role] ?? []).map((t) => <li key={t}><Check size={13} className="ok-text" /> {t}</li>)}</ul>
                {access.role === "developer" ? (
                  <>
                    <div className="label">Off unless switched on</div>
                    {EXTRAS.map((e) => (
                      <label key={e.k} className="rule-row">
                        <span className="grow"><span style={{ fontWeight: 550 }}>{e.label}</span><span className="small muted" style={{ display: "block" }}>{e.text}</span></span>
                        <span className="switch"><input type="checkbox" aria-label={e.label} disabled={!canEdit} checked={!!access.grants[e.k]} onChange={(ev) => setGrant(e.k, ev.target.checked)} /><span /></span>
                      </label>
                    ))}
                  </>
                ) : <div className="small muted">A viewer changes nothing, so there is nothing to switch on.</div>}
              </div>
            </section>
          )}

          {access.role === "admin" && <Summary access={access} />}

          {canEdit && (
            <div className="row" style={{ gap: 12 }}>
              <button className="btn btn-primary" disabled={!dirty || update.isLoading} onClick={() => update.mutate({ id: m.id, ...access })}>{update.isLoading ? <Spinner /> : <><ShieldCheck size={14} /> Save changes</>}</button>
              <span className="small muted">Changes apply at once. {first} does not have to sign in again.</span>
            </div>
          )}
        </div>

        <div className="stack" style={{ gap: 16 }}>
          <section className="card">
            <div className="card-head"><Smartphone size={15} /><h3>Sign-in</h3></div>
            <div className="card-body stack" style={{ gap: 12 }}>
              <dl className="kv" style={{ gridTemplateColumns: "110px minmax(0,1fr)" }}>
                <dt>2-step sign-in</dt>
                <dd>{m.twoFactor ? <span className="badge ok">On</span> : <span className="badge warn">Not set up</span>}{m.twoFactor && <span className="small faint"> · {m.recoveryLeft} recovery codes left</span>}</dd>
                <dt>Last active</dt>
                <dd className="small">{m.lastActiveAt ? `${timeAgo(m.lastActiveAt)}, ${new Date(m.lastActiveAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Never"}</dd>
                <dt>Joined</dt>
                <dd className="small">{m.joinedAt ? new Date(m.joinedAt).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "…"}{m.invitedBy ? ` · invited by ${m.invitedBy}` : ""}</dd>
              </dl>
              {m.twoFactor && canEdit && <div><button className="btn btn-sm" onClick={() => setResetting(true)}><ShieldOff size={13} /> Reset 2-step sign-in</button></div>}
              <div>
                <div className="label">Signed in on</div>
                {m.devices.length === 0 ? <div className="small muted">Not signed in anywhere.</div> : (
                  <div className="stack" style={{ gap: 8 }}>
                    {m.devices.map((d: any) => (
                      <div key={d.id} className="row small" style={{ gap: 8 }}>
                        <Monitor size={14} className="muted" />
                        <span className="grow">{device(d.userAgent)}{d.ip ? <span className="faint mono"> · {d.ip}</span> : null}</span>
                        <span className="faint">{timeAgo(d.lastActivityAt)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {canEdit && <div><button className="btn btn-sm" disabled={signOut.isLoading || m.devices.length === 0} onClick={() => signOut.mutate({ id: m.id })}><LogOut size={13} /> Sign out everywhere</button></div>}
            </div>
          </section>

          <section className="card">
            <div className="card-head"><Bot size={15} /><h3>AI agent tokens</h3></div>
            <div className="card-body stack" style={{ gap: 10 }}>
              {m.tokens.length === 0 ? <div className="small muted">No tokens.</div> : m.tokens.map((t: any) => (
                <div key={t.id} className="row small" style={{ gap: 8 }}>
                  <span className="grow"><span className="mono" style={{ fontWeight: 550 }}>{t.name}</span><span className="muted"> · {t.scope === "full" ? "Full" : t.scope === "deploy" ? "Deploy" : "Read"} · {t.lastUsedAt ? `used ${timeAgo(t.lastUsedAt)}` : "never used"}</span></span>
                  {canEdit && <button className="btn btn-sm btn-ghost" disabled={revoke.isLoading} onClick={() => revoke.mutate({ id: m.id, tokenId: t.id })}>Revoke</button>}
                </div>
              ))}
              <div className="small faint">{m.role === "admin" || m.role === "owner" || m.allApps ? `Limited to what ${first} may do.` : `Limited to ${first}'s ${m.siteIds.length} shared app${m.siteIds.length === 1 ? "" : "s"} and the ones they created.`} Tokens stop working when the member is suspended or removed.</div>
            </div>
          </section>

          <section className="card">
            <div className="card-head"><History size={15} /><h3>Recent activity</h3></div>
            <div className="card-body stack" style={{ gap: 8 }}>
              {m.activity.length === 0 ? <div className="small muted">Nothing yet.</div> : m.activity.map((a: any) => (
                <div key={a.id} className="row small" style={{ gap: 8 }}>
                  <span className="grow ellipsis">{ACTION[a.action] ?? a.action.replace(/_/g, " ")}{a.targetName && !/^two_factor|^login|^team_accept/.test(a.action) ? <span className="mono"> {a.targetName}</span> : null}</span>
                  <span className="faint">{timeAgo(a.createdAt)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        width={480}
        title={`Remove ${m.username} from the team`}
        subtitle="Their account and agent tokens are deleted. Apps they created keep running and become yours."
        footer={<><button className="btn" onClick={() => setRemoving(false)}>Cancel</button><button className="btn btn-danger" disabled={confirmName !== m.username || remove.isLoading} onClick={() => remove.mutate({ id: m.id, confirm: confirmName })}>{remove.isLoading ? <Spinner /> : "Remove"}</button></>}
      >
        <label className="label" htmlFor="rm-name">Type <span className="mono">{m.username}</span> to confirm</label>
        <input id="rm-name" className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoFocus />
      </Dialog>

      <Dialog
        open={resetting}
        onClose={() => setResetting(false)}
        width={460}
        title="Reset 2-step sign-in"
        subtitle={`For when ${m.username} lost their phone and their recovery codes.`}
        footer={<><button className="btn" onClick={() => setResetting(false)}>Cancel</button><button className="btn btn-danger" disabled={reset.isLoading} onClick={() => reset.mutate({ id: m.id })}>{reset.isLoading ? <Spinner /> : "Reset"}</button></>}
      >
        <div className="small muted">Their 2-step sign-in and recovery codes are removed and they are signed out everywhere. They sign in with their password and set it up again{" "}(at once, if the team requires it). Make sure the request really comes from them.</div>
      </Dialog>
    </div>
  );
}

export default MemberPage;
