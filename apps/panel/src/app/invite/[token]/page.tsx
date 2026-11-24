"use client";

import { useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { trpc } from "@/utils/trpc";
import { Crown } from "@/components/shell/Shell";
import { Skeleton, Spinner, errMsg } from "@/components/ui";

/** Public page: accept an invitation by choosing a username and password. */

const ROLE: Record<string, { label: string; can: string[]; cannot: string[] }> = {
  admin: { label: "an Admin", can: ["Everything, including the team and settings"], cannot: ["Change or remove the owner"] },
  developer: { label: "a Developer", can: ["Deploy and roll back your apps", "Add and replace variables", "Read logs and deploy history"], cannot: ["See servers, team or settings"] },
  viewer: { label: "a Viewer", can: ["See status, logs and deploy history"], cannot: ["Deploy, change or delete anything"] },
};
const EXTRA: Record<string, string> = { createApps: "Create apps", deleteApps: "Delete apps", terminal: "Open a terminal inside your apps", agentTokens: "Create AI agent tokens" };

export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const inv = trpc.team.invitation.useQuery({ token }, { retry: false, refetchOnWindowFocus: false });
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const accept = trpc.team.accept.useMutation({
    onSuccess: (data: any) => {
      localStorage.setItem("token", data.token);
      window.location.href = "/"; // a full load, so the panel starts with the new session
    },
    onError: (e) => setError(errMsg(e)),
  });
  const d: any = inv.data;
  const nameOk = /^[a-zA-Z0-9][a-zA-Z0-9._-]{2,29}$/.test(username);
  const ready = nameOk && password.length >= 12 && password === again;

  return (
    <main className="auth">
      <div className="auth-card" style={{ maxWidth: 440 }}>
        <div className="auth-brand">
          <span className="logo" style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--fill-bg)", color: "var(--fill-fg)" }}><Crown size={17} /></span>
          Deploy King
        </div>
        <div className="card card-pad" style={{ padding: 28 }}>
          {inv.isLoading ? <Skeleton h={220} /> : !d || d.state !== "waiting" ? (
            <>
              <h1>{d?.state === "accepted" ? "This invitation was already used" : d?.state === "expired" ? "This invitation has expired" : "This invitation is not valid"}</h1>
              <p className="sub">
                {d?.state === "accepted" ? "Sign in with the account you created." : d?.inviter ? `Ask ${d.inviter} for a new one. An old link stops working as soon as a new one is made.` : "Check the link, or ask the person who invited you for a new one."}
              </p>
              <Link href="/login" className="btn btn-lg btn-block">Go to sign in</Link>
            </>
          ) : (
            <>
              <h1>Join the team</h1>
              <p className="sub">{d.inviter ? `${d.inviter} invited ` : "You are invited: "}<strong style={{ color: "var(--text)" }}>{d.email}</strong> as {ROLE[d.role]?.label ?? d.role}.</p>
              {d.note && <div className="notice small" style={{ marginBottom: 16 }}>&ldquo;{d.note}&rdquo;</div>}
              <div className="card card-pad" style={{ background: "var(--card-2)", marginBottom: 20 }}>
                <div className="small muted" style={{ marginBottom: 8 }}>{d.role === "admin" || d.allApps ? "You can work on every app" : d.apps.length ? "Your apps" : "You start with no apps and can create your own"}</div>
                {!d.allApps && d.apps.length > 0 && <div className="row wrap" style={{ gap: 6, marginBottom: 12 }}>{d.apps.map((a: string) => <span key={a} className="badge square mono">{a}</span>)}</div>}
                <ul className="can-list">
                  {[...(ROLE[d.role]?.can ?? []), ...Object.keys(d.grants ?? {}).filter((k) => d.grants[k]).map((k) => EXTRA[k])].map((t) => <li key={t}><Check size={13} className="ok-text" /> {t}</li>)}
                  {(ROLE[d.role]?.cannot ?? []).map((t) => <li key={t} className="muted"><X size={13} /> {t}</li>)}
                </ul>
              </div>
              <form onSubmit={(e) => { e.preventDefault(); setError(""); if (ready) accept.mutate({ token, username: username.trim(), password }); }}>
                <div className="field">
                  <label className="label" htmlFor="iu">Choose a username</label>
                  <input id="iu" className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
                  <div className="hint">3 to 30 letters, numbers, dots, dashes or underscores. You sign in with it.</div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="ip">Password</label>
                  <input id="ip" className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
                  <div className="hint">At least 12 characters.</div>
                </div>
                <div className="field">
                  <label className="label" htmlFor="ip2">Repeat the password</label>
                  <input id="ip2" className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required aria-invalid={again.length > 0 && again !== password} />
                  {again.length > 0 && again !== password && <div className="hint bad-text">The two passwords are different.</div>}
                </div>
                {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}
                <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!ready || accept.isLoading}>{accept.isLoading ? <Spinner /> : "Accept and continue"}</button>
              </form>
              <p className="small muted" style={{ marginTop: 16, textAlign: "center" }}>Everything you do in the panel is recorded under your name.</p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
