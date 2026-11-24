import os from "node:os";
import "./env";
import { Worker, type Job } from "bullmq";
import { connection } from "./connection";
import { db, sites, deployments, containerInstances, siteEnvVars, gitProviders, type Site, type Deployment, type SiteVolume, type DeployPrompt, siteWorkers, type SiteWorker } from "@dbbkp/db";
import { and, desc, eq, isNotNull, ne } from "drizzle-orm";
import Docker from "dockerode";
import execa from "execa";
import fs from "fs-extra";
import path from "path";
import crypto from "node:crypto";
import * as tar from "tar";
import { decrypt } from "@dbbkp/security";
import { createBuildPlan, GENERATED_DOCKERFILE, gitAuthArgs, redactToken, resolveBuildRoot, withBuildArgs, NODE_VERSIONS, type BuildPlan } from "./deploy/detect";
import { PassThrough } from "node:stream";
import { fireDeployEvent } from "./automation.worker";
import net from "node:net";

/**
 * Hosting worker
 *
 * One deploy path for every kind of site:
 *
 *   source (git clone / uploaded ZIP)
 *     -> build plan (repo Dockerfile, or one generated for the detected runtime)
 *     -> image, tagged per deployment
 *     -> new container on the platform network, with Traefik labels
 *     -> health check
 *     -> only then: retire the previous container
 *
 * The previous container keeps serving until the new one answers, so a broken
 * build or a crashing release never takes a working site down, and every
 * image that was ever live stays available as a rollback target.
 */

const docker = new Docker();

const SITES_ROOT = (process.env.SITES_ROOT || "/var/www/sites").replace(/\/+$/, "");
const NETWORK = process.env.DBBKP_NETWORK || "dbbkp";
const TLS_ENABLED = (process.env.DBBKP_TLS ?? "true") !== "false";
const PUBLIC_HTTP_PORT = Number(process.env.DBBKP_PUBLIC_HTTP_PORT || 80);
const publicUrl = (domain: string) =>
  TLS_ENABLED ? `https://${domain}` : `http://${domain}${PUBLIC_HTTP_PORT && PUBLIC_HTTP_PORT !== 80 ? `:${PUBLIC_HTTP_PORT}` : ""}`;
const CERT_RESOLVER = process.env.DBBKP_CERT_RESOLVER || "letsencrypt";
const ENTRYPOINT_WEB = process.env.TRAEFIK_ENTRYPOINT_WEB || "web";
const ENTRYPOINT_WEBSECURE = process.env.TRAEFIK_ENTRYPOINT_WEBSECURE || "websecure";
const HEALTH_TIMEOUT_MS = Number(process.env.DEPLOY_HEALTH_TIMEOUT_MS || 120_000);
// "http": wait until something answers on the app port. "running": only require the container to stay up.
const HEALTH_MODE = process.env.DEPLOY_HEALTH_CHECK === "running" ? "running" : "http";
const BUILD_TIMEOUT_MS = Number(process.env.DEPLOY_BUILD_TIMEOUT_MS || 20 * 60_000);
const KEEP_IMAGES = Math.max(1, Number(process.env.DEPLOY_KEEP_IMAGES || 5));
const MAX_LOG_CHARS = 400_000;
// How long a deploy waits for the user to answer a question before giving up.
const PROMPT_TIMEOUT_MS = Number(process.env.DEPLOY_PROMPT_TIMEOUT_MS || 15 * 60_000);

type DeployJobData = {
  siteId: string;
  deploymentId?: string;
  trigger?: string;
  rollbackToDeploymentId?: string | null;
  reuseImage?: boolean;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoName = (site: Pick<Site, "id">) => `dbbkp-site-${site.id.slice(0, 8)}`;
// Docker reports a local image as "repo:tag"; Podman's Docker-compatible API
// reports the same image as "localhost/repo:tag" or "docker.io/library/repo:tag".
const shortTag = (tag: string) => tag.split("/").pop()!;

// ─── Deploy log ──────────────────────────────────────────────────────────────
// Buffered in memory and flushed to deployments.log about once a second, so the
// panel can show a build as it happens without a DB write per output line.
class DeployLog {
  private text = "";
  private dirty = false;
  private timer: NodeJS.Timeout;

  constructor(private deploymentId: string, private domain: string) {
    this.timer = setInterval(() => void this.flush(), 1000);
  }

  line(msg: string) {
    const clean = msg.replace(/\r/g, "").replace(/\n+$/, "");
    if (!clean) return;
    this.text += `[${new Date().toISOString()}] ${clean}\n`;
    if (this.text.length > MAX_LOG_CHARS) this.text = "...(truncated)...\n" + this.text.slice(-MAX_LOG_CHARS);
    this.dirty = true;
    console.log(`[Hosting:${this.domain}] ${clean}`);
  }

  /** Raw build output: many lines, no per-line timestamp. */
  raw(chunk: string) {
    const clean = chunk.replace(/\r/g, "");
    if (!clean.trim()) return;
    this.text += clean.endsWith("\n") ? clean : clean + "\n";
    if (this.text.length > MAX_LOG_CHARS) this.text = "...(truncated)...\n" + this.text.slice(-MAX_LOG_CHARS);
    this.dirty = true;
  }

  /** Last part of the log, for matching known build errors. */
  tail(chars = 20_000) {
    return this.text.slice(-chars);
  }

  async flush() {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      await db.update(deployments).set({ log: this.text }).where(eq(deployments.id, this.deploymentId));
    } catch (err) {
      console.error("[Hosting] Failed to persist deploy log:", err);
    }
  }

  async close() {
    clearInterval(this.timer);
    this.dirty = true;
    await this.flush();
  }
}

// ─── Guards ──────────────────────────────────────────────────────────────────

/**
 * docRoot comes from the database and is passed to recursive delete calls.
 * It must be a direct child of SITES_ROOT - never SITES_ROOT itself, never "/".
 */
function assertSafeDocRoot(docRoot: string): string {
  const resolved = path.resolve(docRoot);
  const rel = path.relative(SITES_ROOT, resolved);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
    throw new Error(`Refusing to operate on "${docRoot}": site directories must live directly under ${SITES_ROOT}`);
  }
  return resolved;
}

// ─── Docker helpers ──────────────────────────────────────────────────────────

async function imageExists(tag: string): Promise<boolean> {
  try {
    await docker.getImage(tag).inspect();
    return true;
  } catch {
    return false;
  }
}

async function ensureNetwork() {
  const existing = await docker.listNetworks({ filters: { name: [NETWORK] } });
  if (existing.some((n) => n.Name === NETWORK)) return;
  await docker.createNetwork({ Name: NETWORK, Driver: "bridge", Labels: { "dbbkp.managed": "true" } });
}

async function siteContainers(siteId: string) {
  return docker.listContainers({ all: true, filters: { label: [`dbbkp.site=${siteId}`] } });
}

const isWorker = (c: Docker.ContainerInfo) => c.Labels?.["dbbkp.role"] === "worker";

async function removeContainer(id: string) {
  const c = docker.getContainer(id);
  await c.stop({ t: 10 }).catch(() => {});
  await c.remove({ force: true, v: true }).catch(() => {});
}

async function tailLogs(container: Docker.Container, lines = 40): Promise<string> {
  try {
    const buf = (await container.logs({ stdout: true, stderr: true, tail: lines })) as unknown as Buffer;
    // Strip the 8-byte stream multiplexing header docker puts in front of each frame.
    return buf
      .toString("utf8")
      .replace(/[\x00-\x08\x0e-\x1f]/g, "")
      .trim();
  } catch {
    return "";
  }
}

/** Token of the GitHub connection a site was created with, for private repositories. */
async function providerToken(site: Site): Promise<string | null> {
  if (!site.gitProviderId) return null;
  const [p] = await db.select().from(gitProviders).where(eq(gitProviders.id, site.gitProviderId)).limit(1);
  if (!p) return null;
  return decrypt({ encryptedValue: p.encryptedToken, iv: p.iv, authTag: p.authTag });
}

/** Named volumes survive redeploys; they are labelled so delete can find them. */
async function ensureVolumes(site: Site, log: DeployLog): Promise<string[]> {
  const binds: string[] = [];
  for (const v of (site.volumes ?? []) as SiteVolume[]) {
    const name = `dbbkp-${site.id.slice(0, 8)}-${v.name}`;
    try {
      await docker.createVolume({ Name: name, Labels: { "dbbkp.site": site.id, "dbbkp.managed": "true" } });
    } catch {
      // already exists
    }
    binds.push(`${name}:${v.mountPath}`);
  }
  if (binds.length) log.line(`Mounting ${binds.length} persistent volume${binds.length > 1 ? "s" : ""}: ${binds.join(", ")}`);
  return binds;
}

async function pullImage(ref: string, log: DeployLog) {
  const stream = await docker.pull(ref);
  await new Promise<void>((resolve, reject) => {
    let last = "";
    docker.modem.followProgress(
      stream,
      (err: Error | null) => (err ? reject(err) : resolve()),
      (e: any) => {
        if (e?.error) return reject(new Error(String(e.error)));
        const status = String(e?.status || "");
        if (status && status !== last && !/^(Waiting|Downloading|Extracting|Verifying|Pulling fs layer)/.test(status)) {
          last = status;
          log.raw(e.id ? `${e.id}: ${status}` : status);
        }
      }
    );
  });
}

// ─── Source ──────────────────────────────────────────────────────────────────

async function prepareSource(site: Site, docRoot: string, log: DeployLog) {
  if (site.source === "git") {
    if (!site.repoUrl) throw new Error("Site has no repository URL");
    const branch = site.branch || "main";
    const token = await providerToken(site);
    log.line(`Cloning ${site.repoUrl} (branch ${branch})${token ? " with the connected GitHub account" : ""}`);
    await fs.ensureDir(docRoot);
    await fs.emptyDir(docRoot);
    try {
      // "--" stops a hostile URL or branch being read as a git option;
      // GIT_TERMINAL_PROMPT=0 makes a private repo fail fast instead of waiting for a password.
      await execa("git", [...gitAuthArgs(site.repoUrl, token), "clone", "--depth=1", "--single-branch", "--branch", branch, "--", site.repoUrl, docRoot], {
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        timeout: 10 * 60_000,
      });
    } catch (err: any) {
      const detail = redactToken(String(err.stderr || err.shortMessage || err.message), token).split("\n").slice(-3).join(" ").trim();
      throw new Error(
        /could not read Username|Authentication failed|Repository not found/i.test(detail)
          ? "git clone failed: repository not found or private. Connect GitHub in Settings and pick the repository from your list."
          : `git clone failed: ${detail}`
      );
    }
    const { stdout } = await execa("git", ["log", "-1", "--format=%H%n%s"], { cwd: docRoot });
    const [sha, ...subject] = stdout.split("\n");
    return { commitSha: sha?.trim() || null, commitMessage: subject.join("\n").trim() || null };
  }

  // ZIP: the upload route already extracted the project into docRoot.
  if (!(await fs.pathExists(docRoot)) || (await fs.readdir(docRoot)).length === 0) {
    throw new Error("No uploaded files found for this site. Upload the project ZIP again.");
  }
  log.line("Using uploaded project files");
  return { commitSha: null, commitMessage: null };
}

// ─── Build ───────────────────────────────────────────────────────────────────

async function buildImage(docRoot: string, plan: BuildPlan, imageTag: string, log: DeployLog, buildVars: Record<string, string> = {}) {
  const buildKeys = Object.keys(buildVars);
  if (plan.dockerfile !== null) {
    await fs.writeFile(path.join(docRoot, plan.dockerfilePath), withBuildArgs(plan.dockerfile, buildKeys));
  }
  if (buildKeys.length) {
    log.line(`Build-time variables: ${buildKeys.join(", ")}`);
    if (plan.dockerfile === null) log.line("Your Dockerfile receives them as build arguments; it needs an ARG line for each one it uses.");
  }

  // Generated builds never need VCS metadata or a checked-in node_modules; a
  // repository's own Dockerfile gets the tree as-is (minus .git).
  const skip = plan.dockerfile !== null ? [".git", "node_modules"] : [".git"];
  const context = tar.c(
    {
      cwd: docRoot,
      portable: true,
      filter: (p: string) => {
        const first = p.replace(/^\.\//, "").split("/")[0];
        return !skip.includes(first);
      },
    },
    ["."]
  );

  log.line(`Building image ${imageTag}`);
  const stream = await docker.buildImage(context as any, {
    t: imageTag,
    dockerfile: plan.dockerfilePath,
    rm: true,
    forcerm: true,
    ...(buildKeys.length ? { buildargs: buildVars } : {}),
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      (stream as any).destroy?.();
      reject(new Error(`Build timed out after ${Math.round(BUILD_TIMEOUT_MS / 60000)} minutes`));
    }, BUILD_TIMEOUT_MS);

    let buildError: string | null = null;
    docker.modem.followProgress(
      stream,
      (err: Error | null) => {
        clearTimeout(timer);
        if (err) return reject(err);
        if (buildError) return reject(new Error(`Build failed: ${buildError}`));
        resolve();
      },
      (event: any) => {
        if (event?.stream) log.raw(event.stream);
        if (event?.error || event?.errorDetail) {
          buildError = String(event.errorDetail?.message || event.error).trim();
        }
      }
    );
  });

  if (!(await imageExists(imageTag))) throw new Error("Build finished but the image was not created.");
  log.line("Image built");
}

// ─── Run ─────────────────────────────────────────────────────────────────────

function traefikLabels(site: Site, deploymentId: string, port: number): Record<string, string> {
  const r = `site-${site.id.slice(0, 8)}`;
  const rule = `Host(\`${site.domain}\`)`;
  const labels: Record<string, string> = {
    "dbbkp.managed": "true",
    "dbbkp.site": site.id,
    "dbbkp.deployment": deploymentId,
    "dbbkp.domain": site.domain,
    "traefik.enable": "true",
    "traefik.docker.network": NETWORK,
    [`traefik.http.services.${r}.loadbalancer.server.port`]: String(port),
    [`traefik.http.routers.${r}.rule`]: rule,
    [`traefik.http.routers.${r}.service`]: r,
  };

  if (TLS_ENABLED) {
    labels[`traefik.http.routers.${r}.entrypoints`] = ENTRYPOINT_WEBSECURE;
    labels[`traefik.http.routers.${r}.tls`] = "true";
    labels[`traefik.http.routers.${r}.tls.certresolver`] = CERT_RESOLVER;
    // Plain HTTP only exists to redirect to HTTPS.
    labels[`traefik.http.routers.${r}-http.rule`] = rule;
    labels[`traefik.http.routers.${r}-http.entrypoints`] = ENTRYPOINT_WEB;
    labels[`traefik.http.routers.${r}-http.service`] = r;
    labels[`traefik.http.routers.${r}-http.middlewares`] = `${r}-https`;
    labels[`traefik.http.middlewares.${r}-https.redirectscheme.scheme`] = "https";
    labels[`traefik.http.middlewares.${r}-https.redirectscheme.permanent`] = "true";
  } else {
    labels[`traefik.http.routers.${r}.entrypoints`] = ENTRYPOINT_WEB;
  }
  return labels;
}

/** Variables marked "available during build", decrypted, for the image build. */
async function siteBuildVars(site: Site): Promise<Record<string, string>> {
  const rows = await db.select().from(siteEnvVars).where(and(eq(siteEnvVars.siteId, site.id), eq(siteEnvVars.buildTime, true)));
  const out: Record<string, string> = {};
  for (const row of rows) out[row.key] = decrypt({ encryptedValue: row.encryptedValue, iv: row.iv, authTag: row.authTag });
  return out;
}

async function siteEnvironment(site: Site, port: number): Promise<string[]> {
  const env: Record<string, string> = { PORT: String(port) };
  const rows = await db.select().from(siteEnvVars).where(eq(siteEnvVars.siteId, site.id));
  for (const row of rows) {
    env[row.key] = decrypt({ encryptedValue: row.encryptedValue, iv: row.iv, authTag: row.authTag });
  }
  return Object.entries(env).map(([k, v]) => `${k}=${v}`);
}

async function probeHttp(ip: string, port: number): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(`http://${ip}:${port}/`, { signal: controller.signal, redirect: "manual" });
    return res.status; // any HTTP answer means the server is up, even a 404 or a redirect
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Resolves once the new container is serving; throws (with its last output) if it dies or never answers. */
async function waitUntilHealthy(container: Docker.Container, port: number, log: DeployLog) {
  const started = Date.now();
  const deadline = started + HEALTH_TIMEOUT_MS;
  log.line(
    HEALTH_MODE === "http"
      ? `Waiting for the app to answer on port ${port} (up to ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s)`
      : "Waiting for the container to stay up"
  );

  let nextPortCheck = started + 8000;
  while (Date.now() < deadline) {
    const info = await container.inspect();
    if (!info.State.Running) {
      throw new AppExited(info.State.ExitCode, !!info.State.OOMKilled, await tailLogs(container), "during startup");
    }

    if (HEALTH_MODE === "running") {
      if (Date.now() - started >= 10_000) {
        log.line("Container has stayed up for 10s");
        return;
      }
    } else {
      const ip = info.NetworkSettings?.Networks?.[NETWORK]?.IPAddress;
      if (ip) {
        const status = await probeHttp(ip, port);
        if (status !== null) {
          log.line(`Health check passed: HTTP ${status} on port ${port} after ${Math.round((Date.now() - started) / 1000)}s`);
          return;
        }
      }
      if (Date.now() >= nextPortCheck && ip) {
        nextPortCheck = Date.now() + 5000;
        const listening = await listeningPorts(container);
        if (!listening.length) {
          // No shell in the image to read /proc with: knock on likely ports instead.
          const open = await guessOpenPorts(container, ip, port);
          if (open.length) throw new PortMismatch(port, open);
        }
        const reachable = listening.filter((l) => !l.loopback).map((l) => l.port);
        if (listening.length && !reachable.includes(port)) {
          const others = reachable.filter((p) => p !== port);
          if (others.length) throw new PortMismatch(port, others);
          if (listening.some((l) => l.port === port && l.loopback)) {
            const output = await tailLogs(container);
            throw new Error(
              `The app is listening on 127.0.0.1:${port}, which only accepts connections from inside the container. Make it listen on 0.0.0.0 (for example HOST=0.0.0.0).` +
                (output ? `\n--- last output ---\n${output}` : "")
            );
          }
        }
      }
    }
    await sleep(1500);
  }

  const output = await tailLogs(container);
  throw new Error(
    `Health check timed out: nothing answered on port ${port} within ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s. ` +
      `The app must listen on 0.0.0.0 and on the port in $PORT.` +
      (output ? `\n--- last output ---\n${output}` : "")
  );
}

// ─── Questions during a deploy ───────────────────────────────────────────────
// When the worker hits something it can fix with the user's say-so (the app
// listens on another port, the build needs another Node.js version), it parks
// the deployment in "waiting_input" with a prompt, and polls for the answer the
// panel writes into deployments.answers. The previous release keeps serving
// while it waits.

/**
 * Asks the user a question and waits for the answer. Returns the chosen value,
 * or null when nobody answered in time.
 */
async function ask(deploymentId: string, log: DeployLog, q: Omit<DeployPrompt, "askedAt" | "expiresAt">): Promise<string | null> {
  const [before] = await db
    .select({ status: deployments.status, answers: deployments.answers })
    .from(deployments)
    .where(eq(deployments.id, deploymentId))
    .limit(1);
  const already = before?.answers?.[q.id];
  if (already !== undefined) return already; // answered on an earlier attempt of this job

  const askedAt = new Date();
  const prompt: DeployPrompt = { ...q, askedAt: askedAt.toISOString(), expiresAt: new Date(askedAt.getTime() + PROMPT_TIMEOUT_MS).toISOString() };
  await db.update(deployments).set({ status: "waiting_input", prompt }).where(eq(deployments.id, deploymentId));
  log.line(`Waiting for your answer: ${q.title}`);
  await log.flush();

  const resume = async (answer: string | null) => {
    await db.update(deployments).set({ status: before?.status ?? "building", prompt: null }).where(eq(deployments.id, deploymentId));
    return answer;
  };

  while (Date.now() - askedAt.getTime() < PROMPT_TIMEOUT_MS) {
    await sleep(1500);
    const [row] = await db.select({ answers: deployments.answers }).from(deployments).where(eq(deployments.id, deploymentId)).limit(1);
    const answer = row?.answers?.[q.id];
    if (answer !== undefined) {
      const label = q.options?.find((o) => o.value === answer)?.label ?? answer;
      log.line(`Answer: ${label}`);
      return resume(answer);
    }
  }
  log.line(`No answer within ${Math.round(PROMPT_TIMEOUT_MS / 60_000)} minutes`);
  return resume(null);
}

/** TCP ports the container is listening on, read from /proc inside it. Empty if that is not possible. */
async function listeningPorts(container: Docker.Container): Promise<{ port: number; loopback: boolean }[]> {
  try {
    const exec = await container.exec({ Cmd: ["sh", "-c", "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null"], AttachStdout: true, AttachStderr: true });
    const stream: any = await exec.start({ hijack: true, stdin: false });
    let text = "";
    const out = new PassThrough();
    out.on("data", (c: Buffer) => (text += c.toString("utf8")));
    docker.modem.demuxStream(stream, out, new PassThrough());
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      stream.on("end", done);
      stream.on("close", done);
      stream.on("error", done);
      setTimeout(done, 3000);
    });
    const ports = new Map<number, boolean>();
    for (const line of text.split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f.length < 4 || f[3] !== "0A") continue; // 0A = LISTEN
      const [addr, hex] = f[1].split(":");
      const port = parseInt(hex, 16);
      if (!port) continue;
      const loopback = /^(0100007F|00000000000000000000000001000000|0000000000000000FFFF00000100007F)$/i.test(addr);
      ports.set(port, (ports.get(port) ?? true) && loopback);
    }
    return [...ports].map(([port, loopback]) => ({ port, loopback }));
  } catch {
    return [];
  }
}

/** True when something accepts a TCP connection on ip:port. */
function probeTcp(ip: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: ip, port });
    const done = (ok: boolean) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

const COMMON_PORTS = [80, 8080, 3000, 8000, 5000, 4000, 3001, 8081, 8888, 9000, 5173, 4200, 1337, 5678, 8443, 443];

/**
 * Ports the app might really be serving on, for images without a shell (scratch,
 * distroless) where /proc can't be read: the image's EXPOSE, ports named in its
 * output, then common ones. Each is checked with a plain TCP connect.
 */
async function guessOpenPorts(container: Docker.Container, ip: string, expected: number): Promise<number[]> {
  const info: any = await container.inspect().catch(() => null);
  const exposed = Object.keys(info?.Config?.ExposedPorts ?? {}).map((p) => Number(p.split("/")[0]));
  const output = await tailLogs(container, 80);
  const mentioned = [...output.matchAll(/(?:port|listening|listen|:)\s*:?\s*(\d{2,5})\b/gi)].map((m) => Number(m[1]));
  const candidates = [...new Set([...exposed, ...mentioned, ...COMMON_PORTS])].filter((p) => p > 0 && p < 65536 && p !== expected).slice(0, 40);
  const open: number[] = [];
  for (const p of candidates) if (await probeTcp(ip, p)) open.push(p);
  return open;
}

/** The app's process stopped, during startup or right after its first health check. */
class AppExited extends Error {
  constructor(public exitCode: number, public oomKilled: boolean, public output: string, when: string) {
    super(`The app exited ${when} (exit code ${exitCode}${oomKilled ? ", killed for using too much memory" : ""}).` + (output ? `\n--- last output ---\n${output}` : ""));
  }
  get outOfMemory() {
    return (
      this.oomKilled ||
      this.exitCode === 137 ||
      /heap out of memory|Allocation failed - JavaScript heap|java\.lang\.OutOfMemoryError|MemoryError|Cannot allocate memory|out of memory/i.test(this.output)
    );
  }
}

// After the first successful health check the app is watched a little longer:
// some apps (n8n is one) answer quickly and then crash while they finish booting.
const STABLE_MS = Math.max(0, Number(process.env.DEPLOY_STABLE_MS ?? 15_000));

async function waitStable(container: Docker.Container, log: DeployLog) {
  if (!STABLE_MS) return;
  log.line(`Watching the app for ${Math.round(STABLE_MS / 1000)}s to make sure it stays up`);
  const end = Date.now() + STABLE_MS;
  while (Date.now() < end) {
    await sleep(1000);
    const info = await container.inspect();
    if (!info.State.Running) {
      throw new AppExited(info.State.ExitCode, !!info.State.OOMKilled, await tailLogs(container), "right after its first health check");
    }
  }
}

class PortMismatch extends Error {
  constructor(public expected: number, public found: number[]) {
    super(`Nothing is listening on port ${expected}; the app is listening on ${found.join(", ")}.`);
  }
}

/** Recognises build failures that another Node.js version usually fixes. */
function nodeVersionHint(text: string): { hint: string; suggest: string } | null {
  if (/ERR_OSSL_EVP_UNSUPPORTED|digital envelope routines::unsupported/.test(text))
    return { hint: "This looks like an older webpack build that needs Node.js 16.", suggest: "16" };
  if (/EBADENGINE|engine "node" is incompatible|Unsupported engine|requires? (?:a )?Node(?:\.js)? (?:version )?[>=^~]/i.test(text)) {
    const want = text.match(/(?:Required|wanted)[^\n]*?"node"\s*:\s*"[^"\d]*(\d{2})/i)?.[1];
    return { hint: "A dependency asks for a different Node.js version.", suggest: want && NODE_VERSIONS.includes(want) ? want : "20" };
  }
  if (/gyp ERR!|node-gyp/.test(text)) return { hint: "A native module failed to compile, which often means it does not support this Node.js version yet.", suggest: "20" };
  return null;
}

async function pruneImages(site: Site, keepTag: string) {
  const repo = repoName(site);
  const recent = await db
    .select({ imageTag: deployments.imageTag })
    .from(deployments)
    .where(and(eq(deployments.siteId, site.id), isNotNull(deployments.imageTag)))
    .orderBy(desc(deployments.createdAt))
    .limit(50);

  const keep = new Set<string>([keepTag]);
  for (const row of recent) {
    if (keep.size >= KEEP_IMAGES) break;
    if (row.imageTag) keep.add(row.imageTag);
  }

  const images = await docker.listImages();
  for (const image of images) {
    for (const tag of image.RepoTags ?? []) {
      const short = shortTag(tag);
      if (short.startsWith(`${repo}:`) && !keep.has(short)) {
        await docker.getImage(tag).remove().catch(() => {});
      }
    }
  }
}

// ─── Deploy ──────────────────────────────────────────────────────────────────

/** A full disk breaks the database and every running app, so builds stop at 95%. The API applies the same limit. */
async function assertDiskHasRoom() {
  let usedPct = 0;
  try {
    const st = await (fs as any).statfs(SITES_ROOT);
    if (st.blocks > 0) usedPct = Math.round(((st.blocks - st.bavail) / st.blocks) * 100);
  } catch {
    return; // cannot measure: do not block the deploy on that
  }
  if (usedPct >= 95) throw new Error(`The disk is ${usedPct}% full. Free space on the server, then deploy again.`);
}

async function deploySite(job: Job<DeployJobData>) {
  const { siteId, rollbackToDeploymentId, reuseImage } = job.data;
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) throw new Error("Site not found");
  if (site.desiredStatus === "deleted") return { skipped: "site is being deleted" };

  // Jobs created through the API carry a deployment row; anything else gets one here.
  let deployment: Deployment | undefined;
  if (job.data.deploymentId) {
    [deployment] = await db.select().from(deployments).where(eq(deployments.id, job.data.deploymentId)).limit(1);
  }
  if (!deployment) {
    [deployment] = await db
      .insert(deployments)
      .values({ siteId, trigger: job.data.trigger || "manual", status: "queued", createdBy: site.userId })
      .returning();
  }

  const startedAt = new Date();
  const log = new DeployLog(deployment.id, site.domain);
  const repo = repoName(site);
  let newContainer: Docker.Container | null = null;

  await db.update(deployments).set({ status: "building", startedAt }).where(eq(deployments.id, deployment.id));
  await db.update(sites).set({ status: "provisioning", updatedAt: new Date() }).where(eq(sites.id, site.id));

  try {
    const docRoot = assertSafeDocRoot(site.docRoot);

    let imageTag: string;
    let runtime: string | null;
    let port: number;
    let commitSha = deployment.commitSha;
    let commitMessage = deployment.commitMessage;
    let chosenNodeVersion: string | null = null;

    // ── 1. Decide what to run ────────────────────────────────────────────────
    let reused: Deployment | undefined;
    if (rollbackToDeploymentId) {
      [reused] = await db
        .select()
        .from(deployments)
        .where(and(eq(deployments.id, rollbackToDeploymentId), eq(deployments.siteId, site.id)))
        .limit(1);
      if (!reused?.imageTag || !reused.port) throw new Error("Rollback target has no image to run.");
      if (!(await imageExists(reused.imageTag))) {
        throw new Error(`Rollback image ${reused.imageTag} is no longer on this server (only the last ${KEEP_IMAGES} are kept).`);
      }
      log.line(`Rolling back to deployment ${reused.id.slice(0, 8)} (${reused.imageTag}) - no rebuild`);
    } else if (reuseImage && site.currentTag && site.port && (await imageExists(site.currentTag))) {
      [reused] = await db
        .select()
        .from(deployments)
        .where(and(eq(deployments.siteId, site.id), eq(deployments.imageTag, site.currentTag)))
        .orderBy(desc(deployments.createdAt))
        .limit(1);
      if (reused) log.line(`Restarting from the current image ${site.currentTag} - no rebuild`);
    }

    // Whatever started this deploy (panel, push, agent): nothing is pulled or built onto a full disk.
    if (!reused?.imageTag) await assertDiskHasRoom();

    if (reused?.imageTag) {
      imageTag = reused.imageTag;
      runtime = reused.runtime;
      port = reused.port ?? site.port!;
      commitSha = reused.commitSha;
      commitMessage = reused.commitMessage;
    } else if (site.source === "image") {
      // ── 2. Prebuilt image ──────────────────────────────────────────────────
      if (!site.image) throw new Error("This app has no image set.");
      log.line(`Starting deployment for ${site.domain} (image: ${site.image})`);
      await pullImage(site.image, log);
      const info: any = await docker.getImage(site.image).inspect();
      const exposed = Object.keys(info?.Config?.ExposedPorts ?? {})
        .map((p) => Number(p.split("/")[0]))
        .filter((n) => Number.isInteger(n) && n > 0);
      runtime = "image";
      port = site.port ?? exposed[0] ?? 80;
      if (!site.port) {
        log.line(exposed.length ? `Using port ${port} from the image's EXPOSE` : "The image declares no port; assuming 80. Set the port in Settings if it listens elsewhere.");
      }
      // Re-tag under the site's own name so rollbacks keep working after the upstream tag moves.
      const tag = `img-${deployment.id.slice(0, 8)}`;
      await docker.getImage(site.image).tag({ repo, tag });
      imageTag = `${repo}:${tag}`;
      commitMessage = commitMessage ?? site.image;
      await db
        .update(deployments)
        .set({ runtime, port, commitMessage: commitMessage.slice(0, 500) })
        .where(eq(deployments.id, deployment.id));
    } else {
      // ── 2. Source + build ──────────────────────────────────────────────────
      log.line(`Starting deployment for ${site.domain} (source: ${site.source}, runtime: ${site.type})`);
      const source = await prepareSource(site, docRoot, log);
      commitSha = source.commitSha ?? commitSha;
      commitMessage = source.commitMessage ?? commitMessage;

      // Monorepos: build the app's own folder, not the whole repository.
      const buildRoot = resolveBuildRoot(docRoot, site.rootDirectory);
      if (buildRoot !== docRoot) log.line(`Building from the folder ${site.rootDirectory}`);
      const buildVars = await siteBuildVars(site);

      let settings: Site = { ...site };
      let plan = createBuildPlan(buildRoot, settings);
      for (const note of plan.notes) log.line(note);

      runtime = plan.runtime;
      port = plan.port;
      if (plan.runtime === "docker" && site.port && site.port !== plan.port) {
        // The user already told us (at a previous health check) that this app serves on another port than EXPOSE says.
        const [last] = await db
          .select({ port: deployments.port, runtime: deployments.runtime })
          .from(deployments)
          .where(and(eq(deployments.siteId, site.id), eq(deployments.status, "active")))
          .limit(1);
        if (last?.runtime === "docker" && last.port === site.port) {
          port = site.port;
          log.line(`Using port ${port}, which the previous release was served on`);
        }
      }
      const version = commitSha ? commitSha.slice(0, 7) : "upload";
      imageTag = `${repo}:${version}-${deployment.id.slice(0, 8)}`;

      await db
        .update(deployments)
        .set({ runtime, port, commitSha, commitMessage: commitMessage?.slice(0, 500) ?? null })
        .where(eq(deployments.id, deployment.id));

      for (let attempt = 0; ; attempt++) {
        try {
          await buildImage(buildRoot, plan, imageTag, log, buildVars);
          break;
        } catch (err: any) {
          const nodeBuild = plan.runtime === "node" || plan.runtime === "node-static";
          const hint = attempt === 0 && nodeBuild ? nodeVersionHint(`${err?.message ?? ""}\n${log.tail()}`) : null;
          if (!hint) throw err;
          const current = plan.notes.join(" ").match(/Node\.js (\d+)/)?.[1] ?? "22";
          const choices = NODE_VERSIONS.filter((v) => v !== current);
          const answer = await ask(deployment.id, log, {
            id: "node-version",
            kind: "select",
            title: `The build failed on Node.js ${current}`,
            detail: `${hint.hint} Retry with another version? The current version keeps serving until the new one is healthy.`,
            options: [
              ...choices.map((v) => ({ value: v, label: `Retry with Node.js ${v}`, detail: v === hint.suggest ? "Suggested" : undefined })),
              { value: "stop", label: "Stop the deploy" },
            ],
            default: choices.includes(hint.suggest) ? hint.suggest : choices[0],
          });
          if (!answer || answer === "stop" || !NODE_VERSIONS.includes(answer)) throw err;
          settings = { ...settings, nodeVersion: answer };
          chosenNodeVersion = answer;
          plan = createBuildPlan(buildRoot, settings);
          log.line(`Rebuilding with Node.js ${answer}`);
          for (const note of plan.notes) log.line(note);
        } finally {
          if (plan.dockerfile !== null) await fs.remove(path.join(buildRoot, GENERATED_DOCKERFILE)).catch(() => {});
        }
      }
    }

    await db
      .update(deployments)
      .set({ status: "starting", imageTag, runtime, port, commitSha, commitMessage: commitMessage?.slice(0, 500) ?? null })
      .where(eq(deployments.id, deployment.id));

    // ── 3. Start the new container next to the old one ───────────────────────
    await ensureNetwork();
    const containerName = `${repo}-${deployment.id.slice(0, 8)}`;
    await removeContainer(containerName); // leftover from a retried job

    let memoryMb = site.memoryLimit || 512;
    let chosenMemory: number | null = null;
    const startContainer = async (p: number) => {
      const c = await docker.createContainer({
        name: containerName,
        Image: imageTag,
        Env: await siteEnvironment(site, p),
        Labels: { ...traefikLabels(site, deployment.id, p), "dbbkp.role": "web" },
        HostConfig: {
          NetworkMode: NETWORK,
          Binds: await ensureVolumes(site, log),
          // No restart policy until it has passed its health check: a release
          // that crashes on boot should fail the deploy, not restart forever.
          RestartPolicy: { Name: "no" },
          Memory: memoryMb * 1024 * 1024,
          CpuPeriod: 100000,
          CpuQuota: (site.cpuLimit || 1) * 100000,
          PidsLimit: site.pidsLimit || 256,
          ReadonlyRootfs: site.isReadOnly || false,
          SecurityOpt: ["no-new-privileges"],
          // If the server does run out of memory, the system stops an app first, never the platform's own containers.
          OomScoreAdj: 500,
          // Keep at most 3 x 10 MB of output per app, so logs cannot fill the disk.
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
        },
      });
      await c.start();
      log.line(`Started container ${containerName} (port ${p}, memory ${memoryMb} MB)`);
      return c;
    };

    // Start, health-check and watch the new container. Problems the user can
    // settle with one answer (wrong port, not enough memory) pause the deploy
    // and ask; each question is asked at most once per deploy.
    const asked = new Set<string>();
    for (;;) {
      newContainer = await startContainer(port);
      try {
        await waitUntilHealthy(newContainer, port, log);
        await waitStable(newContainer, log);
        break;
      } catch (err) {
        await removeContainer(newContainer.id).catch(() => {});
        newContainer = null;

        if (err instanceof PortMismatch && !asked.has("port")) {
          asked.add("port");
          log.line(err.message);
          const answer = await ask(deployment.id, log, {
            id: `port-${err.found.join("-")}`,
            kind: err.found.length > 1 ? "select" : "confirm",
            title: `Your app is listening on port ${err.found[0]}${err.found.length > 1 ? ` (and ${err.found.length - 1} more)` : ""}, not ${port}`,
            detail: `Route traffic to the port it really uses? Deploy King remembers it for the next deploys.`,
            options: [...err.found.map((p) => ({ value: String(p), label: `Use port ${p}` })), { value: "no", label: "Stop the deploy" }],
            default: String(err.found[0]),
          });
          const chosen = Number(answer);
          if (!answer || !err.found.includes(chosen)) throw new Error(`${err.message} The app must listen on the port in $PORT (${port}).`);
          port = chosen;
          await db.update(deployments).set({ port }).where(eq(deployments.id, deployment.id));
          continue;
        }

        if (err instanceof AppExited && err.outOfMemory && !asked.has("memory")) {
          asked.add("memory");
          log.line(err.message.split("\n")[0]);
          // Never offer more than the machine has; the API then checks the chosen size against the capacity ledger.
          const choices = [1024, 2048, 4096, 8192].filter((m) => m > memoryMb && m <= os.totalmem() / (1024 * 1024));
          if (!choices.length) throw err;
          const label = (m: number) => (m >= 1024 ? `${m / 1024} GB` : `${m} MB`);
          const answer = await ask(deployment.id, log, {
            id: "memory",
            kind: "select",
            title: `The app ran out of memory (limit ${label(memoryMb)})`,
            detail: "It crashed with an out-of-memory error. Start it again with more memory? The image is reused, nothing is rebuilt.",
            options: [
              ...choices.map((m, i) => ({ value: String(m), label: `Retry with ${label(m)}`, detail: i === 0 ? "Suggested" : undefined })),
              { value: "stop", label: "Stop the deploy" },
            ],
            default: String(choices[0]),
          });
          const mb = Number(answer);
          if (!answer || !choices.includes(mb)) throw err;
          memoryMb = mb;
          chosenMemory = mb;
          continue;
        }
        throw err;
      }
    }

    // From here on the container must come back by itself after a crash or reboot.
    await newContainer.update({ RestartPolicy: { Name: "unless-stopped" } }).catch((err: any) => {
      log.line(`Note: could not set the restart policy (${err.message}); the reconciler will restart this site if it stops.`);
    });

    // ── 4. Switch over ───────────────────────────────────────────────────────
    const info = await newContainer.inspect();
    for (const c of await siteContainers(site.id)) {
      if (c.Id !== info.Id && !isWorker(c)) {
        log.line(`Retiring previous container ${c.Names?.[0]?.replace(/^\//, "") ?? c.Id.slice(0, 12)}`);
        await removeContainer(c.Id);
      }
    }

    const finishedAt = new Date();
    await db.delete(containerInstances).where(eq(containerInstances.siteId, site.id));
    await db.insert(containerInstances).values({
      dockerId: info.Id,
      siteId: site.id,
      tenantId: site.userId,
      runtime,
      createdBy: site.userId,
    });
    await db
      .update(deployments)
      .set({ status: "superseded" })
      .where(and(eq(deployments.siteId, site.id), eq(deployments.status, "active"), ne(deployments.id, deployment.id)));
    await db
      .update(deployments)
      .set({
        status: "active",
        containerName,
        finishedAt,
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        error: null,
      })
      .where(eq(deployments.id, deployment.id));
    await db
      .update(sites)
      .set({
        status: "active",
        pm2Name: containerName,
        currentTag: imageTag,
        port,
        ...(chosenNodeVersion ? { nodeVersion: chosenNodeVersion } : {}),
        ...(chosenMemory ? { memoryLimit: chosenMemory } : {}),
        sslEnabled: TLS_ENABLED,
        nginxConfig: "traefik: docker labels",
        // a new container starts with a clean record
        health: "ok",
        healthDetail: null,
        healthChangedAt: finishedAt,
        restartsSeen: 0,
        lastReconciledAt: finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(sites.id, site.id));

    log.line(`Deployment live: ${publicUrl(site.domain)}`);
    // Workers follow the release that just went live. A worker that fails to start does not undo the deploy.
    await syncWorkers({ ...site, currentTag: imageTag, port }, log).catch((err) => log.line(`Workers: ${err.message}`));
    fireDeployEvent(site, { id: deployment.id, trigger: deployment.trigger, status: "active" }).catch((err) => console.error("[Workflows] deploy event:", err.message));
    await pruneImages(site, imageTag).catch((err) => console.error("[Hosting] Image prune failed:", err));

    return { success: true, containerName, imageTag, port };
  } catch (err: any) {
    const message = err instanceof Error ? err.message : String(err);
    log.line(`Deployment failed: ${message}`);

    if (newContainer) await removeContainer(newContainer.id);

    const finishedAt = new Date();
    await db
      .update(deployments)
      .set({ status: "failed", error: message.slice(0, 4000), finishedAt, durationMs: finishedAt.getTime() - startedAt.getTime() })
      .where(eq(deployments.id, deployment.id));

    // If the previous release is still running, the site is still up: say so
    // instead of flipping a healthy site to "failed".
    const stillServing = (await siteContainers(site.id).catch(() => [])).some((c) => c.State === "running" && !isWorker(c));
    await db
      .update(sites)
      .set({ status: stillServing ? "active" : "failed", updatedAt: finishedAt })
      .where(eq(sites.id, site.id));
    if (stillServing) log.line("The previous release is still serving traffic.");
    fireDeployEvent(site, { id: deployment.id, trigger: deployment.trigger, status: "failed", error: message }).catch((e) => console.error("[Workflows] deploy event:", e.message));

    throw err;
  } finally {
    await log.close();
  }
}

// ─── Workers ──────────────────────────────────────────────────
// Background processes of an app: the live release's image with its own command, the app's variables
// and volumes, no web traffic. Each copy is one container labelled dbbkp.role=worker.

/** What a worker container was made from. A container whose spec differs is replaced. */
function workerSpec(w: SiteWorker, image: string, envHash: string) {
  return crypto.createHash("sha256").update(JSON.stringify([image, w.command, w.memoryLimit, w.restart, envHash])).digest("hex").slice(0, 16);
}

const quietLog = { line: (_: string) => {} } as unknown as DeployLog;

/**
 * Makes the app's worker containers match its workers: starts what is missing, replaces what is out of date
 * (new release, new command, new memory limit, changed variables), stops what was removed or switched off.
 */
async function syncWorkers(site: Site, log: DeployLog = quietLog) {
  const defs = await db.select().from(siteWorkers).where(eq(siteWorkers.siteId, site.id));
  const running = (await siteContainers(site.id)).filter(isWorker);
  if (!site.currentTag || !(await imageExists(site.currentTag))) {
    if (defs.some((d) => d.enabled)) log.line("Workers start after the first successful deploy.");
    return { started: 0, stopped: 0 };
  }
  const env = await siteEnvironment(site, site.port ?? 3000);
  const envHash = crypto.createHash("sha256").update(env.join("\n")).digest("hex");
  const want = new Map<string, { def: SiteWorker; copy: number; spec: string }>();
  for (const d of defs) {
    if (!d.enabled) continue;
    for (let i = 0; i < Math.max(1, Math.min(d.copies, 8)); i++) want.set(`${d.name}#${i}`, { def: d, copy: i, spec: workerSpec(d, site.currentTag, envHash) });
  }
  let stopped = 0;
  const keep = new Set<string>();
  for (const c of running) {
    const slot = `${c.Labels?.["dbbkp.worker"]}#${c.Labels?.["dbbkp.copy"]}`;
    const w = want.get(slot);
    if (w && c.Labels?.["dbbkp.spec"] === w.spec && !keep.has(slot)) {
      keep.add(slot);
      continue;
    }
    const graceful = defs.find((d) => d.name === c.Labels?.["dbbkp.worker"])?.gracefulStop ?? true;
    const ct = docker.getContainer(c.Id);
    await ct.stop({ t: graceful ? 30 : 5 }).catch(() => {});
    await ct.remove({ force: true }).catch(() => {});
    stopped++;
  }
  let started = 0;
  const binds = want.size ? await ensureVolumes(site, quietLog) : [];
  for (const [slot, w] of want) {
    if (keep.has(slot)) continue;
    const name = `${repoName(site)}-w-${w.def.name}-${w.copy}-${crypto.randomBytes(2).toString("hex")}`;
    try {
      const c = await docker.createContainer({
        name,
        Image: site.currentTag,
        Cmd: ["sh", "-c", w.def.command],
        Env: env,
        Labels: { "dbbkp.site": site.id, "dbbkp.role": "worker", "dbbkp.worker": w.def.name, "dbbkp.copy": String(w.copy), "dbbkp.spec": w.spec, "dbbkp.managed": "true" },
        HostConfig: {
          NetworkMode: NETWORK,
          Binds: binds,
          RestartPolicy: w.def.restart ? { Name: "unless-stopped" } : { Name: "no" },
          Memory: w.def.memoryLimit * 1024 * 1024,
          CpuPeriod: 100000,
          CpuQuota: (site.cpuLimit || 1) * 100000,
          PidsLimit: site.pidsLimit || 256,
          ReadonlyRootfs: site.isReadOnly || false,
          SecurityOpt: ["no-new-privileges"],
          OomScoreAdj: 500,
          LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
        },
      });
      await c.start();
      started++;
      log.line(`Started worker ${w.def.name}${w.def.copies > 1 ? ` #${w.copy + 1}` : ""} (${w.def.memoryLimit} MB): ${w.def.command}`);
    } catch (err: any) {
      log.line(`Worker ${w.def.name} did not start: ${err.message}`);
    }
  }
  return { started, stopped };
}

async function syncWorkersById(siteId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site || site.desiredStatus === "deleted") return { skipped: true };
  return syncWorkers(site);
}

// ─── Delete ──────────────────────────────────────────────────────────────────

async function deleteSite(siteId: string) {
  const [site] = await db.select().from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!site) return { success: true };

  for (const c of await siteContainers(site.id)) await removeContainer(c.Id);

  const repo = repoName(site);
  for (const image of await docker.listImages()) {
    for (const tag of image.RepoTags ?? []) {
      if (shortTag(tag).startsWith(`${repo}:`)) {
        await docker.getImage(tag).remove({ force: true }).catch(() => {});
      }
    }
  }

  try {
    const vols: any = await (docker.listVolumes as any)({ filters: { label: [`dbbkp.site=${site.id}`] } });
    for (const v of vols?.Volumes ?? []) await docker.getVolume(v.Name).remove().catch(() => {});
  } catch {
    // volume listing is best-effort on delete
  }

  try {
    await fs.remove(assertSafeDocRoot(site.docRoot));
  } catch (err: any) {
    console.warn(`[Hosting] Skipped removing source for ${site.domain}: ${err.message}`);
  }

  // Deployments, env vars and container records go with the row (ON DELETE CASCADE).
  await db.delete(sites).where(eq(sites.id, siteId));
  console.log(`[Hosting] Site ${site.domain} deleted`);
  return { success: true };
}

// ─── Worker ──────────────────────────────────────────────────────────────────

// Two jobs for the same site must not run at once (they would fight over the
// source directory), while different sites can build side by side.
const siteLocks = new Map<string, Promise<unknown>>();

function withSiteLock<T>(siteId: string, fn: () => Promise<T>): Promise<T> {
  const previous = siteLocks.get(siteId) ?? Promise.resolve();
  const run = previous.catch(() => {}).then(fn);
  const settled = run.catch(() => {});
  siteLocks.set(siteId, settled);
  void settled.then(() => {
    if (siteLocks.get(siteId) === settled) siteLocks.delete(siteId);
  });
  return run;
}

export const hostingWorker = new Worker<DeployJobData>(
  "hosting",
  async (job) => {
    const siteId = job.data?.siteId;
    if (!siteId) throw new Error("Job is missing siteId");

    if (job.name === "delete-site") return withSiteLock(siteId, () => deleteSite(siteId));
    if (job.name === "deploy-site") return withSiteLock(siteId, () => deploySite(job));
    if (job.name === "sync-workers") return withSiteLock(siteId, () => syncWorkersById(siteId));
    return undefined;
  },
  { connection, concurrency: Math.max(1, Number(process.env.DEPLOY_CONCURRENCY || 2)) }
);

hostingWorker.on("failed", (job, err) => console.error(`[Hosting] Job ${job?.id} (${job?.name}) failed: ${err.message.split("\n")[0]}`));

console.log(`[Worker Node] Booted hosting worker (network: ${NETWORK}, tls: ${TLS_ENABLED})`);
