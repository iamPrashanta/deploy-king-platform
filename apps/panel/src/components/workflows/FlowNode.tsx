"use client";

import { createContext, memo, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Zap } from "lucide-react";
import { STEP_BY_TYPE, isTrigger } from "./catalog";
import { Spinner, cx } from "@/components/ui";

export type StepData = { wfType: string; settings: Record<string, any>; status?: "running" | "success" | "failed" | "skipped" };

/** App names for step summaries ("Deploy app · shop-api"). */
export const AppNames = createContext<(id: string) => string>((id) => id);

function StepNodeInner({ data, selected }: NodeProps & { data: StepData }) {
  const appName = useContext(AppNames);
  const kind = STEP_BY_TYPE[data.wfType];
  const Icon = kind?.icon ?? Zap;
  const trig = isTrigger(data.wfType);
  const st = data.status;
  return (
    <div className={cx("wf-node", trig && "trigger", selected && "selected", st && `st-${st}`)}>
      {!trig && <Handle type="target" position={Position.Left} className="wf-handle" />}
      <div className="wf-box" style={{ color: kind?.color ?? "var(--muted)" }}>
        <Icon size={30} />
        {st && (
          <span className={cx("wf-badge", st)}>{st === "success" ? "✓" : st === "failed" ? "✕" : st === "running" ? <Spinner size={11} /> : "–"}</span>
        )}
      </div>
      {kind?.branches ? (
        kind.branches.map((b, i) => (
          <Handle key={b.id} id={b.id} type="source" position={Position.Right} className="wf-handle" style={{ top: `${30 + i * 40}%`, background: b.color }}>
            <span className="wf-branch" style={{ color: b.color }}>{b.label}</span>
          </Handle>
        ))
      ) : (
        <Handle type="source" position={Position.Right} className="wf-handle" />
      )}
      <div className="wf-label">{data.settings?.label || kind?.label || data.wfType}</div>
      <div className="wf-sub">{kind ? kind.summary(data.settings ?? {}, { appName }) : "Unknown step"}</div>
    </div>
  );
}

export const StepNode = memo(StepNodeInner);
export const nodeTypes = { step: StepNode };
