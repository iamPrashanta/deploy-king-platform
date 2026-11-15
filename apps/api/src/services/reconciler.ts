import { db, sites } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import Docker from "dockerode";
import { enqueueDeploy } from "./deploy";

const docker = new Docker();

const INTERVAL_MS = Number(process.env.RECONCILE_INTERVAL_MS || 5 * 60_000);

/**
 * Platform Reconciliation Engine
 *
 * Ensures "desired state" (DB) matches "actual state" (the container runtime).
 * A site that should be active but has no running container is restarted from
 * its last good image - no rebuild - and gets a deployment row saying why.
 */
export async function reconcileOnce() {
  const activeSites = await db.select().from(sites).where(eq(sites.desiredStatus, "active"));
  if (activeSites.length === 0) return { checked: 0, recovered: 0 };

  // Site containers carry a dbbkp.site=<siteId> label, so we do not depend on naming.
  const running = await docker.listContainers({ filters: { label: ["dbbkp.site"], status: ["running"] } });
  const runningSiteIds = new Set(running.map((c) => c.Labels?.["dbbkp.site"]).filter(Boolean));

  let recovered = 0;
  for (const site of activeSites) {
    if (site.status === "active" && !runningSiteIds.has(site.id)) {
      console.warn(`[Reconciler] Drift: ${site.domain} should be running but is not. Recovering...`);
      await db.update(sites).set({ status: "drifted", lastReconciledAt: new Date() }).where(eq(sites.id, site.id));
      await enqueueDeploy(site.id, { trigger: "reconcile", reuseImage: true, createdBy: site.userId });
      recovered += 1;
    } else {
      await db.update(sites).set({ lastReconciledAt: new Date() }).where(eq(sites.id, site.id));
    }
  }
  return { checked: activeSites.length, recovered };
}

export function startReconciliationLoop() {
  console.log(`[Reconciler] Starting Platform Reconciliation Loop (interval: ${Math.round(INTERVAL_MS / 1000)}s)`);
  setInterval(() => {
    reconcileOnce().catch((err) => console.error("[Reconciler] Loop error:", err));
  }, INTERVAL_MS);
}
