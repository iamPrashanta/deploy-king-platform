"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { trpc } from "@/utils/trpc";
import { useAuth } from "@/components/AuthProvider";
import { Crown } from "@/components/shell/Shell";
import { Spinner } from "@/components/ui";

export default function PasswordSetupPage() {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const router = useRouter();
  const { logout } = useAuth();

  const changePassword = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      // The API revokes every session after a password change, so sign in again.
      logout();
      router.push("/login?message=Password updated. Sign in with the new password.");
    },
    onError: (err) => setError(err.message),
  });

  return (
    <main className="auth">
      <div className="auth-card" style={{ maxWidth: 420 }}>
        <div className="auth-brand">
          <span style={{ width: 30, height: 30, borderRadius: 8, display: "grid", placeItems: "center", background: "var(--primary-bg)", color: "var(--primary-fg)" }}>
            <Crown size={17} />
          </span>
          Deploy King
        </div>
        <div className="card" style={{ padding: 28 }}>
          <h1>Choose a new password</h1>
          <p className="sub">The first sign-in uses a temporary password. Set your own to continue.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              setError("");
              if (password.length < 8) return setError("Use at least 8 characters.");
              if (password !== confirm) return setError("The two passwords are different.");
              changePassword.mutate({ newPassword: password });
            }}
          >
            <div className="field">
              <label className="label">New password</label>
              <input className="input" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
              <div className="hint">At least 8 characters.</div>
            </div>
            <div className="field">
              <label className="label">Repeat it</label>
              <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
            </div>
            {error && <div className="notice bad" style={{ marginBottom: 16 }}>{error}</div>}
            <button type="submit" className="btn btn-primary btn-lg btn-block" disabled={changePassword.isLoading}>
              {changePassword.isLoading ? <Spinner /> : "Save and sign in again"}
            </button>
          </form>
        </div>
      </div>
    </main>
  );
}
