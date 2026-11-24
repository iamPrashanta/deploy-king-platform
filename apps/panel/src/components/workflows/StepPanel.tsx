"use client";

import { Copy, RefreshCw, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { CRON_PRESETS, OPS, STEP_BY_TYPE, isTrigger } from "./catalog";
import { copyText, CopyButton } from "@/components/ui";

type Props = {
  node: { id: string; wfType: string; settings: Record<string, any> };
  others: Array<{ id: string; wfType: string; label: string }>;
  triggerType: string;
  apps: Array<{ id: string; domain: string }>;
  webhookUrl: string | null;
  lastStep?: { status: string; output?: unknown; error?: string; durationMs?: number } | null;
  onChange: (patch: Record<string, any>) => void;
  onDelete: () => void;
  onClose: () => void;
  onRotateWebhook: () => void;
};

const OUTPUT_FIELDS: Record<string, string[]> = {
  "action.http": ["status", "ok", "body", "url", "durationMs"],
  "action.deploy": ["status", "url", "app", "deploymentId"],
  "action.rollback": ["status", "app", "deploymentId"],
  "logic.if": ["result"],
  "logic.wait": ["waitedSeconds"],
  "notify.message": ["status", "ok"],
};
const TRIGGER_FIELDS: Record<string, string[]> = {
  deployment: ["app", "appId", "url", "event", "deploymentId", "error", "restarts", "outOfMemory"],
  webhook: ["body", "query", "headers"],
  schedule: ["scheduledAt"],
  manual: [],
};

function Field({ label, hint, children }: { label: string; hint?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="field">
      <label className="label">{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

function AppSelect({ value, onChange, apps, allowAny, allowTemplate }: { value: string; onChange: (v: string) => void; apps: Props["apps"]; allowAny?: boolean; allowTemplate?: boolean }) {
  const isTemplate = /\{\{/.test(value || "");
  return (
    <select className="select" value={isTemplate ? "__tpl" : value || ""} onChange={(e) => onChange(e.target.value === "__tpl" ? "{{ trigger.appId }}" : e.target.value)}>
      <option value="">{allowAny ? "Any app" : "Pick an app…"}</option>
      {allowTemplate && <option value="__tpl">The app from the trigger</option>}
      {apps.map((a) => <option key={a.id} value={a.id}>{a.domain}</option>)}
    </select>
  );
}

export function StepPanel(p: Props) {
  const { node, onChange } = p;
  const kind = STEP_BY_TYPE[node.wfType];
  const d = node.settings ?? {};
  const set = (k: string) => (e: any) => onChange({ [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value });
  const Icon = kind?.icon;
  const trig = isTrigger(node.wfType);
  const values = [
    "{{ prev }}",
    ...TRIGGER_FIELDS[p.triggerType]?.map((f) => `{{ trigger.${f} }}`) ?? [],
    ...p.others.flatMap((o) => (OUTPUT_FIELDS[o.wfType] ?? []).map((f) => ({ v: `{{ steps.${o.id}.${f} }}`, from: o.label }))),
  ];

  return (
    <aside className="wf-side" aria-label="Step settings">
      <div className="head">
        <span className="wf-icon-tile" style={{ color: kind?.color }}>{Icon && <Icon size={18} />}</span>
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="strong ellipsis">{d.label || kind?.label}</div>
          <div className="faint small">{kind?.label ?? node.wfType}{trig ? " trigger" : ""} · <span className="mono">{node.id}</span></div>
        </div>
        <button className="icon-btn" onClick={p.onClose} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="body">
        <Field label="Name">
          <input className="input" value={d.label ?? ""} onChange={set("label")} />
        </Field>

        {node.wfType === "trigger.manual" && <div className="notice small" style={{ marginBottom: 16 }}>Runs when you click Execute workflow. Change the trigger from the + menu.</div>}

        {node.wfType === "trigger.schedule" && (
          <>
            <Field label="When" hint={<>Cron, server time. <a className="link" href="https://crontab.guru" target="_blank" rel="noreferrer">crontab.guru</a> explains any expression.</>}>
              <select className="select" style={{ marginBottom: 8 }} value={CRON_PRESETS.some(([c]) => c === d.cron) ? d.cron : ""} onChange={(e) => e.target.value && onChange({ cron: e.target.value })}>
                <option value="">Custom</option>
                {CRON_PRESETS.map(([c, name]) => <option key={c} value={c}>{name}</option>)}
              </select>
              <input className="input mono" value={d.cron ?? ""} onChange={set("cron")} placeholder="0 2 * * *" />
            </Field>
            <div className="notice small" style={{ marginBottom: 16 }}>Runs on its own only while the workflow is Active.</div>
          </>
        )}

        {node.wfType === "trigger.webhook" && (
          <Field label="Trigger URL" hint="POST JSON to this URL; the body is {{ trigger.body }}. Runs only while the workflow is Active. Anyone with the URL can trigger it.">
            {p.webhookUrl ? (
              <>
                <div className="row" style={{ gap: 6 }}>
                  <input className="input mono" readOnly value={p.webhookUrl} onFocus={(e) => e.target.select()} />
                  <CopyButton text={p.webhookUrl} label="" />
                </div>
                <button className="btn btn-sm btn-ghost" style={{ marginTop: 6 }} onClick={p.onRotateWebhook}><RefreshCw size={12} /> New URL (the old one stops working)</button>
              </>
            ) : (
              <div className="faint small">Save the workflow to get its URL.</div>
            )}
          </Field>
        )}

        {node.wfType === "trigger.deployment" && (
          <>
            <Field label="When" hint={d.event === "crashing" ? "Runs once when a live app starts restarting over and over, for example after running out of memory." : undefined}>
              <select className="select" value={d.event ?? "any"} onChange={set("event")}>
                <option value="any">a deploy finishes (either way)</option>
                <option value="success">a deploy succeeds</option>
                <option value="failed">a deploy fails</option>
                <option value="crashing">a live app keeps crashing</option>
              </select>
            </Field>
            <Field label="Of" hint={d.event === "crashing" ? "The values restarts, outOfMemory and error say what went wrong." : "Deploys started by workflows don't trigger this, so a workflow can't loop."}>
              <AppSelect value={d.siteId ?? ""} onChange={(v) => onChange({ siteId: v })} apps={p.apps} allowAny />
            </Field>
          </>
        )}

        {(node.wfType === "action.deploy" || node.wfType === "action.rollback") && (
          <Field label="App" hint={p.triggerType === "deployment" ? "“The app from the trigger” is the app that just deployed." : undefined}>
            <AppSelect value={d.siteId ?? ""} onChange={(v) => onChange({ siteId: v })} apps={p.apps} allowTemplate={p.triggerType === "deployment"} />
          </Field>
        )}
        {node.wfType === "action.deploy" && (
          <label className="check small" style={{ marginBottom: 16 }}>
            <input type="checkbox" checked={d.wait !== false} onChange={set("wait")} />
            <span>Wait until the new release is live (or failed) before the next step</span>
          </label>
        )}
        {node.wfType === "action.rollback" && <div className="notice small" style={{ marginBottom: 16 }}>Starts the previous release again from its image. Nothing is rebuilt.</div>}

        {node.wfType === "action.http" && (
          <>
            <div className="grid" style={{ gridTemplateColumns: "110px 1fr", gap: 8 }}>
              <Field label="Method">
                <select className="select" value={d.method ?? "GET"} onChange={set("method")}>
                  {["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].map((m) => <option key={m}>{m}</option>)}
                </select>
              </Field>
              <Field label="URL">
                <input className="input mono" value={d.url ?? ""} onChange={set("url")} placeholder="https://… or {{ trigger.url }}/health" />
              </Field>
            </div>
            <Field label="Headers" hint="One per line, Name: value">
              <textarea className="textarea mono" style={{ minHeight: 60 }} value={d.headers ?? ""} onChange={set("headers")} placeholder="Authorization: Bearer …" />
            </Field>
            {!["GET", "HEAD"].includes(d.method ?? "GET") && (
              <Field label="Body">
                <textarea className="textarea mono" value={d.body ?? ""} onChange={set("body")} placeholder='{ "ref": "{{ trigger.body.ref }}" }' />
              </Field>
            )}
            <div className="grid g3" style={{ gap: 8 }}>
              <Field label="Expect"><input className="input" value={d.expectStatus ?? "2xx"} onChange={set("expectStatus")} placeholder="2xx" /></Field>
              <Field label="Timeout (s)"><input className="input" inputMode="numeric" value={d.timeout ?? 30} onChange={set("timeout")} /></Field>
              <Field label="Retries"><input className="input" inputMode="numeric" value={d.retries ?? 0} onChange={set("retries")} /></Field>
            </div>
          </>
        )}

        {node.wfType === "logic.if" && (
          <>
            <Field label="Value"><input className="input mono" value={d.left ?? ""} onChange={set("left")} /></Field>
            <Field label="Is">
              <select className="select" value={d.op ?? "equals"} onChange={set("op")}>
                {Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </Field>
            {!["is_true", "is_empty"].includes(d.op) && <Field label="Compared with"><input className="input mono" value={d.right ?? ""} onChange={set("right")} /></Field>}
            <div className="notice small" style={{ marginBottom: 16 }}><span>Connect the green <b>true</b> and red <b>false</b> dots to what happens in each case.</span></div>
          </>
        )}

        {node.wfType === "logic.wait" && (
          <Field label="Wait (seconds)" hint="Up to 3600.">
            <input className="input" inputMode="numeric" value={d.seconds ?? 30} onChange={set("seconds")} />
          </Field>
        )}

        {node.wfType === "notify.message" && (
          <>
            <Field label="Send to">
              <select className="select" value={d.kind ?? "discord"} onChange={set("kind")}>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
                <option value="webhook">Other webhook (JSON)</option>
              </select>
            </Field>
            <Field label="Webhook URL" hint={d.kind === "slack" ? "Slack → Apps → Incoming Webhooks" : d.kind === "discord" ? "Discord channel → Integrations → Webhooks" : "Receives { text, content, message }"}>
              <input className="input mono" value={d.url ?? ""} onChange={set("url")} placeholder="https://…" />
            </Field>
            <Field label="Message">
              <textarea className="textarea" value={d.message ?? ""} onChange={set("message")} placeholder="✅ {{ trigger.app }} is live" />
            </Field>
          </>
        )}

        {!trig && (
          <label className="check small" style={{ marginBottom: 16 }}>
            <input type="checkbox" checked={!!d.continueOnError} onChange={set("continueOnError")} />
            <span>
              <span className="strong">Continue on error</span>
              <br />
              <span className="faint">Pass the error to the next step instead of stopping the run.</span>
            </span>
          </label>
        )}

        {!trig && values.length > 0 && (
          <details style={{ marginBottom: 16 }}>
            <summary className="small link" style={{ cursor: "pointer" }}>Values you can use in text fields</summary>
            <div className="stack" style={{ gap: 4, marginTop: 8 }}>
              {values.map((v: any) => {
                const text = typeof v === "string" ? v : v.v;
                return (
                  <button
                    key={text}
                    className="row small"
                    style={{ gap: 8, textAlign: "left" }}
                    onClick={async () => {
                      await copyText(text);
                      toast.success(`Copied ${text}`);
                    }}
                    title="Copy"
                  >
                    <Copy size={11} className="faint" />
                    <span className="mono" style={{ fontSize: 12 }}>{text}</span>
                    {typeof v !== "string" && <span className="faint tiny ellipsis">{v.from}</span>}
                  </button>
                );
              })}
            </div>
          </details>
        )}

        {p.lastStep && (
          <div className="field">
            <label className="label">Last run · {p.lastStep.status}{p.lastStep.durationMs != null ? ` · ${p.lastStep.durationMs} ms` : ""}</label>
            {p.lastStep.error && <div className="notice bad small" style={{ marginBottom: 6 }}>{p.lastStep.error}</div>}
            {p.lastStep.output !== undefined && <pre className="log" style={{ minHeight: 0, maxHeight: 220 }}>{JSON.stringify(p.lastStep.output, null, 2)}</pre>}
          </div>
        )}

        {!trig && (
          <button className="btn btn-danger btn-sm" onClick={p.onDelete}><Trash2 size={13} /> Delete step</button>
        )}
      </div>
    </aside>
  );
}
