"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bell, CheckCircle2, Github, KeyRound, Mail, Send, ShieldCheck, Smartphone, Webhook } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { Dialog, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";
import { CodeInput, RecoveryCodes, TwoStepSetup } from "@/components/TwoStep";

/** Settings › Sign-in, Email and Alerts, and the GitHub App card on the GitHub tab. */

// ─── Sign-in: your own 2-step sign-in ────────────────────────────────────────

export function SignInSettings() {
  const utils = trpc.useContext();
  const status = trpc.twoFactor.status.useQuery();
  const start = trpc.twoFactor.start.useMutation();
  const confirm = trpc.twoFactor.confirm.useMutation();
  const disable = trpc.twoFactor.disable.useMutation();
  const renew = trpc.twoFactor.newRecoveryCodes.useMutation();
  const [setting, setSetting] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [ask, setAsk] = useState<null | "off" | "codes">(null);
  const [code, setCode] = useState("");
  const [err, setErr] = useState("");
  const s = status.data as any;
  const refresh = () => utils.twoFactor.status.invalidate();

  const runAsk = async () => {
    setErr("");
    try {
      if (ask === "off") {
        await disable.mutateAsync({ code });
        toast.success("2-step sign-in is off");
      } else {
        const out = await renew.mutateAsync({ code });
        setCodes(out.recoveryCodes);
      }
      setAsk(null);
      setCode("");
      refresh();
    } catch (e) {
      setErr(errMsg(e));
      setCode("");
    }
  };

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head"><Smartphone size={15} /><h3>2-step sign-in</h3>{s && <span className="right">{s.enabled ? <span className="badge ok">On</span> : <span className="badge warn">Off</span>}</span>}</div>
        <div className="card-body stack" style={{ gap: 14 }}>
          {status.isLoading ? <Skeleton h={60} /> : codes ? (
            <RecoveryCodes codes={codes} onContinue={() => { setCodes(null); setSetting(false); refresh(); }} continueLabel="Done" />
          ) : setting ? (
            <TwoStepSetup start={() => start.mutateAsync()} confirm={(c) => confirm.mutateAsync({ code: c })} onDone={(rc) => setCodes(rc)} compact />
          ) : s?.enabled ? (
            <>
              <div className="muted small">You sign in with your password and a code from your authenticator app{s.enabledAt ? `, since ${new Date(s.enabledAt).toLocaleDateString()}` : ""}.</div>
              <dl className="kv">
                <dt>Recovery codes</dt>
                <dd className={cx("small", s.recoveryLeft <= 2 && "warn-text")}>{s.recoveryLeft} left{s.recoveryLeft <= 2 ? ". Make new ones soon." : ""}</dd>
              </dl>
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn btn-sm" onClick={() => { setAsk("codes"); setErr(""); }}><KeyRound size={13} /> New recovery codes</button>
                <button className="btn btn-sm btn-ghost" disabled={s.required} title={s.required ? "This team requires 2-step sign-in" : undefined} onClick={() => { setAsk("off"); setErr(""); }}>Turn off</button>
              </div>
              {s.required && <div className="small faint">This team requires 2-step sign-in, so it cannot be turned off. If you lose your phone, an admin can reset it.</div>}
            </>
          ) : (
            <>
              <div className="muted small">Sign in with your password and a 6-digit code from an app on your phone. Someone who learns your password still cannot get in.{s?.required ? " This team requires it: you will be asked at your next sign-in." : ""}</div>
              <div><button className="btn btn-primary btn-sm" onClick={() => setSetting(true)}><ShieldCheck size={13} /> Set up 2-step sign-in</button></div>
            </>
          )}
        </div>
      </div>

      <Dialog
        open={!!ask}
        onClose={() => setAsk(null)}
        width={420}
        title={ask === "off" ? "Turn off 2-step sign-in" : "Make new recovery codes"}
        subtitle={ask === "off" ? "Signing in will need only your password." : "The old codes stop working."}
        footer={<><button className="btn" onClick={() => setAsk(null)}>Cancel</button><button className={cx("btn", ask === "off" ? "btn-danger" : "btn-primary")} disabled={code.length < 6 || disable.isLoading || renew.isLoading} onClick={runAsk}>{disable.isLoading || renew.isLoading ? <Spinner /> : ask === "off" ? "Turn off" : "Make new codes"}</button></>}
      >
        <div className="stack" style={{ gap: 10 }}>
          <label className="label">A code from your authenticator app</label>
          <CodeInput value={code} onChange={setCode} autoFocus />
          {err && <div className="notice bad small">{err}</div>}
        </div>
      </Dialog>
    </div>
  );
}

// ─── Email (SMTP) ────────────────────────────────────────────────────────────

type EmailForm = { host: string; port: number; security: "tls" | "starttls" | "none"; user: string; password: string; from: string; panelUrl: string; teamName: string };

export function EmailSettings() {
  const utils = trpc.useContext();
  const q = trpc.notify.email.useQuery(undefined, { retry: false });
  const [f, setF] = useState<EmailForm | null>(null);
  const [testTo, setTestTo] = useState("");
  const save = trpc.notify.saveEmail.useMutation({ onSuccess: () => { toast.success("Email settings saved"); utils.notify.email.invalidate(); setF((x) => (x ? { ...x, password: "" } : x)); }, onError: (e) => toast.error(errMsg(e)) });
  const test = trpc.notify.testEmail.useMutation({ onSuccess: (o: any) => toast.success(`Test email sent to ${o.sentTo}`), onError: (e) => toast.error(errMsg(e)) });
  const d = q.data as any;
  useEffect(() => {
    if (d && !f) setF({ host: d.host, port: d.port, security: d.security, user: d.user, password: "", from: d.from, panelUrl: d.panelUrl || window.location.origin, teamName: d.teamName });
  }, [d, f]);

  if (q.error) return <div className="notice">Only the owner and admins can change email settings.</div>;
  if (!f) return <Skeleton h={300} />;
  const set = (patch: Partial<EmailForm>) => setF({ ...f, ...patch });
  const submit = () => save.mutate({ host: f.host, port: Number(f.port) || 587, security: f.security, user: f.user, from: f.from, panelUrl: f.panelUrl, teamName: f.teamName, ...(f.password ? { password: f.password } : {}) });

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className={cx("notice", d.configured ? "ok" : "")}>
        {d.configured ? <CheckCircle2 size={16} className="ok-text" /> : <Mail size={16} />}
        <div className="grow">
          <div className="strong">{d.configured ? "Email is set up" : "Email is not set up"}</div>
          <div className="muted small">{d.configured ? "Invitations and alerts are emailed from this server." : "Invitations still work: copy the link and send it yourself. Alerts can go to a webhook instead."}</div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><Mail size={15} /><h3>SMTP server</h3></div>
        <form className="card-body stack" style={{ gap: 14 }} onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <div className="grid g3" style={{ gap: 12 }}>
            <div style={{ gridColumn: "span 2" }}>
              <label className="label" htmlFor="smtp-host">Host</label>
              <input id="smtp-host" className="input mono" placeholder="smtp.example.com" value={f.host} onChange={(e) => set({ host: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="smtp-port">Port</label>
              <input id="smtp-port" className="input mono" inputMode="numeric" value={f.port} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, "")) || ("" as any) })} />
            </div>
          </div>
          <div>
            <span className="label">Encryption</span>
            <div className="seg">
              {([["starttls", "STARTTLS (587)"], ["tls", "TLS (465)"], ["none", "None"]] as const).map(([v, l]) => (
                <button key={v} type="button" className={cx(f.security === v && "on")} onClick={() => set({ security: v, port: v === "tls" ? 465 : v === "starttls" && f.port === 465 ? 587 : f.port })}>{l}</button>
              ))}
            </div>
            {f.security === "none" && <div className="hint warn-text">Without encryption the password and every email cross the network readable. Use it only for a mail server on this machine.</div>}
          </div>
          <div className="grid g2" style={{ gap: 12 }}>
            <div>
              <label className="label" htmlFor="smtp-user">Username</label>
              <input id="smtp-user" className="input" autoComplete="off" value={f.user} onChange={(e) => set({ user: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="smtp-pass">Password</label>
              <input id="smtp-pass" className="input" type="password" autoComplete="new-password" placeholder={d.passwordSet ? "Saved. Leave empty to keep it." : ""} value={f.password} onChange={(e) => set({ password: e.target.value })} />
              <div className="hint"><KeyRound size={11} style={{ verticalAlign: -1 }} /> Stored encrypted on this server. It is never shown again.</div>
            </div>
          </div>
          <div className="grid g2" style={{ gap: 12 }}>
            <div>
              <label className="label" htmlFor="smtp-from">From address</label>
              <input id="smtp-from" className="input" placeholder="no-reply@example.com" value={f.from} onChange={(e) => set({ from: e.target.value })} />
              <div className="hint">Shown as &ldquo;Deploy King &lt;address&gt;&rdquo;. Your mail provider must allow it.</div>
            </div>
            <div>
              <label className="label" htmlFor="smtp-team">Team name in emails</label>
              <input id="smtp-team" className="input" placeholder="Acme" value={f.teamName} onChange={(e) => set({ teamName: e.target.value })} />
              <div className="hint">&ldquo;You are invited to join Acme&rdquo;. Optional.</div>
            </div>
          </div>
          <div>
            <label className="label" htmlFor="smtp-url">Panel address</label>
            <input id="smtp-url" className="input mono" placeholder="https://panel.example.com" value={f.panelUrl} onChange={(e) => set({ panelUrl: e.target.value })} />
            <div className="hint">Links in invitations and alerts start with this. It must be the address people open the panel at.</div>
          </div>
          <div className="row"><span className="grow" /><button type="submit" className="btn btn-primary" disabled={save.isLoading || !f.host || !f.from}>{save.isLoading ? <Spinner /> : "Save"}</button></div>
        </form>
      </div>
      <div className="card">
        <div className="card-head"><Send size={15} /><h3>Send test email</h3></div>
        <div className="card-body row wrap" style={{ gap: 8 }}>
          <input className="input" style={{ maxWidth: 320 }} placeholder="To you, or type another address" value={testTo} onChange={(e) => setTestTo(e.target.value)} aria-label="Send the test to" />
          <button className="btn" disabled={!d.configured || test.isLoading} onClick={() => test.mutate(testTo.trim() ? { to: testTo.trim() } : {})}>{test.isLoading ? <Spinner /> : <><Send size={13} /> Send test email</>}</button>
          {!d.configured && <span className="small faint">Save the SMTP server first.</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Alerts ──────────────────────────────────────────────────────────────────

type Events = { jobFailed: { on: boolean; after: number }; workerCrash: { on: boolean }; deployFailed: { on: boolean }; hostUrgent: { on: boolean } };
type AlertForm = { email: { on: boolean; admins: boolean; to: string }; webhook: { on: boolean }; webhookUrl: string; events: Events };

const KIND_LABEL: Record<string, string> = { job_failed: "Scheduled job", worker_crash: "Crashing", deploy_failed: "Deploy", host_urgent: "Server watch", test: "Test" };

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <span className="switch">
      <input type="checkbox" aria-label={label} checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </span>
  );
}

export function AlertSettings({ onGoEmail }: { onGoEmail: () => void }) {
  const utils = trpc.useContext();
  const q = trpc.notify.alerts.useQuery(undefined, { retry: false });
  const [f, setF] = useState<AlertForm | null>(null);
  const save = trpc.notify.saveAlerts.useMutation({ onSuccess: () => { toast.success("Alerts saved"); setF((x) => (x ? { ...x, webhookUrl: "" } : x)); utils.notify.alerts.invalidate(); }, onError: (e) => toast.error(errMsg(e)) });
  const test = trpc.notify.testAlert.useMutation({
    onSuccess: (r: any) => {
      const parts = Object.entries(r).map(([k, v]) => `${k}: ${v}`);
      (Object.values(r).every((v) => v === "sent") ? toast.success : toast.error)(`Test alert. ${parts.join(" · ")}`);
      utils.notify.alerts.invalidate();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const d = q.data as any;
  useEffect(() => {
    if (d && !f) setF({ email: { on: d.email.on, admins: d.email.admins, to: d.email.to.join(", ") }, webhook: { on: d.webhook.on }, webhookUrl: "", events: d.events });
  }, [d, f]);

  if (q.error) return <div className="notice">Only the owner and admins can change alerts.</div>;
  if (!f) return <Skeleton h={300} />;
  const to = f.email.to.split(/[\s,;]+/).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const toOk = to.every((t) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(t));
  const ev = (k: keyof Events, patch: any) => setF({ ...f, events: { ...f.events, [k]: { ...f.events[k], ...patch } } });
  const submit = () => save.mutate({ email: { on: f.email.on, admins: f.email.admins, to }, webhook: { on: f.webhook.on }, events: f.events, ...(f.webhookUrl.trim() ? { webhookUrl: f.webhookUrl.trim() } : {}) });
  const noChannel = !f.email.on && !(f.webhook.on && (d.webhook.urlSet || f.webhookUrl.trim()));

  return (
    <div className="stack" style={{ gap: 14 }}>
      <div className="card">
        <div className="card-head"><Bell size={15} /><h3>Where alerts go</h3></div>
        <div className="card-body">
          <label className="rule-row">
            <Mail size={16} className="muted" />
            <span className="grow"><span style={{ fontWeight: 550 }}>Email</span><span className="small muted" style={{ display: "block" }}>{d.emailReady ? "Sent with the SMTP server from the Email tab." : "Email is not set up yet."}</span></span>
            <Switch label="Email alerts" checked={f.email.on} onChange={(v) => setF({ ...f, email: { ...f.email, on: v } })} />
          </label>
          {f.email.on && (
            <div className="stack" style={{ gap: 10, padding: "4px 0 12px 32px" }}>
              {!d.emailReady && <div className="notice warn small"><AlertTriangle size={14} className="warn-text" /><span>Email is not set up, so nothing can be emailed. <button type="button" className="link" onClick={onGoEmail}>Set up email</button></span></div>}
              <label className="check small"><input type="checkbox" checked={f.email.admins} onChange={(e) => setF({ ...f, email: { ...f.email, admins: e.target.checked } })} /><span>Send to the owner and every admin</span></label>
              <div>
                <label className="label" htmlFor="al-to">Also send to</label>
                <input id="al-to" className="input" placeholder="oncall@example.com, ops@example.com" value={f.email.to} onChange={(e) => setF({ ...f, email: { ...f.email, to: e.target.value } })} />
                {!toOk && <div className="hint bad-text">One of these is not an email address.</div>}
              </div>
            </div>
          )}
          <label className="rule-row">
            <Webhook size={16} className="muted" />
            <span className="grow"><span style={{ fontWeight: 550 }}>Webhook</span><span className="small muted" style={{ display: "block" }}>Slack and Discord incoming webhooks work as they are. Other services get JSON with text, title, kind and link.</span></span>
            <Switch label="Webhook alerts" checked={f.webhook.on} onChange={(v) => setF({ ...f, webhook: { on: v } })} />
          </label>
          {f.webhook.on && (
            <div style={{ padding: "4px 0 12px 32px" }}>
              <label className="label" htmlFor="al-hook">Webhook address</label>
              <input id="al-hook" className="input mono" type="password" autoComplete="off" placeholder={d.webhook.urlSet ? `Saved: ${d.webhook.urlHint} Leave empty to keep it.` : "https://hooks.slack.com/services/…"} value={f.webhookUrl} onChange={(e) => setF({ ...f, webhookUrl: e.target.value })} />
              <div className="hint"><KeyRound size={11} style={{ verticalAlign: -1 }} /> The address works like a password, so it is stored encrypted and not shown again.</div>
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head"><AlertTriangle size={15} /><h3>When to alert</h3></div>
        <div className="card-body">
          <label className="rule-row">
            <span className="grow">
              <span style={{ fontWeight: 550 }}>A scheduled job fails{" "}
                <input className="input mono" style={{ width: 54, height: 26, display: "inline-block", padding: "0 6px", margin: "0 4px" }} inputMode="numeric" aria-label="Failures in a row" value={f.events.jobFailed.after} onChange={(e) => ev("jobFailed", { after: Math.max(1, Math.min(50, Number(e.target.value.replace(/\D/g, "")) || 1)) })} onClick={(e) => e.preventDefault()} />
                times in a row</span>
              <span className="small muted" style={{ display: "block" }}>Only jobs with &ldquo;Tell me when it fails&rdquo; switched on.</span>
            </span>
            <Switch label="Scheduled job failures" checked={f.events.jobFailed.on} onChange={(v) => ev("jobFailed", { on: v })} />
          </label>
          <label className="rule-row">
            <span className="grow"><span style={{ fontWeight: 550 }}>An app or one of its workers keeps crashing</span><span className="small muted" style={{ display: "block" }}>It restarts again and again, for example out of memory.</span></span>
            <Switch label="Crashing" checked={f.events.workerCrash.on} onChange={(v) => ev("workerCrash", { on: v })} />
          </label>
          <label className="rule-row">
            <span className="grow"><span style={{ fontWeight: 550 }}>A deploy fails</span><span className="small muted" style={{ display: "block" }}>The version that was live before keeps running.</span></span>
            <Switch label="Deploy failures" checked={f.events.deployFailed.on} onChange={(v) => ev("deployFailed", { on: v })} />
          </label>
          <label className="rule-row">
            <span className="grow"><span style={{ fontWeight: 550 }}>The server watch finds something urgent</span><span className="small muted" style={{ display: "block" }}>A new admin user, a key, a program from a temporary folder and the like, on the Security page.</span></span>
            <Switch label="Urgent server findings" checked={f.events.hostUrgent.on} onChange={(v) => ev("hostUrgent", { on: v })} />
          </label>
          <div className="small faint" style={{ marginTop: 8 }}>The same alert is sent at most once an hour. Repeats in between are counted and listed below.</div>
        </div>
      </div>

      <div className="row" style={{ gap: 8 }}>
        {noChannel && <span className="small warn-text">Switch on email or a webhook, or no alert is sent.</span>}
        <span className="grow" />
        <button className="btn" disabled={test.isLoading} onClick={() => test.mutate()}>{test.isLoading ? <Spinner /> : <><Send size={13} /> Send test alert</>}</button>
        <button className="btn btn-primary" disabled={save.isLoading || !toOk} onClick={submit}>{save.isLoading ? <Spinner /> : "Save"}</button>
      </div>

      <div className="card">
        <div className="card-head"><h3>Recent alerts</h3></div>
        {!d.recent?.length ? <div className="card-body small muted">No alerts yet.</div> : (
          <div className="list">
            {d.recent.map((a: any) => (
              <div key={a.kind + a.itemKey} className="row" style={{ padding: "10px 18px", gap: 10 }}>
                <span className="badge square">{KIND_LABEL[a.kind] ?? a.kind}</span>
                <span className="grow ellipsis small">{a.title}</span>
                {a.suppressed > 0 && <span className="small faint">{a.suppressed} repeat{a.suppressed === 1 ? "" : "s"} held back</span>}
                <span className="small muted">{Object.entries(a.result ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ") || "…"}</span>
                <span className="small faint" style={{ width: 90, textAlign: "right" }}>{timeAgo(a.lastSentAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── GitHub App card on the GitHub tab ───────────────────────────────────────

export function GitHubAppCard() {
  const q = trpc.git.app.useQuery(undefined, { retry: false });
  const d = q.data as any;
  if (q.error) return null;
  return (
    <div className="card">
      <div className="card-head"><Github size={15} /><h3>GitHub App</h3>{d?.app && <span className="right badge ok">Created</span>}</div>
      <div className="card-body row wrap" style={{ gap: 14 }}>
        <div className="grow" style={{ minWidth: 240 }}>
          <div className="small muted">
            {d?.app
              ? `${d.app.name} is installed on ${d.installations.length} account${d.installations.length === 1 ? "" : "s"}. Push events come to this server without a webhook per repository.`
              : "Recommended. Install the Deploy King app on GitHub and choose which repositories it can see. Push events arrive without a webhook per repository."}
          </div>
        </div>
        <Link href="/settings/github" className="btn btn-primary btn-sm"><Github size={13} /> {d?.app ? "Manage the GitHub App" : "Install the GitHub App"}</Link>
      </div>
    </div>
  );
}
