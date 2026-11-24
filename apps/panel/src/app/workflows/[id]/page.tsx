"use client";

import "@xyflow/react/dist/style.css";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import {
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from "@xyflow/react";
import { AlertTriangle, Check, Play, Plus, Save } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { useTheme } from "@/components/theme";
import { Skeleton, Spinner, cx, duration, errMsg, timeAgo } from "@/components/ui";
import { STEP_BY_TYPE, isTrigger, newId, type StepKind, type WFGraph } from "@/components/workflows/catalog";
import { AppNames, nodeTypes, type StepData } from "@/components/workflows/FlowNode";
import { Palette } from "@/components/workflows/Palette";
import { StepPanel } from "@/components/workflows/StepPanel";

type RFNode = Node<StepData>;

/** Run and step times: milliseconds under a second, otherwise 12s / 3m 04s. */
const took = (ms?: number | null) => (ms == null ? "" : ms < 1000 ? `${ms} ms` : duration(ms));

const edgeStyle = (handle?: string | null) => {
  const color = handle === "true" ? "var(--green)" : handle === "false" ? "var(--red)" : "var(--border-strong)";
  return { style: { stroke: color, strokeWidth: 2 }, markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 } };
};

function toRF(graph: WFGraph, steps?: Record<string, any>): { nodes: RFNode[]; edges: Edge[] } {
  return {
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      type: "step",
      position: n.position,
      deletable: !isTrigger(n.type),
      data: { wfType: n.type, settings: n.data ?? {}, status: steps?.[n.id]?.status },
    })),
    edges: graph.edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? undefined, ...edgeStyle(e.sourceHandle) })),
  };
}

function fromRF(nodes: RFNode[], edges: Edge[]): WFGraph {
  return {
    nodes: nodes.map((n) => ({ id: n.id, type: n.data.wfType, position: { x: Math.round(n.position.x), y: Math.round(n.position.y) }, data: n.data.settings })),
    edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle ?? null })),
  };
}

function useAppNames() {
  const sites = trpc.sites.list.useQuery(undefined, { staleTime: 30_000 });
  const apps = useMemo(() => (sites.data ?? []).filter((s: any) => !s.isPreview).map((s: any) => ({ id: s.id, domain: s.domain })), [sites.data]);
  const name = useCallback(
    (id: string) => (/\{\{/.test(id) ? "app from trigger" : apps.find((a) => a.id === id)?.domain.split(".")[0] ?? "missing app"),
    [apps]
  );
  return { apps, name };
}

// ─── Editor ──────────────────────────────────────────────────────────────────
function Editor({ a, onExecuted, setDirtyFlag }: { a: any; onExecuted: (runId: string) => void; setDirtyFlag: (d: boolean) => void }) {
  const utils = trpc.useContext();
  const { resolved } = useTheme();
  const { screenToFlowPosition, fitView } = useReactFlow();
  const { apps, name: appName } = useAppNames();
  const initial = useMemo(() => toRF(a.graph), [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [nodes, setNodes, onNodesChange] = useNodesState<RFNode>(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initial.edges);
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [palette, setPalette] = useState<{ source?: string; handle?: string | null; position?: { x: number; y: number } } | null>(null);
  const [webhookUrl, setWebhookUrl] = useState<string | null>(a.webhookUrl);
  const connecting = useRef<{ source: string; handle: string | null } | null>(null);
  const runs = trpc.automations.runs.useQuery({ id: a.id, limit: 1 });
  const lastRun = trpc.automations.run.useQuery({ runId: runs.data?.[0]?.id! }, { enabled: !!runs.data?.[0]?.id });

  const update = trpc.automations.update.useMutation();
  const execute = trpc.automations.execute.useMutation();
  const rotate = trpc.automations.rotateWebhook.useMutation();

  useEffect(() => setDirtyFlag(dirty), [dirty, setDirtyFlag]);
  const touch = () => setDirty(true);

  const save = useCallback(
    async (quiet = false) => {
      const graph = fromRF(nodes, edges);
      try {
        const r: any = await update.mutateAsync({ id: a.id, graph } as any);
        setDirty(false);
        setWebhookUrl(r.webhookUrl);
        utils.automations.get.invalidate({ id: a.id });
        utils.automations.list.invalidate();
        if (!quiet) toast.success("Saved");
        return true;
      } catch (e) {
        toast.error(errMsg(e));
        return false;
      }
    },
    [nodes, edges, a.id, update, utils]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    const onLeave = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", onLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", onLeave);
    };
  }, [save, dirty]);

  const graphNow = () => fromRF(nodes, edges);
  const trigger = nodes.find((n) => isTrigger(n.data.wfType));
  const triggerType = trigger?.data.wfType.slice("trigger.".length) ?? "manual";
  const sel = nodes.find((n) => n.id === selected) ?? null;

  const addStep = (kind: StepKind) => {
    const g = graphNow();
    if (isTrigger(kind.type) && trigger) {
      // one trigger per workflow: swap it in place and keep its connections
      setNodes((ns) => ns.map((n) => (n.id === trigger.id ? { ...n, data: { ...n.data, wfType: kind.type, settings: { ...kind.defaults } } } : n)));
      setSelected(trigger.id);
      setPalette(null);
      touch();
      return;
    }
    const id = newId(g);
    const from = palette?.source ? nodes.find((n) => n.id === palette.source) : sel;
    const position =
      palette?.position ??
      (from ? { x: from.position.x + 220, y: from.position.y + (from.data.wfType === "logic.if" ? -60 : 0) } : { x: Math.max(0, ...nodes.map((n) => n.position.x)) + 220, y: 120 });
    setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id, type: "step", position, selected: true, deletable: true, data: { wfType: kind.type, settings: { ...kind.defaults } } }]);
    if (from) {
      const handle = palette?.source ? palette.handle ?? null : from.data.wfType === "logic.if" ? "true" : null;
      setEdges((es) => addEdge({ id: `${from.id}-${handle ?? "out"}-${id}`, source: from.id, target: id, sourceHandle: handle ?? undefined, ...edgeStyle(handle) }, es));
    }
    setSelected(id);
    setPalette(null);
    touch();
  };

  const onConnect = (c: Connection) => {
    if (c.source === c.target) return;
    setEdges((es) => addEdge({ ...c, id: `${c.source}-${c.sourceHandle ?? "out"}-${c.target}`, ...edgeStyle(c.sourceHandle) }, es));
    touch();
  };

  const run = async () => {
    if (dirty && !(await save(true))) return;
    try {
      const r: any = await execute.mutateAsync({ id: a.id });
      onExecuted(r.runId);
    } catch (e) {
      toast.error(errMsg(e));
    }
  };

  const lastStep = sel && (lastRun.data as any)?.steps?.[sel.id];

  return (
    <AppNames.Provider value={appName}>
      <div className="wf-body">
        <div className="wf-canvas">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            colorMode={resolved}
            onNodesChange={(ch) => {
              onNodesChange(ch);
              if (ch.some((c) => c.type === "position" || c.type === "remove")) touch();
              const removed = ch.filter((c) => c.type === "remove").map((c: any) => c.id);
              if (removed.includes(selected)) setSelected(null);
            }}
            onEdgesChange={(ch) => {
              onEdgesChange(ch);
              if (ch.some((c) => c.type === "remove")) touch();
            }}
            onConnect={onConnect}
            onConnectStart={(_e, p) => (connecting.current = p.nodeId ? { source: p.nodeId, handle: p.handleId ?? null } : null)}
            onConnectEnd={(e, state: any) => {
              // dropped on empty canvas: open the step list and connect what is picked
              if (state?.isValid || !connecting.current) return;
              const pt = "changedTouches" in e ? (e as TouchEvent).changedTouches[0] : (e as MouseEvent);
              setPalette({ source: connecting.current.source, handle: connecting.current.handle, position: screenToFlowPosition({ x: pt.clientX, y: pt.clientY - 40 }) });
            }}
            onNodeClick={(_e, n) => setSelected(n.id)}
            onPaneClick={() => {
              setSelected(null);
              setPalette(null);
            }}
            isValidConnection={(c) => c.source !== c.target}
            fitView
            fitViewOptions={{ padding: 0.35, maxZoom: 1.1 }}
            minZoom={0.3}
            maxZoom={1.8}
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={["Backspace", "Delete"]}
          >
            <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--border-strong)" />
            <Controls showInteractive={false} position="bottom-left" />
          </ReactFlow>

          <button className="btn wf-float wf-add" style={{ height: 38, width: 38, padding: 0 }} title="Add a step" aria-label="Add a step" onClick={() => setPalette(palette ? null : {})}>
            <Plus size={18} />
          </button>
          <Palette open={!!palette} onClose={() => setPalette(null)} onPick={addStep} hasTrigger={!!trigger} />
          {nodes.length === 1 && !palette && (
            <div className="wf-float wf-empty-hint notice small"><span>Add your first step with <b>+</b>, or drag from the trigger's dot.</span></div>
          )}
          <button className="btn btn-primary btn-lg wf-float wf-exec" disabled={execute.isLoading || update.isLoading} onClick={run}>
            {execute.isLoading ? <Spinner /> : <Play size={15} />} Execute workflow
          </button>
        </div>

        {sel && (
          <StepPanel
            key={sel.id}
            node={{ id: sel.id, wfType: sel.data.wfType, settings: sel.data.settings }}
            others={nodes.filter((n) => n.id !== sel.id && !isTrigger(n.data.wfType)).map((n) => ({ id: n.id, wfType: n.data.wfType, label: n.data.settings?.label || STEP_BY_TYPE[n.data.wfType]?.label }))}
            triggerType={triggerType}
            apps={apps}
            webhookUrl={webhookUrl ? (webhookUrl.startsWith("/") ? `${window.location.origin}${webhookUrl}` : webhookUrl) : null}
            lastStep={lastStep}
            onChange={(patch) => {
              setNodes((ns) => ns.map((n) => (n.id === sel.id ? { ...n, data: { ...n.data, settings: { ...n.data.settings, ...patch } } } : n)));
              touch();
            }}
            onDelete={() => {
              setNodes((ns) => ns.filter((n) => n.id !== sel.id));
              setEdges((es) => es.filter((e) => e.source !== sel.id && e.target !== sel.id));
              setSelected(null);
              touch();
            }}
            onClose={() => setSelected(null)}
            onRotateWebhook={() => rotate.mutate({ id: a.id }, { onSuccess: (r: any) => { setWebhookUrl(r.webhookUrl); toast.success("New URL created"); } })}
          />
        )}
      </div>
      <SaveBar dirty={dirty} saving={update.isLoading} onSave={() => save()} onFit={() => fitView({ padding: 0.35, duration: 300 })} />
    </AppNames.Provider>
  );
}

/** Rendered into the top bar through a portal-free trick: the bar reads this via a custom event. */
function SaveBar({ dirty, saving, onSave }: { dirty: boolean; saving: boolean; onSave: () => void; onFit: () => void }) {
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("wf-save-state", { detail: { dirty, saving } }));
  }, [dirty, saving]);
  useEffect(() => {
    const h = () => onSave();
    window.addEventListener("wf-save", h);
    return () => window.removeEventListener("wf-save", h);
  }, [onSave]);
  return null;
}

// ─── Executions ──────────────────────────────────────────────────────────────
function Executions({ a, runId, onSelectRun }: { a: any; runId: string | null; onSelectRun: (id: string) => void }) {
  const { resolved } = useTheme();
  const { fitView } = useReactFlow();
  const { name: appName } = useAppNames();
  const runs = trpc.automations.runs.useQuery(
    { id: a.id, limit: 50 },
    { refetchInterval: (d: any) => (d?.some((r: any) => r.status === "queued" || r.status === "running") ? 1500 : 8000) }
  );
  const current = runId ?? runs.data?.[0]?.id ?? null;
  const run = trpc.automations.run.useQuery(
    { runId: current! },
    { enabled: !!current, refetchInterval: (d: any) => (d && (d.status === "queued" || d.status === "running") ? 1000 : false) }
  );
  const [step, setStep] = useState<string | null>(null);
  const r: any = run.data;
  const view = useMemo(() => {
    if (!r) return null;
    const v = toRF(r.graph, r.steps);
    const st = r.steps ?? {};
    v.edges = v.edges.map((e) => {
      const went = st[e.source]?.status === "success" && st[e.target] && st[e.target].status !== "skipped" && (!st[e.source].branch || (e.sourceHandle ?? "true") === st[e.source].branch);
      const failedOn = st[e.source]?.status === "failed" && st[e.target] && st[e.target].status !== "skipped";
      const color = went || failedOn ? "var(--green)" : "var(--border-strong)";
      return { ...e, style: { stroke: color, strokeWidth: 2, strokeDasharray: went || failedOn ? undefined : "5 5" }, markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 }, animated: st[e.target]?.status === "running" };
    });
    return v;
  }, [r]);
  const total = runs.data?.length ?? 0;
  const s = step && r?.steps?.[step];
  const firstFailed = r && Object.entries(r.steps ?? {}).find(([, v]: any) => v.status === "failed")?.[0];
  useEffect(() => setStep(null), [current]);
  const shown = step ?? firstFailed ?? null;
  const shownStep = shown ? r?.steps?.[shown] : null;
  const shownNode = shown ? r?.graph?.nodes?.find((n: any) => n.id === shown) : null;
  // the output panel takes space from the canvas: fit the graph again when it opens or closes
  const hasOutput = !!shownStep;
  useEffect(() => {
    const t = setTimeout(() => fitView({ padding: 0.35, maxZoom: 1.1, duration: 200 }), 80);
    return () => clearTimeout(t);
  }, [hasOutput, current, fitView]);

  return (
    <AppNames.Provider value={appName}>
      <div className="wf-body">
        <div className="wf-runs" aria-label="Runs">
          <div className="faint small" style={{ padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>{total ? `${total} run${total === 1 ? "" : "s"}` : "No runs yet"}</div>
          {(runs.data ?? []).map((x: any, i: number) => (
            <button key={x.id} className={cx(x.id === current && "on")} onClick={() => onSelectRun(x.id)}>
              <span className={`dot ${x.status === "success" ? "ok" : x.status === "failed" ? "bad" : "info"} ${x.status === "running" || x.status === "queued" ? "pulse" : ""}`} />
              <span className="grow" style={{ minWidth: 0 }}>
                <span className="small strong">#{total - i} · {x.status === "success" ? "Success" : x.status === "failed" ? "Failed" : x.status === "queued" ? "Queued" : "Running"}</span>
                <br />
                <span className="faint tiny">{timeAgo(x.createdAt)} · {x.trigger}</span>
              </span>
              <span className="faint tiny mono">{took(x.durationMs)}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <div className="wf-canvas">
            {!current ? (
              <div className="empty" style={{ paddingTop: 120 }}>
                <h3>No runs yet</h3>
                <p className="small">Click Execute workflow in the editor to run it now.</p>
              </div>
            ) : !view ? (
              <div style={{ padding: 20 }}><Skeleton h={300} /></div>
            ) : (
              <>
                <div className="wf-float row wrap" style={{ top: 12, left: 14, gap: 8 }}>
                  <span className={cx("badge", r.status === "success" ? "ok" : r.status === "failed" ? "bad" : "info")}>
                    {r.status === "success" ? "Success" : r.status === "failed" ? "Failed" : r.status === "queued" ? "Queued" : "Running"}
                  </span>
                  <span className="badge">{r.trigger} · {timeAgo(r.createdAt)}{r.durationMs != null ? ` · ${took(r.durationMs)}` : ""}</span>
                  {r.error && <span className="badge bad" title={r.error} style={{ maxWidth: 520 }}><span className="ellipsis">{r.error}</span></span>}
                </div>
                <ReactFlow
                  key={current}
                  nodes={view.nodes.map((n) => ({ ...n, selected: n.id === shown }))}
                  edges={view.edges}
                  nodeTypes={nodeTypes}
                  colorMode={resolved}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  onNodeClick={(_e, n) => setStep(n.id)}
                  fitView
                  fitViewOptions={{ padding: 0.35, maxZoom: 1.1 }}
                  proOptions={{ hideAttribution: true }}
                  deleteKeyCode={null}
                >
                  <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} color="var(--border-strong)" />
                  <Controls showInteractive={false} position="bottom-left" />
                </ReactFlow>
              </>
            )}
          </div>
          {shownStep && (
            <section className="wf-output" aria-label="Step output">
              <div className="row wrap" style={{ padding: "10px 16px", borderBottom: "1px solid var(--border)" }}>
                <span className="strong small">{shownNode?.data?.label ?? shown}</span>
                <span className={cx("badge", shownStep.status === "success" ? "ok" : shownStep.status === "failed" ? "bad" : shownStep.status === "running" ? "info" : "")}>
                  {shownStep.status}{shownStep.status === "failed" && shownNode?.data?.continueOnError ? " · continued" : ""}
                </span>
                {shownStep.durationMs != null && <span className="faint small">{took(shownStep.durationMs)}{shownStep.attempts > 1 ? ` · ${shownStep.attempts} attempts` : ""}</span>}
                {shownStep.branch && <span className="faint small">went {shownStep.branch}</span>}
                <span className="right faint tiny">Click a step to see its output</span>
              </div>
              {shownStep.error && <div className="notice bad small" style={{ margin: "10px 16px 0" }}><AlertTriangle size={14} className="bad-text" />{shownStep.error}</div>}
              <pre>{shownStep.output === undefined ? (shownStep.status === "skipped" ? "This step did not run." : "No output.") : JSON.stringify(shownStep.output, null, 2)}</pre>
            </section>
          )}
        </div>
      </div>
    </AppNames.Provider>
  );
}

// ─── Page ────────────────────────────────────────────────────────────────────
function WorkflowPage() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const utils = trpc.useContext();
  const q = trpc.automations.get.useQuery({ id }, { refetchOnWindowFocus: false });
  const rename = trpc.automations.update.useMutation();
  const setEnabled = trpc.automations.setEnabled.useMutation({ onSuccess: () => utils.automations.get.invalidate({ id }) });
  const [view, setView] = useState<"editor" | "runs">(params.get("view") === "runs" ? "runs" : "editor");
  const [runId, setRunId] = useState<string | null>(params.get("run"));
  const [name, setName] = useState("");
  const [saveState, setSaveState] = useState({ dirty: false, saving: false });
  const a: any = q.data;
  useCrumbs([{ label: "Workflows", href: "/workflows" }, { label: a?.name ?? "…" }]);
  useEffect(() => {
    if (a) setName(a.name);
  }, [a?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const h = (e: any) => setSaveState(e.detail);
    window.addEventListener("wf-save-state", h);
    return () => window.removeEventListener("wf-save-state", h);
  }, []);
  useEffect(() => {
    const qs = new URLSearchParams();
    if (view === "runs") qs.set("view", "runs");
    if (view === "runs" && runId) qs.set("run", runId);
    router.replace(`/workflows/${id}${qs.toString() ? `?${qs}` : ""}`, { scroll: false });
  }, [view, runId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <div className="page"><div className="notice bad">{q.error.message}</div></div>;
  if (!a) return <div className="page stack"><Skeleton h={48} /><Skeleton h={480} /></div>;

  const commitName = () => {
    const n = name.trim();
    if (n && n !== a.name) rename.mutate({ id, name: n }, { onSuccess: () => { utils.automations.get.invalidate({ id }); utils.automations.list.invalidate(); } });
  };

  return (
    <div className="wf-page">
      <div className="wf-bar">
        <input className="wf-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={commitName} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} aria-label="Workflow name" />
        <div className="seg">
          <button className={view === "editor" ? "on" : ""} onClick={() => setView("editor")}>Editor</button>
          <button
            className={view === "runs" ? "on" : ""}
            onClick={() => {
              // keep edits: save them before the editor goes away
              if (saveState.dirty) window.dispatchEvent(new Event("wf-save"));
              setView("runs");
            }}
          >
            Executions
          </button>
        </div>
        <span className="grow" />
        <label className="row small" style={{ gap: 8 }} title={a.triggerType === "manual" ? "Manual workflows run only when you click Execute" : "Runs on its own trigger while active"}>
          <span className="switch">
            <input type="checkbox" checked={!!a.enabled} onChange={(e) => setEnabled.mutate({ id, enabled: e.target.checked })} />
            <span />
          </span>
          {a.enabled ? "Active" : "Inactive"}
        </label>
        {view === "editor" && (
          <>
            <span className={cx("badge", saveState.dirty ? "warn" : "ok")}>
              {saveState.saving ? <Spinner size={12} /> : saveState.dirty ? null : <Check size={12} />}
              {saveState.saving ? "Saving" : saveState.dirty ? "Unsaved changes" : "Saved"}
            </span>
            <button className="btn btn-sm" disabled={!saveState.dirty || saveState.saving} onClick={() => window.dispatchEvent(new Event("wf-save"))} title="Save (Ctrl S)">
              <Save size={13} /> Save
            </button>
          </>
        )}
      </div>
      <ReactFlowProvider>
        {view === "editor" ? (
          <Editor
            a={a}
            setDirtyFlag={() => {}}
            onExecuted={(rid) => {
              setRunId(rid);
              setView("runs");
              utils.automations.runs.invalidate({ id });
            }}
          />
        ) : (
          <Executions a={a} runId={runId} onSelectRun={setRunId} />
        )}
      </ReactFlowProvider>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense>
      <WorkflowPage />
    </Suspense>
  );
}
