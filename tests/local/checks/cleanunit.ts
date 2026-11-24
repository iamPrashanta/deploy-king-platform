// the cleanup rules on fixed inputs (no server, no containers):  cd apps/api && npx tsx <this file>
async function main() {
  const { planCleanup, automaticKinds, dueRun } = await import(process.cwd() + "/src/services/cleanup");
  let failed = 0;
  const pass = (ok: unknown, label: string, extra = "") => { if (!ok) failed++; console.log((ok ? "PASS  " : "FAIL  ") + label + (extra ? "  | " + extra : "")); };

  const H = 60 * 60_000, D = 24 * H, now = 1_800_000_000_000, MBs = 1024 * 1024;
  const A = "aaaaaaaa-0000-4000-8000-000000000001", B = "bbbbbbbb-0000-4000-8000-000000000002", GONE = "cccccccc-0000-4000-8000-000000000003";
  const base = () => ({
    now,
    sites: [{ id: A, domain: "a.test", docRoot: "/var/www/sites/a.test" }, { id: B, domain: "b.test", docRoot: "/var/www/sites/b.test" }],
    keepTags: ["dbbkp-site-aaaaaaaa:d5", "dbbkp-site-aaaaaaaa:d4", "dbbkp-site-bbbbbbbb:d1"],
    images: [
      { id: "i5", tags: ["dbbkp-site-aaaaaaaa:d5"], size: 300 * MBs, createdMs: now - 2 * H },
      { id: "i4", tags: ["localhost/dbbkp-site-aaaaaaaa:d4"], size: 300 * MBs, createdMs: now - 2 * D },
      { id: "i1", tags: ["localhost/dbbkp-site-aaaaaaaa:d1"], size: 280 * MBs, createdMs: now - 9 * D },
      { id: "ib", tags: ["dbbkp-site-bbbbbbbb:d1"], size: 200 * MBs, createdMs: now - 3 * D },
      { id: "ig", tags: ["dbbkp-site-cccccccc:d7"], size: 150 * MBs, createdMs: now - 30 * D },
      { id: "inew", tags: ["dbbkp-site-aaaaaaaa:d6"], size: 310 * MBs, createdMs: now - 5 * 60_000 },
      { id: "ipg", tags: ["postgres:15-alpine"], size: 240 * MBs, createdMs: now - 90 * D },
      { id: "inone", tags: [], size: 90 * MBs, createdMs: now - 4 * D },
      { id: "inone-used", tags: [], size: 70 * MBs, createdMs: now - 4 * D },
    ],
    containers: [
      { id: "ca", name: "a-live", siteId: A, platform: true, running: true, imageId: "i5", createdMs: now - 2 * H },
      { id: "ca-old", name: "a-old", siteId: A, platform: true, running: false, imageId: "i4", createdMs: now - 2 * D },
      { id: "ca-fresh", name: "a-fresh", siteId: A, platform: true, running: false, imageId: "i5", createdMs: now - 60_000 },
      { id: "cb", name: "b-stopped", siteId: B, platform: true, running: false, imageId: "ib", createdMs: now - 3 * D },
      { id: "cg", name: "gone", siteId: GONE, platform: true, running: false, imageId: "inone-used", createdMs: now - 30 * D },
      { id: "cw", name: "a-worker-done", siteId: A, platform: true, running: false, imageId: "i5", createdMs: now - 3 * D, worker: true },
      { id: "cpg", name: "dbbkp-postgres", platform: true, running: true, imageId: "ipg", createdMs: now - 90 * D },
    ],
    volumes: [
      { name: "vol-a", siteId: A, size: 500 * MBs, inUse: true },
      { name: "vol-gone", siteId: GONE, size: 900 * MBs, inUse: false },
      { name: "vol-gone-mounted", siteId: GONE, size: 10 * MBs, inUse: true },
    ],
    buildCacheBytes: 2048 * MBs,
    folders: [
      { name: "a.test", bytes: 40 * MBs, modifiedMs: now - 9 * D },
      { name: "b.test", bytes: 10 * MBs, modifiedMs: now - 9 * D },
      { name: "old-shop", bytes: 700 * MBs, modifiedMs: now - 40 * D },
      { name: "uploading", bytes: 5 * MBs, modifiedMs: now - 60_000 },
      { name: ".cache", bytes: 5 * MBs, modifiedMs: now - 40 * D },
    ],
  });
  const of = (plan: any, kind: string) => plan.items.filter((i: any) => i.kind === kind);
  let plan = planCleanup(base());

  const imgs = of(plan, "old-images")[0];
  pass(imgs?.targets.join() === "localhost/dbbkp-site-aaaaaaaa:d1,dbbkp-site-cccccccc:d7", "old builds and images of deleted apps go; the builds kept for rollback stay", imgs?.targets.join());
  pass(imgs?.bytes === 430 * MBs && imgs.safe && !imgs.shared, "their size is added up, and they are the platform's own");
  pass(!imgs.targets.some((t: string) => t.includes(":d6")), "an image built five minutes ago is left alone (a deploy may be using it)");
  pass(!plan.items.some((i: any) => i.targets.some((t: string) => t.includes("postgres"))), "images that are not app builds are never listed");

  const cons = of(plan, "app-containers")[0];
  pass(cons?.targets.join() === "ca-old,cg", "leftover containers: an older one beside the running one, and one of a deleted app", cons?.targets.join());
  pass(!cons.targets.includes("cb"), "an app that was stopped on purpose keeps its container");
  pass(!cons.targets.includes("cw"), "a worker that stopped by itself is not a leftover while its app exists");
  pass(!cons.targets.includes("ca-fresh"), "a container made a minute ago is left alone");

  const untagged = of(plan, "untagged-images")[0];
  pass(untagged?.targets.join() === "inone" && untagged.shared, "untagged images no container uses are listed as a shared cache", untagged?.targets.join());
  pass(of(plan, "build-cache")[0]?.bytes === 2048 * MBs && of(plan, "build-cache")[0].shared, "build cache is listed with its size");

  const vols = of(plan, "orphan-volume");
  pass(vols.length === 1 && vols[0].targets[0] === "vol-gone" && vols[0].safe === false, "a volume of a deleted app is listed, and needs its name typed", vols.map((v: any) => v.targets[0]).join());
  const dirs = of(plan, "orphan-folder");
  pass(dirs.length === 1 && dirs[0].targets[0] === "old-shop" && dirs[0].safe === false, "a folder no app uses is listed; app folders, hidden folders and fresh ones are not", dirs.map((v: any) => v.targets[0]).join());
  pass(plan.safeBytes === (430 + 2048 + 90) * MBs, "the safe total leaves out everything that needs a typed name", String(plan.safeBytes / MBs));

  // automatic runs
  pass(!plan.sharedEngine && automaticKinds(plan).join() === "old-images,app-containers,build-cache,untagged-images", "alone on the engine, an automatic run takes all safe kinds", automaticKinds(plan).join());
  const shared = base();
  shared.containers.push({ id: "cx", name: "someone-elses-db", platform: false, running: true, imageId: "ipg", createdMs: now - 90 * D } as any);
  plan = planCleanup(shared);
  pass(plan.sharedEngine && automaticKinds(plan).join() === "old-images,app-containers", "with other software's containers present, an automatic run leaves the shared caches alone", automaticKinds(plan).join());
  pass(!automaticKinds(plan).some((k: string) => k.startsWith("orphan")), "an automatic run never removes a volume or a folder");

  const empty = planCleanup({ ...base(), images: [], containers: [], volumes: [], folders: [], buildCacheBytes: 0 });
  pass(empty.items.length === 0 && empty.safeBytes === 0, "a clean server has nothing to clean");

  // timing
  pass(dueRun(now, 50, null, null) === "weekly", "the first automatic run is due when there has never been one");
  pass(dueRun(now, 50, now - 6 * D, null) === null && dueRun(now, 50, now - 8 * D, null) === "weekly", "then once a week");
  pass(dueRun(now, 85, now - H, null) === "disk", "a disk at 85% starts one at once");
  pass(dueRun(now, 97, now - H, now - H) === null && dueRun(now, 97, now - 7 * H, now - 7 * H) === "disk", "but not again within six hours");
  pass(dueRun(now, null, now - H, null) === null, "an unknown disk reading starts nothing");

  console.log(failed ? `${failed} FAILED` : "cleanup rules hold");
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error("CRASH", e); process.exit(1); });
