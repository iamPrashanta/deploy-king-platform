import { db, sites, siteWorkers, type Site, type SiteHealthDetail } from "@dbbkp/db";
import { and, eq } from "drizzle-orm";
import { hostingQueue } from "../queues";
import Docker from "dockerode";
import { enqueueDeploy } from "./deploy";
import { fireAppEvent } from "./automations";
import { demuxLogs } from "./validation";
import { alertAppCrashing, alertWorkerCrashing } from "@dbbkp/notify";

const docker = new Docker();

const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 60_000);
/** Restarts before an app counts as crash-looping, and how long it must stay up to count as recovered. */
const CRASH_RESTARTS = Math.max(2, Number(process.env.CRASH_LOOP_RESTARTS || 3));
const RECOVER_MS = Number(process.env.CRASH_RECOVER_MS || 10 * 60_000);

const OOM_TEXT = /heap out of memory|Allocation failed - JavaScript heap|java\.lang\.OutOfMemoryError|MemoryError|Cannot allocate memory/i;

/**
 * Looks at one live app's container and keeps sites.health in step with it.
 * A deploy only proves the app survived its first seconds; this catches the app
 * that passes its health check and then keeps dying (out of memory, a bad
 * variable, a lost database).
 */
async function checkHealth(site: Site, containerId: string): Promise<"ok" | "crashing"> {
  const c = docker.getContainer(containerId);
  const info: any = await c.inspect();
  const restarts = Number(info.RestartCount ?? 0);
  const state = info.State ?? {};
  const upMs = state.StartedAt ? Date.now() - Date.parse(state.StartedAt) : 0;
  // restartsSeen is the restart count the last time the app was stable. Restarts are only counted
  // against it while the app has not managed to stay up, so one crash a week never adds up to a loop.
  const baseline = Math.min(site.restartsSeen ?? 0, restarts);
  const stable = !!state.Running && !state.Restarting && upMs >= RECOVER_MS;
  const crashingNow = !!state.Restarting || (!stable && restarts - baseline >= CRASH_RESTARTS);

  if (crashingNow) {
    let lastOutput = "";
    try {
      const buf = (await c.logs({ stdout: true, stderr: true, tail: 40 })) as unknown as Buffer;
      lastOutput = demuxLogs(Buffer.from(buf)).map((l) => l.text).join("\n").split("\n").slice(-15).join("\n").slice(-3000);
    } catch {}
    const detail: SiteHealthDetail = {
      restarts,
      // between restarts the container is "running" and reports 0, which says nothing about the last crash
      exitCode: !state.Running && typeof state.ExitCode === "number" ? state.ExitCode : null,
      outOfMemory: !!state.OOMKilled || state.ExitCode === 137 || OOM_TEXT.test(lastOutput),
      lastOutput,
      since: site.health === "crashing" && site.healthDetail?.since ? site.healthDetail.since : new Date().toISOString(),
    };
    const first = site.health !== "crashing";
    await db
      .update(sites)
      .set({ health: "crashing", healthDetail: detail, restartsSeen: baseline, lastReconciledAt: new Date(), ...(first ? { healthChangedAt: new Date() } : {}) })
      .where(eq(sites.id, site.id));
    if (first) {
      console.warn(`[Reconciler] ${site.domain} keeps crashing (${restarts} restarts${detail.outOfMemory ? ", out of memory" : ""})`);
      await fireAppEvent(site, "crashing", {
        restarts,
        exitCode: detail.exitCode,
        outOfMemory: detail.outOfMemory,
        error: detail.outOfMemory ? "The app ran out of memory" : lastOutput.split("\n").filter(Boolean).slice(-1)[0] ?? "The app keeps restarting",
      }).catch((err) => console.error("[Reconciler] crash event:", err.message));
    }
    // Every pass while it keeps crashing; the alert itself goes out at most once an hour.
    await alertAppCrashing(site, { restarts, outOfMemory: detail.outOfMemory, lastLine: lastOutput.split("\n").filter(Boolean).slice(-1)[0] ?? null });
    return "crashing";
  }

  const recovered = site.health === "crashing" && stable;
  await db
    .update(sites)
    .set({ restartsSeen: stable ? restarts : baseline, lastReconciledAt: new Date(), ...(recovered ? { health: "ok", healthDetail: null, healthChangedAt: new Date() } : {}) })
    .where(eq(sites.id, site.id));
  if (recovered) console.log(`[Reconciler] ${site.domain} is stable again`);
  return recovered || site.health !== "crashing" ? "ok" : "crashing";
}

/**
 * Platform Reconciliation Engine
 *
 * Ensures "desired state" (DB) matches "actual state" (the container runtime).
 * A site that should be active but has no container is restarted from its last
 * good image - no rebuild - and gets a deployment row saying why. A site whose
 * container is there but keeps restarting is marked as crashing instead: starting
 * it again from the same image would only crash again.
 */
/** Fewer worker containers than the app's workers ask for (one was removed by hand, the engine restarted): put them back. */
async function reconcileWorkers(site: { id: string; domain: string; currentTag: string | null }, all: Docker.ContainerInfo[]) {
  if (!site.currentTag) return;
  const defs = await db.select({ copies: siteWorkers.copies }).from(siteWorkers).where(and(eq(siteWorkers.siteId, site.id), eq(siteWorkers.enabled, true)));
  const want = defs.reduce((n, d) => n + Math.max(1, Math.min(d.copies, 8)), 0);
  // Any state counts: a worker that stopped by itself (restart switched off) is not started again.
  const have = all.filter((c) => c.Labels?.["dbbkp.site"] === site.id && c.Labels?.["dbbkp.role"] === "worker").length;
  if (have < want) await hostingQueue.add("sync-workers", { siteId: site.id }, { jobId: `sync-workers-${site.id}`, removeOnComplete: true, removeOnFail: true });
  // A worker the engine keeps restarting is crash-looping. The alert goes out at most once an hour per worker.
  for (const c of all) {
    if (c.Labels?.["dbbkp.site"] !== site.id || c.Labels?.["dbbkp.role"] !== "worker" || c.State !== "restarting") continue;
    const container = (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
    const name = c.Labels?.["dbbkp.worker"] || container;
    await alertWorkerCrashing(site, { name, container });
  }
}

export async function reconcileOnce() {
  const activeSites = await db.select().from(sites).where(eq(sites.desiredStatus, "active"));
  if (activeSites.length === 0) return { checked: 0, recovered: 0, crashing: 0 };

  // Site containers carry a dbbkp.site=<siteId> label, so we do not depend on naming.
  const all = await docker.listContainers({ all: true, filters: { label: ["dbbkp.site"] } });
  const alive = all.filter((c) => c.State === "running" || c.State === "restarting");

  let recovered = 0;
  let crashing = 0;
  for (const site of activeSites) {
    if (site.status !== "active") {
      // deploying, failed or stopped: the deploy pipeline owns it
      await db.update(sites).set({ lastReconciledAt: new Date() }).where(eq(sites.id, site.id));
      continue;
    }
    // Workers carry the app's label too; only the web container says whether the app is up.
    const mine = alive.filter((c) => c.Labels?.["dbbkp.site"] === site.id && c.Labels?.["dbbkp.role"] !== "worker");
    await reconcileWorkers(site, all).catch((err) => console.error(`[Reconciler] workers of ${site.domain}: ${err.message}`));
    const current = mine.find((c) => c.Names?.some((n) => n.replace(/^\//, "") === site.pm2Name)) ?? mine[0];
    if (!current) {
      console.warn(`[Reconciler] Drift: ${site.domain} should be running but is not. Recovering...`);
      await db.update(sites).set({ status: "drifted", lastReconciledAt: new Date() }).where(eq(sites.id, site.id));
      await enqueueDeploy(site.id, { trigger: "reconcile", reuseImage: true, createdBy: site.userId });
      recovered += 1;
      continue;
    }
    try {
      if ((await checkHealth(site, current.Id)) === "crashing") crashing += 1;
    } catch (err: any) {
      console.error(`[Reconciler] health check of ${site.domain} failed: ${err.message}`);
    }
  }
  return { checked: activeSites.length, recovered, crashing };
}

export function startReconciliationLoop() {
  console.log(`[Reconciler] Starting Platform Reconciliation Loop (interval: ${Math.round(INTERVAL_MS / 1000)}s)`);
  setInterval(() => {
    reconcileOnce().catch((err) => console.error("[Reconciler] Loop error:", err));
  }, INTERVAL_MS);
}
