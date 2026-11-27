"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy, Download, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { Skeleton, Spinner, copyText, errMsg } from "@/components/ui";

/**
 * Setting up 2-step sign-in: scan the QR code (or type the key), confirm with a code, keep the recovery codes.
 * Used at sign-in when the team requires it, and in Settings › Sign-in.
 */

/** "JBSW Y3DP EHPK 3PXP": easier to type. */
const groupKey = (k: string) => k.replace(/(.{4})/g, "$1 ").trim();

export function CodeInput({ value, onChange, autoFocus, recovery }: { value: string; onChange: (v: string) => void; autoFocus?: boolean; recovery?: boolean }) {
  return (
    <input
      className="input mono"
      style={{ fontSize: 18, letterSpacing: recovery ? "0.08em" : "0.3em", textAlign: "center", height: 46 }}
      inputMode={recovery ? "text" : "numeric"}
      autoComplete="one-time-code"
      autoFocus={autoFocus}
      maxLength={recovery ? 12 : 6}
      placeholder={recovery ? "xxxx-xxxx" : "000000"}
      aria-label={recovery ? "Recovery code" : "6-digit code"}
      value={value}
      onChange={(e) => onChange(recovery ? e.target.value.trim() : e.target.value.replace(/\D/g, "").slice(0, 6))}
    />
  );
}

export function TwoStepSetup({ start, confirm, onDone, compact }: {
  start: () => Promise<{ qr: string; secret: string }>;
  confirm: (code: string) => Promise<{ recoveryCodes: string[] }>;
  onDone: (recoveryCodes: string[]) => void;
  compact?: boolean;
}) {
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [error, setError] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    start().then(setSetup, (e) => setError(errMsg(e)));
  }, [start]);

  const submit = async () => {
    setError("");
    setBusy(true);
    try {
      const out = await confirm(code);
      onDone(out.recoveryCodes);
    } catch (e) {
      setError(errMsg(e));
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (!setup) return error ? <div className="notice bad">{error}</div> : <Skeleton h={compact ? 180 : 260} />;
  return (
    <div className="stack" style={{ gap: 18 }}>
      <div className="row top wrap" style={{ gap: 20 }}>
        <img src={setup.qr} alt="QR code for your authenticator app" width={180} height={180} style={{ borderRadius: 10, background: "#fff", padding: 6, flexShrink: 0 }} />
        <div className="grow stack" style={{ gap: 10, minWidth: 220 }}>
          <div className="row top" style={{ gap: 10 }}>
            <span className="step-num">1</span>
            <div className="small"><strong>Scan the code</strong> with an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator, 1Password or Bitwarden.</div>
          </div>
          <div className="row top" style={{ gap: 10 }}>
            <span className="step-num">2</span>
            <div className="small grow">
              <strong>Cannot scan it?</strong> Choose &ldquo;enter a setup key&rdquo; in the app and type this key (time based):
              <div className="row" style={{ gap: 8, marginTop: 6 }}>
                <code className="inline-code mono" style={{ fontSize: 13 }}>{groupKey(setup.secret)}</code>
                <button type="button" className="btn btn-sm btn-ghost" onClick={() => { copyText(setup.secret); toast.success("Key copied"); }}><Copy size={12} /> Copy</button>
              </div>
            </div>
          </div>
          <div className="row top" style={{ gap: 10 }}>
            <span className="step-num">3</span>
            <div className="small"><strong>Type the 6-digit code</strong> the app shows now.</div>
          </div>
        </div>
      </div>
      <form className="stack" style={{ gap: 10 }} onSubmit={(e) => { e.preventDefault(); if (code.length === 6) submit(); }}>
        <CodeInput value={code} onChange={setCode} autoFocus />
        {error && <div className="notice bad small">{error}</div>}
        <button type="submit" className="btn btn-primary btn-block" disabled={code.length !== 6 || busy}>{busy ? <Spinner /> : <><ShieldCheck size={15} /> Turn on 2-step sign-in</>}</button>
      </form>
    </div>
  );
}

/** Shown once, right after setup or after making new ones. */
export function RecoveryCodes({ codes, onContinue, continueLabel = "Continue" }: { codes: string[]; onContinue: () => void; continueLabel?: string }) {
  const [saved, setSaved] = useState(false);
  const text = `Deploy King recovery codes\nEach code works once, instead of a code from your phone.\n\n${codes.join("\n")}\n`;
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "deploy-king-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="notice ok"><Check size={16} className="ok-text" /><div><strong>2-step sign-in is on.</strong><div className="small muted">Keep these recovery codes somewhere safe. If you lose your phone, each one signs you in once. They are shown only now.</div></div></div>
      <div className="card card-pad" style={{ background: "var(--card-2)" }}>
        <div className="grid g2 mono" style={{ gap: 8, fontSize: 14 }}>{codes.map((c) => <span key={c}>{c}</span>)}</div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button type="button" className="btn btn-sm" onClick={() => { copyText(codes.join("\n")); toast.success("Codes copied"); }}><Copy size={13} /> Copy</button>
        <button type="button" className="btn btn-sm" onClick={download}><Download size={13} /> Download</button>
      </div>
      <label className="check small"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> <span>I saved my recovery codes</span></label>
      <button type="button" className="btn btn-primary btn-block" disabled={!saved} onClick={onContinue}>{continueLabel}</button>
    </div>
  );
}

