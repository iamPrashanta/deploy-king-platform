"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import { STEPS, type StepKind } from "./catalog";
import { cx } from "@/components/ui";

const GROUPS: StepKind["group"][] = ["Triggers", "Apps", "Web", "Logic", "Notify"];

/** The "add a step" list. Picking a trigger replaces the current one (a workflow has exactly one). */
export function Palette({ open, onClose, onPick, hasTrigger }: { open: boolean; onClose: () => void; onPick: (k: StepKind) => void; hasTrigger: boolean }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = STEPS.filter((s) => !needle || `${s.label} ${s.description} ${s.group}`.toLowerCase().includes(needle));
    return GROUPS.flatMap((g) => list.filter((s) => s.group === g));
  }, [q]);
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      setTimeout(() => ref.current?.focus(), 10);
    }
  }, [open]);
  if (!open) return null;
  let lastGroup = "";
  return (
    <div className="card wf-float" style={{ top: 64, right: 14, width: 340, maxHeight: "calc(100% - 90px)", display: "flex", flexDirection: "column", boxShadow: "var(--shadow)", zIndex: 20 }}>
      <div className="row" style={{ padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
        <Search size={15} className="faint" />
        <input
          ref={ref}
          className="input"
          style={{ border: 0, boxShadow: "none", background: "transparent", height: 30, padding: 0 }}
          placeholder="Add a step…"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(items.length - 1, s + 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            if (e.key === "Enter" && items[sel]) onPick(items[sel]);
          }}
        />
        <button className="icon-btn" style={{ width: 26, height: 26 }} onClick={onClose} aria-label="Close"><X size={14} /></button>
      </div>
      <div style={{ overflowY: "auto", padding: 6 }}>
        {items.length === 0 && <div className="faint small" style={{ padding: 12 }}>Nothing matches.</div>}
        {items.map((s, i) => {
          const header = s.group !== lastGroup ? s.group : null;
          lastGroup = s.group;
          const Icon = s.icon;
          return (
            <div key={s.type}>
              {header && <div className="faint tiny strong" style={{ padding: "10px 10px 4px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{header}{header === "Triggers" && hasTrigger ? " · replaces the current one" : ""}</div>}
              <button className={cx("palette-item", i === sel && "on")} onMouseEnter={() => setSel(i)} onClick={() => onPick(s)}>
                <span className="wf-icon-tile" style={{ color: s.color }}><Icon size={17} /></span>
                <span>
                  <span className="strong small">{s.label}</span>
                  <br />
                  <span className="faint tiny">{s.description}</span>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
