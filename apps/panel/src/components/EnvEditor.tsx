"use client";

import { Eye, EyeOff, Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";

export type EnvRow = { key: string; value: string; hint?: string; generator?: "hex" | "laravel"; required?: boolean };

export function generateSecret(kind: "hex" | "laravel" = "hex") {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  if (kind === "laravel") return "base64:" + btoa(String.fromCharCode(...bytes));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Parses pasted .env text into rows (KEY=value, comments ignored). */
export function parseDotenv(text: string): EnvRow[] {
  const rows: EnvRow[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    const q = v.match(/^(['"])(.*)\1$/);
    v = q ? q[2] : v;
    rows.push({ key: m[1], value: v });
  }
  return rows;
}

export function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const [show, setShow] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pasted, setPasted] = useState("");
  const set = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <div>
      {rows.length > 0 && (
        <div className="stack" style={{ gap: 8 }}>
          {rows.map((r, i) => (
            <div key={i} className="row top" style={{ gap: 8 }}>
              <input
                className="input mono"
                style={{ flex: "0 0 38%" }}
                placeholder="KEY"
                value={r.key}
                onChange={(e) => set(i, { key: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_") })}
              />
              <div className="grow">
                <div className="input-group">
                  <input
                    className="input mono"
                    type={show ? "text" : "password"}
                    placeholder={r.hint || (r.required ? "Required" : "value")}
                    value={r.value}
                    onChange={(e) => set(i, { value: e.target.value })}
                    style={r.required && !r.value ? { borderColor: "color-mix(in srgb, var(--amber) 55%, var(--border))" } : undefined}
                  />
                </div>
              </div>
              {r.generator && (
                <button type="button" className="btn btn-sm" style={{ height: 36 }} title="Generate a random secret" onClick={() => set(i, { value: generateSecret(r.generator) })}>
                  <Wand2 size={13} /> Generate
                </button>
              )}
              <button type="button" className="icon-btn" style={{ height: 36 }} aria-label="Remove" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </div>
      )}
      {paste && (
        <div style={{ marginTop: 10 }}>
          <textarea className="textarea mono" placeholder={"DATABASE_URL=postgres://...\nAPI_KEY=..."} value={pasted} onChange={(e) => setPasted(e.target.value)} />
          <div className="row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                const add = parseDotenv(pasted);
                const keys = new Set(add.map((a) => a.key));
                onChange([...rows.filter((r) => !keys.has(r.key)), ...add]);
                setPasted("");
                setPaste(false);
              }}
            >
              Add {parseDotenv(pasted).length || ""} variables
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPaste(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="row" style={{ marginTop: 10 }}>
        <button type="button" className="btn btn-sm" onClick={() => onChange([...rows, { key: "", value: "" }])}>
          <Plus size={13} /> Add variable
        </button>
        {!paste && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPaste(true)}>Paste .env</button>
        )}
        {rows.length > 0 && (
          <button type="button" className="btn btn-sm btn-ghost right" onClick={() => setShow((s) => !s)}>
            {show ? <EyeOff size={13} /> : <Eye size={13} />} {show ? "Hide values" : "Show values"}
          </button>
        )}
      </div>
    </div>
  );
}
