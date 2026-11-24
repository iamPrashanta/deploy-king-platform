"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Boxes, ExternalLink, Plus, Search } from "lucide-react";
import { appStatus, appUrl, sourceLabel, RUNTIME } from "@/components/apps";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Empty, PageHeader, Skeleton, StatusBadge, Tile, timeAgo, isLiveStatus } from "@/components/ui";

export default function AppsPage() {
  useCrumbs([{ label: "Applications" }]);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "running" | "failed">("all");
  const list = trpc.sites.list.useQuery(undefined, {
    refetchInterval: (data: any) => (data?.some((s: any) => isLiveStatus(s.status)) ? 3000 : 15_000),
  });
  const info = trpc.system.info.useQuery(undefined, { staleTime: 5 * 60_000 });

  const rows = useMemo(() => {
    const all = (list.data ?? []).filter((s: any) => !s.isPreview);
    return all.filter((s: any) => {
      if (filter === "running" && s.status !== "active") return false;
      if (filter === "failed" && s.status !== "failed") return false;
      const needle = q.trim().toLowerCase();
      return !needle || s.domain.toLowerCase().includes(needle) || (s.repoUrl || "").toLowerCase().includes(needle) || (s.image || "").includes(needle);
    });
  }, [list.data, q, filter]);
  const total = (list.data ?? []).filter((s: any) => !s.isPreview).length;

  return (
    <div className="page">
      <PageHeader
        title="Applications"
        description="Every app runs in its own container behind the proxy, with HTTPS, logs, variables and one-click rollback."
        actions={<Link href="/apps/new" className="btn btn-primary"><Plus size={15} /> New app</Link>}
      />

      {total > 0 && (
        <div className="row wrap" style={{ marginBottom: 14 }}>
          <div className="input-group" style={{ maxWidth: 320, flex: 1 }}>
            <span className="addon"><Search size={14} /></span>
            <input className="input" placeholder="Filter by domain, repository or image" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="seg">
            {(["all", "running", "failed"] as const).map((f) => (
              <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f === "all" ? "All" : f === "running" ? "Running" : "Failed"}</button>
            ))}
          </div>
        </div>
      )}

      <div className="card">
        {list.isLoading ? (
          <div className="card-body stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={40} />)}</div>
        ) : total === 0 ? (
          <Empty
            icon={<Boxes size={18} />}
            title="No applications yet"
            action={
              <div className="row" style={{ justifyContent: "center" }}>
                <Link href="/templates" className="btn">Browse templates</Link>
                <Link href="/apps/new" className="btn btn-primary"><Plus size={15} /> New app</Link>
              </div>
            }
          >
            Connect a repository and Deploy King checks the project, tells you what it found and what it still needs, then builds and runs it.
          </Empty>
        ) : rows.length === 0 ? (
          <div className="empty small">No app matches this filter.</div>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Application</th><th>Status</th><th className="desktop-only">Source</th><th className="desktop-only">Runtime</th><th>Updated</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((s: any) => {
                const src = sourceLabel(s);
                return (
                  <tr key={s.id} className="click" onClick={() => (window.location.href = `/apps/${s.id}`)}>
                    <td>
                      <div className="row">
                        <Tile name={s.domain} size={30} />
                        <div style={{ minWidth: 0 }}>
                          <div className="strong ellipsis" style={{ maxWidth: 260 }}>{s.domain.split(".")[0]}</div>
                          <div className="faint small ellipsis" style={{ maxWidth: 260 }}>{s.domain}</div>
                        </div>
                      </div>
                    </td>
                    <td><StatusBadge status={appStatus(s)} /></td>
                    <td className="desktop-only muted small"><span className="row" style={{ gap: 6 }}>{src.icon}<span className="ellipsis" style={{ maxWidth: 240 }}>{src.text}</span></span></td>
                    <td className="desktop-only muted small">{RUNTIME[s.type] ?? s.type}</td>
                    <td className="muted small">{timeAgo(s.updatedAt)}</td>
                    <td style={{ textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                      {s.status === "active" && (
                        <a className="btn btn-ghost btn-sm" href={appUrl(s.domain, info.data)} target="_blank" rel="noreferrer" title="Open the app">
                          <ExternalLink size={14} />
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
