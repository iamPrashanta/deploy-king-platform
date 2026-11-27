"use client";

import { Fragment } from "react";
import Link from "next/link";
import { Check, Minus } from "lucide-react";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { PageHeader } from "@/components/ui";

/**
 * Roles: what each role may do, as the server checks it (services/team.ts and utils/rbac.ts).
 * "Their apps" = the apps shared with them plus the ones they created. "Per member" = off until switched on for that person.
 */

type Cell = "yes" | "their" | "per" | "no";
const COLS = ["owner", "admin", "developer", "viewer"] as const;
const LABEL: Record<(typeof COLS)[number], string> = { owner: "Owner", admin: "Admin", developer: "Developer", viewer: "Viewer" };

const GROUPS: Array<{ name: string; rows: Array<[string, Cell, Cell, Cell, Cell]> }> = [
  {
    name: "Apps",
    rows: [
      ["See apps, logs and deploy history", "yes", "yes", "their", "their"],
      ["Deploy and roll back", "yes", "yes", "their", "no"],
      ["Add and replace variables", "yes", "yes", "their", "no"],
      ["Scheduled jobs and workers", "yes", "yes", "their", "no"],
      ["Read and edit files", "yes", "yes", "their", "no"],
      ["Create apps", "yes", "yes", "per", "no"],
      ["Delete apps", "yes", "yes", "per", "no"],
      ["Open a terminal inside their apps", "yes", "yes", "per", "no"],
    ],
  },
  {
    name: "Platform",
    rows: [
      ["Servers, SSH and the server watch", "yes", "yes", "no", "no"],
      ["Backups and restores", "yes", "yes", "no", "no"],
      ["Server settings, GitHub App, email and alerts", "yes", "yes", "no", "no"],
      ["Create AI agent tokens", "yes", "yes", "per", "no"],
    ],
  },
  {
    name: "Team",
    rows: [
      ["Invite and remove members", "yes", "yes", "no", "no"],
      ["Change roles and access, reset 2-step sign-in", "yes", "yes", "no", "no"],
      ["Add, change or remove admins", "yes", "no", "no", "no"],
      ["Team rules", "yes", "yes", "no", "no"],
      ["Read the activity log", "yes", "yes", "no", "no"],
    ],
  },
];

function Mark({ c }: { c: Cell }) {
  if (c === "yes") return <span className="row ok-text" style={{ gap: 6 }}><Check size={14} /> Yes</span>;
  if (c === "their") return <span className="row" style={{ gap: 6 }}><Check size={14} className="ok-text" /> Their apps</span>;
  if (c === "per") return <span className="badge warn">Per member</span>;
  return <span className="row faint" style={{ gap: 6 }}><Minus size={14} /> No</span>;
}

export default function RolesPage() {
  useCrumbs([{ label: "Team", href: "/team" }, { label: "Roles" }]);
  const members = trpc.team.members.useQuery(undefined, { retry: false });
  const list = (members.data as any[]) ?? [];
  const n = (role: string) => list.filter((m) => m.role === role).length;

  return (
    <div className="page">
      <PageHeader title="Roles" description="What each role may do. “Per member” is off until it is switched on for that person." actions={<Link href="/team" className="btn">Back to the team</Link>} />

      <section className="card" style={{ marginBottom: 16 }}>
        <div style={{ overflowX: "auto" }}>
          <table className="table" style={{ minWidth: 820 }}>
            <thead>
              <tr>
                <th>Permission</th>
                {COLS.map((c) => (
                  <th key={c}>
                    <div>{LABEL[c]}</div>
                    {members.data && <div className="small faint" style={{ fontWeight: 400 }}>{n(c)} {n(c) === 1 ? "person" : "people"}</div>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {GROUPS.map((g) => (
                <Fragment key={g.name}>
                  <tr><td colSpan={5} className="small strong" style={{ background: "var(--card-2)", textTransform: "uppercase", letterSpacing: "0.05em", fontSize: 11.5 }}>{g.name}</td></tr>
                  {g.rows.map(([label, ...cells]) => (
                    <tr key={label}>
                      <td>{label}</td>
                      {cells.map((c, i) => <td key={i} className="small"><Mark c={c} /></td>)}
                    </tr>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid g3">
        <section className="card card-pad">
          <div className="strong" style={{ marginBottom: 6 }}>One owner</div>
          <div className="small muted">The owner is the first admin. Nobody can change or remove them, and only the owner adds, changes or removes admins.</div>
        </section>
        <section className="card card-pad">
          <div className="strong" style={{ marginBottom: 6 }}>No more than you have</div>
          <div className="small muted">Nobody can give a member, an invitation or a token more access than they hold themselves. An AI agent token can never do more than the member who made it.</div>
        </section>
        <section className="card card-pad">
          <div className="strong" style={{ marginBottom: 6 }}>Their apps</div>
          <div className="small muted">The apps shared with a member, plus every app they created themselves. Set them on each member&apos;s page; changes apply at once.</div>
        </section>
      </div>
    </div>
  );
}
