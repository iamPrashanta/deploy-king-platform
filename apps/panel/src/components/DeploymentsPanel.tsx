"use client";

import React, { useState } from "react";
import { History, Loader2, RotateCcw, Rocket, ChevronDown, ChevronRight } from "lucide-react";
import { trpc } from "@/utils/trpc";

const STATUS_BADGE: Record<string, string> = {
  active: "badge-success",
  failed: "badge-error",
  queued: "badge-warning",
  building: "badge-active",
  starting: "badge-active",
  superseded: "badge-purple",
};

const IN_PROGRESS = new Set(["queued", "building", "starting"]);

function timeAgo(value: string | Date | null) {
  if (!value) return "";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function DeploymentLog({ deploymentId, live }: { deploymentId: string; live: boolean }) {
  const { data, isLoading } = trpc.sites.deployment.useQuery(
    { deploymentId },
    { refetchInterval: live ? 2000 : false }
  );
  if (isLoading) return <pre className="deploy-log">Loading log...</pre>;
  return (
    <pre className="deploy-log">
      {data?.log || "No output yet."}
      <style jsx>{`
        .deploy-log {
          margin: 0.75rem 0 0;
          padding: 1rem;
          max-height: 360px;
          overflow: auto;
          background: rgba(0, 0, 0, 0.45);
          border: 1px solid var(--border);
          border-radius: 8px;
          font-size: 0.78rem;
          line-height: 1.5;
          white-space: pre-wrap;
          word-break: break-word;
          color: #cbd5e1;
        }
      `}</style>
    </pre>
  );
}

/**
 * Deployment history for one site: every deploy with its status, what triggered
 * it, its build log, and a one-click rollback to any release that still has an image.
 */
export default function DeploymentsPanel({ siteId }: { siteId: string }) {
  const utils = trpc.useContext();
  const [open, setOpen] = useState<string | null>(null);

  const { data: deployments, isLoading } = trpc.sites.deployments.useQuery(
    { id: siteId },
    { refetchInterval: 4000 }
  );

  const refresh = () => {
    utils.sites.deployments.invalidate({ id: siteId });
    utils.sites.get.invalidate({ id: siteId });
  };
  const redeploy = trpc.sites.redeploy.useMutation({ onSuccess: refresh });
  const rollback = trpc.sites.rollback.useMutation({ onSuccess: refresh });

  const busy = (deployments ?? []).some((d) => IN_PROGRESS.has(d.status));
  const current = (deployments ?? []).find((d) => d.status === "active");

  return (
    <div className="glass-panel deployments">
      <div className="head">
        <h3>
          <History size={18} /> Deployments
        </h3>
        <button
          className="btn btn-primary"
          disabled={busy || redeploy.isLoading}
          onClick={() => redeploy.mutate({ id: siteId })}
        >
          {busy || redeploy.isLoading ? <Loader2 size={16} className="spin" /> : <Rocket size={16} />}
          {busy ? "Deploying..." : "Redeploy"}
        </button>
      </div>

      {(redeploy.error || rollback.error) && (
        <p className="text-error">{(redeploy.error || rollback.error)?.message}</p>
      )}

      {isLoading ? (
        <p className="muted">Loading...</p>
      ) : !deployments?.length ? (
        <p className="muted">No deployments yet.</p>
      ) : (
        <ul>
          {deployments.map((d) => {
            const expanded = open === d.id;
            const canRollback = !!d.imageTag && d.id !== current?.id && !IN_PROGRESS.has(d.status) && d.status !== "failed";
            return (
              <li key={d.id}>
                <div className="row">
                  <button className="toggle" onClick={() => setOpen(expanded ? null : d.id)} aria-label="Show log">
                    {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <span className={`badge ${STATUS_BADGE[d.status] ?? "badge-warning"}`}>{d.status}</span>
                  <div className="what">
                    <strong>{d.commitMessage?.split("\n")[0] || (d.trigger === "rollback" ? "Rollback" : "Deployment")}</strong>
                    <span>
                      {d.trigger}
                      {d.commitSha ? ` · ${d.commitSha.slice(0, 7)}` : ""}
                      {d.runtime ? ` · ${d.runtime}` : ""}
                      {d.durationMs ? ` · ${Math.round(d.durationMs / 1000)}s` : ""}
                      {` · ${timeAgo(d.createdAt)}`}
                    </span>
                  </div>
                  {canRollback && (
                    <button
                      className="btn"
                      disabled={busy || rollback.isLoading}
                      onClick={() => {
                        if (confirm("Roll back to this release? The site switches over once it passes its health check.")) {
                          rollback.mutate({ id: siteId, deploymentId: d.id });
                        }
                      }}
                    >
                      <RotateCcw size={14} /> Roll back
                    </button>
                  )}
                </div>
                {d.status === "failed" && d.error && !expanded && <p className="error-line">{d.error.split("\n")[0]}</p>}
                {expanded && <DeploymentLog deploymentId={d.id} live={IN_PROGRESS.has(d.status)} />}
              </li>
            );
          })}
        </ul>
      )}

      <style jsx>{`
        .deployments {
          padding: 1.5rem;
        }
        .head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 1rem;
        }
        h3 {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 1.05rem;
        }
        ul {
          list-style: none;
          display: flex;
          flex-direction: column;
        }
        li {
          padding: 0.85rem 0;
          border-top: 1px solid var(--border);
        }
        .row {
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }
        .toggle {
          background: none;
          border: 0;
          color: var(--text-muted);
          cursor: pointer;
          display: flex;
        }
        .what {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }
        .what strong {
          font-size: 0.92rem;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .what span,
        .muted {
          font-size: 0.8rem;
          color: var(--text-muted);
        }
        .error-line {
          margin: 0.5rem 0 0 2.2rem;
          font-size: 0.82rem;
          color: var(--error);
        }
      `}</style>
    </div>
  );
}
