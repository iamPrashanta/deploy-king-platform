"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertTriangle, ArrowRight, Check, ExternalLink, Github, KeyRound, Plus, RefreshCw, Trash2, Webhook, X } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Dialog, Empty, PageHeader, Skeleton, Spinner, cx, errMsg } from "@/components/ui";

/**
 * Connect GitHub: create this panel's GitHub App (one click on GitHub, from a manifest), install it on accounts
 * and organizations with the repositories chosen there, then deploy. GitHub sends the admin back here after each step.
 */

const CAN = [
  { ok: true, text: "Read code and metadata of the repositories you chose" },
  { ok: true, text: "Receive push and pull request events" },
  { ok: false, text: "Cannot push code, change settings or see other repositories" },
];

function Installation({ i }: { i: any }) {
  const repos = trpc.git.appRepos.useQuery({ installationId: i.installationId }, { retry: false, staleTime: 60_000 });
  const list = (repos.data as any[]) ?? [];
  return (
    <div style={{ padding: "16px 20px", borderTop: "1px solid var(--border)" }} className="stack">
      <div className="row wrap" style={{ gap: 12 }}>
        <span className="avatar" style={{ borderRadius: 8 }}>{i.account.slice(0, 2).toUpperCase()}</span>
        <span className="grow" style={{ minWidth: 0 }}>
          <span style={{ fontWeight: 600 }}>{i.account} <span className="muted" style={{ fontWeight: 400 }}>· {i.accountType === "Organization" ? "organization" : "personal"}</span></span>
          <span className="small muted" style={{ display: "block" }}>
            {i.repositorySelection === "all" ? "All repositories" : "Only select repositories"}
            {repos.data ? ` · ${list.length}` : ""}
            {i.suspended && <span className="warn-text"> · suspended on GitHub</span>}
          </span>
        </span>
        <a className="link small" href={i.settingsUrl} target="_blank" rel="noreferrer">Change repositories on GitHub <ExternalLink size={11} style={{ verticalAlign: -1 }} /></a>
      </div>
      {repos.isLoading ? <Skeleton h={22} w={280} /> : repos.error ? <div className="small bad-text">{errMsg(repos.error)}</div> : (
        <div className="row wrap" style={{ gap: 6 }}>
          {list.slice(0, 6).map((r) => <span key={r.fullName} className="badge square mono">{r.name}</span>)}
          {list.length > 6 && <span className="badge square">+{list.length - 6} more</span>}
          {list.length === 0 && <span className="small faint">No repositories chosen yet.</span>}
        </div>
      )}
    </div>
  );
}

function GitConnect() {
  useCrumbs([{ label: "Settings", href: "/settings" }, { label: "Connect GitHub" }]);
  const router = useRouter();
  const params = useSearchParams();
  const utils = trpc.useContext();
  const q = trpc.git.app.useQuery(undefined, { retry: false });
  const [where, setWhere] = useState<"me" | "org">("me");
  const [org, setOrg] = useState("");
  const [removing, setRemoving] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  const [post, setPost] = useState<{ url: string; manifest: string } | null>(null);
  const handled = useRef(false);

  const refresh = () => { utils.git.app.invalidate(); utils.git.appRepos.invalidate(); utils.git.providers.invalidate(); };
  const manifest = trpc.git.appManifest.useMutation({ onSuccess: (m: any) => setPost({ url: m.postUrl, manifest: m.manifest }), onError: (e) => toast.error(errMsg(e)) });
  const complete = trpc.git.appComplete.useMutation();
  const sync = trpc.git.appSync.useMutation({ onSuccess: (o: any) => { toast.success(`${o.installations} installation${o.installations === 1 ? "" : "s"}${o.removed ? `, ${o.removed} removed` : ""}`); refresh(); }, onError: (e) => toast.error(errMsg(e)) });
  const remove = trpc.git.appRemove.useMutation({ onSuccess: (o: any) => { toast.success("The GitHub App was removed here. Delete it on GitHub too."); setRemoving(false); refresh(); if (o.htmlUrl) window.open(o.htmlUrl.replace("/apps/", "/settings/apps/"), "_blank"); }, onError: (e) => toast.error(errMsg(e)) });

  // Submit the manifest to GitHub as soon as the panel has it.
  useEffect(() => { if (post) formRef.current?.submit(); }, [post]);

  // GitHub sends the admin back with ?code&state (the app was created) or ?installation_id (it was installed or changed).
  useEffect(() => {
    if (handled.current) return;
    const code = params.get("code");
    const state = params.get("state");
    const installed = params.get("installation_id");
    if (code && state) {
      handled.current = true;
      complete.mutateAsync({ code, state }).then(
        (o: any) => { toast.success(`${o.name} was created. Now install it.`); refresh(); },
        (e) => toast.error(errMsg(e))
      ).finally(() => router.replace("/settings/github"));
    } else if (installed) {
      handled.current = true;
      sync.mutateAsync().catch(() => {}).finally(() => router.replace("/settings/github"));
    }
  }, [params]); // eslint-disable-line react-hooks/exhaustive-deps

  if (q.error) return <div className="page"><Empty icon={<Github size={20} />} title="The GitHub App is managed by the owner and admins">You can still connect your own account with a token in Settings › GitHub.</Empty></div>;
  const d = q.data as any;
  const app = d?.app;
  const installs: any[] = d?.installations ?? [];
  const local = typeof window !== "undefined" && /^(localhost|127\.|10\.|192\.168\.)/.test(window.location.hostname);

  return (
    <div className="page">
      <PageHeader title="Connect GitHub" description="Install the Deploy King app on GitHub and decide which repositories it can see. Change it any time on GitHub." />
      {post && (
        <form ref={formRef} action={post.url} method="post" style={{ display: "none" }}>
          <input type="hidden" name="manifest" value={post.manifest} />
        </form>
      )}
      {q.isLoading ? <Skeleton h={300} /> : (
        <div className="side-layout">
          <div className="stack" style={{ gap: 16 }}>
            <section className="card card-pad row top" style={{ gap: 16 }}>
              <span className={cx("step-num")} style={app ? { background: "color-mix(in srgb, var(--green) 14%, transparent)", color: "var(--green)", borderColor: "transparent" } : undefined}>{app ? <Check size={13} /> : "1"}</span>
              <div className="grow stack" style={{ gap: 8 }}>
                <h3 style={{ fontSize: 15 }}>1 · Create the GitHub App</h3>
                <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>One click on GitHub creates &ldquo;{app?.name ?? `Deploy King (${typeof window !== "undefined" ? window.location.hostname : "this panel"})`}&rdquo; with read access to code, and push and pull request events. Its keys are stored encrypted here.</p>
                {app ? (
                  <div className="row wrap" style={{ gap: 12 }}>
                    <span className="small muted mono">Created {new Date(app.createdAt).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · app id {app.appId}{app.owner ? ` · owner ${app.owner}` : ""}</span>
                    <a className="link small" href={app.htmlUrl} target="_blank" rel="noreferrer">Open on GitHub <ExternalLink size={11} style={{ verticalAlign: -1 }} /></a>
                  </div>
                ) : (
                  <div className="stack" style={{ gap: 10, marginTop: 4 }}>
                    <div className="seg">
                      <button type="button" className={cx(where === "me" && "on")} onClick={() => setWhere("me")}>My GitHub account</button>
                      <button type="button" className={cx(where === "org" && "on")} onClick={() => setWhere("org")}>An organization</button>
                    </div>
                    {where === "org" && <input className="input mono" style={{ maxWidth: 280 }} placeholder="organization name" value={org} onChange={(e) => setOrg(e.target.value.trim())} aria-label="Organization" />}
                    {local && <div className="notice warn small"><AlertTriangle size={14} className="warn-text" /><span>This panel is open at a local address. GitHub cannot reach it, so pushes will not deploy until the panel has a public address. Listing and cloning repositories still works.</span></div>}
                    <div>
                      <button className="btn btn-primary" disabled={manifest.isLoading || !!post || (where === "org" && !/^[A-Za-z0-9-]{1,39}$/.test(org))} onClick={() => manifest.mutate({ origin: window.location.origin, ...(where === "org" ? { organization: org } : {}) })}>
                        {manifest.isLoading || post ? <Spinner /> : <><Github size={14} /> Create the GitHub App</>}
                      </button>
                    </div>
                    {complete.isLoading && <div className="small muted"><Spinner size={12} /> Saving the app&apos;s keys…</div>}
                  </div>
                )}
              </div>
            </section>

            <section className="card">
              <div className="card-pad row top" style={{ gap: 16 }}>
                <span className="step-num">2</span>
                <div className="grow stack" style={{ gap: 8 }}>
                  <h3 style={{ fontSize: 15 }}>2 · Install it and choose repositories</h3>
                  <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>On GitHub you pick <strong style={{ color: "var(--text)" }}>All repositories</strong> or <strong style={{ color: "var(--text)" }}>Only select repositories</strong>. Deploy King only ever sees what you chose.</p>
                </div>
                <div className="row" style={{ gap: 8 }}>
                  {app && <button className="btn btn-sm btn-ghost" disabled={sync.isLoading} onClick={() => sync.mutate()} title="Read the installations from GitHub again"><RefreshCw size={13} className={sync.isLoading ? "spin" : ""} /> Refresh</button>}
                  {app ? <a className="btn btn-primary btn-sm" href={d.installUrl}><Plus size={13} /> Add installation</a> : <button className="btn btn-sm" disabled><Plus size={13} /> Add installation</button>}
                </div>
              </div>
              {app && installs.length === 0 && <div className="small muted" style={{ padding: "14px 20px", borderTop: "1px solid var(--border)" }}>Not installed anywhere yet.</div>}
              {installs.map((i) => <Installation key={i.installationId} i={i} />)}
            </section>

            <section className="card card-pad row top" style={{ gap: 16 }}>
              <span className="step-num">3</span>
              <div className="grow stack" style={{ gap: 8 }}>
                <h3 style={{ fontSize: 15 }}>3 · Deploy</h3>
                <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>Pick a repository in New application. We check it first and tell you whether it can be deployed before anything is built.</p>
                <div><Link href="/apps/new" className="link small">Start a new application <ArrowRight size={12} style={{ verticalAlign: -2 }} /></Link></div>
              </div>
            </section>

            {app && (
              <section className="notice bad">
                <Trash2 size={16} className="bad-text" />
                <div className="grow">
                  <strong>Remove the GitHub App</strong>
                  <div className="small muted" style={{ marginTop: 4 }}>Its keys and installations are forgotten here. Apps that use it keep their repository but cannot pull private code until GitHub is connected again.</div>
                </div>
                <button className="btn btn-danger btn-sm" onClick={() => { setRemoving(true); setConfirmText(""); }}>Remove</button>
              </section>
            )}
          </div>

          <div className="stack" style={{ gap: 16 }}>
            <section className="card card-pad stack" style={{ gap: 10 }}>
              <h3 style={{ fontSize: 14 }}>What the app can do</h3>
              {CAN.map((c) => (
                <div key={c.text} className="row top small" style={{ gap: 8 }}>
                  {c.ok ? <Check size={14} className="ok-text" /> : <X size={14} className="muted" />}
                  <span className={c.ok ? "" : "muted"}>{c.text}</span>
                </div>
              ))}
            </section>
            <section className="card card-pad stack" style={{ gap: 8 }}>
              <h3 style={{ fontSize: 14 }}><Webhook size={14} style={{ verticalAlign: -2 }} /> Push to deploy</h3>
              <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>The app sends push events to this server, so there is no webhook to add per repository. GitHub must be able to reach this panel&apos;s public URL.</p>
            </section>
            <section className="card card-pad stack" style={{ gap: 8 }}>
              <h3 style={{ fontSize: 14 }}><KeyRound size={14} style={{ verticalAlign: -2 }} /> Prefer a token?</h3>
              <p className="small muted" style={{ margin: 0, lineHeight: 1.6 }}>A fine-grained personal access token also works and can be limited to chosen repositories. Push events then need a webhook per repository.</p>
              <div><Link href="/settings?tab=github" className="btn btn-sm">Use a token instead</Link></div>
            </section>
          </div>
        </div>
      )}

      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        width={460}
        title="Remove the GitHub App"
        subtitle="Then delete it on GitHub as well; its page opens when you remove it here."
        footer={<><button className="btn" onClick={() => setRemoving(false)}>Cancel</button><button className="btn btn-danger" disabled={confirmText !== "remove" || remove.isLoading} onClick={() => remove.mutate({ confirm: "remove" })}>{remove.isLoading ? <Spinner /> : "Remove"}</button></>}
      >
        <label className="label" htmlFor="gh-rm">Type <span className="mono">remove</span> to confirm</label>
        <input id="gh-rm" className="input" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoFocus />
      </Dialog>
    </div>
  );
}

export default function GitConnectPage() {
  return (
    <Suspense>
      <GitConnect />
    </Suspense>
  );
}
