"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Clock, Server } from "lucide-react";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Empty, PageHeader, Skeleton, cx, timeAgo } from "@/components/ui";

/**
 * Every scheduled job on this server: those of the apps this user may see, and (for admins) the server's
 * own cron jobs as the server watch found them. Jobs are changed on each app's Scheduled jobs tab;
 * the server's own are changed on the server.
 */

const STATUS: Record<string, { tone: string; label: string }> = { ok: { tone: "ok", label: "Succeeded" }, failed: { tone: "bad", label: "Failed" }, timeout: { tone: "bad", label: "Ran past its limit" }, skipped: { tone: "", label: "Skipped" } };

function next(iso: string | null) {
  if (!iso) return "";
  const diff = Date.parse(iso) - Date.now();
  if (diff < 60 * 60_000) return `in ${Math.max(1, Math.round(diff / 60_000))} min`;
  if (diff < 36 * 3_600_000) return `in ${Math.round(diff / 3_600_000)} h`;
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function ScheduledJobsPage() {
  useCrumbs([{ label: "Scheduled jobs" }]);
  const q = trpc.cron.all.useQuery(undefined, { refetchInterval: 30_000 });
  const d: any = q.data;
  const [filter, setFilter] = useState<"all" | "failing" | "paused">("all");
  const [search, setSearch] = useState("");
  const jobs: any[] = d?.jobs ?? [];
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return jobs
      .filter((j) => (filter === "failing" ? j.active && j.failStreak > 0 : filter === "paused" ? !j.active : true))
      .filter((j) => !s || `${j.name} ${j.command} ${j.domain}`.toLowerCase().includes(s))
      .sort((a, b) => (b.failStreak > 0 ? 1 : 0) - (a.failStreak > 0 ? 1 : 0) || (Date.parse(a.nextRunAt ?? "9999") - Date.parse(b.nextRunAt ?? "9999")));
  }, [jobs, filter, search]);
  const failing = jobs.filter((j) => j.active && j.failStreak > 0);
  const soonest = jobs.filter((j) => j.active && j.nextRunAt).sort((a, b) => Date.parse(a.nextRunAt) - Date.parse(b.nextRunAt))[0];
  const apps = new Set(jobs.map((j) => j.siteId)).size;

  return (
    <div className="page">
      <PageHeader
        title="Scheduled jobs"
        description={d?.host ? "Everything that runs on a schedule on this server: in your apps, and the server's own." : "Every scheduled job in the apps you can see."}
        actions={
          <div className="row wrap" style={{ gap: 10 }}>
            <div className="seg" role="radiogroup" aria-label="Show">
              {(["all", "failing", "paused"] as const).map((f) => <button key={f} type="button" role="radio" aria-checked={filter === f} className={cx(filter === f && "on")} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "failing" ? "Failing" : "Paused"}</button>)}
            </div>
            <input className="input" style={{ width: 220 }} placeholder="Search jobs" aria-label="Search jobs" value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
        }
      />

      {q.isLoading ? <Skeleton h={240} /> : (
        <>
          <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginBottom: 16 }}>
            <div className="card card-pad"><div className="small muted">In apps</div><div style={{ fontSize: 24, fontWeight: 650 }}>{jobs.length}</div><div className="small faint">in {apps} app{apps === 1 ? "" : "s"}</div></div>
            <div className="card card-pad"><div className="small muted">Failing</div><div className={cx(failing.length && "bad-text")} style={{ fontSize: 24, fontWeight: 650 }}>{failing.length}</div><div className="small faint ellipsis">{failing[0]?.name ?? "none"}</div></div>
            <div className="card card-pad"><div className="small muted">Paused</div><div style={{ fontSize: 24, fontWeight: 650 }}>{jobs.filter((j) => !j.active).length}</div><div className="small faint">no runs until resumed</div></div>
            <div className="card card-pad"><div className="small muted">Next run</div><div style={{ fontSize: 24, fontWeight: 650 }}>{soonest ? next(soonest.nextRunAt) : "–"}</div><div className="small faint ellipsis">{soonest ? `${soonest.domain.split(".")[0]} · ${soonest.name}` : "nothing scheduled"}</div></div>
          </div>

          <section className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><h3>In apps</h3></div>
            {shown.length === 0 ? (
              <Empty icon={<Clock size={20} />} title={jobs.length ? "Nothing matches" : "No scheduled jobs yet"}>{jobs.length ? "Try another filter or search." : "Add one on an app's Scheduled jobs tab."}</Empty>
            ) : (
              <div style={{ overflowX: "auto" }}>
                <table className="table" style={{ minWidth: 860 }}>
                  <thead><tr><th>Job</th><th>App</th><th>Schedule</th><th>Next run</th><th>Last run</th></tr></thead>
                  <tbody>
                    {shown.map((j) => {
                      const st = j.lastStatus ? STATUS[j.lastStatus] ?? { tone: "", label: j.lastStatus } : null;
                      return (
                        <tr key={j.id} style={j.active && j.failStreak > 0 ? { background: "color-mix(in srgb, var(--red) 5%, transparent)" } : undefined}>
                          <td><div className="row" style={{ gap: 8 }}><span style={{ fontWeight: 550 }}>{j.name || "Unnamed job"}</span>{!j.active && <span className="badge">Paused</span>}</div><div className="mono small muted ellipsis" style={{ maxWidth: 340 }}>{j.command}</div></td>
                          <td><Link className="link mono small" href={`/apps/${j.siteId}?tab=jobs&job=${j.id}`}>{j.domain.split(".")[0]}</Link></td>
                          <td><div>{j.words}</div><div className="mono small faint">{j.schedule}{j.timezone !== "UTC" ? ` · ${j.timezone}` : ""}</div></td>
                          <td className="muted" style={{ whiteSpace: "nowrap" }}>{j.active ? next(j.nextRunAt) : "Paused"}</td>
                          <td>{st ? (
                            <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                              <span className={cx("row small", st.tone === "bad" && "bad-text")} style={{ gap: 6 }}><span className={cx("dot", st.tone)} />{st.label}{j.lastExitCode != null && j.lastStatus !== "ok" ? ` · exit ${j.lastExitCode}` : ""}</span>
                              <span className="small faint">{timeAgo(j.lastRunAt)}</span>
                            </span>
                          ) : <span className="faint small">Not run yet</span>}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {d?.host && (
            <section className="card">
              <div className="card-head">
                <span className="row" style={{ gap: 8 }}><Server size={15} className="muted" /><h3>On the server</h3><span className="badge">Read only</span></span>
                <span className="right small faint">From the server watch</span>
              </div>
              {d.host.length === 0 ? (
                <div className="card-body small muted">None found. If the server watch is not running yet, turn it on from the <Link className="link" href="/security">Security</Link> page.</div>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table className="table" style={{ minWidth: 860 }}>
                    <thead><tr><th>Command</th><th>Runs as</th><th>Schedule</th><th>Where it is set</th><th><span className="sr-only">State</span></th></tr></thead>
                    <tbody>
                      {d.host.map((h: any) => (
                        <tr key={h.id}>
                          <td className="mono small" style={{ maxWidth: 360, overflowWrap: "anywhere" }}>{h.detail?.command ?? h.label}</td>
                          <td className="muted">{h.detail?.user ?? "root"}</td>
                          <td><div>{h.words}</div><div className="mono small faint">{h.detail?.schedule}</div></td>
                          <td className="mono small faint">{String(h.detail?.file ?? "").startsWith("/var/spool/cron") ? `crontab of ${h.detail?.user}` : h.detail?.file}</td>
                          <td>{h.status === "accepted" ? <span className="badge">Accepted</span> : h.status === "initial" ? <span className="badge">Not reviewed</span> : <Link href="/security" className={cx("badge", h.severity === "urgent" ? "bad" : "warn")}>{h.severity === "urgent" ? "Urgent" : "New"} · see Security</Link>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="card-body small faint" style={{ borderTop: "1px solid var(--border)" }}>These are set on the server itself, so they are changed there. New ones appear on the Security page within five minutes.</div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
