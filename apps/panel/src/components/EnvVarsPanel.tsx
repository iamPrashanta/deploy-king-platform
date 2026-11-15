"use client";

import React, { useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { trpc } from "@/utils/trpc";

/**
 * Per-site environment variables. Values are write-only: they are encrypted on
 * the server and never sent back, so this panel only ever lists the names.
 */
export default function EnvVarsPanel({ siteId }: { siteId: string }) {
  const utils = trpc.useContext();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");

  const { data: vars } = trpc.sites.envList.useQuery({ id: siteId });
  const refresh = () => utils.sites.envList.invalidate({ id: siteId });

  const setVar = trpc.sites.envSet.useMutation({
    onSuccess: () => {
      setKey("");
      setValue("");
      refresh();
    },
  });
  const unsetVar = trpc.sites.envUnset.useMutation({ onSuccess: refresh });

  return (
    <div className="glass-panel env">
      <h3>
        <KeyRound size={18} /> Environment variables
      </h3>
      <p className="hint">Encrypted at rest. Changes apply on the next deploy.</p>

      {vars?.length ? (
        <ul>
          {vars.map((v) => (
            <li key={v.key}>
              <code>{v.key}</code>
              <span className="masked">••••••••</span>
              <button
                className="icon-btn"
                aria-label={`Remove ${v.key}`}
                disabled={unsetVar.isLoading}
                onClick={() => unsetVar.mutate({ id: siteId, key: v.key })}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="hint">None set.</p>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (key.trim()) setVar.mutate({ id: siteId, key: key.trim(), value });
        }}
      >
        <input className="input" placeholder="NAME" value={key} onChange={(e) => setKey(e.target.value)} />
        <input
          className="input"
          placeholder="value"
          type="password"
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="btn" type="submit" disabled={!key.trim() || setVar.isLoading}>
          <Plus size={14} /> Add
        </button>
      </form>
      {setVar.error && <p className="text-error">{setVar.error.message}</p>}

      <style jsx>{`
        .env {
          padding: 1.5rem;
        }
        h3 {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 1.05rem;
        }
        .hint {
          margin: 0.35rem 0 1rem;
          font-size: 0.8rem;
          color: var(--text-muted);
        }
        ul {
          list-style: none;
          margin-bottom: 1rem;
        }
        li {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.5rem 0;
          border-top: 1px solid var(--border);
        }
        code {
          flex: 1;
          font-size: 0.85rem;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .masked {
          color: var(--text-muted);
          letter-spacing: 0.1em;
        }
        form {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
        }
      `}</style>
    </div>
  );
}
