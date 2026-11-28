"use client";

import React from "react";
import { Check } from "lucide-react";
import { cx } from "@/components/ui";

/** Status of a connected server, in the design's words. */
export const SERVER_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "bad" | "neutral" }> = {
  connected: { label: "Connected", tone: "ok" },
  waiting_key: { label: "Waiting for key", tone: "warn" },
  waiting_trust: { label: "Not verified yet", tone: "warn" },
  unreachable: { label: "Unreachable", tone: "bad" },
  auth_failed: { label: "Cannot sign in", tone: "bad" },
  host_key_changed: { label: "Fingerprint changed", tone: "bad" },
};

export function ServerStatus({ status }: { status: string }) {
  const s = SERVER_STATUS[status] ?? { label: status, tone: "neutral" as const };
  return (
    <span className={cx("badge", s.tone !== "neutral" && s.tone)}>
      <span className={cx("dot", s.tone !== "neutral" && s.tone)} />
      {s.label}
    </span>
  );
}

export const TYPE_LABEL: Record<string, string> = { ed25519: "Ed25519", rsa4096: "RSA 4096", rsa: "RSA", ecdsa: "ECDSA P-256" };

/** "SSH key · Ed25519" and the small line under it. */
export function signIn(s: any): { text: string; note: string; warn: boolean } {
  if (s.authMethod === "password") return { text: "Password", note: "Less safe: switch to a key", warn: true };
  const k = s.key;
  if (!k) return { text: "SSH key", note: "No key yet", warn: true };
  const text = `SSH key · ${TYPE_LABEL[k.type] ?? k.type}`;
  if (s.status === "waiting_key") return { text, note: "Key not on the server yet", warn: true };
  return { text, ...keyAgeNote(k) };
}

export function keyAgeNote(k: { ageDays: number; rotateInDays: number | null }): { note: string; warn: boolean } {
  if (k.rotateInDays == null) return { note: `Key is ${k.ageDays} days old`, warn: false };
  if (k.rotateInDays <= 0) return { note: `Key is ${k.ageDays} days old`, warn: true };
  return { note: `Rotate in ${k.rotateInDays} days`, warn: false };
}

export function systemLine(sys: any): string {
  if (!sys?.os) return "";
  return [sys.os.replace(/ LTS$/, " LTS"), sys.cpus && `${sys.cpus} vCPU`, sys.memoryMb && `${Math.round(sys.memoryMb / 1024)} GB`].filter(Boolean).join(" · ");
}

export function shortFp(fp?: string | null) {
  if (!fp) return "";
  return fp.length > 20 ? `${fp.slice(0, 13)}…${fp.slice(-4)}` : fp;
}

export function since(d: string | Date | null | undefined) {
  if (!d) return "";
  const s = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return "now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const days = Math.round(h / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function uptimeText(sec?: number) {
  if (!sec) return "";
  const d = Math.floor(sec / 86400);
  if (d >= 1) return `${d} day${d === 1 ? "" : "s"}`;
  const h = Math.floor(sec / 3600);
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.floor(sec / 60))} min`;
}

/** The three-step header of Add server. */
export function WizardSteps({ step }: { step: 1 | 2 | 3 }) {
  const all = ["Connection", "SSH key", "Verify"];
  return (
    <div className="steps">
      {all.map((l, i) => (
        <div key={l} className="row" style={{ gap: 8 }}>
          {i > 0 && <span className="bar" />}
          <span className={cx("st", i + 1 === step && "on", i + 1 < step && "done")}>
            <span className="n">{i + 1 < step ? <Check size={12} /> : i + 1}</span>
            {l}
          </span>
        </div>
      ))}
    </div>
  );
}

/** A switch with a title and one line saying what it does. */
export function Rule({ title, text, checked, onChange, disabled, badge }: { title: React.ReactNode; text: React.ReactNode; checked: boolean; onChange?: (v: boolean) => void; disabled?: boolean; badge?: React.ReactNode }) {
  return (
    <label className="rule-row" style={disabled ? { cursor: "default" } : undefined}>
      <span className="grow">
        <span style={{ fontWeight: 550 }}>{title}</span>
        {badge}
        <span className="small muted" style={{ display: "block" }}>{text}</span>
      </span>
      <span className="switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} />
        <span />
      </span>
    </label>
  );
}

export type Rules = { adminsOnly: boolean; askPassword: boolean; record: boolean; idleMinutes: number; allowAutomation: boolean };

/** The access rules, as on Add server step 3 and the server's Access tab. */
export function RulesEditor({ value, onChange }: { value: Rules; onChange: (r: Rules) => void }) {
  return (
    <div>
      <Rule title="Only admins can open a terminal" text="Other users see the server but cannot connect. Servers are for admins only in this version." checked disabled />
      <Rule title="Ask for my password before a terminal opens" text="Stops someone using an unlocked browser." checked={value.askPassword} onChange={(v) => onChange({ ...value, askPassword: v })} />
      <Rule title="Record terminal sessions" text="Commands and output are kept for 30 days under Activity." checked={value.record} onChange={(v) => onChange({ ...value, record: v })} />
      <label className="rule-row">
        <span className="grow">
          <span style={{ fontWeight: 550 }}>Close idle sessions</span>
          <span className="small muted" style={{ display: "block" }}>After {value.idleMinutes || "no"} minutes without typing.</span>
        </span>
        <select className="input" style={{ width: 130 }} value={value.idleMinutes} onChange={(e) => onChange({ ...value, idleMinutes: Number(e.target.value) })} aria-label="Close idle sessions after">
          {[5, 15, 30, 60].map((m) => <option key={m} value={m}>{m} minutes</option>)}
          <option value={0}>Never</option>
        </select>
      </label>
      <Rule title="Let workflows and AI agents run commands here" text="Off by default. Each command still needs your approval." checked={value.allowAutomation} onChange={(v) => onChange({ ...value, allowAutomation: v })} />
    </div>
  );
}

export const CHECK_TONE: Record<string, string> = { ok: "ok", warn: "warn", bad: "bad", info: "info" };
