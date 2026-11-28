"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Code, Spinner } from "@/components/ui";

/** One line of the connection test, with "Show command" when there is something to run on the server. */
function CheckRow({ c }: { c: any }) {
  const [show, setShow] = useState(false);
  const icon = c.state === "ok" ? <CheckCircle2 size={16} className="ok-text" /> : c.state === "bad" ? <XCircle size={16} className="bad-text" /> : c.state === "warn" ? <AlertTriangle size={16} className="warn-text" /> : <Info size={16} className="faint" />;
  return (
    <div className="attn-row" style={{ alignItems: "flex-start" }}>
      <span style={{ marginTop: 2 }}>{icon}</span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 550 }}>{c.title}</div>
        <div className="small muted">{c.detail} {c.command && <button className="link" onClick={() => setShow(!show)}>{show ? "Hide command" : "Show command"}</button>}</div>
        {show && c.command && <div style={{ marginTop: 8 }}><Code>{c.command}</Code></div>}
      </div>
    </div>
  );
}

/** The connection test, as Add server step 3 and the server page show it. */
export function TestResults({ result, loading }: { result: any; loading: boolean }) {
  if (loading && !result) return <div className="card-body row muted small"><Spinner /> Connecting…</div>;
  if (!result) return <div className="card-body small muted">Not tested yet.</div>;
  return <div>{result.checks.map((c: any) => <CheckRow key={c.key + c.title} c={c} />)}</div>;
}

