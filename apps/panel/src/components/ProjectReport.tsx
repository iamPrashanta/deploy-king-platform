"use client";

import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, CircleDashed, FileText, Folder, Info, XCircle } from "lucide-react";
import { useState } from "react";
import { cx } from "./ui";

export type Report = {
  verdict: "ready" | "needs-input" | "not-deployable";
  summary: string;
  framework: string | null;
  runtime: string | null;
  port: number | null;
  facts: { label: string; value: string }[];
  checks: { id: string; level: "ok" | "info" | "warn" | "bad"; title: string; detail?: string }[];
  env: { key: string; example: string; value: string; placeholder: boolean; canGenerate: boolean; generator?: "hex" | "laravel"; appUrl?: boolean; platform: boolean; source: string }[];
  services: string[];
  questions: { id: string; kind: "confirm" | "select"; title: string; detail?: string; options?: { value: string; label: string; detail?: string }[]; default: string; suggested?: string }[];
  plan: { runtime: string; port: number; notes: string[]; dockerfile: string; usesRepoDockerfile: boolean } | null;
  error: string | null;
};

const VERDICT = {
  ready: { tone: "ok", title: "Ready to deploy", icon: <CheckCircle2 size={20} /> },
  "needs-input": { tone: "warn", title: "Deployable, with a few answers", icon: <AlertTriangle size={20} /> },
  "not-deployable": { tone: "bad", title: "Not deployable as it is", icon: <XCircle size={20} /> },
} as const;

export function CheckIcon({ level }: { level: string }) {
  if (level === "ok") return <CheckCircle2 size={16} className="ok-text" />;
  if (level === "warn") return <AlertTriangle size={16} className="warn-text" />;
  if (level === "bad") return <XCircle size={16} className="bad-text" />;
  return <Info size={16} style={{ color: "var(--blue)" }} />;
}

export function VerdictBanner({ report }: { report: Report }) {
  const v = VERDICT[report.verdict];
  return (
    <div className={cx("notice", v.tone)} style={{ padding: "16px 18px", alignItems: "center" }}>
      <span className={v.tone === "ok" ? "ok-text" : v.tone === "bad" ? "bad-text" : "warn-text"}>{v.icon}</span>
      <div>
        <div className="strong" style={{ fontSize: 15 }}>{v.title}</div>
        <div className="muted">{report.summary}</div>
      </div>
    </div>
  );
}

export function FactsGrid({ facts }: { facts: Report["facts"] }) {
  return (
    <div className="grid g3" style={{ gap: 10 }}>
      {facts.map((f) => (
        <div key={f.label} className="card" style={{ padding: "10px 14px" }}>
          <div className="faint tiny">{f.label}</div>
          <div className="strong ellipsis" title={f.value}>{f.value}</div>
        </div>
      ))}
    </div>
  );
}

export function ChecksList({ checks }: { checks: Report["checks"] }) {
  return (
    <div>
      {checks.map((c) => (
        <div key={c.id} className="check-line">
          <CheckIcon level={c.level} />
          <div className="grow">
            <div className="strong">{c.title}</div>
            {c.detail && <div className="muted small" style={{ marginTop: 1 }}>{c.detail}</div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function Question({ q, value, onChange }: { q: Report["questions"][number]; value: string; onChange: (v: string) => void }) {
  if (q.kind === "confirm") {
    return (
      <div className="card card-pad">
        <div className="row top">
          <CircleDashed size={16} className="warn-text" style={{ marginTop: 2 }} />
          <div className="grow">
            <div className="strong">{q.title}</div>
            {q.detail && <div className="muted small">{q.detail}</div>}
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className={cx("btn btn-sm", value === "yes" && "btn-primary")} onClick={() => onChange("yes")}>Yes</button>
              <button type="button" className={cx("btn btn-sm", value === "no" && "btn-primary")} onClick={() => onChange("no")}>No</button>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="card card-pad">
      <div className="row top">
        <CircleDashed size={16} className="warn-text" style={{ marginTop: 2 }} />
        <div className="grow">
          <div className="strong">{q.title}</div>
          {q.detail && <div className="muted small">{q.detail}</div>}
          <div className="stack" style={{ gap: 6, marginTop: 10 }}>
            {(q.options ?? []).map((o) => (
              <label key={o.value} className="check">
                <input type="radio" name={q.id} checked={value === o.value} onChange={() => onChange(o.value)} />
                <span>
                  <span className="strong">{o.label}</span>
                  {o.detail && <span className="muted small"> · {o.detail}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export function Collapsible({ title, children, defaultOpen = false, right }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; right?: React.ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <button type="button" className="card-head" style={{ width: "100%", borderBottom: open ? undefined : 0 }} onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <h3>{title}</h3>
        {right && <span className="right">{right}</span>}
      </button>
      {open && <div className="card-body">{children}</div>}
    </div>
  );
}

export function FileList({ files }: { files: { name: string; dir: boolean }[] }) {
  return (
    <div className="grid g3" style={{ gap: 4 }}>
      {files.map((f) => (
        <div key={f.name} className="row small muted" style={{ gap: 7 }}>
          {f.dir ? <Folder size={13} /> : <FileText size={13} />}
          <span className="ellipsis mono" style={{ fontSize: 12 }}>{f.name}</span>
        </div>
      ))}
    </div>
  );
}
