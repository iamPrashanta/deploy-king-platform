"use client";

import { Check, X } from "lucide-react";
import { cx } from "@/components/ui";

/** Team access: the role, apps and extras editor and the "will / will not be able to" summary. Used by Team and by one member's page. */

export type Role = "admin" | "developer" | "viewer";
export type Grants = { createApps?: boolean; deleteApps?: boolean; terminal?: boolean; agentTokens?: boolean; restoreBackups?: boolean };
export type Access = { role: Role; allApps: boolean; siteIds: string[]; grants: Grants };

export const ROLES: Array<{ v: Role; label: string; text: string }> = [
  { v: "admin", label: "Admin", text: "Everything, including the team and settings. Cannot change the owner." },
  { v: "developer", label: "Developer", text: "Deploys and looks after the apps they are given. No servers, team or settings." },
  { v: "viewer", label: "Viewer", text: "Sees status, logs and history. Changes nothing." },
];
export const EXTRAS: Array<{ k: keyof Grants; label: string; text: string }> = [
  { k: "createApps", label: "Create apps", text: "New apps of their own. The server still checks that each one fits." },
  { k: "deleteApps", label: "Delete apps", text: "Deleting also removes the app's storage." },
  { k: "terminal", label: "Open a terminal inside their apps", text: "Runs commands in the app's own container, not on the server." },
  { k: "agentTokens", label: "Create AI agent tokens", text: "A token can never do more than the member who made it." },
  { k: "restoreBackups", label: "Restore backups", text: "Into a new copy or over live data of their apps. Making backups needs no extra." },
];
export const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", developer: "Developer", viewer: "Viewer", member: "Member" };
export const ROLE_TONE: Record<string, string> = { owner: "purple", admin: "info", developer: "", viewer: "", member: "" };
export const emptyAccess: Access = { role: "developer", allApps: false, siteIds: [], grants: {} };

/** In words, what this access allows and what it does not. Shown before an invitation is sent. */
export function summary(a: Access, appCount: number) {
  const where = a.role === "admin" ? "every app" : a.allApps ? "every app, including ones added later" : appCount ? `${appCount} app${appCount === 1 ? "" : "s"}` : "no apps yet, only ones they create";
  if (a.role === "admin") return { can: ["Do everything an admin can", "Invite and manage members", "Change settings"], cannot: ["Change or remove the owner"] };
  if (a.role === "viewer") return { can: [`See status, logs and deploy history of ${where}`], cannot: ["Deploy, change or delete anything", "See servers, team or settings"] };
  const can = [`Deploy and roll back ${where}`, "Add and replace variables", "Read logs and deploy history"];
  const cannot = ["See servers, team or settings"];
  for (const e of EXTRAS) (a.grants[e.k] ? can : cannot).push(e.label);
  return { can, cannot };
}

export function AccessEditor({ value, onChange, apps, canMakeAdmin }: { value: Access; onChange: (a: Access) => void; apps: Array<{ id: string; domain: string }>; canMakeAdmin: boolean }) {
  const toggleApp = (id: string) => onChange({ ...value, siteIds: value.siteIds.includes(id) ? value.siteIds.filter((x) => x !== id) : [...value.siteIds, id] });
  return (
    <div className="stack" style={{ gap: 20 }}>
      <fieldset className="plain">
        <legend className="label">Role</legend>
        <div className="choice-grid">
          {ROLES.filter((r) => r.v !== "admin" || canMakeAdmin || value.role === "admin").map((r) => (
            <label key={r.v} className={cx("choice", value.role === r.v && "on")}>
              <input type="radio" name="role" checked={value.role === r.v} onChange={() => onChange({ ...value, role: r.v })} />
              <span>
                <strong>{r.label}</strong>
                <span className="small muted">{r.text}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>

      {value.role !== "admin" && (
        <fieldset className="plain">
          <legend className="label">Which apps</legend>
          <div className="choice-grid two">
            <label className={cx("choice", value.allApps && "on")}>
              <input type="radio" name="apps" checked={value.allApps} onChange={() => onChange({ ...value, allApps: true })} />
              <span><strong>All apps</strong><span className="small muted">Including apps added later.</span></span>
            </label>
            <label className={cx("choice", !value.allApps && "on")}>
              <input type="radio" name="apps" checked={!value.allApps} onChange={() => onChange({ ...value, allApps: false })} />
              <span><strong>Only selected apps</strong><span className="small muted">Plus any app they create themselves.</span></span>
            </label>
          </div>
          {!value.allApps && (
            <div className="row wrap" style={{ marginTop: 12, gap: 8 }}>
              {apps.length === 0 && <span className="small faint">There are no apps yet.</span>}
              {apps.map((a) => {
                const on = value.siteIds.includes(a.id);
                return (
                  <button key={a.id} type="button" role="checkbox" aria-checked={on} className={cx("chip-btn mono", on && "on")} onClick={() => toggleApp(a.id)}>
                    {on && <Check size={12} />} {a.domain}
                  </button>
                );
              })}
            </div>
          )}
        </fieldset>
      )}

      {value.role === "developer" && (
        <fieldset className="plain">
          <legend className="label">Extras, off unless switched on</legend>
          {EXTRAS.map((e) => (
            <label key={e.k} className="rule-row">
              <span className="grow">
                <span style={{ fontWeight: 550 }}>{e.label}</span>
                <span className="small muted" style={{ display: "block" }}>{e.text}</span>
              </span>
              <span className="switch">
                <input type="checkbox" checked={!!value.grants[e.k]} onChange={(ev) => onChange({ ...value, grants: { ...value.grants, [e.k]: ev.target.checked } })} />
                <span />
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </div>
  );
}

export function Summary({ access }: { access: Access }) {
  const s = summary(access, access.siteIds.length);
  return (
    <div className="card card-pad" style={{ background: "var(--card-2)" }}>
      <div className="small" style={{ fontWeight: 600, marginBottom: 8 }}>Will be able to</div>
      <ul className="can-list">{s.can.map((t) => <li key={t}><Check size={13} className="ok-text" /> {t}</li>)}</ul>
      <div className="small" style={{ fontWeight: 600, margin: "12px 0 8px" }}>Will not be able to</div>
      <ul className="can-list">{s.cannot.map((t) => <li key={t} className="muted"><X size={13} /> {t}</li>)}</ul>
    </div>
  );
}

