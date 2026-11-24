"use client";

import React, { useEffect, useRef, useState } from "react";
import { Check, Copy, Loader2, X } from "lucide-react";

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return "";
  const t = typeof d === "string" ? new Date(d).getTime() : d.getTime();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(t).toLocaleDateString();
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "–";
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="spin" />;
}

type Tone = "ok" | "bad" | "warn" | "info" | "purple" | "neutral";

const STATUS: Record<string, { tone: Tone; label: string; live?: boolean }> = {
  active: { tone: "ok", label: "Running" },
  running: { tone: "ok", label: "Running" },
  provisioning: { tone: "info", label: "Deploying", live: true },
  queued: { tone: "neutral", label: "Queued", live: true },
  building: { tone: "info", label: "Building", live: true },
  starting: { tone: "info", label: "Starting", live: true },
  waiting_input: { tone: "warn", label: "Needs your answer", live: true },
  failed: { tone: "bad", label: "Failed" },
  crashing: { tone: "bad", label: "Crashing", live: true },
  superseded: { tone: "neutral", label: "Replaced" },
  pending: { tone: "neutral", label: "Waiting for upload" },
  stopped: { tone: "neutral", label: "Stopped" },
};

export const isLiveStatus = (s: string | null | undefined) => !!(s && STATUS[s]?.live);

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const st = STATUS[status ?? ""] ?? { tone: "neutral" as Tone, label: status ?? "unknown" };
  return (
    <span className={cx("badge", st.tone !== "neutral" && st.tone)}>
      <span className={cx("dot", st.tone !== "neutral" && st.tone, st.live && "pulse")} />
      {label ?? st.label}
    </span>
  );
}

export function Badge({ tone = "neutral", children, square }: { tone?: Tone; children: React.ReactNode; square?: boolean }) {
  return <span className={cx("badge", tone !== "neutral" && tone, square && "square")}>{children}</span>;
}

export function copyText(text: string) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // Fallback for plain-http origins where the async clipboard API is unavailable.
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
  return Promise.resolve();
}

export function CopyButton({ text, label = "Copy", className }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={cx("btn btn-sm", className)}
      onClick={async () => {
        await copyText(text);
        setDone(true);
        setTimeout(() => setDone(false), 1500);
      }}
    >
      {done ? <Check size={13} /> : <Copy size={13} />}
      {done ? "Copied" : label}
    </button>
  );
}

/** A code block with a copy bar. Lines starting with "#" are shown as comments. */
export function Code({ children, copy = true, label = "shell" }: { children: string; copy?: boolean; label?: string }) {
  const text = children.replace(/^\n+|\n+$/g, "");
  return (
    <div className="code-box">
      <div className="code-bar">
        <span>{label}</span>
        {copy && <CopyButton text={text} className="btn-ghost" />}
      </div>
      <pre className="code">
        {text.split("\n").map((line, i) => (
          <div key={i} className={line.trim().startsWith("#") ? "c" : undefined}>
            {line || " "}
          </div>
        ))}
      </pre>
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="empty">
      {icon && <div className="ic">{icon}</div>}
      <h3>{title}</h3>
      {children && <p className="small" style={{ maxWidth: 420, margin: "0 auto" }}>{children}</p>}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function Skeleton({ h = 16, w = "100%", style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skel" style={{ height: h, width: w, ...style }} />;
}

export function Dialog({ open, onClose, title, subtitle, children, footer, width = 560 }: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: width }} role="dialog" aria-modal="true">
        <div className="dh">
          <div className="grow">
            <h3 style={{ fontSize: 16 }}>{title}</h3>
            {subtitle && <div className="muted small" style={{ marginTop: 2 }}>{subtitle}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="db">{children}</div>
        {footer && <div className="df">{footer}</div>}
      </div>
    </div>
  );
}

/** Closes a popover when clicking outside it. */
export function useClickAway<T extends HTMLElement>(onAway: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onAway();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [onAway]);
  return ref;
}

export function PageHeader({ title, description, actions, children }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="ph">
      <div className="grow" style={{ minWidth: 240 }}>
        <h1>{title}</h1>
        {description && <p>{description}</p>}
        {children}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

/** Coloured letter tile for apps and templates. */
export function Tile({ name, color, size = 36 }: { name: string; color?: string; size?: number }) {
  const palette = ["#6d5dfc", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6", "#14b8a6", "#ec4899"];
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <div className="tile" style={{ background: color ?? palette[h % palette.length], width: size, height: size, fontSize: size * 0.4 }}>
      {name.replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "?"}
    </div>
  );
}

export function errMsg(err: unknown): string {
  const e = err as any;
  return e?.message || String(err);
}
