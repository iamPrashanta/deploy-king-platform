import { PassThrough } from "node:stream";
import { Worker } from "bullmq";
import Docker from "dockerode";
import { connection } from "./connection";
import { db, cronJobs, cronRuns, sites, siteEnvVars, type CronJob, type Site } from "@dbbkp/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { decrypt } from "@dbbkp/security";

/**
 * Runs scheduled jobs inside the app: the web container, or one of its workers.
 * Every run is recorded (cron_runs) with its exit code and the end of its output, secrets hidden.
 * A run still going when the next is due makes the next one skip; a run past its time limit is stopped.
 */

const docker = new Docker();
const MAX_OUTPUT = 64 * 1024;
const KEEP_DAYS = 30;

/**
 * Starts the command under `timeout` when the image has one that works: GNU coreutils and newer BusyBox
 * take -k (kill if it ignores the stop signal), older BusyBox only the seconds. Without one, the worker's
 * own deadline still ends the wait.
 */
export const RUNNER =
  'if timeout --help 2>&1 | grep -q -- "-k"; then exec timeout -k 10 "$DK_TIMEOUT" sh -c "$DK_CMD"; ' +
  'elif command -v timeout >/dev/null 2>&1 && timeout "$DK_TIMEOUT" true 2>/dev/null; then exec timeout "$DK_TIMEOUT" sh -c "$DK_CMD"; ' +
  'else exec sh -c "$DK_CMD"; fi';

type CronJobData = { cronId: string; trigger?: "schedule" | "manual"; triggeredBy?: string };

/** The running container a job should use, or null with the reason. */
export async function containerFor(site: Site, runIn: string): Promise<{ id: string; name: string } | { error: string }> {
  const all = await docker.listContainers({ filters: { label: [`dbbkp.site=${site.id}`], status: ["running"] } });
  const name = (c: Docker.ContainerInfo) => (c.Names?.[0] ?? c.Id.slice(0, 12)).replace(/^\//, "");
  if (runIn.startsWith("worker:")) {
    const worker = runIn.slice(7);
    const mine = all.filter((c) => c.Labels?.["dbbkp.worker"] === worker).sort((a, b) => Number(a.Labels?.["dbbkp.copy"] ?? 0) - Number(b.Labels?.["dbbkp.copy"] ?? 0));
    return mine[0] ? { id: mine[0].Id, name: name(mine[0]) } : { error: `The worker "${worker}" is not running.` };
  }
  // The web container: anything of this app that is not a worker; the one the last deploy named comes first.
  const web = all.filter((c) => c.Labels?.["dbbkp.role"] !== "worker");
  const pick = web.find((c) => name(c) === site.pm2Name) ?? web[0];
  return pick ? { id: pick.Id, name: name(pick) } : { error: "The app is not running, so there is nothing to run the job in." };
}

/** Keeps the last `max` characters of output, and says when the start was cut. */
class Tail {
  private text = "";
  private cut = false;
  push(chunk: Buffer | string) {
    this.text += chunk.toString();
    if (this.text.length > 2 * MAX_OUTPUT) {
      this.text = this.text.slice(-MAX_OUTPUT);
      this.cut = true;
    }
  }
  value() {
    const t = this.text.length > MAX_OUTPUT ? this.text.slice(-MAX_OUTPUT) : this.text;
    return (this.cut || this.text.length > MAX_OUTPUT ? "[earlier output cut]\n" : "") + t;
  }
}

/** The values of the app's variables, so they can be hidden in the output. Short values would hide too much. */
async function secretsOf(siteId: string) {
  const rows = await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, siteId));
  const out: string[] = [];
  for (const r of rows) {
    try {
      const v = decrypt({ encryptedValue: r.encryptedValue, iv: r.iv, authTag: r.authTag });
      if (v && v.length >= 6) out.push(v);
    } catch {
      // a value that cannot be read cannot leak either
    }
  }
  return out.sort((a, b) => b.length - a.length);
}

export const hideSecrets = (text: string, secrets: string[]) => secrets.reduce((t, s) => t.split(s).join("••••••"), text);

async function finish(job: CronJob, runId: string, startedAt: Date, status: "ok" | "failed" | "timeout" | "skipped", exitCode: number | null, output: string, container?: string) {
  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  await db.update(cronRuns).set({ status, exitCode, output, finishedAt, durationMs, ...(container ? { container } : {}) }).where(eq(cronRuns.id, runId));
  if (status !== "skipped") {
    await db
      .update(cronJobs)
      .set({ lastRunAt: startedAt, lastStatus: status, lastExitCode: exitCode, lastDurationMs: durationMs, failStreak: status === "ok" ? 0 : sql`${cronJobs.failStreak} + 1` })
      .where(eq(cronJobs.id, job.id));
  }
  await db.delete(cronRuns).where(and(eq(cronRuns.jobId, job.id), lt(cronRuns.startedAt, new Date(Date.now() - KEEP_DAYS * 86_400_000))));
  return { status, exitCode, durationMs };
}

export async function runJob(data: CronJobData) {
  const [job] = await db.select().from(cronJobs).where(eq(cronJobs.id, data.cronId)).limit(1);
  if (!job) return { skipped: "deleted" };
  if (!job.active && data.trigger !== "manual") return { skipped: "paused" };
  const [site] = await db.select().from(sites).where(eq(sites.id, job.siteId)).limit(1);
  if (!site) return { skipped: "app deleted" };

  const startedAt = new Date();
  const timeoutSec = job.timeoutSec || 600;
  const [run] = await db.insert(cronRuns).values({ jobId: job.id, siteId: site.id, trigger: data.trigger ?? "schedule", triggeredBy: data.triggeredBy ?? null, startedAt }).returning();

  // A run that is still going (started within its time limit) makes this one skip. Older "running" rows
  // were cut short by a restart of this worker.
  const others = await db.select().from(cronRuns).where(and(eq(cronRuns.jobId, job.id), eq(cronRuns.status, "running")));
  for (const o of others) {
    if (o.id === run.id) continue;
    const age = startedAt.getTime() - new Date(o.startedAt!).getTime();
    if (age < (timeoutSec + 60) * 1000) {
      return finish(job, run.id, startedAt, "skipped", null, `Skipped: the run that started at ${new Date(o.startedAt!).toISOString()} was still going.`);
    }
    await db.update(cronRuns).set({ status: "failed", output: (o.output ?? "") + "\nThe run was cut short: the job runner restarted.", finishedAt: startedAt }).where(eq(cronRuns.id, o.id));
  }

  if (site.type === "static") return finish(job, run.id, startedAt, "failed", null, "A static site has no container to run commands in.");
  const target = await containerFor(site, job.runIn || "web").catch((e: any) => ({ error: `Could not reach the container engine: ${e.message}` }));
  if ("error" in target) return finish(job, run.id, startedAt, "failed", null, target.error);
  await db.update(cronRuns).set({ container: target.name }).where(eq(cronRuns.id, run.id));

  const secrets = await secretsOf(site.id);
  const tail = new Tail();
  try {
    const container = docker.getContainer(target.id);
    // `timeout` stops the command at its limit when the image has it (most do); the deadline below covers the rest.
    const exec = await container.exec({
      Cmd: ["sh", "-c", RUNNER],
      Env: [`DK_CMD=${job.command}`, `DK_TIMEOUT=${timeoutSec}`],
      AttachStdout: true,
      AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    out.on("data", (c) => tail.push(c));
    docker.modem.demuxStream(stream, out, out);
    const ended = new Promise<"ended">((resolve) => {
      stream.on("end", () => resolve("ended"));
      stream.on("close", () => resolve("ended"));
      stream.on("error", () => resolve("ended"));
    });
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), (timeoutSec + 30) * 1000)));
    const how = await Promise.race([ended, deadline]);
    clearTimeout(timer);
    if (how === "timeout") {
      (stream as any).destroy?.();
      return finish(job, run.id, startedAt, "timeout", null, hideSecrets(tail.value() + `\nStopped: the run took longer than ${timeoutSec} seconds.`, secrets), target.name);
    }
    const info = await exec.inspect();
    const code = typeof info.ExitCode === "number" ? info.ExitCode : null;
    // 124: GNU timeout stopped it; 143 (stopped by SIGTERM) right at the limit: BusyBox timeout did.
    const atLimit = Date.now() - startedAt.getTime() >= (timeoutSec - 1) * 1000;
    if (code === 124 || (code === 143 && atLimit)) return finish(job, run.id, startedAt, "timeout", code, hideSecrets(tail.value() + `\nStopped: the run took longer than ${timeoutSec} seconds.`, secrets), target.name);
    return finish(job, run.id, startedAt, code === 0 ? "ok" : "failed", code, hideSecrets(tail.value(), secrets), target.name);
  } catch (err: any) {
    return finish(job, run.id, startedAt, "failed", null, hideSecrets(tail.value() + `\nCould not run the command: ${err.message}`, secrets), target.name);
  }
}

export const cronWorker = new Worker<CronJobData>(
  "cron",
  async (job) => {
    if (job.name !== "execute-cron") return;
    const r = await runJob(job.data);
    if ("status" in r) console.log(`[CronWorker] ${job.data.cronId}: ${r.status}${r.exitCode != null ? ` (exit ${r.exitCode})` : ""} in ${r.durationMs} ms`);
    return r;
  },
  { connection, concurrency: 5 }
);

console.log("[Worker Node] Booted cron worker");
