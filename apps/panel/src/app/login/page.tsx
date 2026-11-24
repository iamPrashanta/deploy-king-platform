"use client";

import React, { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { trpc } from "@/utils/trpc";
import { Crown } from "@/components/shell/Shell";
import { ThemeSwitch } from "@/components/theme";
import { Spinner } from "@/components/ui";

function LoginForm() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  const params = useSearchParams();
  const message = params.get("message");

  const login = trpc.auth.login.useMutation({
    onSuccess: (data: any) => {
      localStorage.setItem("token", data.token);
      router.push(data.user?.mustChangePassword ? "/setup/password" : "/");
    },
    onError: (err) => setError(err.message === "Invalid credentials" ? "Wrong username or password." : err.message),
  });

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
