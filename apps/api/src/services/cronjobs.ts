import { db, cronJobs, cronRuns, siteWorkers, type CronJob } from "@dbbkp/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import { cronQueue } from "../queues";
import { parseCron, preview, validTimezone, ScheduleError } from "./schedule";

/**
 * Scheduled jobs of an app. The schedule lives in BullMQ as a repeatable job with the id `cron-<id>`;
 * the worker (apps/worker/src/cron.worker.ts) runs the command inside the app and records each run.
 */

export const MAX_JOBS_PER_APP = 50;
export const RUNS_KEPT_DAYS = 30;
const repeatId = (id: string) => `cron-${id}`;

async function dropSchedule(id: string) {
  for (const r of await cronQueue.getRepeatableJobs()) if (r.id === repeatId(id)) await cronQueue.removeRepeatableByKey(r.key);
}

/** Puts the job's schedule into the queue, or takes it out when paused. Safe to call again. */
export async function applySchedule(job: Pick<CronJob, "id" | "schedule" | "timezone" | "active">) {
  await dropSchedule(job.id);
  if (!job.active) return;
  await cronQueue.add(
    "execute-cron",
    { cronId: job.id, trigger: "schedule" },
    { repeat: { pattern: job.schedule, tz: job.timezone || "UTC" }, jobId: repeatId(job.id), removeOnComplete: 50, removeOnFail: 50 }
  );
}

export const removeSchedule = dropSchedule;

export async function runNow(jobId: string, userId: string) {
  await cronQueue.add("execute-cron", { cronId: jobId, trigger: "manual", triggeredBy: userId }, { removeOnComplete: 50, removeOnFail: 50 });
}

/**
 * At start-up: every active job has its schedule, and nothing is scheduled that should not be
 * (a job deleted while the queue was down, or one whose schedule was changed).
 */
export async function syncSchedules() {
  const jobs = await db.select().from(cronJobs);
  const want = new Map(jobs.filter((j) => j.active).map((j) => [repeatId(j.id), j]));
  const have = await cronQueue.getRepeatableJobs();
  for (const r of have) {
    const j = r.id ? want.get(r.id) : undefined;
    if (r.name !== "execute-cron") continue;
    if (!j || r.pattern !== j.schedule || (r.tz || "UTC") !== (j.timezone || "UTC")) await cronQueue.removeRepeatableByKey(r.key);
  }
  const left = new Set((await cronQueue.getRepeatableJobs()).map((r) => r.id));
  let added = 0;
  for (const [rid, j] of want) {
    if (left.has(rid)) continue;
    try {
      parseCron(j.schedule);
      await applySchedule(j);
      added++;
    } catch {
      // an old row with a schedule this version refuses: left paused until someone edits it
    }
  }
  return { jobs: jobs.length, added };
}

export type JobInput = { name: string; command: string; schedule: string; timezone: string; runIn: string; timeoutSec: number; notifyOnFailure: boolean };

/** Checks a job before it is saved. Returns the schedule as it is stored (shortcuts expanded). */
export async function checkJob(siteId: string, j: JobInput): Promise<string> {
  if (!validTimezone(j.timezone)) throw new ScheduleError(`"${j.timezone}" is not a time zone this server knows.`);
  const p = preview(j.schedule, j.timezone);
  if (!p.valid) throw new ScheduleError(p.error);
  if (j.runIn !== "web") {
    const name = j.runIn.startsWith("worker:") ? j.runIn.slice(7) : "";
    const [w] = name ? await db.select({ id: siteWorkers.id }).from(siteWorkers).where(and(eq(siteWorkers.siteId, siteId), eq(siteWorkers.name, name))).limit(1) : [];
    if (!w) throw new ScheduleError("Choose the app's web container or one of its workers to run this in.");
  }
  return p.cron;
}

/** A job as the panel shows it: its schedule in words and the next run. */
export function describeJob(j: CronJob) {
  const p = preview(j.schedule, j.timezone || "UTC");
  return { ...j, words: p.valid ? p.words : "Schedule not understood", nextRunAt: j.active && p.valid ? p.next[0] : null };
}

export async function pruneRuns(jobIds?: string[]) {
  const cutoff = new Date(Date.now() - RUNS_KEPT_DAYS * 86_400_000);
  await db.delete(cronRuns).where(jobIds?.length ? and(inArray(cronRuns.jobId, jobIds), lt(cronRuns.startedAt, cutoff)) : lt(cronRuns.startedAt, cutoff));
}
