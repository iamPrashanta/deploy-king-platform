"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Save, XCircle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { Spinner, errMsg } from "@/components/ui";

/** 1536 -> "1.5 GB", 512 -> "512 MB" */
export const memText = (mb: number) => (Math.abs(mb) >= 1024 ? `${parseFloat((mb / 1024).toFixed(1))} GB` : `${Math.round(mb)} MB`);

type Fit = {
  verdict: "fits" | "tight" | "blocked";
  overridable: boolean;
  canOverride: boolean;
  note: string;
  reasons: { kind: string; text: string }[];
  suggestions: string[];
};

/**
 * Asks the server "will it fit?" for a new app (no siteId) or for an existing app with a new memory limit.
 * `blocked` is true while the answer is no and the owner has not chosen to deploy anyway.
 */
export function useFit(memoryMb: number | undefined, opts: { siteId?: string; enabled?: boolean } = {}) {
  const [override, setOverride] = useState(false);
  const q = trpc.system.fit.useQuery(
    { memoryMb, siteId: opts.siteId },
    { enabled: opts.enabled !== false, refetchOnWindowFocus: false, keepPreviousData: true, staleTime: 5_000 }
  );
  const fit = (opts.enabled === false ? undefined : q.data) as Fit | undefined;
  const isBlocked = fit?.verdict === "blocked";
  // A tick made for one situation must not carry over to the next.
  useEffect(() => {
    if (!isBlocked) setOverride(false);
  }, [isBlocked]);
  return { fit, override, setOverride, blocked: isBlocked && !override, allowOverCapacity: isBlocked && override ? true : undefined, refetch: q.refetch };
}

/** Says in words whether the app fits. `showFits` also shows the quiet "it fits" line. */
export function FitNotice({ state, action = "Deploy", showFits = true }: { state: ReturnType<typeof useFit>; action?: string; showFits?: boolean }) {
  const { fit, override, setOverride } = state;
  if (!fit) return null;
  if (fit.verdict === "fits") {
    return showFits && fit.note ? (
      <div className="row small ok-text" style={{ gap: 8 }}>
        <CheckCircle2 size={14} /> <span>{fit.note}</span>
      </div>
    ) : null;
  }
  if (fit.verdict === "tight") {
    return (
      <div className="notice warn" role="status">
        <AlertTriangle size={16} className="warn-text" />
        <div>{fit.note}</div>
      </div>
    );
  }
  return (
    <div className="notice bad" role="alert">
      <XCircle size={16} className="bad-text" />
      <div className="grow">
        <strong>This does not fit on the server</strong>
        <ul className="fit-list">
          {fit.reasons.map((r) => (
            <li key={r.kind}>{r.text}</li>
          ))}
        </ul>
        {fit.suggestions.length > 0 && (
          <>
            <div className="small" style={{ marginTop: 10, fontWeight: 600 }}>What you can do</div>
            <ul className="fit-list">
              {fit.suggestions.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </>
        )}
        {fit.canOverride ? (
          <label className="check small" style={{ marginTop: 12 }}>
            <input type="checkbox" checked={override} onChange={(e) => setOverride(e.target.checked)} />
            <span>
              {action} anyway. <span className="faint">This is written to the audit log.</span>
            </span>
          </label>
        ) : fit.overridable ? (
          <div className="small faint" style={{ marginTop: 10 }}>Only the server owner can {action.toLowerCase()} past this.</div>
        ) : null}
      </div>
    </div>
  );
}

/** Settings > Server: the three numbers behind the fit check. Owner only. */
export function CapacitySettings() {
  const q = trpc.system.capacity.useQuery(undefined, { retry: false, refetchOnWindowFocus: false });
  const utils = trpc.useContext();
  const [form, setForm] = useState<{ hostReservePct: string; overcommitPct: string; diskReserveGb: string } | null>(null);
  const cap = q.data as any;
  useEffect(() => {
    if (cap && !form) setForm({ hostReservePct: String(cap.settings.hostReservePct), overcommitPct: String(cap.settings.overcommitPct), diskReserveGb: cap.settings.diskReserveGb == null ? "" : String(cap.settings.diskReserveGb) });
  }, [cap, form]);
  const save = trpc.system.setCapacity.useMutation({
    onSuccess: (next) => {
      utils.system.capacity.setData(undefined, next as any);
      utils.system.overview.invalidate();
      utils.system.fit.invalidate();
      toast.success("Capacity settings saved");
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (q.isError || !cap || !form) return null; // not the owner, or still loading
  const m = cap.memory;
  const num = (s: string, lo: number, hi: number) => {
    const n = Number(s);
    return Number.isInteger(n) && n >= lo && n <= hi ? n : null;
  };
  const reserve = num(form.hostReservePct, 5, 60);
  const over = num(form.overcommitPct, 100, 200);
  const disk = form.diskReserveGb.trim() === "" ? "auto" : num(form.diskReserveGb, 1, 500);
  const valid = reserve !== null && over !== null && disk !== null;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="card">
      <div className="card-head">
        <h3>Capacity</h3>
        <span className="right small faint">
          Apps hold {memText(m.reservedMb)} of {memText(m.promiseLimitMb)} · room for about {cap.apps.roomFor} more
        </span>
      </div>
      <div className="card-body">
        <p className="small muted" style={{ marginBottom: 16, maxWidth: 640 }}>
          Before every deploy the panel checks that the app fits. These three numbers decide what &ldquo;fits&rdquo; means on this server.
        </p>
        <div className="grid g3">
          <div className="field">
            <label className="label" htmlFor="cap-reserve">Memory kept for the panel (%)</label>
            <input id="cap-reserve" className="input" inputMode="numeric" value={form.hostReservePct} onChange={set("hostReservePct")} aria-invalid={reserve === null} />
            <div className="hint">5 to 60. Never less than 512 MB. Now {memText(m.hostReserveMb)} of {memText(m.totalMb)}.</div>
          </div>
          <div className="field">
            <label className="label" htmlFor="cap-over">App limits may add up to (%)</label>
            <input id="cap-over" className="input" inputMode="numeric" value={form.overcommitPct} onChange={set("overcommitPct")} aria-invalid={over === null} />
            <div className="hint">100 to 200. 100 is strict; 150 suits apps that sit far below their limit.</div>
          </div>
          <div className="field">
            <label className="label" htmlFor="cap-disk">Disk kept free (GB)</label>
            <input id="cap-disk" className="input" inputMode="numeric" value={form.diskReserveGb} onChange={set("diskReserveGb")} placeholder="Automatic" aria-invalid={disk === null} />
            <div className="hint">Empty = automatic{cap.disk ? `, now ${memText(cap.disk.reserveMb)}` : ""}. Nothing is deployed once the disk is 95% full.</div>
          </div>
        </div>
        <button
          className="btn btn-primary"
          disabled={!valid || save.isLoading}
          onClick={() => save.mutate({ hostReservePct: reserve!, overcommitPct: over!, diskReserveGb: disk === "auto" ? null : (disk as number) })}
        >
          {save.isLoading ? <Spinner /> : <><Save size={14} /> Save</>}
        </button>
      </div>
    </div>
  );
}
