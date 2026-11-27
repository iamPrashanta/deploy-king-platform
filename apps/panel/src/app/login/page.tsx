"use client";

import React, { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { Crown } from "@/components/shell/Shell";
import { ThemeSwitch } from "@/components/theme";
import { Spinner } from "@/components/ui";
import { CodeInput } from "@/components/TwoStep";
import { TWO_STEP_KEY } from "@/components/paths";

function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  const params = useSearchParams();
  const message = params.get("message");

  // After the password: a code from the authenticator app, when 2-step sign-in is on.
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState(false);

  const signedIn = (data: any) => {
    localStorage.setItem("token", data.token);
    if (recovery && typeof data.recoveryLeft === "number") toast.warning(`${data.recoveryLeft} recovery code${data.recoveryLeft === 1 ? "" : "s"} left. Make new ones in Settings › Sign-in.`);
    router.push(data.user?.mustChangePassword ? "/setup/password" : "/");
  };
  const login = trpc.auth.login.useMutation({
    onSuccess: (data: any) => {
      if (data.step === "code") {
        setChallenge(data.challenge);
        setCode("");
        return;
      }
      if (data.step === "setup") {
        sessionStorage.setItem(TWO_STEP_KEY, data.challenge);
        router.push("/setup/two-step");
        return;
      }
      signedIn(data);
    },
    onError: (err) => setError(err.message === "Invalid credentials" ? "Wrong username or password." : err.message),
  });
  const loginCode = trpc.auth.loginCode.useMutation({
    onSuccess: signedIn,
    onError: (err) => {
      if (/expired/.test(err.message)) setChallenge(null);
      setError(err.message);
      setCode("");
    },
  });
  const codeReady = recovery ? code.replace(/[^a-zA-Z0-9]/g, "").length === 8 : code.length === 6;

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="auth-brand">
          <span className="logo" style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--fill-bg)", color: "var(--fill-fg)" }}>
            <Crown size={17} />
          </span>
          Deploy King
        </div>
        <div className="card card-pad" style={{ padding: 28 }}>
          {challenge ? (
            <>
              <h1>2-step sign-in</h1>
              <p className="sub">{recovery ? "Type one of the recovery codes you saved. Each works once." : "Type the 6-digit code from your authenticator app."}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  setError("");
                  if (codeReady) loginCode.mutate({ challenge, code });
                }}
              >
                <div className="field">
                  <CodeInput value={code} onChange={setCode} autoFocus recovery={recovery} key={recovery ? "r" : "c"} />
                </div>
                {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}
                <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={!codeReady || loginCode.isLoading}>
                  {loginCode.isLoading ? <Spinner /> : "Verify and sign in"}
                </button>
              </form>
              <div className="row" style={{ justifyContent: "space-between", marginTop: 14 }}>
                <button type="button" className="link small" onClick={() => { setRecovery(!recovery); setCode(""); setError(""); }}>{recovery ? "Use a code from the app" : "Use a recovery code"}</button>
                <button type="button" className="link small" onClick={() => { setChallenge(null); setError(""); setPassword(""); }}>Back</button>
              </div>
              <p className="small faint" style={{ marginTop: 14 }}>Lost your phone and your recovery codes? Ask the owner or an admin to reset your 2-step sign-in.</p>
            </>
          ) : (
          <>
          <h1>Sign in</h1>
          <p className="sub">to your Deploy King server</p>
          {message && <div className="notice ok" style={{ marginBottom: 16 }}>{message}</div>}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              login.mutate({ username: username.trim(), password });
            }}
          >
            <div className="field">
              <label className="label" htmlFor="u">Username</label>
              <input id="u" className="input" autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} required />
            </div>
            <div className="field">
              <label className="label" htmlFor="p">Password</label>
              <input id="p" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </div>
            {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={login.isLoading}>
              {login.isLoading ? <Spinner /> : "Sign in"}
            </button>
          </form>
          </>
          )}
        </div>
        <p className="small muted" style={{ textAlign: "center", marginTop: 16 }}>No account yet? <a href="/signup" style={{ color: "var(--link)" }}>Request access</a></p>
        <div className="row" style={{ justifyContent: "center", marginTop: 20 }}>
          <ThemeSwitch compact />
        </div>
      </div>
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
