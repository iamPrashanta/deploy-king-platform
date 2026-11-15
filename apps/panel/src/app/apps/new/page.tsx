"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Check, Github, GitBranch, Globe, LayoutTemplate, Lock, Package, RefreshCw, Rocket, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Empty, PageHeader, Skeleton, Spinner, cx, errMsg, timeAgo } from "@/components/ui";
import { EnvEditor, generateSecret, type EnvRow } from "@/components/EnvEditor";
import { ChecksList, Collapsible, FactsGrid, FileList, Question, VerdictBanner, type Report } from "@/components/ProjectReport";
import { appUrl } from "@/components/apps";

type SourceKind = "github" | "url" | "image";
type Step = "source" | "check" | "configure";

const BUILD_AS = [
  { v: "auto", l: "Detect automatically" },
  { v: "node", l: "Node.js" },
  { v: "static", l: "Static files" },
  { v: "python", l: "Python" },
  { v: "php", l: "PHP" },
  { v: "go", l: "Go" },
  { v: "docker", l: "Dockerfile in the repo" },
];

const slug = (s: string) => s.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";

function Steps({ step, skipCheck }: { step: Step; skipCheck: boolean }) {
  const all: Array<[Step, string]> = skipCheck ? [["source", "Source"], ["configure", "Configure"]] : [["source", "Source"], ["check", "Check"], ["configure", "Configure"]];
  const idx = all.findIndex(([s]) => s === step);
  return (
    <div className="steps">
      {all.map(([s, l], i) => (
        <div key={s} className="row" style={{ gap: 8 }}>
          {i > 0 && <span className="bar" />}
          <span className={cx("st", i === idx && "on", i < idx && "done")}>
            <span className="n">{i < idx ? <Check size={12} /> : i + 1}</span>
            {l}
          </span>
        </div>
      ))}
      <span className="bar" />
      <span className="st"><span className="n">{all.length + 1}</span>Deploy</span>
    </div>
  );
}

export default function NewAppPage() {
  useCrumbs([{ label: "Applications", href: "/apps" }, { label: "New app" }]);
  const router = useRouter();
  const info = trpc.system.info.useQuery(undefined, { staleTime: 5 * 60_000 });
  const providers = trpc.git.providers.useQuery(undefined, { staleTime: 60_000 });

  const [step, setStep] = useState<Step>("source");
  const [kind, setKind] = useState<SourceKind>("github");
  const [providerId, setProviderId] = useState<string | null>(null);
  const [repoQuery, setRepoQuery] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoName, setRepoName] = useState("");
  const [branch, setBranch] = useState("");
  const [image, setImage] = useState("");
  const [buildAs, setBuildAs] = useState("auto");
  const [checkPort, setCheckPort] = useState<string>("");

  // configure
  const [name, setName] = useState("");
  const [customDomain, setCustomDomain] = useState("");
  const [useCustom, setUseCustom] = useState(false);
  const [port, setPort] = useState<string>("");
  const [buildCommand, setBuildCommand] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [env, setEnv] = useState<EnvRow[]>([]);
  const [autoDeploy, setAutoDeploy] = useState(true);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!providerId && providers.data?.length) setProviderId(providers.data[0].id);
    if (providers.data && providers.data.length === 0 && kind === "github") setKind("url");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.data]);

  const repos = trpc.git.repos.useQuery({ providerId: providerId! }, { enabled: kind === "github" && !!providerId, staleTime: 60_000 });
  const urlValid = /^https:\/\/\S+\/\S+/.test(repoUrl) || /^git@\S+:\S+/.test(repoUrl);
  const branches = trpc.git.branches.useQuery(
    { repoUrl, providerId: kind === "github" ? providerId : null },
    { enabled: (kind === "github" || kind === "url") && urlValid, staleTime: 60_000, retry: false }
  );
  useEffect(() => {
    if (branches.data && (!branch || !branches.data.branches.includes(branch))) setBranch(branches.data.defaultBranch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branches.data]);

  const inspect = trpc.git.inspect.useMutation();
  const report: Report | null = (inspect.data?.report as Report) ?? null;
  const create = trpc.sites.create.useMutation();

  const filteredRepos = useMemo(() => {
    const needle = repoQuery.trim().toLowerCase();
    return (repos.data ?? []).filter((r) => !needle || r.fullName.toLowerCase().includes(needle)).slice(0, 50);
  }, [repos.data, repoQuery]);

  const baseDomain = info.data?.baseDomain ?? "localhost";
  const domain = useCustom ? customDomain.trim().toLowerCase() : `${slug(name)}.${baseDomain}`;
  const url = appUrl(domain, info.data);

  const runCheck = () => {
    setStep("check");
    inspect.mutate(
      {
        repoUrl,
        branch,
        providerId: kind === "github" ? providerId : null,
        type: buildAs as any,
        port: checkPort ? Number(checkPort) : null,
      },
      {
        onSuccess: (res: any) => {
          const r: Report = res.report;
          const a: Record<string, string> = {};
          for (const q of r.questions) a[q.id] = q.default;
          setAnswers(a);
          setName(slug(res.name));
        },
      }
    );
  };

  // Build the Configure step from what the check found.
  const toConfigure = () => {
    if (kind === "image") {
      setName((n) => n || slug(image.split("/").pop()!.split(":")[0]));
    } else if (report) {
      const portQ = report.questions.find((q) => q.id === "port");
      setPort(checkPort || (portQ && answers.port === "yes" ? portQ.suggested ?? "" : ""));
      const needFor = new Set(
        report.questions.filter((q) => q.id.startsWith("service:") && answers[q.id] === "existing").map((q) => (q.detail?.match(/should (\w+) point/)?.[1] ?? ""))
      );
      const rows: EnvRow[] = report.env
        .filter((e) => !e.platform)
        .map((e) => ({
          key: e.key,
          value: e.appUrl ? url : e.canGenerate ? generateSecret(e.generator) : e.value,
          hint: e.example && e.placeholder ? `e.g. ${e.example}` : undefined,
          generator: e.canGenerate ? e.generator ?? "hex" : undefined,
          required: (e.placeholder && !e.canGenerate) || needFor.has(e.key),
        }));
      for (const k of needFor) if (k && !rows.some((r) => r.key === k)) rows.push({ key: k, value: "", required: true });
      setEnv(rows);
    }
    setStep("configure");
  };

  // Keep "app URL" variables in step with the chosen domain.
  const [lastUrl, setLastUrl] = useState(url);
  useEffect(() => {
    if (url === lastUrl) return;
    setEnv((rows) => rows.map((r) => (r.value === lastUrl ? { ...r, value: url } : r)));
    setLastUrl(url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const missing = env.filter((r) => r.required && !r.value.trim()).length;

  const deploy = () => {
    create.mutate(
      {
        domain,
        runtime: (kind === "image" ? "image" : buildAs) as any,
        source: kind === "image" ? "image" : "git",
        repoUrl: kind === "image" ? undefined : repoUrl,
        branch: kind === "image" ? undefined : branch,
        gitProviderId: kind === "github" && providerId ? providerId : undefined,
        image: kind === "image" ? image.trim() : undefined,
        port: port ? Number(port) : undefined,
        buildCommand: buildCommand.trim() || undefined,
        startCommand: startCommand.trim() || undefined,
        env: env.filter((r) => r.key && r.value !== "").map((r) => ({ key: r.key, value: r.value })),
        autoDeploy,
      } as any,
      {
        onSuccess: (site: any) => {
          toast.success("Deploy started");
          router.push(`/apps/${site.id}`);
        },
        onError: (e) => toast.error(errMsg(e)),
      }
    );
  };

  return (
    <div className="page" style={{ maxWidth: 980 }}>
      <PageHeader title="New application" description="Pick the source. Deploy King checks the project before building it, and asks only what it can't work out itself." />
      <Steps step={step} skipCheck={kind === "image"} />

      {/* ── 1. Source ─────────────────────────────────────────────── */}
      {step === "source" && (
        <div className="stack" style={{ gap: 16 }}>
          <div className="grid g4">
            {[
              { k: "github" as const, icon: <Github size={17} />, t: "GitHub", d: "Your connected repositories" },
              { k: "url" as const, icon: <Globe size={17} />, t: "Public Git URL", d: "Any public repository" },
              { k: "image" as const, icon: <Package size={17} />, t: "Docker image", d: "From Docker Hub or a registry" },
            ].map((o) => (
              <button key={o.k} className={cx("option", kind === o.k && "on")} onClick={() => setKind(o.k)}>
                <span className="oi">{o.icon}</span>
                <span><span className="strong">{o.t}</span><br /><span className="muted small">{o.d}</span></span>
              </button>
            ))}
            <Link href="/templates" className="option">
              <span className="oi"><LayoutTemplate size={17} /></span>
              <span><span className="strong">Template</span><br /><span className="muted small">n8n, Uptime Kuma, Gitea…</span></span>
            </Link>
          </div>

          {kind === "github" && (
            <div className="card">
              {providers.isLoading ? (
                <div className="card-body"><Skeleton h={40} /></div>
              ) : !providers.data?.length ? (
                <Empty icon={<Github size={18} />} title="GitHub is not connected" action={<Link className="btn btn-primary" href="/settings?tab=github"><Github size={15} /> Connect GitHub</Link>}>
                  Connect your GitHub account and choose which repositories Deploy King may use. Public repositories also work with “Public Git URL”.
                </Empty>
              ) : (
                <>
                  <div className="card-head">
                    <Github size={16} />
                    {providers.data.length > 1 ? (
                      <select className="select" style={{ width: 240 }} value={providerId ?? ""} onChange={(e) => setProviderId(e.target.value)}>
                        {providers.data.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    ) : (
                      <h3>{providers.data[0].login ?? providers.data[0].name}</h3>
                    )}
                    <div className="right input-group" style={{ width: 280 }}>
                      <span className="addon"><Search size={13} /></span>
                      <input className="input" placeholder="Search repositories" value={repoQuery} onChange={(e) => setRepoQuery(e.target.value)} />
                    </div>
                  </div>
                  <div style={{ maxHeight: 380, overflowY: "auto" }}>
                    {repos.isLoading ? (
                      <div className="card-body stack">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={36} />)}</div>
                    ) : repos.error ? (
                      <div className="card-body"><div className="notice bad">{repos.error.message}</div></div>
                    ) : filteredRepos.length === 0 ? (
                      <div className="empty small">No repository matches. If one is missing, give Deploy King access to it on GitHub.</div>
                    ) : (
                      <div className="list">
                        {filteredRepos.map((r) => (
                          <button
                            key={r.fullName}
                            className="row"
                            style={{ width: "100%", padding: "11px 18px", textAlign: "left", background: repoUrl === r.cloneUrl ? "var(--active)" : undefined }}
                            onClick={() => {
                              setRepoUrl(r.cloneUrl);
                              setRepoName(r.fullName);
                              setBranch(r.defaultBranch);
                            }}
                          >
                            <div className="grow" style={{ minWidth: 0 }}>
                              <div className="row" style={{ gap: 6 }}>
                                <span className="strong ellipsis">{r.fullName}</span>
                                {r.private && <Lock size={12} className="faint" />}
                              </div>
                              {r.description && <div className="faint small ellipsis">{r.description}</div>}
                            </div>
                            {r.language && <span className="faint small desktop-only">{r.language}</span>}
                            <span className="faint small desktop-only" style={{ width: 70, textAlign: "right" }}>{timeAgo(r.pushedAt)}</span>
                            {repoUrl === r.cloneUrl && <Check size={16} />}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          )}

          {kind === "url" && (
            <div className="card card-pad">
              <label className="label">Repository URL</label>
              <input className="input mono" placeholder="https://github.com/owner/repo.git" value={repoUrl} onChange={(e) => { setRepoUrl(e.target.value.trim()); setRepoName(e.target.value.trim().replace(/^https:\/\/[^/]+\//, "").replace(/\.git$/, "")); }} autoFocus />
              <div className="hint">Public repositories only. For private ones, connect GitHub in Settings.</div>
            </div>
          )}

          {kind === "image" && (
            <div className="card card-pad grid g2">
              <div>
                <label className="label">Image</label>
                <input className="input mono" placeholder="nginx:alpine or ghcr.io/owner/app:1.2" value={image} onChange={(e) => setImage(e.target.value.trim())} autoFocus />
                <div className="hint">Pulled on every deploy, so a moving tag like :latest picks up new versions.</div>
              </div>
              <div>
                <label className="label">Port the app listens on</label>
                <input className="input" inputMode="numeric" placeholder="From the image's EXPOSE" value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
              </div>
            </div>
          )}

          {(kind === "github" || kind === "url") && urlValid && (
            <div className="card card-pad">
              <div className="row wrap" style={{ gap: 16, alignItems: "flex-end" }}>
                <div style={{ minWidth: 220 }}>
                  <label className="label">Branch</label>
                  {branches.isLoading ? (
                    <Skeleton h={36} w={220} />
                  ) : branches.error ? (
                    <div className="notice bad small">{branches.error.message}</div>
                  ) : (
                    <select className="select" value={branch} onChange={(e) => setBranch(e.target.value)}>
                      {(branches.data?.branches ?? []).map((b) => <option key={b} value={b}>{b}</option>)}
                    </select>
                  )}
                </div>
                <div style={{ minWidth: 200 }}>
                  <label className="label">Build as</label>
                  <select className="select" value={buildAs} onChange={(e) => setBuildAs(e.target.value)}>
                    {BUILD_AS.map((b) => <option key={b.v} value={b.v}>{b.l}</option>)}
                  </select>
                </div>
                <div className="grow" />
                <button className="btn btn-primary btn-lg" disabled={!branch || !!branches.error} onClick={runCheck}>
                  Check project <ArrowRight size={15} />
                </button>
              </div>
              <div className="hint" style={{ marginTop: 10 }}>
                <GitBranch size={12} style={{ verticalAlign: -2 }} /> {repoName || repoUrl}. The check clones the branch, finds the framework, runtime, port, database and variables, and tells you if anything blocks a deploy. Nothing is built yet.
              </div>
            </div>
          )}

          {kind === "image" && (
            <div className="row">
              <div className="grow" />
              <button className="btn btn-primary btn-lg" disabled={!/^[a-z0-9][a-z0-9._/-]*(:[\w.-]+)?$/.test(image)} onClick={toConfigure}>
                Continue <ArrowRight size={15} />
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── 2. Check ──────────────────────────────────────────────── */}
      {step === "check" && (
        <div className="stack" style={{ gap: 16 }}>
          {inspect.isLoading && (
            <div className="card card-pad">
              <div className="row"><Spinner /> <span className="strong">Checking {repoName || repoUrl} @ {branch}</span></div>
              <div className="muted small" style={{ marginTop: 8, marginLeft: 26 }}>Cloning the branch, then reading package files, lockfiles, Dockerfiles and example environment files.</div>
              <div className="stack" style={{ marginTop: 16 }}>{[0, 1, 2].map((i) => <Skeleton key={i} h={44} />)}</div>
            </div>
          )}
          {inspect.error && (
            <div className="notice bad">
              <div className="grow">
                <div className="strong">The check could not run</div>
                <div>{inspect.error.message}</div>
              </div>
              <button className="btn btn-sm" onClick={() => setStep("source")}>Back</button>
            </div>
          )}
          {report && inspect.data && !inspect.isLoading && (
            <>
              <VerdictBanner report={report} />
              <div className="muted small row wrap" style={{ gap: 14 }}>
                <span><GitBranch size={12} style={{ verticalAlign: -2 }} /> {repoName} @ {inspect.data.branch}</span>
                {inspect.data.commit.sha && <span className="mono">{inspect.data.commit.sha.slice(0, 7)}</span>}
                {inspect.data.commit.message && <span className="ellipsis" style={{ maxWidth: 420 }}>{inspect.data.commit.message}</span>}
                {inspect.data.commit.date && <span>{timeAgo(inspect.data.commit.date)}</span>}
              </div>

              <h2 className="section" style={{ marginTop: 8 }}>What we found</h2>
              <FactsGrid facts={report.facts} />

              {report.questions.length > 0 && (
                <>
                  <h2 className="section">Before deploying</h2>
                  <div className="stack" style={{ gap: 10 }}>
                    {report.questions.map((q) => <Question key={q.id} q={q} value={answers[q.id] ?? q.default} onChange={(v) => setAnswers((a) => ({ ...a, [q.id]: v }))} />)}
                  </div>
                </>
              )}

              <h2 className="section">Checks</h2>
              <div className="card card-pad" style={{ paddingTop: 6, paddingBottom: 6 }}>
                <ChecksList checks={report.checks} />
              </div>

              {report.plan && (
                <Collapsible title={report.plan.usesRepoDockerfile ? "Your Dockerfile" : "Dockerfile we will build with"} right={<span className="faint small">port {report.plan.port}</span>}>
                  <pre className="code" style={{ maxHeight: 360 }}>{report.plan.dockerfile}</pre>
                </Collapsible>
              )}
              <Collapsible title="Files in the repository root" right={<span className="faint small">{inspect.data.files.length}</span>}>
                <FileList files={inspect.data.files} />
              </Collapsible>

              <div className="card card-pad">
                <div className="row wrap" style={{ alignItems: "flex-end", gap: 12 }}>
                  <div style={{ minWidth: 200 }}>
                    <label className="label">Build as</label>
                    <select className="select" value={buildAs} onChange={(e) => setBuildAs(e.target.value)}>
                      {BUILD_AS.map((b) => <option key={b.v} value={b.v}>{b.l}</option>)}
                    </select>
                  </div>
                  <div style={{ width: 140 }}>
                    <label className="label">Port</label>
                    <input className="input" inputMode="numeric" placeholder={String(report.port ?? "")} value={checkPort} onChange={(e) => setCheckPort(e.target.value.replace(/\D/g, ""))} />
                  </div>
                  <button className="btn" onClick={runCheck}><RefreshCw size={14} /> Check again</button>
                  <span className="faint small">Change these if the check guessed wrong.</span>
                </div>
              </div>

              <div className="row">
                <button className="btn" onClick={() => setStep("source")}><ArrowLeft size={15} /> Back</button>
                <div className="grow" />
                {report.verdict === "not-deployable" ? (
                  report.plan ? (
                    <button className="btn" onClick={toConfigure}>Continue anyway <ArrowRight size={15} /></button>
                  ) : null
                ) : (
                  <button className="btn btn-primary btn-lg" onClick={toConfigure}>Continue <ArrowRight size={15} /></button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── 3. Configure ──────────────────────────────────────────── */}
      {step === "configure" && (
        <div className="side-layout">
          <div className="stack" style={{ gap: 16 }}>
            <div className="card">
              <div className="card-head"><h3>Name and address</h3></div>
              <div className="card-body">
                {!useCustom ? (
                  <div className="field">
                    <label className="label">Name</label>
                    <div className="input-group">
                      <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
                      <span className="addon mono" style={{ fontSize: 12.5 }}>.{baseDomain}</span>
                    </div>
                  </div>
                ) : (
                  <div className="field">
                    <label className="label">Domain</label>
                    <input className="input" placeholder="app.example.com" value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} />
                    <div className="hint">Point an A record for this domain at this server. HTTPS is issued automatically when TLS is on.</div>
                  </div>
                )}
                <label className="check small">
                  <input type="checkbox" checked={useCustom} onChange={(e) => setUseCustom(e.target.checked)} />
                  <span>Use my own domain</span>
                </label>
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                <h3>Environment variables</h3>
                <span className="right faint small">{missing ? <span className="warn-text">{missing} required without a value</span> : `${env.length} variables`}</span>
              </div>
              <div className="card-body">
                {kind !== "image" && report?.env.length ? (
                  <div className="faint small" style={{ marginBottom: 12 }}>Filled in from {report.env[0].source}. Secrets were generated for you; PORT and HOST are set by Deploy King.</div>
                ) : null}
                <EnvEditor rows={env} onChange={setEnv} />
              </div>
            </div>

            <Collapsible title="Build and run settings">
              <div className="grid g2">
                {kind !== "image" && (
                  <>
                    <div className="field">
                      <label className="label">Build command</label>
                      <input className="input mono" placeholder="Detected automatically" value={buildCommand} onChange={(e) => setBuildCommand(e.target.value)} />
                    </div>
                    <div className="field">
                      <label className="label">Start command</label>
                      <input className="input mono" placeholder="Detected automatically" value={startCommand} onChange={(e) => setStartCommand(e.target.value)} />
                    </div>
                  </>
                )}
                <div className="field">
                  <label className="label">Port</label>
                  <input className="input" inputMode="numeric" placeholder={String(report?.port ?? "auto")} value={port} onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))} />
                  <div className="hint">Only if the app ignores $PORT.</div>
                </div>
              </div>
              {kind !== "image" && (
                <label className="check small">
                  <input type="checkbox" checked={autoDeploy} onChange={(e) => setAutoDeploy(e.target.checked)} />
                  <span>Redeploy automatically on every push to <span className="mono">{branch}</span></span>
                </label>
              )}
            </Collapsible>
          </div>

          <div className="card" style={{ position: "sticky", top: 16 }}>
            <div className="card-head"><Rocket size={15} /><h3>Ready to deploy</h3></div>
            <div className="card-body">
              <dl className="kv" style={{ gridTemplateColumns: "84px minmax(0,1fr)" }}>
                <dt>Source</dt><dd className="ellipsis">{kind === "image" ? image : repoName}</dd>
                {kind !== "image" && (<><dt>Branch</dt><dd>{branch}</dd></>)}
                {report?.framework && kind !== "image" && (<><dt>Framework</dt><dd>{report.framework}</dd></>)}
                <dt>URL</dt><dd className="mono small">{url}</dd>
              </dl>
              {missing > 0 && <div className="notice warn small" style={{ marginTop: 14 }}>{missing} required variable{missing === 1 ? " has" : "s have"} no value. You can deploy anyway and add {missing === 1 ? "it" : "them"} later.</div>}
              <div className="faint small" style={{ marginTop: 14 }}>
                The build log streams live. If something comes up mid-deploy (a different port, another Node.js version), the deploy pauses and asks you here.
              </div>
              <button className="btn btn-primary btn-lg btn-block" style={{ marginTop: 16 }} disabled={create.isLoading || !domain || (useCustom ? !customDomain : !name)} onClick={deploy}>
                {create.isLoading ? <Spinner /> : <><Rocket size={15} /> Deploy</>}
              </button>
              <button className="btn btn-ghost btn-block" style={{ marginTop: 6 }} onClick={() => setStep(kind === "image" ? "source" : "check")}>
                <ArrowLeft size={15} /> Back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
