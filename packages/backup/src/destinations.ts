import crypto from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import fs from "fs-extra";

/**
 * Where backup files are copied.
 *   local  - a folder on this server. "This server" (DK_BACKUP_DIR, default /var/backups/dbbkp) always exists.
 *   rclone - any remote set up in rclone on this server ("remote:path"): Amazon S3, Google Drive, SFTP, Backblaze...
 * S3 and SFTP with their own keys stored in Deploy King are not built yet; until then they go through rclone.
 */

export type DestinationRow = { id: string; name: string; kind: string; location: string; keepLast: number | null };

export const DESTINATION_KINDS = [
  { kind: "local", label: "A folder on this server", available: true, reason: null },
  { kind: "rclone", label: "rclone remote (S3, Google Drive, SFTP, Backblaze and more)", available: true, reason: null },
  { kind: "s3", label: "Amazon S3 with access keys", available: false, reason: "Not available yet. Set S3 up as an rclone remote on the server and add that instead." },
  { kind: "sftp", label: "Another server over SSH (rsync)", available: false, reason: "Not available yet. Set the server up as an rclone SFTP remote and add that instead." },
] as const;

export const localBackupDir = () => path.resolve(process.env.DK_BACKUP_DIR || "/var/backups/dbbkp");
export const rcloneBin = () => process.env.RCLONE_BIN || "rclone";

const SYSTEM = ["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/lib64", "/proc", "/root", "/run", "/sbin", "/sys", "/usr", "/var/lib/docker", "/var/lib/postgresql"];

/** Why a destination's location is refused, or null when it is fine. */
export function locationProblem(kind: string, location: string): string | null {
  if (kind === "local") {
    if (!path.isAbsolute(location) || location.includes("..")) return "Give the full path of a folder, such as /var/backups/dbbkp.";
    const p = path.resolve(location);
    if (SYSTEM.includes(p) || SYSTEM.some((s) => s !== "/" && (p === s || (p.startsWith(s + "/") && ["/proc", "/sys", "/dev", "/etc", "/boot"].includes(s))))) return "That is a system folder. Choose a folder of its own, such as /var/backups/dbbkp.";
    return null;
  }
  if (kind === "rclone") {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}:[A-Za-z0-9_./ -]{0,250}$/.test(location) || location.includes("..")) return 'Write it the way rclone does: the remote name, a colon, then the folder, such as "gdrive:dbbkp".';
    return null;
  }
  const k = DESTINATION_KINDS.find((d) => d.kind === kind);
  return k && !k.available ? k.reason : "Unknown kind of destination.";
}

export async function sha256File(file: string): Promise<{ sha256: string; bytes: number }> {
  const h = crypto.createHash("sha256");
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (c: string | Buffer) => { const b = typeof c === "string" ? Buffer.from(c) : c; h.update(b); bytes += b.length; }).on("end", () => resolve()).on("error", reject);
  });
  return { sha256: h.digest("hex"), bytes };
}

function rclone(args: string[], opts: { hash?: boolean } = {}): Promise<{ code: number | null; stderr: string; sha256?: string }> {
  return new Promise((resolve) => {
    const h = crypto.createHash("sha256");
    let stderr = "";
    let settled = false;
    const child = spawn(rcloneBin(), args, { stdio: ["ignore", "pipe", "pipe"] });
    const done = (code: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      resolve({ code, stderr: (stderr + extra).trim().slice(-2000), ...(opts.hash ? { sha256: h.digest("hex") } : {}) });
    };
    child.on("error", (e: any) => done(null, e?.code === "ENOENT" ? "rclone is not installed on this server." : String(e?.message ?? e)));
    child.stdout!.on("data", (d: Buffer) => opts.hash && h.update(d));
    child.stderr!.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => done(code));
  });
}

const rcloneError = (stderr: string) => stderr.split("\n").map((l) => l.replace(/^\S+ \S+ (ERROR|NOTICE) : /, "").trim()).filter(Boolean).pop() ?? "rclone failed";

const joinRemote = (location: string, rel: string) => (location.endsWith(":") || location.endsWith("/") ? location + rel : `${location}/${rel}`);

/** Copies a local file to the destination under `rel` (folder/file). Returns where it is. */
export async function putFile(dest: DestinationRow, file: string, rel: string): Promise<string> {
  if (dest.kind === "local") {
    const to = path.join(dest.location, rel);
    await fs.ensureDir(path.dirname(to));
    await fs.copyFile(file, to + ".part");
    await fs.rename(to + ".part", to);
    return to;
  }
  if (dest.kind === "rclone") {
    const to = joinRemote(dest.location, rel);
    const r = await rclone(["copyto", file, to]);
    if (r.code !== 0) throw new Error(rcloneError(r.stderr));
    return to;
  }
  throw new Error(locationProblem(dest.kind, dest.location) ?? "This kind of destination is not available.");
}

/** Reads the copy back and compares its SHA-256. */
export async function verifyCopy(dest: DestinationRow, location: string, sha256: string): Promise<{ ok: boolean; error?: string }> {
  try {
    if (dest.kind === "local") return (await sha256File(location)).sha256 === sha256 ? { ok: true } : { ok: false, error: "The copy's SHA-256 does not match." };
    if (dest.kind === "rclone") {
      const r = await rclone(["cat", location], { hash: true });
      if (r.code !== 0) return { ok: false, error: rcloneError(r.stderr) };
      return r.sha256 === sha256 ? { ok: true } : { ok: false, error: "The copy's SHA-256 does not match." };
    }
  } catch (e: any) {
    return { ok: false, error: e?.code === "ENOENT" ? "The copy is not there any more." : e?.message ?? String(e) };
  }
  return { ok: false, error: "This kind of destination is not available." };
}

/** A local path to read the copy from; `temp` files are removed by the caller. */
export async function fetchCopy(dest: DestinationRow, location: string, tmpDir: string): Promise<{ file: string; temp: boolean }> {
  if (dest.kind === "local") {
    if (!(await fs.pathExists(location))) throw new Error(`The copy on ${dest.name} is not there any more.`);
    return { file: location, temp: false };
  }
  if (dest.kind === "rclone") {
    await fs.ensureDir(tmpDir);
    const file = path.join(tmpDir, `${crypto.randomUUID()}-${path.posix.basename(location)}`);
    const r = await rclone(["copyto", location, file]);
    if (r.code !== 0) throw new Error(rcloneError(r.stderr));
    return { file, temp: true };
  }
  throw new Error("This kind of destination is not available.");
}

export async function removeCopy(dest: DestinationRow, location: string) {
  if (dest.kind === "local") return fs.remove(location);
  if (dest.kind === "rclone") {
    const r = await rclone(["deletefile", location]);
    if (r.code !== 0 && !/not found|doesn't exist/i.test(r.stderr)) throw new Error(rcloneError(r.stderr));
  }
}

/** Writes a small file, reads it back and removes it. */
export async function checkDestination(dest: DestinationRow): Promise<{ ok: boolean; message: string }> {
  const problem = locationProblem(dest.kind, dest.location);
  if (problem) return { ok: false, message: problem };
  const tmp = path.join(localBackupDir(), ".staging");
  const name = `.dk-check-${crypto.randomUUID().slice(0, 8)}`;
  try {
    await fs.ensureDir(tmp);
    const file = path.join(tmp, name);
    const body = `Deploy King destination check ${new Date().toISOString()}\n`;
    await fs.writeFile(file, body);
    const want = crypto.createHash("sha256").update(body).digest("hex");
    const at = await putFile(dest, file, name);
    const v = await verifyCopy(dest, at, want);
    await removeCopy(dest, at).catch(() => {});
    await fs.remove(file);
    return v.ok ? { ok: true, message: "Wrote a test file, read it back and removed it." } : { ok: false, message: v.error ?? "The test file did not read back." };
  } catch (e: any) {
    return { ok: false, message: e?.code === "EACCES" ? "Deploy King may not write to that folder." : e?.message ?? String(e) };
  }
}
