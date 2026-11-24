"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { trpc } from "@/utils/trpc";
import { Crown } from "@/components/shell/Shell";
import { Spinner, errMsg } from "@/components/ui";

/**
 * Public page: ask for an account. Nothing is created until the owner approves;
 * every account can run its own code on the server, so strangers are looked at first.
 */
export default function SignupPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const ask = trpc.team.requestAccess.useMutation({ onError: (e) => setError(errMsg(e)) });

  return (
    <main className="auth">
      <div className="auth-card" style={{ maxWidth: 420 }}>
        <div className="auth-brand">
          <span className="logo" style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--fill-bg)", color: "var(--fill-fg)" }}><Crown size={17} /></span>
          Deploy King
        </div>
        <div className="card card-pad" style={{ padding: 28 }}>
          {ask.isSuccess ? (
            <div style={{ textAlign: "center" }}>
              <CheckCircle2 size={34} className="ok-text" style={{ margin: "0 auto 12px" }} />
              <h1>Request received</h1>
              <p className="sub">If it is approved, you get a link to create your account. Nothing else is needed from you now.</p>
              <Link href="/login" className="btn btn-lg btn-block">Back to sign in</Link>
            </div>
          ) : (
            <>
              <h1>Request access</h1>
              <p className="sub">The owner of this panel approves each new account.</p>
              <form onSubmit={(e) => { e.preventDefault(); setError(""); ask.mutate({ name: name.trim(), email: email.trim(), message: message.trim() || undefined }); }}>
                <div className="field">
                  <label className="label" htmlFor="sn">Your name</label>
                  <input id="sn" className="input" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
                </div>
                <div className="field">
                  <label className="label" htmlFor="se">Email</label>
                  <input id="se" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
                </div>
                <div className="field">
                  <label className="label" htmlFor="sm">What will you deploy? (optional)</label>
                  <textarea id="sm" className="textarea" rows={3} maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
                </div>
                {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}
                <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={ask.isLoading}>{ask.isLoading ? <Spinner /> : "Request access"}</button>
              </form>
              <p className="small muted" style={{ marginTop: 16, textAlign: "center" }}>Already have an account? <Link href="/login" style={{ color: "var(--link)" }}>Sign in</Link></p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
