"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, Boxes, Search } from "lucide-react";
import { trpc } from "@/utils/trpc";

const PAGES = [
  { label: "Overview", href: "/" },
  { label: "Applications", href: "/apps" },
  { label: "New app", href: "/apps/new" },
  { label: "Templates", href: "/templates" },
  { label: "Databases", href: "/databases" },
  { label: "Backups: history, schedules and destinations", href: "/backups" },
  { label: "Files: app volumes", href: "/files" },
  { label: "Backup CLI: install and commands", href: "/backup-cli" },
  { label: "AI agents: connect Claude, Cursor or Codex (MCP)", href: "/agents" },
  { label: "Settings", href: "/settings" },
  { label: "Settings: GitHub", href: "/settings?tab=github" },
  { label: "Settings: Server checks", href: "/settings?tab=server" },
];

export function CommandPalette({ open, onClose, onGo }: { open: boolean; onClose: () => void; onGo: (href: string) => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sites = trpc.sites.list.useQuery(undefined, { enabled: open, staleTime: 15_000 });

  const items = useMemo(() => {
    const apps = (sites.data ?? []).map((s: any) => ({ label: s.domain, href: `/apps/${s.id}`, app: true }));
    const all = [...apps, ...PAGES.map((p) => ({ ...p, app: false }))];
    const needle = q.trim().toLowerCase();
    return (needle ? all.filter((i) => i.label.toLowerCase().includes(needle)) : all).slice(0, 12);
  }, [q, sites.data]);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);
  useEffect(() => setSel(0), [q]);

  if (!open) return null;
  const go = (href: string) => {
    onClose();
    onGo(href);
  };
  return (
    <div className="dialog-scrim" style={{ alignItems: "start", paddingTop: "12vh" }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" style={{ maxWidth: 560 }}>
        <div className="row" style={{ padding: "4px 14px", borderBottom: "1px solid var(--border)" }}>
          <Search size={16} className="faint" />
          <input
            ref={inputRef}
            className="input"
            style={{ border: 0, boxShadow: "none", background: "transparent", height: 46 }}
            placeholder="Jump to an app or page…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
              if (e.key === "Enter" && items[sel]) go(items[sel].href);
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div style={{ padding: 6, maxHeight: 360, overflowY: "auto" }}>
          {items.length === 0 && <div className="faint small" style={{ padding: 14 }}>Nothing matches “{q}”.</div>}
          {items.map((i, idx) => (
            <button
              key={i.href}
              className="mi"
              style={{
                display: "flex", alignItems: "center", gap: 10, width: "100%", height: 36, padding: "0 10px", borderRadius: 6,
                background: idx === sel ? "var(--active)" : "transparent", color: idx === sel ? "var(--text)" : "var(--muted)", textAlign: "left",
              }}
              onMouseEnter={() => setSel(idx)}
              onClick={() => go(i.href)}
            >
              {i.app ? <Boxes size={15} /> : <ArrowRight size={15} />}
              <span className="grow ellipsis">{i.label}</span>
              {i.app && <span className="faint tiny">App</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
