"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, HardDrive, Rocket, Search } from "lucide-react";
import { toast } from "sonner";
import { trpc } from "@/utils/trpc";
import { useCrumbs } from "@/components/shell/Shell";
import { Dialog, PageHeader, Spinner, Tile, cx, errMsg } from "@/components/ui";
import { EnvEditor, generateSecret, type EnvRow } from "@/components/EnvEditor";
import { TEMPLATES, type Template } from "@/components/templates";
import { appUrl } from "@/components/apps";

export default function TemplatesPage() {
  useCrumbs([{ label: "Templates" }]);
  const router = useRouter();
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("All");
  const [open, setOpen] = useState<Template | null>(null);
  const [name, setName] = useState("");
  const [env, setEnv] = useState<EnvRow[]>([]);
  const info = trpc.system.info.useQuery(undefined, { staleTime: 5 * 60_000 });
  const create = trpc.sites.create.useMutation();
  const sites = trpc.sites.list.useQuery(undefined, { staleTime: 15_000 });

  const cats = ["All", ...Array.from(new Set(TEMPLATES.map((t) => t.category)))];
  const shown = useMemo(
    () => TEMPLATES.filter((t) => (cat === "All" || t.category === cat) && (!q || `${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase()))),
    [q, cat]
  );
  const baseDomain = info.data?.baseDomain ?? "localhost";
  const domain = `${name}.${baseDomain}`;
  const taken = (sites.data ?? []).some((s: any) => s.domain === domain);

  const pick = (t: Template) => {
    let n = t.id;
    let i = 2;
    const used = new Set((sites.data ?? []).map((s: any) => s.domain));
    while (used.has(`${n}.${baseDomain}`)) n = `${t.id}-${i++}`;
    setName(n);
    const url = appUrl(`${n}.${baseDomain}`, info.data);
    const vars = [...t.env, ...(info.data && !info.data.tls ? t.noTlsEnv ?? [] : [])];
    setEnv(vars.map((v) => ({ key: v.key, value: v.secret ? generateSecret("hex") : v.appUrl ? url : v.value ?? "", hint: v.label, generator: v.secret ? "hex" : undefined })));
    setOpen(t);
  };

  const deploy = () => {
    if (!open) return;
    create.mutate(
      {
        domain,
        runtime: "image",
        source: "image",
        image: open.image,
        port: open.port,
        volumes: open.volumes,
        memoryLimit: open.memoryMb,
        env: env.filter((e) => e.key && e.value !== "").map((e) => ({ key: e.key, value: e.value })),
      } as any,
      {
        onSuccess: (site: any) => {
          toast.success(`${open.name} is deploying`);
          router.push(`/apps/${site.id}`);
        },
        onError: (e) => toast.error(errMsg(e)),
      }
    );
  };

  return (
    <div className="page">
      <PageHeader title="Templates" description="Ready-to-run apps. Pick one, check the settings, and it is live in about a minute with its data kept on a volume." />
      <div className="row wrap" style={{ marginBottom: 16 }}>
        <div className="input-group" style={{ maxWidth: 320, flex: 1 }}>
          <span className="addon"><Search size={14} /></span>
          <input className="input" placeholder="Search templates" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="seg" style={{ flexWrap: "wrap" }}>
          {cats.map((c) => <button key={c} className={cat === c ? "on" : ""} onClick={() => setCat(c)}>{c}</button>)}
        </div>
      </div>
      <div className="grid g3">
        {shown.map((t) => (
          <button key={t.id} className="card card-pad hoverable" style={{ textAlign: "left", display: "flex", flexDirection: "column", gap: 12 }} onClick={() => pick(t)}>
            <div className="row">
              <Tile name={t.name} color={t.color} size={38} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="strong">{t.name}</div>
                <div className="faint small">{t.category}</div>
              </div>
            </div>
            <div className="muted small" style={{ flex: 1 }}>{t.description}</div>
            <div className="row faint tiny" style={{ gap: 12 }}>
              <span className="mono ellipsis" style={{ maxWidth: 200 }}>{t.image}</span>
              {t.volumes.length > 0 && <span className="row" style={{ gap: 4 }}><HardDrive size={11} /> keeps data</span>}
            </div>
          </button>
        ))}
      </div>

      <Dialog
        open={!!open}
        onClose={() => setOpen(null)}
        width={620}
        title={open ? <span className="row" style={{ gap: 10 }}><Tile name={open.name} color={open.color} size={28} /> Deploy {open.name}</span> : ""}
        subtitle={open?.description}
        footer={
          <>
            {open && <a className="btn btn-ghost" href={open.docs} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Docs</a>}
            <span className="grow" />
            <button className="btn" onClick={() => setOpen(null)}>Cancel</button>
            <button className="btn btn-primary" disabled={!name || taken || create.isLoading} onClick={deploy}>
              {create.isLoading ? <Spinner /> : <><Rocket size={14} /> Deploy</>}
            </button>
          </>
        }
      >
        {open && (
          <div className="stack" style={{ gap: 16 }}>
            <div>
              <label className="label">Name</label>
              <div className="input-group">
                <input className="input" value={name} onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} />
                <span className="addon mono" style={{ fontSize: 12.5 }}>.{baseDomain}</span>
              </div>
              {taken && <div className="hint bad-text">Another app already uses this address.</div>}
            </div>
            <dl className="kv">
              <dt>Image</dt><dd className="mono small">{open.image}</dd>
              <dt>Port</dt><dd>{open.port}</dd>
              <dt>Memory</dt><dd>{open.memoryMb ? `${open.memoryMb >= 1024 ? `${open.memoryMb / 1024} GB` : `${open.memoryMb} MB`}` : "512 MB"} <span className="faint small">· change later in the app's settings</span></dd>
              <dt>Volumes</dt>
              <dd>{open.volumes.length ? open.volumes.map((v) => <div key={v.name} className="mono small">{v.name} → {v.mountPath}</div>) : <span className="faint">None, nothing is stored</span>}</dd>
            </dl>
            <div>
              <div className="label">Environment variables</div>
              {env.length === 0 && <div className="faint small" style={{ marginBottom: 8 }}>This template needs none.</div>}
              <EnvEditor rows={env} onChange={setEnv} />
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
