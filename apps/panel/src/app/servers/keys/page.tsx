"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, KeyRound, Plus, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Code, CopyButton, Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg } from "@/components/ui";
import { Rule, TYPE_LABEL, keyAgeNote } from "@/components/servers/common";

/**
 * SSH keys: every key with type, fingerprint, use and age; the security defaults; how rotation works;
 * and a warning about an old key. Private halves are never shown.
 */

const onError = (e: unknown) => toast.error(errMsg(e));
const ROTATE = [{ v: 90, l: "After 90 days" }, { v: 180, l: "After 180 days" }, { v: 365, l: "After 1 year" }, { v: 0, l: "Never" }];

function limitsText(k: any) {
  if (k.fromAddress === null && !k.restrict) return "No limits";
  return [k.fromAddress !== null ? "This panel only" : "From anywhere", k.restrict ? "no forwarding" : "forwarding allowed"].join(" · ");
}

function noteFor(k: any): { text: string; warn: boolean; action: "Rotate" | "Delete" | null } {
  if (k.usedBy.length === 0) return { text: "Safe to delete", warn: false, action: "Delete" };
  if (k.usedBy.some((u: any) => u.status === "waiting_key")) return { text: "Finish the server setup", warn: true, action: null };
  const a = keyAgeNote(k);
  return { text: a.warn ? "Rotate now" : a.note, warn: a.warn, action: "Rotate" };
}

function NewKeyDialog({ mode, onClose, defaults }: { mode: "generate" | "import"; onClose: () => void; defaults: any }) {
  const utils = trpc.useContext();
  const [type, setType] = useState(defaults?.keyType ?? "ed25519");
  const [label, setLabel] = useState("");
  const [priv, setPriv] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [lock, setLock] = useState(defaults?.lockToPanel ?? true);
  const [restrict, setRestrict] = useState(true);
  const [rotate, setRotate] = useState<number>(defaults?.rotateDays ?? 90);
  const [done, setDone] = useState<any>(null);
  const ok = (r: any) => { setDone(r); utils.servers.keys.invalidate(); };
  const gen = trpc.servers.generateKey.useMutation({ onSuccess: ok, onError });
  const imp = trpc.servers.importKey.useMutation({ onSuccess: ok, onError });
  const busy = gen.isLoading || imp.isLoading;
  const labelOk = /^[A-Za-z0-9@._+-]{1,100}$/.test(label);
  const submit = () => {
    const common = { label, lock, restrict, rotateDays: rotate || null };
    if (mode === "generate") gen.mutate({ ...common, type: type as any, passphrase: passphrase || undefined });
    else imp.mutate({ ...common, privateKey: priv, passphrase: passphrase || undefined });
  };
  return (
    <Dialog open onClose={onClose} width={620} title={done ? "Key ready" : mode === "generate" ? "Generate key" : "Import a key"}
      subtitle={done ? "The private half is stored encrypted on this server and is never shown." : mode === "import" ? "Paste the private key. Deploy King works out the public half and stores the private one encrypted." : "Deploy King creates the key pair. Only the public half is shown."}
      footer={done ? <button className="btn btn-primary" onClick={onClose}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !labelOk || (mode === "import" && priv.length < 64) || (mode === "generate" && !!passphrase && passphrase.length < 8)} onClick={submit}>{busy ? <Spinner /> : mode === "generate" ? "Generate key" : "Import key"}</button></>}>
      {done ? (
        <div className="stack" style={{ gap: 10 }}>
          <div className="row" style={{ justifyContent: "space-between" }}><span className="label" style={{ margin: 0 }}>Public key</span><CopyButton text={done.key.publicKey} /></div>
          <pre className="code mono small" style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{done.key.publicKey}</pre>
          <div className="small muted">Fingerprint <span className="mono">{done.key.fingerprint}</span></div>
          <div className="small">To put it on a server by hand, add this line to <span className="mono">~/.ssh/authorized_keys</span>:</div>
          <Code label="authorized_keys">{done.install.line}</Code>
        </div>
      ) : (
        <div className="stack" style={{ gap: 14 }}>
          {mode === "generate" && (
            <div className="choice-grid">
              {(["ed25519", "rsa4096", "ecdsa"] as const).map((t) => (
                <label key={t} className={cx("choice", type === t && "on")}>
                  <input type="radio" checked={type === t} onChange={() => setType(t)} />
                  <span><strong>{TYPE_LABEL[t]}</strong></span>
                </label>
              ))}
            </div>
          )}
          <div>
            <label className="label" htmlFor="nk-label">Label</label>
            <input id="nk-label" className="input mono" placeholder="deploy-king@staging-eu" value={label} onChange={(e) => setLabel(e.target.value)} autoFocus />
            <div className="hint">Shown next to the key on the server. Letters, digits and @ . _ + - only.</div>
          </div>
          {mode === "import" && (
            <div>
              <label className="label" htmlFor="nk-priv">Private key</label>
              <textarea id="nk-priv" className="textarea mono small" rows={7} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={priv} onChange={(e) => setPriv(e.target.value)} spellCheck={false} />
            </div>
          )}
          <div>
            <label className="label" htmlFor="nk-pass">Passphrase {mode === "import" ? "(if the key has one)" : "(optional)"}</label>
            <input id="nk-pass" className="input" type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} />
            <div className="hint">You type it each time you open a terminal. Workflows cannot use a key that has one.</div>
          </div>
          <div>
            <Rule title="Only from this panel" text={defaults?.effectiveAddress ? <>Adds <span className="mono">from="{defaults.effectiveAddress}"</span>.</> : "Adds from=\"…\" once this panel's address is known."} checked={lock} onChange={setLock} />
            <Rule title="No forwarding" text="Blocks port, agent and X11 forwarding (restrict)." checked={restrict} onChange={setRestrict} />
            <label className="rule-row">
              <span className="grow"><span style={{ fontWeight: 550 }}>Remind me to rotate</span><span className="small muted" style={{ display: "block" }}>Old keys are flagged here and on the Overview.</span></span>
              <select className="input" style={{ width: 150 }} value={rotate} onChange={(e) => setRotate(Number(e.target.value))}>{ROTATE.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select>
            </label>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function Defaults() {
  const utils = trpc.useContext();
  const q = trpc.servers.settings.useQuery();
  const [v, setV] = useState<any>(null);
  useEffect(() => { if (q.data && !v) setV({ ...(q.data as any), panelAddress: (q.data as any).panelAddress ?? "" }); }, [q.data, v]);
  const save = trpc.servers.saveSettings.useMutation({ onSuccess: () => { toast.success("Security defaults saved"); utils.servers.settings.invalidate(); }, onError });
  if (!v) return <section className="card"><div className="card-body"><Skeleton h={200} /></div></section>;
  const d = q.data as any;
  const put = (patch: any) => setV({ ...v, ...patch });
  const dirty = ["keyType", "rotateDays", "lockToPanel", "askPassword", "record", "allowPasswordSignIn"].some((k) => v[k] !== d[k]) || (v.panelAddress || null) !== (d.panelAddress ?? null);
  const effective = v.panelAddress || d.envAddress || d.seenAddress;
  return (
    <section className="card">
      <div className="card-head"><h3>Security defaults</h3></div>
      <div className="card-body">
        <label className="rule-row">
          <span className="grow"><span style={{ fontWeight: 550 }}>Key type for new keys</span><span className="small muted" style={{ display: "block" }}>Ed25519 unless a server cannot use it.</span></span>
          <select className="input" style={{ width: 150 }} value={v.keyType} onChange={(e) => put({ keyType: e.target.value })}>{(["ed25519", "rsa4096", "ecdsa"] as const).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}</select>
        </label>
        <label className="rule-row">
          <span className="grow"><span style={{ fontWeight: 550 }}>Remind me to rotate keys</span><span className="small muted" style={{ display: "block" }}>Old keys are flagged here and on the Overview.</span></span>
          <select className="input" style={{ width: 150 }} value={v.rotateDays ?? 0} onChange={(e) => put({ rotateDays: Number(e.target.value) || null })}>{ROTATE.map((r) => <option key={r.v} value={r.v}>{r.l}</option>)}</select>
        </label>
        <Rule title="Lock new keys to this panel's address" text={<>Adds <span className="mono">from="{effective || "…"}"</span> and restrict to every install command.</>} checked={v.lockToPanel} onChange={(x) => put({ lockToPanel: x })} />
        <label className="rule-row" style={{ cursor: "default" }}>
          <span className="grow"><span style={{ fontWeight: 550 }}>This panel's address</span><span className="small muted" style={{ display: "block" }}>{d.seenAddress ? <>Servers last saw this panel as <span className="mono">{d.seenAddress}</span>. Leave empty to use that.</> : "The address your servers see this panel connect from. Learned on the first connection when left empty."}</span></span>
          <input className="input mono" style={{ width: 190 }} placeholder={d.envAddress || d.seenAddress || "203.0.113.10"} value={v.panelAddress} onChange={(e) => put({ panelAddress: e.target.value.trim() })} />
        </label>
        <Rule title="Ask for my password before a terminal opens" text="Applies to every server unless a server says otherwise." checked={v.askPassword} onChange={(x) => put({ askPassword: x })} />
        <Rule title="Record terminal sessions" text="Kept for 30 days." checked={v.record} onChange={(x) => put({ record: x })} />
        <Rule title="Allow password sign-in to servers" text="Off means every new server must use a key." checked={v.allowPasswordSignIn} onChange={(x) => put({ allowPasswordSignIn: x })} />
        <Rule title="Refuse to connect when a server's fingerprint changes" text="Always on. It is the only protection against a fake server." checked disabled badge={<span className="badge ok" style={{ marginLeft: 8 }}>Always on</span>} />
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn btn-primary" disabled={!dirty || save.isLoading} onClick={() => save.mutate({ keyType: v.keyType, rotateDays: v.rotateDays ?? null, lockToPanel: v.lockToPanel, askPassword: v.askPassword, record: v.record, allowPasswordSignIn: v.allowPasswordSignIn, panelAddress: v.panelAddress || null })}>Save</button>
          <span className="small faint">New servers start with these. Each server's own access rules can differ.</span>
        </div>
      </div>
    </section>
  );
}

export default function SshKeysPage() {
  useCrumbs([{ label: "Servers", href: "/servers" }, { label: "SSH keys" }]);
  const utils = trpc.useContext();
  const keys = trpc.servers.keys.useQuery(undefined, { retry: false });
  const settings = trpc.servers.settings.useQuery(undefined, { retry: false });
  const [dialog, setDialog] = useState<"generate" | "import" | null>(null);
  const [deleting, setDeleting] = useState<any>(null);
  const rotate = trpc.servers.rotateKey.useMutation({ onSuccess: (r: any) => { (r.ok ? toast.success : toast.error)(r.message); utils.servers.keys.invalidate(); }, onError });
  const del = trpc.servers.deleteKey.useMutation({ onSuccess: () => { toast.success("Key deleted"); setDeleting(null); utils.servers.keys.invalidate(); }, onError });

  if (keys.error) return <div className="page"><Empty icon={<KeyRound size={20} />} title="SSH keys are managed by admins" /></div>;
  const list = (keys.data as any[]) ?? [];
  const stale = list.filter((k) => k.usedBy.length && k.rotateInDays != null && k.rotateInDays <= 0).sort((a, b) => b.ageDays - a.ageDays);
  const worst = stale.find((k) => k.fromAddress === null) ?? stale[0];

  return (
    <div className="page">
      <PageHeader
        title="SSH keys"
        description="The keys this panel uses to sign in to your servers. Private halves are stored encrypted and never shown. Public halves can be copied any time."
        actions={<>
          <button className="btn" onClick={() => setDialog("import")}><Upload size={15} /> Import a key</button>
          <button className="btn btn-primary" onClick={() => setDialog("generate")}><Plus size={15} /> Generate key</button>
        </>}
      />

      {worst && (
        <div className="notice warn" style={{ marginBottom: 16 }}>
          <AlertTriangle size={15} />
          <span className="grow"><span className="mono">{worst.label}</span> is {worst.ageDays} days old{worst.fromAddress === null ? " and is not locked to this panel" : ""}. Rotate it.</span>
          <button className="btn btn-sm" disabled={rotate.isLoading} onClick={() => rotate.mutate({ id: worst.id })}>{rotate.isLoading ? <Spinner size={13} /> : <RefreshCw size={13} />} Rotate</button>
        </div>
      )}

      <section className="card" style={{ marginBottom: 16 }}>
        {keys.isLoading ? <div className="card-body"><Skeleton h={140} /></div> : list.length === 0 ? (
          <div className="card-body small muted">No keys yet. Adding a server creates one, or generate or import one here.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="table" style={{ minWidth: 900 }}>
              <thead><tr><th>Key</th><th>Type</th><th>Fingerprint</th><th>Used by</th><th>Age</th><th><span className="sr-only">Actions</span></th></tr></thead>
              <tbody>
                {list.map((k) => {
                  const n = noteFor(k);
                  const pending = k.usedBy.find((u: any) => u.status === "waiting_key");
                  return (
                    <tr key={k.id}>
                      <td><div className="mono" style={{ fontWeight: 550 }}>{k.label}</div><div className="small muted">{limitsText(k)}{k.hasPassphrase ? " · passphrase" : ""}</div></td>
                      <td>{k.typeLabel}</td>
                      <td className="mono small" title={k.fingerprint}>{k.fingerprint.slice(0, 13)}…{k.fingerprint.slice(-4)}</td>
                      <td className={cx("small", pending ? "warn-text" : k.usedBy.length ? "" : "muted")}>
                        {k.usedBy.length ? k.usedBy.map((u: any, i: number) => <span key={u.id}>{i > 0 && ", "}<Link href={`/servers/${u.id}`}>{u.name}</Link>{u.status === "waiting_key" ? " · not installed" : ""}</span>) : "Not used"}
                      </td>
                      <td><div className="small">{k.ageDays === 0 ? "Created today" : `${k.ageDays} day${k.ageDays === 1 ? "" : "s"}`}</div><div className={cx("small", n.warn ? "warn-text" : "muted")}>{n.text}</div></td>
                      <td style={{ textAlign: "right", whiteSpace: "nowrap" }}>
                        <CopyButton text={k.publicKey} label="Copy .pub" className="btn-ghost" />{" "}
                        {pending ? <Link href={`/servers/new?id=${pending.id}&step=2`} className="btn btn-sm">Finish setup</Link>
                          : n.action === "Rotate" ? <button className="btn btn-sm" disabled={rotate.isLoading || k.hasPassphrase} title={k.hasPassphrase ? "A key with a passphrase cannot be rotated from here" : undefined} onClick={() => rotate.mutate({ id: k.id })}>Rotate</button>
                          : <button className="btn btn-sm" onClick={() => setDeleting(k)}><Trash2 size={12} /> Delete</button>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="side-layout">
        <Defaults />
        <section className="card">
          <div className="card-head"><RefreshCw size={14} /><h3>Rotating a key</h3></div>
          <div className="card-body">
            <ol className="stack small" style={{ gap: 10, listStyle: "none" }}>
              {["Deploy King creates a new key pair.", "It signs in with the old key and adds the new public key.", "It tests the new key, then removes the old one from the server.", "If the test fails, the old key stays and nothing changes."].map((t, i) => (
                <li key={t} className="row top" style={{ gap: 10 }}><span className="step-num" style={{ width: 22, height: 22, fontSize: 11 }}>{i + 1}</span><span>{t}</span></li>
              ))}
            </ol>
          </div>
        </section>
      </div>

      {dialog && <NewKeyDialog mode={dialog} defaults={settings.data} onClose={() => setDialog(null)} />}
      <Dialog open={!!deleting} onClose={() => setDeleting(null)} title={`Delete ${deleting?.label ?? ""}?`} subtitle="No server uses it. If you put it on a server by hand, remove it from that server's authorized_keys too."
        footer={<><button className="btn" onClick={() => setDeleting(null)}>Cancel</button><button className="btn btn-danger" disabled={del.isLoading} onClick={() => del.mutate({ id: deleting.id })}>Delete key</button></>}>
        <div className="mono small">{deleting?.fingerprint}</div>
      </Dialog>
    </div>
  );
}
