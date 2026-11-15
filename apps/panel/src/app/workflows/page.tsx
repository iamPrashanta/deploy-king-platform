"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Clock, Copy, MoreHorizontal, Plus, Rocket, Trash2, Webhook, Workflow, Zap } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Dialog, Empty, PageHeader, Skeleton, Spinner, errMsg, timeAgo, useClickAway } from "@/components/ui";
import { RECIPES, blankGraph, chain } from "@/components/workflows/catalog";

const TRIGGER: Record<string, { icon: React.ReactNode; label: (s: string | null) => string }> = {
  manual: { icon: <Zap size={14} />, label: () => "Manual" },
  schedule: { icon: <Clock size={14} />, label: (s) => `Schedule · ${s ?? ""}` },
  webhook: { icon: <Webhook size={14} />, label: () => "Webhook" },
  deployment: { icon: <Rocket size={14} />, label: () => "After a deploy" },
};

function RowMenu({ onDuplicate, onDelete }: { onDuplicate: () => void; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useClickAway<HTMLDivElement>(() => setOpen(false));
  return (
    <div className="menu-wrap" ref={ref} onClick={(e) => e.stopPropagation()}>
      <button className="icon-btn" aria-label="More actions" onClick={() => setOpen((o) => !o)}><MoreHorizontal size={16} /></button>
      {open && (
        <div className="menu" style={{ minWidth: 170 }}>
          <button className="mi" onClick={() => { setOpen(false); onDuplicate(); }}><Copy size={14} /> Duplicate</button>
          <button className="mi" style={{ color: "var(--red)" }} onClick={() => { setOpen(false); onDelete(); }}><Trash2 size={14} /> Delete</button>
        </div>
      )}
    </div>
  );
}

export default function WorkflowsPage() {
  useCrumbs([{ label: "Workflows" }]);
  const router = useRouter();
  const utils = trpc.useContext();
  const list = trpc.automations.list.useQuery(undefined, { refetchInterval: 10_000 });
  const create = trpc.automations.create.useMutation();
  const setEnabled = trpc.automations.setEnabled.useMutation({ onSettled: () => utils.automations.list.invalidate() });
  const duplicate = trpc.automations.duplicate.useMutation({ onSuccess: () => utils.automations.list.invalidate() });
  const del = trpc.automations.delete.useMutation({ onSuccess: () => utils.automations.list.invalidate() });
  const [confirm, setConfirm] = useState<{ id: string; name: string } | null>(null);

  const make = (name: string, graph = blankGraph(), description?: string) =>
    create.mutate({ name, description, graph } as any, {
      onSuccess: (r: any) => router.push(`/workflows/${r.id}`),
      onError: (e) => toast.error(errMsg(e)),
    });

  const rows: any[] = list.data ?? [];

  return (
    <div className="page">
      <PageHeader
        title="Workflows"
        description="Chain deploys, checks, rollbacks and messages. Runs by hand, on a schedule, from a webhook or after a deploy."
        actions={
          <button className="btn btn-primary" disabled={create.isLoading} onClick={() => make("Untitled workflow")}>
            {create.isLoading ? <Spinner /> : <Plus size={15} />} New workflow
          </button>
        }
      />

      <div className="card">
        {list.isLoading ? (
          <div className="card-body stack">{[0, 1, 2].map((i) => <Skeleton key={i} h={44} />)}</div>
        ) : rows.length === 0 ? (
          <Empty icon={<Workflow size={18} />} title="No workflows yet">
            Start from a recipe below, or create an empty workflow and add steps on the canvas.
          </Empty>
        ) : (
          <table className="table">
            <thead>
              <tr><th>Workflow</th><th className="desktop-only">Trigger</th><th>Last run</th><th>Active</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const t = TRIGGER[a.triggerType] ?? TRIGGER.manual;
                const st = a.lastRunStatus;
                return (
                  <tr key={a.id} className="click" onClick={() => router.push(`/workflows/${a.id}`)}>
                    <td style={{ maxWidth: 420 }}>
                      <div className="strong ellipsis">{a.name}</div>
                      <div className="faint small ellipsis">{chain(a.graph) || "Empty"}</div>
                    </td>
                    <td className="desktop-only">
                      <span className="row small" style={{ gap: 8 }}>
                        <span className="wf-icon-tile" style={{ width: 26, height: 26, borderRadius: 7, color: "var(--amber)" }}>{t.icon}</span>
                        <span className="ellipsis">{t.label(a.schedule)}</span>
                      </span>
                    </td>
                    <td className="small">
                      {a.lastRunAt ? (
                        <span className="row" style={{ gap: 8 }}>
                          <span className={`dot ${st === "success" ? "ok" : st === "failed" ? "bad" : "info"}`} />
                          {st === "success" ? "Success" : st === "failed" ? "Failed" : "Running"} · {timeAgo(a.lastRunAt)}
                        </span>
                      ) : (
                        <span className="faint">Never</span>
                      )}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <label className="switch" title={a.triggerType === "manual" ? "Manual workflows only run when you click Execute" : a.enabled ? "Active" : "Inactive"}>
                        <input type="checkbox" checked={!!a.enabled} onChange={(e) => setEnabled.mutate({ id: a.id, enabled: e.target.checked })} />
                        <span />
                      </label>
                    </td>
                    <td style={{ width: 48 }}>
                      <RowMenu onDuplicate={() => duplicate.mutate({ id: a.id })} onDelete={() => setConfirm({ id: a.id, name: a.name })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <h2 className="section">Start from a recipe</h2>
      <div className="grid g3">
        {RECIPES.map((r) => (
          <button key={r.id} className="card card-pad hoverable" style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 8 }} disabled={create.isLoading} onClick={() => make(r.name, r.graph, r.description)}>
            <span className="mono faint" style={{ fontSize: 12 }}>{r.steps}</span>
            <span className="strong">{r.name}</span>
            <span className="muted small">{r.description}</span>
          </button>
        ))}
      </div>

      <Dialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={`Delete “${confirm?.name}”?`}
        subtitle="Its run history goes with it."
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={() => confirm && del.mutate({ id: confirm.id }, { onSuccess: () => setConfirm(null) })}>Delete</button>
          </>
        }
      >
        <div className="muted small">Scheduled and webhook runs stop straight away.</div>
      </Dialog>
    </div>
  );
}
