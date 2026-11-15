import { db, deployments, sites } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { hostingQueue } from "../queues";

export type DeployTrigger = "manual" | "webhook" | "rollback" | "reconcile" | "preview";

export interface DeployOptions {
  trigger: DeployTrigger;
  createdBy?: string | null;
  commitSha?: string | null;
  commitMessage?: string | null;
  /** Re-run the image built by an earlier deployment instead of building again. */
  rollbackToDeploymentId?: string | null;
  /** Restart from the site's current image if it still exists (used by the reconciler). */
  reuseImage?: boolean;
}

/**
 * Records a deployment and hands it to the hosting worker.
 * The row exists before the job runs, so the UI can show "queued" immediately
 * and every deploy - whatever triggered it - leaves a history entry.
 */
export async function enqueueDeploy(siteId: string, opts: DeployOptions) {
  const [deployment] = await db
    .insert(deployments)
    .values({
      siteId,
      status: "queued",
      trigger: opts.trigger,
      commitSha: opts.commitSha ?? null,
      commitMessage: opts.commitMessage ? opts.commitMessage.slice(0, 500) : null,
      createdBy: opts.createdBy ?? null,
    })
    .returning();

  await db.update(sites).set({ status: "provisioning", updatedAt: new Date() }).where(eq(sites.id, siteId));

  await hostingQueue.add(
    "deploy-site",
    {
      siteId,
      deploymentId: deployment.id,
      trigger: opts.trigger,
      rollbackToDeploymentId: opts.rollbackToDeploymentId ?? null,
      reuseImage: !!opts.reuseImage,
    },
    { removeOnComplete: 200, removeOnFail: 500 }
  );

  return deployment;
}
