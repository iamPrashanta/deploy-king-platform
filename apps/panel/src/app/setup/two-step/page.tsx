"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { trpc } from "@/utils/trpc";
import { Crown } from "@/components/shell/Shell";
import { RecoveryCodes, TwoStepSetup } from "@/components/TwoStep";
import { TWO_STEP_KEY } from "@/components/paths";

/**
 * Sign-in, when the team requires 2-step sign-in and this account has not set it up (or an admin reset it).
 * The page holds a short-lived challenge from the password step, not a session; the session comes once a code is confirmed.
 */
export default function TwoStepSetupPage() {
  const [challenge, setChallenge] = useState<string | null | undefined>(undefined);
  const [done, setDone] = useState<{ codes: string[]; token: string; mustChangePassword: boolean } | null>(null);
  const start = trpc.auth.setupStart.useMutation();
  const confirm = trpc.auth.setupConfirm.useMutation();

  useEffect(() => setChallenge(sessionStorage.getItem(TWO_STEP_KEY)), []);

  const doStart = useCallback(() => start.mutateAsync({ challenge: challenge! }), [challenge]); // eslint-disable-line react-hooks/exhaustive-deps
  const doConfirm = useCallback(
    async (code: string) => {
      const out: any = await confirm.mutateAsync({ challenge: challenge!, code });
      setDone({ codes: out.recoveryCodes, token: out.token, mustChangePassword: !!out.user?.mustChangePassword });
      return out;
    },
    [challenge] // eslint-disable-line react-hooks/exhaustive-deps
  );

  const finish = () => {
    if (!done) return;
    sessionStorage.removeItem(TWO_STEP_KEY);
    localStorage.setItem("token", done.token);
    window.location.href = done.mustChangePassword ? "/setup/password" : "/"; // a full load, so the panel starts with the new session
  };

  return (
    <main className="auth">
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <div className="auth-brand">
          <span className="logo" style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--fill-bg)", color: "var(--fill-fg)" }}><Crown size={17} /></span>
          Deploy King
        </div>
        <div className="card card-pad" style={{ padding: 28 }}>
          {challenge === undefined ? null : !challenge ? (
            <>
              <h1>Sign in first</h1>
              <p className="sub">This page continues a sign-in. Start again with your username and password.</p>
              <Link href="/login" className="btn btn-lg btn-block">Go to sign in</Link>
            </>
          ) : done ? (
            <>
              <h1>Save your recovery codes</h1>
              <p className="sub">One more step, then you are signed in.</p>
              <RecoveryCodes codes={done.codes} onContinue={finish} continueLabel="Continue to the panel" />
            </>
          ) : (
            <>
              <h1>Set up 2-step sign-in</h1>
              <p className="sub">This team requires it. From now on you sign in with your password and a code from your phone.</p>
              <TwoStepSetup start={doStart} confirm={doConfirm} onDone={() => {}} />
              <p className="small faint" style={{ marginTop: 16, textAlign: "center" }}>
                Not now? <Link href="/login" className="link" onClick={() => sessionStorage.removeItem(TWO_STEP_KEY)}>Back to sign in</Link>. You cannot use the panel until it is set up.
              </p>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
