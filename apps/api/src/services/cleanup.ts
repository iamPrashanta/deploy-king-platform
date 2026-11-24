import path from "node:path";
import fs from "fs-extra";
import execa from "execa";
import Docker from "dockerode";
import { db, sites, deployments, platformSettings, cleanupRuns } from "@dbbkp/db";
import { desc, eq, isNotNull } from "drizzle-orm";
import { SITES_ROOT } from "../config";

/**
 * Usage per app, and cleanup.
 *
 * The rule for cleanup: remove only what the platform made and no app can still need.
 *   safe      - old app images, leftover app containers, and the two engine-wide caches (build cache,
 *               untagged images). Safe to remove without asking; the worst case is a slower next build.
 *   confirm   - storage volumes and folders that belong to no app. They may hold data, so each one
 *               needs its name typed, one at a time, and is never part of an automatic run.
 * The engine-wide caches are shared with anything else that uses Docker on this server. An automatic
 * run leaves them alone when other software's containers are present ("shared engine").
 */

const docker = new Docker();
const KEEP_IMAGES = Math.max(1, Number(process.env.DEPLOY_KEEP_IMAGES || 5));
/** Nothing younger than this is touched: a deploy in progress owns things the database does not list yet. */
const MIN_AGE_MS = 60 * 60_000;
const FOLDER_MIN_AGE_MS = 24 * 60 * 60_000;
const SITE_REPO = /^dbbkp-site-([0-9a-f]{8}):/;
const repoOf = (siteId: string) => `dbbkp-site-${siteId.slice(0, 8)}`;
// Docker reports "repo:tag"; Podman reports "localhost/repo:tag".
const shortTag = (tag: string) => tag.split("/").pop()!;
// Docker prefixes image ids with "sha256:"; Podman does not always. Compared without it.
const bareId = (id: string | undefined) => (id ?? "").replace(/^sha256:/, "");

export type Snapshot = {
  now: number;
  sites: Array<{ id: string; domain: string; docRoot: string }>;
  /** Short image tags the last few deploys of each app produced; rollback needs them. */
  keepTags: string[];
  images: Array<{ id: string; tags: string[]; size: number; createdMs: number }>;
  containers: Array<{ id: string; name: string; siteId?: string; platform: boolean; running: boolean; imageId: string; createdMs: number; worker?: boolean }>;
  volumes: Array<{ name: string; siteId?: string; size: number; inUse: boolean }>;
  /** Build cache that nothing is using right now. */
  buildCacheBytes: number;
  folders: Array<{ name: string; bytes: number; modifiedMs: number }>;
};

export type CleanupKind = "old-images" | "app-containers" | "build-cache" | "untagged-images" | "orphan-volume" | "orphan-folder";
export const SAFE_KINDS = ["old-images", "app-containers", "build-cache", "untagged-images"] as const;
export type SafeKind = (typeof SAFE_KINDS)[number];

export type CleanupItem = {
  kind: CleanupKind;
  /** false: may hold data, needs its name typed. */
  safe: boolean;
  /** true: an engine-wide cache, shared with other software on this server. */
  shared: boolean;
  title: string;
  detail: string;
  bytes: number;
  count: number;
  /** What exactly would be removed: image tags or ids, container ids, a volume name, a folder name. */
  targets: string[];
};

export type CleanupPlan = { items: CleanupItem[]; safeBytes: number; sharedEngine: boolean };

/** Decides what may be removed. Pure: the same snapshot always gives the same plan. */
export function planCleanup(s: Snapshot): CleanupPlan {
  const items: CleanupItem[] = [];
  const old = (ms: number, min = MIN_AGE_MS) => s.now - ms >= min;
  const siteById = new Map(s.sites.map((x) => [x.id, x]));
  const repos = new Set(s.sites.map((x) => repoOf(x.id)));
  const keep = new Set(s.keepTags);
  const usedImages = new Set(s.containers.map((c) => c.imageId));
  const sharedEngine = s.containers.some((c) => !c.platform);

  // Images of apps: gone apps entirely, and builds older than the ones kept for rollback.
  const oldImages = s.images.filter((i) => !usedImages.has(i.id) && old(i.createdMs) && i.tags.length > 0 && i.tags.every((t) => {
    const m = shortTag(t).match(SITE_REPO);
    return !!m && (!repos.has(`dbbkp-site-${m[1]}`) || !keep.has(shortTag(t)));
  }));
  if (oldImages.length) {
    items.push({
      kind: "old-images", safe: true, shared: false,
      title: "Old app images",
      detail: `Builds older than the last ${KEEP_IMAGES} of each app, and images of apps that were deleted. Rollback keeps working for the builds that stay.`,
      bytes: oldImages.reduce((n, i) => n + i.size, 0), count: oldImages.length, targets: oldImages.flatMap((i) => i.tags),
    });
  }

  // Containers left behind: their app is gone, or a newer container of the same app is the one running.
  const runningSites = new Set(s.containers.filter((c) => c.running && c.siteId).map((c) => c.siteId!));
  // A worker that stopped by itself (restart switched off) belongs to its app while the app exists.
  const leftovers = s.containers.filter((c) => c.siteId && !c.running && old(c.createdMs) && (!siteById.has(c.siteId) || (runningSites.has(c.siteId) && !c.worker)));
  if (leftovers.length) {
    items.push({
      kind: "app-containers", safe: true, shared: false,
      title: "Leftover app containers",
      detail: "Stopped containers from earlier deploys or deleted apps. An app you stopped yourself keeps its container.",
      bytes: 0, count: leftovers.length, targets: leftovers.map((c) => c.id),
    });
  }

  if (s.buildCacheBytes > 0) {
    items.push({
      kind: "build-cache", safe: true, shared: true,
      title: "Build cache",
      detail: "Saved build steps. Removing them only makes the next build of each app slower.",
      bytes: s.buildCacheBytes, count: 1, targets: [],
    });
  }

  const untagged = s.images.filter((i) => i.tags.length === 0 && !usedImages.has(i.id) && old(i.createdMs));
  if (untagged.length) {
    items.push({
      kind: "untagged-images", safe: true, shared: true,
      title: "Untagged images",
      detail: "Images with no name that no container uses, usually left over from builds.",
      bytes: untagged.reduce((n, i) => n + i.size, 0), count: untagged.length, targets: untagged.map((i) => i.id),
    });
  }

  for (const v of s.volumes) {
    if (!v.siteId || siteById.has(v.siteId) || v.inUse) continue;
    items.push({
      kind: "orphan-volume", safe: false, shared: false,
      title: `Storage volume ${v.name}`,
      detail: "Belonged to an app that no longer exists. It may still hold that app's data.",
      bytes: Math.max(0, v.size), count: 1, targets: [v.name],
    });
  }

  const roots = new Set(s.sites.map((x) => path.basename(path.resolve(x.docRoot))));
  for (const f of s.folders) {
    if (roots.has(f.name) || f.name.startsWith(".") || !old(f.modifiedMs, FOLDER_MIN_AGE_MS)) continue;
    items.push({
      kind: "orphan-folder", safe: false, shared: false,
      title: `Folder ${f.name}`,
      detail: `In ${SITES_ROOT}, used by no app. It may be source code of a deleted app, or something you put there yourself.`,
      bytes: f.bytes, count: 1, targets: [f.name],
    });
  }

  return { items, safeBytes: items.filter((i) => i.safe).reduce((n, i) => n + i.bytes, 0), sharedEngine };
}

/** Which safe kinds an automatic run may take: never the shared caches while other software uses the engine. */
export const automaticKinds = (plan: CleanupPlan): SafeKind[] =>
  plan.items.filter((i) => i.safe && !(i.shared && plan.sharedEngine)).map((i) => i.kind as SafeKind);

// ─── Reading the server ──────────────────────────────────────────────────────

const within = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p.catch(() => fallback), new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

let folderCache: { at: number; rows: Snapshot["folders"] } | null = null;
/** Size of each app folder. `du` over source trees is slow, so the answer is kept for five minutes. */
async function folderSizes(): Promise<Snapshot["folders"]> {
  if (folderCache && Date.now() - folderCache.at < 5 * 60_000) return folderCache.rows;
  const rows: Snapshot["folders"] = [];
  const names = await fs.readdir(SITES_ROOT).catch(() => [] as string[]);
  const sizes = new Map<string, number>();
  if (names.length) {
    const out = await within(execa("du", ["-sk", "--", ...names], { cwd: SITES_ROOT, reject: false, timeout: 30_000 }).then((r) => r.stdout), 31_000, "");
    for (const line of out.split("\n")) {
      const m = line.match(/^(\d+)\s+(.+)$/);
      if (m) sizes.set(m[2], Number(m[1]) * 1024);
    }
  }
  for (const name of names) {
    const st = await fs.stat(path.join(SITES_ROOT, name)).catch(() => null);
    if (st?.isDirectory()) rows.push({ name, bytes: sizes.get(name) ?? 0, modifiedMs: st.mtimeMs });
  }
  folderCache = { at: Date.now(), rows };
  return rows;
}

const isPlatformContainer = (c: Docker.ContainerInfo) =>
  !!c.Labels?.["dbbkp.site"] || !!c.Labels?.["dbbkp.managed"] || (c.Names ?? []).some((n) => n.replace(/^\//, "").startsWith("dbbkp-"));

export async function snapshot(): Promise<Snapshot> {
  const [siteRows, recent, images, containers, vols, df, folders] = await Promise.all([
    db.select({ id: sites.id, domain: sites.domain, docRoot: sites.docRoot }).from(sites),
    db.select({ siteId: deployments.siteId, imageTag: deployments.imageTag }).from(deployments).where(isNotNull(deployments.imageTag)).orderBy(desc(deployments.createdAt)).limit(5000),
    docker.listImages(),
    docker.listContainers({ all: true }),
    docker.listVolumes().catch(() => ({ Volumes: [] as any[] })),
    // Sizes of volumes and build cache. Slow on a busy engine and incomplete on Podman, so it may be missing.
    within(docker.df() as Promise<any>, 20_000, null),
    folderSizes(),
  ]);

  const perSite = new Map<string, Set<string>>();
  for (const r of recent) {
    const set = perSite.get(r.siteId) ?? new Set<string>();
    if (set.size < KEEP_IMAGES && r.imageTag) set.add(shortTag(r.imageTag));
    perSite.set(r.siteId, set);
  }
  const volumeSize = new Map<string, { size: number; refs: number }>((df?.Volumes ?? []).map((v: any) => [v.Name, { size: v.UsageData?.Size ?? -1, refs: v.UsageData?.RefCount ?? 0 }]));
  const mounted = new Set(containers.flatMap((c) => (c.Mounts ?? []).map((m: any) => m.Name).filter(Boolean)));

  return {
    now: Date.now(),
    sites: siteRows,
    keepTags: [...perSite.values()].flatMap((s) => [...s]),
    images: images.map((i) => ({ id: bareId(i.Id), tags: (i.RepoTags ?? []).filter((t) => t && !t.startsWith("<none>")), size: i.Size ?? 0, createdMs: (i.Created ?? 0) * 1000 })),
    containers: containers.map((c) => ({
      id: c.Id, name: (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, ""), siteId: c.Labels?.["dbbkp.site"], platform: isPlatformContainer(c),
      running: c.State === "running" || c.State === "restarting" || c.State === "paused", imageId: bareId(c.ImageID), createdMs: (c.Created ?? 0) * 1000, worker: c.Labels?.["dbbkp.role"] === "worker",
    })),
    volumes: (vols.Volumes ?? []).filter((v: any) => v.Labels?.["dbbkp.managed"] || v.Labels?.["dbbkp.site"]).map((v: any) => ({
      name: v.Name, siteId: v.Labels?.["dbbkp.site"], size: volumeSize.get(v.Name)?.size ?? -1, inUse: mounted.has(v.Name) || (volumeSize.get(v.Name)?.refs ?? 0) > 0,
    })),
    buildCacheBytes: ((df?.BuildCache ?? []) as any[]).filter((b) => !b.InUse).reduce((n, b) => n + (b.Size ?? 0), 0),
    folders,
  };
}

// ─── Usage per app ───────────────────────────────────────────────────────────

export type AppUsage = {
  id: string; domain: string; running: boolean;
  memoryMb: number | null; memoryLimitMb: number; cpuPct: number | null;
  imagesBytes: number; images: number; storageBytes: number | null; sourceBytes: number | null;
};

async function liveStats(containerId: string): Promise<{ memoryMb: number; cpuPct: number } | null> {
  const st: any = await within(docker.getContainer(containerId).stats({ stream: false }) as Promise<any>, 6000, null);
  if (!st?.memory_stats?.usage) return null;
  const cpu = st.cpu_stats?.cpu_usage?.total_usage - st.precpu_stats?.cpu_usage?.total_usage;
  const sys = st.cpu_stats?.system_cpu_usage - st.precpu_stats?.system_cpu_usage;
  const cache = st.memory_stats.stats?.inactive_file ?? st.memory_stats.stats?.cache ?? 0;
  return {
    memoryMb: Math.round((st.memory_stats.usage - cache) / 1024 / 1024),
    cpuPct: sys > 0 && cpu >= 0 ? Math.round((cpu / sys) * (st.cpu_stats.online_cpus || 1) * 1000) / 10 : 0,
  };
}

export async function usage(): Promise<{ apps: AppUsage[]; totals: { imagesBytes: number; storageBytes: number; sourceBytes: number; buildCacheBytes: number } }> {
  const [s, limits] = await Promise.all([snapshot(), db.select({ id: sites.id, memoryLimit: sites.memoryLimit }).from(sites)]);
  const limitOf = new Map(limits.map((l) => [l.id, l.memoryLimit || 512]));
  const folderOf = new Map(s.folders.map((f) => [f.name, f.bytes]));
  const apps = await Promise.all(s.sites.map(async (site): Promise<AppUsage> => {
    const repo = repoOf(site.id) + ":";
    const imgs = s.images.filter((i) => i.tags.some((t) => shortTag(t).startsWith(repo)));
    const vols = s.volumes.filter((v) => v.siteId === site.id);
    const live = s.containers.find((c) => c.siteId === site.id && c.running);
    const stats = live ? await liveStats(live.id) : null;
    return {
      id: site.id, domain: site.domain, running: !!live,
      memoryMb: stats?.memoryMb ?? null, memoryLimitMb: limitOf.get(site.id) ?? 512, cpuPct: stats?.cpuPct ?? null,
      imagesBytes: imgs.reduce((n, i) => n + i.size, 0), images: imgs.length,
      storageBytes: vols.length === 0 ? 0 : vols.some((v) => v.size < 0) ? null : vols.reduce((n, v) => n + v.size, 0),
      sourceBytes: folderOf.get(path.basename(path.resolve(site.docRoot))) ?? null,
    };
  }));
  apps.sort((a, b) => b.imagesBytes + (b.storageBytes ?? 0) + (b.sourceBytes ?? 0) - (a.imagesBytes + (a.storageBytes ?? 0) + (a.sourceBytes ?? 0)));
  return {
    apps,
    totals: {
      imagesBytes: apps.reduce((n, a) => n + a.imagesBytes, 0),
      storageBytes: apps.reduce((n, a) => n + (a.storageBytes ?? 0), 0),
      sourceBytes: apps.reduce((n, a) => n + (a.sourceBytes ?? 0), 0),
      buildCacheBytes: s.buildCacheBytes,
    },
  };
}

// ─── Doing it ────────────────────────────────────────────────────────────────

export type CleanupResult = { kind: CleanupKind; removed: number; bytes: number; errors: string[] };

async function removeKind(item: CleanupItem, s: Snapshot): Promise<CleanupResult> {
  const out: CleanupResult = { kind: item.kind, removed: 0, bytes: 0, errors: [] };
  const fail = (what: string, e: any) => out.errors.push(`${what}: ${String(e?.json?.message ?? e?.message ?? e).slice(0, 160)}`);
  if (item.kind === "build-cache") {
    try {
      const r: any = await (docker as any).pruneBuilder();
      out.bytes = r?.SpaceReclaimed ?? 0;
      out.removed = 1;
    } catch (e) {
      fail("build cache", e);
    }
    return out;
  }
  if (item.kind === "old-images" || item.kind === "untagged-images") {
    const sizeOf = (ref: string) => s.images.find((i) => i.id === ref || i.tags.includes(ref));
    const done = new Set<string>();
    for (const ref of item.targets) {
      try {
        await docker.getImage(ref).remove(); // never forced: an image a container still uses stays
        out.removed++;
        const img = sizeOf(ref);
        if (img && !done.has(img.id)) { done.add(img.id); out.bytes += img.size; }
      } catch (e) {
        fail(shortTag(ref).slice(0, 60), e);
      }
    }
    return out;
  }
  if (item.kind === "app-containers") {
    for (const id of item.targets) {
      try {
        await docker.getContainer(id).remove({ v: true }); // not forced: a container that started meanwhile stays
        out.removed++;
      } catch (e) {
        fail(id.slice(0, 12), e);
      }
    }
    return out;
  }
  if (item.kind === "orphan-volume") {
    try {
      await docker.getVolume(item.targets[0]).remove();
      out.removed = 1;
      out.bytes = item.bytes;
    } catch (e) {
      fail(item.targets[0], e);
    }
    return out;
  }
  // orphan-folder: a direct child of SITES_ROOT, by name only.
  const name = item.targets[0];
  const dir = path.resolve(SITES_ROOT, name);
  if (path.dirname(dir) !== path.resolve(SITES_ROOT) || name !== path.basename(dir)) {
    out.errors.push(`${name}: not a folder directly inside ${SITES_ROOT}`);
    return out;
  }
  try {
    await fs.remove(dir);
    folderCache = null;
    out.removed = 1;
    out.bytes = item.bytes;
  } catch (e) {
    fail(name, e);
  }
  return out;
}

async function record(trigger: string, userId: string | null, results: CleanupResult[]) {
  const freedBytes = results.reduce((n, r) => n + r.bytes, 0);
  const [row] = await db.insert(cleanupRuns).values({ trigger, userId, freedBytes, results }).returning();
  return row;
}

let running = false;
/** Removes the chosen safe kinds. The plan is made again here, so nothing the caller sends decides what is deleted. */
export async function runCleanup(kinds: readonly SafeKind[], trigger: "manual" | "weekly" | "disk", userId: string | null) {
  if (running) throw new Error("A cleanup is already running.");
  running = true;
  try {
    const s = await snapshot();
    const plan = planCleanup(s);
    const results: CleanupResult[] = [];
    for (const item of plan.items) {
      if (item.safe && kinds.includes(item.kind as SafeKind)) results.push(await removeKind(item, s));
    }
    return await record(trigger, userId, results);
  } finally {
    running = false;
  }
}

/** Removes one volume or folder that belongs to no app. The name must be typed, and it must still be in the plan. */
export async function removeOrphan(kind: "orphan-volume" | "orphan-folder", target: string, userId: string) {
  const s = await snapshot();
  const item = planCleanup(s).items.find((i) => i.kind === kind && i.targets[0] === target);
  if (!item) throw new Error("That is no longer on the list. It is in use, or already gone.");
  const result = await removeKind(item, s);
  if (result.errors.length) throw new Error(result.errors[0]);
  return record("manual", userId, [result]);
}

// ─── Settings and the automatic run ──────────────────────────────────────────

const SETTINGS_KEY = "cleanup";
export type CleanupSettings = { auto: boolean };

export async function getCleanupSettings(): Promise<CleanupSettings> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, SETTINGS_KEY)).limit(1);
  return { auto: (row?.value as any)?.auto !== false };
}

export async function setCleanupSettings(next: CleanupSettings, userId: string): Promise<CleanupSettings> {
  const value = { auto: !!next.auto };
  await db.insert(platformSettings).values({ key: SETTINGS_KEY, value, updatedBy: userId }).onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId, updatedAt: new Date() } });
  return value;
}

export const lastRuns = (limit = 20) => db.select().from(cleanupRuns).orderBy(desc(cleanupRuns.createdAt)).limit(limit);

const WEEK_MS = 7 * 24 * 60 * 60_000;
const DISK_TRIGGER_PCT = 85;
const DISK_RETRY_MS = 6 * 60 * 60_000;

/** Which automatic run is due, if any. Pure, so the timing can be checked on fixed inputs. */
export function dueRun(now: number, diskUsedPct: number | null, lastAnyMs: number | null, lastDiskMs: number | null): "disk" | "weekly" | null {
  if (diskUsedPct !== null && diskUsedPct >= DISK_TRIGGER_PCT && (lastDiskMs === null || now - lastDiskMs >= DISK_RETRY_MS)) return "disk";
  if (lastAnyMs === null || now - lastAnyMs >= WEEK_MS) return "weekly";
  return null;
}

async function diskUsedPct(): Promise<number | null> {
  try {
    const st = await (fs as any).statfs(SITES_ROOT);
    return st.blocks ? Math.round((1 - st.bavail / st.blocks) * 100) : null;
  } catch {
    return null;
  }
}

async function automaticTick() {
  if (!(await getCleanupSettings()).auto) return;
  const runs = await lastRuns(50);
  const ms = (r?: { createdAt: Date | null }) => (r?.createdAt ? new Date(r.createdAt).getTime() : null);
  const due = dueRun(Date.now(), await diskUsedPct(), ms(runs[0]), ms(runs.find((r) => r.trigger === "disk")));
  if (!due) return;
  const kinds = automaticKinds(planCleanup(await snapshot()));
  const run = await runCleanup(kinds, due, null);
  console.log(`[Cleanup] ${due} run freed ${Math.round((run.freedBytes ?? 0) / 1024 / 1024)} MB`);
}

/** Weekly, and as soon as the disk passes 85%. Safe items only. */
export function startAutomaticCleanup() {
  console.log("[Cleanup] Automatic cleanup is on a one-hour check (weekly, or when the disk passes 85%)");
  const tick = () => automaticTick().catch((e) => console.error("[Cleanup] automatic run failed:", e?.message ?? e));
  setTimeout(tick, 10 * 60_000); // not during start-up
  setInterval(tick, 60 * 60_000);
}
