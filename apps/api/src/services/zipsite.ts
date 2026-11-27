import path from "path";
import fs from "fs-extra";
import AdmZip from "adm-zip";

export class UnsafeArchiveError extends Error {}

/**
 * Unpacks an uploaded project ZIP into an app's folder. Refuses archives with entries that would land
 * outside it, and unwraps the single top-level folder a ZIP of a folder usually has.
 */
export async function extractProjectZip(zipPath: string, sitePath: string) {
  await fs.ensureDir(sitePath);
  const zip = new AdmZip(zipPath);
  for (const entry of zip.getEntries()) {
    const target = path.resolve(sitePath, entry.entryName);
    if (target !== sitePath && !target.startsWith(sitePath + path.sep)) {
      await fs.remove(sitePath);
      throw new UnsafeArchiveError("Archive contains an unsafe path");
    }
  }
  zip.extractAllTo(sitePath, true);

  const entries = (await fs.readdir(sitePath)).filter((n) => n !== "__MACOSX");
  if (entries.length === 1 && (await fs.stat(path.join(sitePath, entries[0]))).isDirectory()) {
    const inner = path.join(sitePath, entries[0]);
    for (const name of await fs.readdir(inner)) {
      await fs.move(path.join(inner, name), path.join(sitePath, name), { overwrite: true });
    }
    await fs.remove(inner);
  }
}
