"use client";

import Link from "next/link";
import { KeyRound, Lock, Plus, Server } from "lucide-react";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Empty, PageHeader, Skeleton, Tile, cx } from "@/components/ui";
import { ServerStatus, signIn, since, systemLine } from "@/components/servers/common";

/**
 * Servers: other servers connected over SSH, with sign-in method, status and system, plus the three steps to add one.
 * Admins only.
 */
export default function ServersPage() {
  useCrumbs([{ label: "Platform" }, { label: "Servers" }]);
  const list = trpc.servers.list.useQuery(undefined, { retry: false, refetchInterval: 30_000 });

  if (list.error) {
    return <div className="page"><Empty icon={<Server size={20} />} title="Servers are managed by admins">Ask an admin if you need a terminal on one of them.</Empty></div>;
  }
  const d = list.data as any;
  const servers: any[] = d?.servers ?? [];

  const action = (s: any) => {
    if (!s.setupDone) return { label: "Finish setup", href: `/servers/new?id=${s.id}&step=${s.status === "waiting_key" ? 2 : 3}` };
    if (s.status === "unreachable" || s.status === "auth_failed" || s.status === "host_key_changed") return { label: s.status === "host_key_changed" ? "Review" : "Retry", href: `/servers/${s.id}?tab=overview` };
    return { label: "Terminal", href: `/servers/${s.id}` };
  };

  return (
    <div className="page">
      <PageHeader
        title="Servers"
        description="Connect your other servers over SSH and work on them from this panel: open a terminal, run checks, use them in workflows."
        actions={<>
          <Link href="/servers/keys" className="btn"><KeyRound size={15} /> SSH keys</Link>
          <Link href="/servers/new" className="btn btn-primary"><Plus size={15} /> Add server</Link>
        </>}
      />

      <section className="card" style={{ marginBottom: 16 }}>
        {list.isLoading ? <div className="card-body"><Skeleton h={160} /></div> : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 860 }}>
              <thead><tr><th>Server</th><th>Sign-in</th><th>Status</th><th>System</th><th>Last used</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {d?.local && (
                  <tr>
                    <td>
                      <div className="row">
                        <Tile name={d.local.name} color="#3FB950" />
                        <div><div className="mono" style={{ fontWeight: 550 }}>{d.local.name}</div><div className="small muted">this server</div></div>
                      </div>
                    </td>
                    <td><div>Local</div><div className="small muted">No sign-in needed</div></td>
                    <td><ServerStatus status="connected" /><div className="small muted">Runs Deploy King</div></td>
                    <td className="small">{[d.local.os, `${d.local.cpus} vCPU`, `${Math.round(d.local.memoryMb / 1024)} GB`].join(" · ")}</td>
                    <td className="muted small">now</td>
                    <td style={{ textAlign: "right" }}><Link href="/" className="btn btn-sm">Overview</Link></td>
                  </tr>
                )}
                {servers.map((s) => {
                  const si = signIn(s);
                  const a = action(s);
                  return (
                    <tr key={s.id}>
                      <td>
                        <Link href={s.setupDone ? `/servers/${s.id}` : a.href} className="row" style={{ color: "inherit" }}>
                          <Tile name={s.name} />
                          <div><div className="mono" style={{ fontWeight: 550 }}>{s.name}</div><div className="small muted mono">{s.username}@{s.host}:{s.port}</div></div>
                        </Link>
                      </td>
                      <td><div>{si.text}</div><div className={cx("small", si.warn ? "warn-text" : "muted")}>{si.note}</div></td>
                      <td>
                        <ServerStatus status={s.setupDone || s.status !== "connected" ? s.status : "waiting_trust"} />
                        <div className="small muted">{s.liveSessions ? `${s.liveSessions} terminal${s.liveSessions === 1 ? "" : "s"} open` : s.status === "host_key_changed" ? "Refused to connect" : s.statusNote ?? ""}</div>
                      </td>
                      <td className="small">{systemLine(s.system)}</td>
                      <td className="muted small">{since(s.lastUsedAt)}</td>
                      <td style={{ textAlign: "right" }}><Link href={a.href} className={cx("btn btn-sm", a.label === "Finish setup" && "btn-primary")}>{a.label}</Link></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {!list.isLoading && servers.length === 0 && <div className="card-body small muted" style={{ borderTop: "1px solid var(--border)" }}>No other servers yet. Add one to open a terminal on it from here.</div>}
      </section>

      <div className="grid g3" style={{ marginBottom: 16 }}>
        {[
          ["Add the server", "Its address, port and the user to sign in as."],
          ["Create an SSH key", "Deploy King makes the key pair. You put the public half on the server with one command, or let us install it with a one-time password."],
          ["Check and connect", "Confirm the server's fingerprint, then open a terminal from here."],
        ].map(([t, x], i) => (
          <div key={t} className="card card-pad row top" style={{ gap: 12 }}>
            <span className="step-num">{i + 1}</span>
            <div><div className="strong">{t}</div><div className="small muted" style={{ marginTop: 2 }}>{x}</div></div>
          </div>
        ))}
      </div>

      <div className="notice info small"><Lock size={15} /> <span>Private keys and stored passwords are encrypted on this server and are never shown again. Every terminal session is listed under the server's Activity.</span></div>
    </div>
  );
}
