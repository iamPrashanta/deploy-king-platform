import { db, jobs, pipelineRuns, type Pipeline } from "@dbbkp/db";
import { eq } from "drizzle-orm";
import { pipelineQueue } from "../queues";

function parseEnvVars(raw: string | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Creates the run + job records and enqueues the pipeline.
 * Shared by the tRPC `pipeline.run` mutation and the GitHub push webhook so a
 * push actually starts a run (the webhook used to only log that it would).
 */
export async function enqueuePipelineRun(p: Pipeline, meta: { commitSha?: string | null } = {}) {
  const [run] = await db
    .insert(pipelineRuns)
    .values({
      pipelineId: p.id,
      status: "waiting",
      commitSha: meta.commitSha ? meta.commitSha.slice(0, 40) : null,
      runner: process.env.PIPELINE_ISOLATION ?? "docker",
      image: process.env.PIPELINE_DOCKER_IMAGE ?? "node:20-bookworm",
    })
    .returning();

  const payload = {
    runId: run.id,
    pipelineId: p.id,
    repoUrl: p.repoUrl,
    branch: p.branch ?? "main",
    buildCommand: p.buildCommand ?? null,
    deployCommand: p.deployCommand ?? null,
    envVars: parseEnvVars(p.envVars),
  };

  const [dbJob] = await db
    .insert(jobs)
    .values({
      type: "pipeline",
      name: p.name,
      status: "waiting",
      payload: JSON.stringify(payload),
    })
    .returning();

  const job = await pipelineQueue.add("pipeline-run", { ...payload, dbJobId: dbJob.id });

  await db.update(pipelineRuns).set({ bullJobId: String(job.id) }).where(eq(pipelineRuns.id, run.id));
  await db.update(jobs).set({ bullJobId: String(job.id) }).where(eq(jobs.id, dbJob.id));

  return { jobId: job.id, runId: run.id };
}
