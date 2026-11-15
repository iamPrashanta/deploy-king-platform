"use client";

import Link from "next/link";
import { Boxes, Cpu, Github, HardDrive, HardDriveDownload, LayoutTemplate, MemoryStick, Plus, Rocket } from "lucide-react";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { PageHeader, Skeleton, StatusBadge, bytes, duration, timeAgo, Empty, cx } from "@/components/ui";
import { useAuth } from "@/components/AuthProvider";

function Meter({ used, total }: { used: number | null; total: number | null }) {
  const pct = used != null && total ? Math.round((used / total) * 100) : 0;
  return (
    <div className={cx("meter", pct > 90 ? "bad" : pct > 75 && "warn")}>
      <i style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function OverviewPage() {
  useCrumbs([{ label: "Overview" }]);
  const { user } = useAuth();
  const q = trpc.system.overview.useQuery(undefined, { refetchInterval: 10_000 });
  const providers = trpc.git.providers.useQuery(undefined, { staleTime: 60_000 });
  const d = q.data;

  const setup = [
    { done: (providers.data?.length ?? 0) > 0, title: "Connect GitHub", text: "Deploy private repositories and redeploy on every push.", href: "/settings?tab=github", icon: <Github size={16} /> },
    { done: (d?.apps.total ?? 0) > 0, title: "Deploy your first app", text: "From a repository, a Docker image or a template.", href: "/apps/new", icon: <Rocket size={16} /> },
    { done: false, title: "Back up your databases", text: "Install the dbbkp CLI on your database servers.", href: "/backup-cli", icon: <HardDriveDownload size={16} /> },
  ];
  const showSetup = d && (d.apps.total === 0 || !providers.data?.length);

  return (
    <div className="page">
      <PageHeader
        title={user ? `Welcome back, ${user.username}` : "Overview"}
        description="Everything running on this server at a glance."
        actions={
          <>
            <Link href="/templates" className="btn"><LayoutTemplate size={15} /> Templates</Link>
            <Link href="/apps/new" className="btn btn-primary"><Plus size={15} /> New app</Link>
          </>
        }
      />

      <div className="grid g4">
        <div className="card card-pad stat">
          <div className="k"><Boxes size={14} /> Applications</div>
          {d ? <div className="v">{d.apps.running}<span className="faint" style={{ fontSize: 15 }}> / {d.apps.total} running</span></div> : <Skeleton h={30} w={90} style={{ marginTop: 8 }} />}
          <div className="s">{d ? (d.apps.failed ? <span className="bad-text">{d.apps.failed} failed</span> : d.apps.building ? `${d.apps.building} deploying` : "All healthy") : " "}</div>
        </div>
        <div className="card card-pad stat">
          <div className="k"><Rocket size={14} /> Deploys today</div>
          {d ? <div className="v">{d.deploysToday.total}</div> : <Skeleton h={30} w={60} style={{ marginTop: 8 }} />}
          <div className="s">{d ? (d.deploysToday.total ? `${d.deploysToday.succeeded} succeeded${d.deploysToday.medianMs ? ` · median ${duration(d.deploysToday.medianMs)}` : ""}` : "None yet") : " "}</div>
        </div>
        <div className="card card-pad stat">
          <div className="k"><Cpu size={14} /> CPU</div>
          {d ? <div className="v">{d.server.cpuPct}%</div> : <Skeleton h={30} w={60} style={{ marginTop: 8 }} />}
          <div className="s">{d ? `${d.server.cores} cores · ${d.server.hostname}` : " "}</div>
          {d && <Meter used={d.server.cpuPct} total={100} />}
        </div>
        <div className="card card-pad stat">
          <div className="k"><MemoryStick size={14} /> Memory · <HardDrive size={14} /> Disk</div>
          {d ? <div className="v">{Math.round((d.server.memUsed / d.server.memTotal) * 100)}%</div> : <Skeleton h={30} w={60} style={{ marginTop: 8 }} />}
          <div className="s">{d ? `${bytes(d.server.memUsed)} of ${bytes(d.server.memTotal)} · disk ${bytes(d.server.diskUsed)} of ${bytes(d.server.diskTotal)}` : " "}</div>
          {d && <Meter used={d.server.memUsed} total={d.server.memTotal} />}
        </div>
      </div>

      {showSetup && (
        <>
          <h2 className="section">Get started</h2>
          <div className="grid g3">
            {setup.map((s) => (
              <Link key={s.title} href={s.href} className="card card-pad hoverable row top" style={{ gap: 12 }}>
                <div className="option" style={{ padding: 0, border: 0, width: "auto", background: "none" }}>
                  <div className="oi">{s.icon}</div>
                </div>
                <div className="grow">
                  <div className="row"><span className="strong">{s.title}</span>{s.done && <span className="badge ok right">Done</span>}</div>
                  <div className="muted small" style={{ marginTop: 2 }}>{s.text}</div>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}

      <h2 className="section">Recent deployments <Link href="/apps" className="link small right" style={{ fontWeight: 500 }}>All applications</Link></h2>
      <div className="card">
        {!d ? (
          <div className="card-body stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={20} />)}</div>
        ) : d.recentDeployments.length === 0 ? (
          <Empty icon={<Rocket size={18} />} title="No deployments yet" action={<Link href="/apps/new" className="btn btn-primary"><Plus size={15} /> Deploy an app</Link>}>
            Deploy from GitHub, any public git URL, a Docker image or a one-click template.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr><th>App</th><th>Status</th><th className="desktop-only">Commit</th><th className="desktop-only">Trigger</th><th>Duration</th><th>When</th></tr>
            </thead>
            <tbody>
              {d.recentDeployments.map((r) => (
                <tr key={r.id} className="click" onClick={() => (window.location.href = `/apps/${r.siteId}?deployment=${r.id}`)}>
                  <td className="strong ellipsis" style={{ maxWidth: 240 }}>{r.domain}</td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="desktop-only muted ellipsis" style={{ maxWidth: 280 }}>
                    {r.commitSha && <span className="mono small" style={{ marginRight: 8 }}>{r.commitSha.slice(0, 7)}</span>}
                    {r.commitMessage}
                  </td>
                  <td className="desktop-only muted">{r.trigger}</td>
                  <td className="muted">{duration(r.durationMs)}</td>
                  <td className="muted">{timeAgo(r.createdAt as any)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
