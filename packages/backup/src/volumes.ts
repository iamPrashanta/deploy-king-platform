import path from "node:path";
import fs from "fs-extra";
import Docker from "dockerode";

/**
 * An app's volumes as folders. The deploy worker names each volume dbbkp-<first 8 of the app id>-<name>.
 * Their files are read straight from the container engine's data folder:
 *   DK_VOLUME_ROOT, when set, is that folder (each volume at <root>/<volume>/_data, as Docker lays it out);
 *   otherwise the engine is asked where the volume is.
 * Deploy King must run where that folder can be reached (for the compose stack: mount /var/lib/docker/volumes).
 */

const docker = new Docker();

export const engineVolumeName = (siteId: string, volume: string) => `dbbkp-${siteId.slice(0, 8)}-${volume}`;

export class VolumeError extends Error {}

export async function volumeDir(siteId: string, volume: string): Promise<string> {
  const name = engineVolumeName(siteId, volume);
  let dir: string | null = null;
  if (process.env.DK_VOLUME_ROOT) dir = path.join(process.env.DK_VOLUME_ROOT, name, "_data");
  else {
    try {
      const info: any = await docker.getVolume(name).inspect();
      dir = info?.Mountpoint ?? null;
    } catch (e: any) {
      if (e?.statusCode === 404) throw new VolumeError("This volume has not been created yet. It is made on the app's first deploy.");
      throw new VolumeError("The container engine could not be reached, so the volume's folder is unknown.");
    }
  }
  if (!dir || !(await fs.pathExists(dir))) throw new VolumeError("This volume's folder cannot be reached from where Deploy King runs.");
  try {
    await fs.access(dir, fs.constants.R_OK);
  } catch {
    throw new VolumeError("Deploy King may not read this volume's folder.");
  }
  return dir;
}

/** A path inside `root`. Throws for anything that would leave it (../, absolute paths, a sibling like <root>-other). */
export function insideRoot(root: string, rel: string): string {
  const base = path.resolve(root);
  const clean = path.posix.normalize("/" + String(rel ?? "").replace(/\\/g, "/"));
  const full = path.resolve(base, "." + clean);
  if (full !== base && !full.startsWith(base + path.sep)) throw new VolumeError("That path is outside the volume.");
  return full;
}

/** Like insideRoot, and also refuses a path whose real location (after symbolic links) is outside the root. */
export async function realInsideRoot(root: string, rel: string): Promise<string> {
  const full = insideRoot(root, rel);
  const base = await fs.realpath(path.resolve(root));
  // the deepest part of the path that exists decides
  let probe = full;
  while (!(await fs.pathExists(probe)) && probe !== base && probe.length > base.length) probe = path.dirname(probe);
  const real = await fs.realpath(probe).catch(() => probe);
  if (real !== base && !real.startsWith(base + path.sep)) throw new VolumeError("That path leads outside the volume.");
  return full;
}

/** Total bytes under a folder (files only; links are not followed). */
export async function folderBytes(dir: string, limit = 200_000): Promise<{ bytes: number; files: number; partial: boolean }> {
  let bytes = 0, files = 0, seen = 0;
  const walk = async (d: string): Promise<boolean> => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.readdir(d, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (++seen > limit) return false;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!(await walk(p))) return false;
      } else if (e.isFile()) {
        files++;
        bytes += (await fs.lstat(p).catch(() => ({ size: 0 }))).size;
      }
    }
    return true;
  };
  const complete = await walk(dir);
  return { bytes, files, partial: !complete };
}
