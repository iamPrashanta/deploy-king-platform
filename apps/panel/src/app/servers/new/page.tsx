"use client";

import Link from "next/link";
import React, { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowRight, CheckCircle2, Download, Info, KeyRound, Lock, RefreshCw, Server, ShieldCheck, XCircle } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { useAuth } from "@/components/AuthProvider";
import { Code, CopyButton, Empty, Spinner, cx, errMsg } from "@/components/ui";
import { Rule, RulesEditor, TYPE_LABEL, WizardSteps, type Rules } from "@/components/servers/common";
import { TestResults } from "@/components/servers/Checks";

/**
 * Add server, in three steps: 1 Connection, 2 SSH key, 3 Verify (fingerprint, connection test, access rules).
 * The server is saved after step 1, so "Finish setup" on the Servers page comes back to the right step.
 */

const METHODS = [
  { v: "key", title: "SSH key", badge: { text: "Recommended", tone: "ok" }, text: "Deploy King creates a key pair in the next step. You add the public half to the server once. No password is typed or stored." },
  { v: "password-once", title: "Password once, then a key", text: "Type the user's password one time. Deploy King uses it to install a key, then forgets it." },
  { v: "password", title: "Password every time", badge: { text: "Least safe", tone: "warn" }, text: "The password is stored encrypted and used for every connection. Choose this only when the server does not allow keys." },
] as const;

const KEY_TYPES = [
  { v: "ed25519", title: "Ed25519", text: "Recommended. Small, fast and supported by every current server." },
  { v: "rsa4096", title: "RSA 4096", text: "For old servers that do not accept Ed25519." },
  { v: "ecdsa", title: "ECDSA P-256", text: "Only when a policy asks for it." },
] as const;

const onError = (e: unknown) => toast.error(errMsg(e));

function Saved({ rows }: { rows: Array<[string, string]> }) {
  return (
    <section className="card">
      <div className="card-head"><h3>What gets saved</h3></div>
      <div className="card-body">
        <dl className="kv" style={{ gridTemplateColumns: "130px minmax(0,1fr)" }}>
          {rows.map(([k, v]) => <React.Fragment key={k}><dt>{k}</dt><dd className="small">{v}</dd></React.Fragment>)}
        </dl>
      </div>
    </section>
  );
}

// ─── Step 1 ───────────────────────────────────────────────────────────────────
function StepConnection() {
  const router = useRouter();
  const settings = trpc.servers.settings.useQuery();
  const servers = trpc.servers.list.useQuery();
  const [f, setF] = useState({ name: "", host: "", port: 22, username: "deploy", authMethod: "key" as "key" | "password-once" | "password", timeoutSec: 10, jumpServerId: "" });
  const [advanced, setAdvanced] = useState(false);
  const create = trpc.servers.create.useMutation({ onSuccess: (s: any) => router.replace(`/servers/new?id=${s.id}&step=2`), onError });
  const addr = (settings.data as any)?.effectiveAddress;
  const pwOff = settings.data && !(settings.data as any).allowPasswordSignIn;
  const ok = f.name.trim() && f.host.trim() && f.username.trim() && f.port > 0;
  const jumps = ((servers.data as any)?.servers ?? []).filter((s: any) => s.setupDone);

  return (
    <div className="side-layout">
      <div className="stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-head"><h3>Server</h3></div>
          <div className="card-body">
            <div className="field">
              <label className="label" htmlFor="sv-name">Name</label>
              <input id="sv-name" className="input mono" placeholder="db-primary" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
              <div className="hint">Only used inside this panel.</div>
            </div>
            <div className="grid" style={{ gridTemplateColumns: "minmax(0,1fr) 110px", gap: 12 }}>
              <div className="field">
                <label className="label" htmlFor="sv-host">Host or IP address</label>
                <input id="sv-host" className="input mono" placeholder="203.0.113.24" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value.trim() })} />
              </div>
              <div className="field">
                <label className="label" htmlFor="sv-port">Port</label>
                <input id="sv-port" className="input mono" type="number" min={1} max={65535} value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />
              </div>
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label className="label" htmlFor="sv-user">User</label>
              <input id="sv-user" className="input mono" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.trim() })} />
              <div className="hint">A normal user is safer than root. It needs sudo only for installing packages.</div>
            </div>
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h3>How should Deploy King sign in?</h3></div>
          <div className="card-body stack" style={{ gap: 10 }}>
            {METHODS.map((m) => {
              const off = m.v === "password" && pwOff;
              return (
                <label key={m.v} className={cx("choice", f.authMethod === m.v && "on")} style={off ? { opacity: 0.55, cursor: "not-allowed" } : undefined}>
                  <input type="radio" name="method" disabled={!!off} checked={f.authMethod === m.v} onChange={() => setF({ ...f, authMethod: m.v })} />
                  <span>
                    <strong>{m.title} {"badge" in m && m.badge && <span className={cx("badge", m.badge.tone)} style={{ marginLeft: 6 }}>{m.badge.text}</span>}</strong>
                    <span className="small muted">{off ? "Turned off under SSH keys, Security defaults." : m.text}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <div><h3>Advanced</h3><div className="small muted">Connect through a jump server, or change the 10 second timeout.</div></div>
            <span className="right"><button className="btn btn-sm" onClick={() => setAdvanced(!advanced)}>{advanced ? "Hide" : "Show"}</button></span>
          </div>
          {advanced && (
            <div className="card-body grid g2" style={{ gap: 12 }}>
              <div>
                <label className="label" htmlFor="sv-jump">Jump server</label>
                <select id="sv-jump" className="input" value={f.jumpServerId} onChange={(e) => setF({ ...f, jumpServerId: e.target.value })}>
                  <option value="">None, connect directly</option>
                  {jumps.map((j: any) => <option key={j.id} value={j.id}>{j.name}</option>)}
                </select>
                <div className="hint">Its key must allow forwarding (no "No forwarding" limit).</div>
              </div>
              <div>
                <label className="label" htmlFor="sv-timeout">Timeout</label>
                <select id="sv-timeout" className="input" value={f.timeoutSec} onChange={(e) => setF({ ...f, timeoutSec: Number(e.target.value) })}>
                  {[5, 10, 20, 30, 60].map((s) => <option key={s} value={s}>{s} seconds</option>)}
                </select>
              </div>
            </div>
          )}
        </section>

        <div className="notice info small"><Info size={15} /> <span>The server must allow SSH from this panel's address{addr ? <>, <b className="mono">{addr}</b></> : ""}. Open that in its firewall first.</span></div>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <Saved rows={[["Address and user", "Plain"], ["Private key", "Encrypted, never shown"], ["Password", f.authMethod === "password" ? "Encrypted" : "Not stored"], ["Server fingerprint", "Saved after you confirm it"]]} />
        <button className="btn btn-primary btn-block" disabled={!ok || create.isLoading} onClick={() => create.mutate({ name: f.name.trim(), host: f.host, port: f.port, username: f.username, authMethod: f.authMethod, timeoutSec: f.timeoutSec, jumpServerId: f.jumpServerId || null })}>
          {create.isLoading ? <Spinner /> : "Continue"}
        </button>
        <Link href="/servers" className="btn btn-block">Cancel</Link>
      </div>
    </div>
  );
}

// ─── Step 2 ───────────────────────────────────────────────────────────────────
function StepKey({ s }: { s: any }) {
  const router = useRouter();
  const utils = trpc.useContext();
  const settings = trpc.servers.settings.useQuery();
  const keys = trpc.servers.keys.useQuery();
  const st = settings.data as any;
  const [type, setType] = useState<string>("ed25519");
  const [label, setLabel] = useState(`deploy-king@${s.name}`);
  const [passphrase, setPassphrase] = useState("");
  const [limits, setLimits] = useState({ lock: true, restrict: true, rotate: true });
  const [how, setHow] = useState<"command" | "install" | "hand">(s.authMethod === "password-once" ? "install" : "command");
  const [password, setPassword] = useState("");
  const [testPass, setTestPass] = useState("");
  const [picking, setPicking] = useState(false);
  const [testError, setTestError] = useState("");
  const started = useRef(false);
  const refresh = () => utils.servers.get.invalidate({ id: s.id });
  const prepare = trpc.servers.prepareKey.useMutation({ onSuccess: () => { refresh(); utils.servers.keys.invalidate(); }, onError });
  const useKey = trpc.servers.useKey.useMutation({ onSuccess: () => { setPicking(false); refresh(); }, onError });
  const install = trpc.servers.installKey.useMutation({ onSuccess: () => { setPassword(""); toast.success("Key installed. The password was not kept."); router.replace(`/servers/new?id=${s.id}&step=3`); }, onError });
  const setPw = trpc.servers.setPassword.useMutation({ onSuccess: () => router.replace(`/servers/new?id=${s.id}&step=3`), onError });
  const test = trpc.servers.test.useMutation({
    onSuccess: (r: any) => {
      const bad = r.checks.find((c: any) => c.state === "bad");
      if (bad) setTestError(`${bad.title}. ${bad.detail}`);
      else router.replace(`/servers/new?id=${s.id}&step=3`);
    },
    onError,
  });

  const gen = (t = type) => prepare.mutate({ serverId: s.id, type: t as any, label, passphrase: passphrase || undefined, lock: limits.lock, restrict: limits.restrict, rotateDays: limits.rotate ? st?.rotateDays ?? 90 : null });

  // Settings first: the default key type and limits come from Security defaults. Then make the pair once.
  useEffect(() => {
    if (!st || started.current) return;
    started.current = true;
    setType(st.keyType);
    setLimits((l) => ({ ...l, lock: st.lockToPanel }));
    if (!s.key && s.authMethod !== "password") prepare.mutate({ serverId: s.id, type: st.keyType, label, lock: st.lockToPanel, restrict: true, rotateDays: st.rotateDays ?? null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [st]);

  if (s.authMethod === "password") {
    return (
      <div className="side-layout">
        <section className="card">
          <div className="card-head"><h3>Password for {s.username}</h3><span className="badge warn right">Least safe</span></div>
          <div className="card-body stack" style={{ gap: 12 }}>
            <div className="small muted">The password is stored encrypted on this server and used for every connection. Switch to a key when the server allows it.</div>
            <input className="input" type="password" autoComplete="off" placeholder={`Password for ${s.username}`} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            <div className="row"><button className="btn btn-primary" disabled={!password || setPw.isLoading} onClick={() => setPw.mutate({ serverId: s.id, password })}>{setPw.isLoading ? <Spinner /> : "Save and continue"}</button></div>
          </div>
        </section>
        <Saved rows={[["Address and user", "Plain"], ["Password", "Encrypted, never shown"], ["Server fingerprint", "Saved after you confirm it"]]} />
      </div>
    );
  }

  const k = s.key;
  const inst = s.install;
  const download = () => {
    const url = URL.createObjectURL(new Blob([k.publicKey + "\n"], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${k.label}.pub`; a.click();
    URL.revokeObjectURL(url);
  };
  const others = ((keys.data as any[]) ?? []).filter((x) => x.id !== k?.id);

  return (
    <div className="side-layout">
      <div className="stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-head">
            <h3>Key pair for {s.name}</h3>
            <span className="right"><button className="link small" onClick={() => setPicking(!picking)}>{picking ? "Make a new key" : "Use a key I already have"}</button></span>
          </div>
          <div className="card-body stack" style={{ gap: 14 }}>
            {picking ? (
              others.length === 0 ? <div className="small muted">There are no other keys yet. Import one on the <Link href="/servers/keys">SSH keys</Link> page.</div> : (
                <div className="stack" style={{ gap: 8 }}>
                  {others.map((o: any) => (
                    <div key={o.id} className="row" style={{ gap: 10 }}>
                      <KeyRound size={15} className="faint" />
                      <div className="grow"><div className="mono small strong">{o.label}</div><div className="tiny faint mono">{o.typeLabel} · {o.fingerprint}</div></div>
                      <button className="btn btn-sm" disabled={useKey.isLoading} onClick={() => useKey.mutate({ serverId: s.id, keyId: o.id })}>Use this key</button>
                    </div>
                  ))}
                </div>
              )
            ) : (
              <>
                <div className="choice-grid">
                  {KEY_TYPES.map((t) => (
                    <label key={t.v} className={cx("choice", type === t.v && "on")}>
                      <input type="radio" name="ktype" checked={type === t.v} onChange={() => setType(t.v)} />
                      <span><strong>{t.title}</strong><span className="small muted">{t.text}</span></span>
                    </label>
                  ))}
                </div>
                <div className="grid g2" style={{ gap: 12 }}>
                  <div>
                    <label className="label" htmlFor="k-label">Label</label>
                    <input id="k-label" className="input mono" value={label} onChange={(e) => setLabel(e.target.value)} />
                    <div className="hint">Shown next to the key on the server.</div>
                  </div>
                  <div>
                    <label className="label" htmlFor="k-pass">Passphrase (optional)</label>
                    <input id="k-pass" className="input" type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
                    <div className="hint">You type it each time you open a terminal. Workflows cannot use a key that has one.</div>
                  </div>
                </div>
                <div className="row"><button className="btn" disabled={prepare.isLoading || (!!passphrase && passphrase.length < 8)} onClick={() => gen()}>{prepare.isLoading ? <Spinner /> : <RefreshCw size={14} />} {k ? "Generate again" : "Generate key"}</button>{passphrase && passphrase.length < 8 && <span className="small faint">A passphrase needs 8 characters or more.</span>}</div>
              </>
            )}

            {k && (
              <div className="stack" style={{ gap: 8, borderTop: "1px solid var(--border)", paddingTop: 14 }}>
                <div className="row"><CheckCircle2 size={15} className="ok-text" /><span className="strong">Key pair created</span></div>
                <div className="row" style={{ justifyContent: "space-between" }}>
                  <span className="label" style={{ margin: 0 }}>Public key</span>
                  <span className="row" style={{ gap: 6 }}><CopyButton text={k.publicKey} /><button className="btn btn-sm" onClick={download}><Download size={13} /> Download .pub</button></span>
                </div>
                <pre className="code mono small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{k.publicKey}</pre>
                <div className="small muted">Fingerprint <span className="mono">{k.fingerprint}</span>. This half is safe to share.</div>
              </div>
            )}
          </div>
        </section>

        {k && inst && (
          <section className="card">
            <div className="card-head"><h3>Put it on the server</h3></div>
            <div className="card-body stack" style={{ gap: 12 }}>
              <div className="seg" role="tablist">
                {([["command", "Run one command"], ["install", "Install it for me"], ["hand", "By hand"]] as const).map(([v, l]) => (
                  <button key={v} role="tab" aria-selected={how === v} className={cx(how === v && "on")} onClick={() => setHow(v)}>{l}</button>
                ))}
              </div>
              {how === "command" && (
                <>
                  <div className="small">Sign in to <span className="mono">{s.host}</span> as <span className="mono">{s.username}</span> the way you do today, and paste this:</div>
                  <Code>{inst.command}</Code>
                  {inst.lockPending && <div className="notice warn small"><AlertTriangle size={15} /> <span>This panel's address is not known yet, so this command does not lock the key to it. Use Install it for me (it learns the address), or set the address on the <Link href="/servers/keys">SSH keys</Link> page and generate again.</span></div>}
                </>
              )}
              {how === "hand" && (
                <>
                  <div className="small">Add this line to <span className="mono">~/.ssh/authorized_keys</span> of <span className="mono">{s.username}</span> on the server. The folder must be <span className="mono">700</span> and the file <span className="mono">600</span>.</div>
                  <Code label="authorized_keys">{inst.line}</Code>
                </>
              )}
              {(how === "install" || how === "command") && (
                <div className="stack" style={{ gap: 8 }}>
                  <div className="small muted">{how === "command" ? "Or install it for me with the password for " : "Type the password for "}<span className="mono">{s.username}</span>{how === "install" ? ". It is used once to add the key, then forgotten." : ""}</div>
                  <div className="row" style={{ gap: 8 }}>
                    <input id="k-install-pw" className="input" type="password" autoComplete="off" placeholder="Used once, not saved" aria-label={`Password for ${s.username}`} value={password} onChange={(e) => setPassword(e.target.value)} style={{ maxWidth: 320 }} />
                    <button className="btn" disabled={!password || install.isLoading} onClick={() => install.mutate({ serverId: s.id, password })}>{install.isLoading ? <Spinner /> : "Install key"}</button>
                  </div>
                </div>
              )}
            </div>
          </section>
        )}
        {testError && <div className="notice bad small"><XCircle size={15} /> <span>{testError}</span></div>}
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-head"><Lock size={14} /><h3>Private key</h3></div>
          <div className="card-body small muted">Stored encrypted on this server (AES-256-GCM). It is never shown and never leaves this server.</div>
        </section>
        <section className="card">
          <div className="card-head"><h3>Limit what this key can do</h3></div>
          <div className="card-body">
            <Rule title="Only from this panel" text={k?.fromAddress ? <>Adds <span className="mono">from="{k.fromAddress}"</span>, so the key is useless anywhere else.</> : "Adds from=\"this panel's address\", so the key is useless anywhere else."} checked={limits.lock} onChange={(v) => setLimits({ ...limits, lock: v })} />
            <Rule title="No forwarding" text="Blocks port, agent and X11 forwarding (restrict)." checked={limits.restrict} onChange={(v) => setLimits({ ...limits, restrict: v })} />
            <Rule title="Remind me to rotate" text={`After ${st?.rotateDays ?? 90} days the key is flagged on the SSH keys page.`} checked={limits.rotate} onChange={(v) => setLimits({ ...limits, rotate: v })} />
            {k && (limits.lock !== (k.fromAddress !== null) || limits.restrict !== k.restrict || limits.rotate !== (k.rotateAfterDays != null)) && (
              <div className="hint">Generate again to apply these limits to the key.</div>
            )}
          </div>
        </section>
        {k?.hasPassphrase && <input className="input" type="password" placeholder="The key's passphrase, to test it" value={testPass} onChange={(e) => setTestPass(e.target.value)} />}
        <button className="btn btn-primary btn-block" disabled={!k || test.isLoading} onClick={() => { setTestError(""); test.mutate({ id: s.id, passphrase: testPass || undefined }); }}>{test.isLoading ? <Spinner /> : <>I added the key. Test it <ArrowRight size={15} /></>}</button>
        <Link href={`/servers`} className="btn btn-block">Back</Link>
      </div>
    </div>
  );
}

// ─── Step 3 ───────────────────────────────────────────────────────────────────
const HOST_KEY_FILE: Record<string, string> = { ED25519: "ssh_host_ed25519_key.pub", ECDSA: "ssh_host_ecdsa_key.pub", RSA: "ssh_host_rsa_key.pub" };

function StepVerify({ s }: { s: any }) {
  const router = useRouter();
  const utils = trpc.useContext();
  const [fp, setFp] = useState<any>(s.hostKey ? { ...s.hostKey, trusted: true } : s.seenHostKey ? { ...s.seenHostKey, trusted: false } : null);
  const [result, setResult] = useState<any>(null);
  const [rules, setRules] = useState<Rules>(s.rules);
  const [passphrase, setPassphrase] = useState("");
  const probe = trpc.servers.probe.useMutation({ onSuccess: (r: any) => setFp(r), onError });
  const trust = trpc.servers.trust.useMutation({ onSuccess: () => { setFp({ ...fp, trusted: true }); utils.servers.get.invalidate({ id: s.id }); toast.success("Server trusted"); }, onError });
  const test = trpc.servers.test.useMutation({ onSuccess: (r) => setResult(r), onError });
  const finish = trpc.servers.finish.useMutation({ onSuccess: () => { toast.success(`${s.name} added`); router.push(`/servers/${s.id}`); }, onError });
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!fp) probe.mutate({ id: s.id });
    if (!s.key?.hasPassphrase) test.mutate({ id: s.id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const k = s.key;

  return (
    <div className="side-layout">
      <div className="stack" style={{ gap: 16 }}>
        <section className="card" style={fp && !fp.trusted ? { borderColor: "color-mix(in srgb, var(--amber) 45%, var(--border))", background: "color-mix(in srgb, var(--amber) 5%, var(--card))" } : undefined}>
          <div className="card-head">{fp?.trusted ? <ShieldCheck size={15} className="ok-text" /> : <AlertTriangle size={15} className="warn-text" />}<h3>Is this the right server?</h3>{fp?.trusted && <span className="badge ok right">Trusted</span>}</div>
          <div className="card-body stack" style={{ gap: 12 }}>
            {!fp ? <div className="row small muted"><Spinner /> Asking the server who it is…</div> : (
              <>
                <div className="small">{fp.trusted ? <>This is the fingerprint you trusted for <span className="mono">{s.host}</span>:</> : <>This is the first connection to <span className="mono">{s.host}</span>. It identified itself with this fingerprint:</>}</div>
                <div className="code mono" style={{ fontSize: 14 }}><span className="faint">{fp.type}</span>  {fp.fingerprint}</div>
                <div className="small muted">To be sure, run this on the server and compare: <code className="inline-code">ssh-keygen -lf /etc/ssh/{HOST_KEY_FILE[fp.type] ?? "ssh_host_ed25519_key.pub"}</code></div>
                {!fp.trusted && <div className="row"><button className="btn btn-primary" disabled={trust.isLoading} onClick={() => trust.mutate({ id: s.id, fingerprint: fp.fingerprint })}>{trust.isLoading ? <Spinner /> : "It matches. Trust this server"}</button></div>}
                <div className="small faint">If the fingerprint ever changes, Deploy King refuses to connect and tells you why.</div>
              </>
            )}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h3>Connection test</h3>
            <span className="right row" style={{ gap: 6 }}>
              {k?.hasPassphrase && <input className="input" style={{ width: 200, height: 30 }} type="password" placeholder="Key passphrase" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />}
              <button className="btn btn-sm" disabled={test.isLoading} onClick={() => test.mutate({ id: s.id, passphrase: passphrase || undefined })}>{test.isLoading ? <Spinner size={13} /> : <RefreshCw size={13} />} Run again</button>
            </span>
          </div>
          <TestResults result={result} loading={test.isLoading} />
        </section>

        <section className="card">
          <div className="card-head"><h3>Access rules for this server</h3></div>
          <div className="card-body"><RulesEditor value={rules} onChange={setRules} /></div>
        </section>
      </div>

      <div className="stack" style={{ gap: 16 }}>
        <section className="card">
          <div className="card-head"><h3>Summary</h3></div>
          <div className="card-body">
            <dl className="kv" style={{ gridTemplateColumns: "110px minmax(0,1fr)" }}>
              <dt>Name</dt><dd className="mono small">{s.name}</dd>
              <dt>Address</dt><dd className="mono small">{s.host}:{s.port}</dd>
              <dt>User</dt><dd className="mono small">{s.username}</dd>
              <dt>Sign-in</dt><dd className="small">{s.authMethod === "password" ? "Password, stored encrypted" : `SSH key · ${TYPE_LABEL[k?.type] ?? ""}`}</dd>
              {k && <><dt>Key limits</dt><dd className="small">{[k.fromAddress !== null ? "This panel only" : "From anywhere", k.restrict ? "no forwarding" : "forwarding allowed"].join(" · ")}</dd></>}
              <dt>Server identity</dt><dd className={cx("small", fp?.trusted ? "ok-text" : "warn-text")}>{fp?.trusted ? "Trusted" : "Waiting for you"}</dd>
            </dl>
          </div>
        </section>
        <button className="btn btn-primary btn-block" disabled={!fp?.trusted || finish.isLoading} onClick={() => finish.mutate({ id: s.id, rules })}>{finish.isLoading ? <Spinner /> : "Add server"}</button>
        <Link href={`/servers/new?id=${s.id}&step=2`} className="btn btn-block">Back</Link>
        <section className="card">
          <div className="card-head"><h3>If the test fails</h3></div>
          <div className="card-body stack small" style={{ gap: 8 }}>
            <div><b>Timed out:</b> the firewall blocks this panel{s.panelAddress ? <>, <span className="mono">{s.panelAddress}</span></> : ""}.</div>
            <div><b>Permission denied:</b> the key is not in authorized_keys for this user.</div>
            <div><b>Wrong fingerprint:</b> stop and check the address.</div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Wizard() {
  const params = useSearchParams();
  const id = params.get("id");
  const step = (Number(params.get("step")) || (id ? 2 : 1)) as 1 | 2 | 3;
  const server = trpc.servers.get.useQuery({ id: id ?? "" }, { enabled: !!id, retry: false });
  const s = server.data as any;
  useCrumbs([{ label: "Servers", href: "/servers" }, { label: s ? `Add server: ${s.name}` : "Add server" }]);
  const title = step === 1 ? "Add server: connection" : step === 2 ? "Add server: SSH key" : "Add server: verify";
  const { user } = useAuth();
  // The API refuses every step for non-admins; say so instead of showing a form that cannot be saved (as /servers does).
  if (user && user.role !== "admin") {
    return <div className="page"><Empty icon={<Server size={20} />} title="Servers are managed by admins">Ask an admin if you need a terminal on one of them.</Empty></div>;
  }
  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <div className="ph"><div className="grow"><h1>{title}</h1></div></div>
      <WizardSteps step={step} />
      {step === 1 || !id ? <StepConnection /> : server.error ? <div className="notice bad">{server.error.message}</div> : !s ? <Spinner /> : step === 2 ? <StepKey s={s} /> : <StepVerify s={s} />}
    </div>
  );
}

export default function AddServerPage() {
  return <Suspense><Wizard /></Suspense>;
}
