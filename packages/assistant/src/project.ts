import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import AdmZip from "adm-zip";
import * as buildplanNs from "@dbbkp/buildplan";
import { SECRET_NAME } from "./secrets";

/**
 * The project check of a ZIP (or folder) the user attached, run here with the same analyser the server
 * uses (packages/buildplan), so nothing is uploaded before the user approved a plan.
 */

const MAX_ENTRIES = 100_000;
const MAX_UNPACKED = 2 * 1024 * 1024 * 1024;
const SKIP = new Set(["node_modules", ".git", ".next", "__MACOSX", ".venv", "venv", "__pycache__", ".turbo", ".cache"]);

// @dbbkp/buildplan is CommonJS source: under Node's ESM loader its functions sit on the default export.
const buildplan: typeof buildplanNs = ((buildplanNs as any).analyzeProject ? buildplanNs : (buildplanNs as any).default) as typeof buildplanNs;
const { analyzeProject, appFolders } = buildplan;

export interface PreparedUpload {
  zip: Uint8Array;
  bytes: number;
  sha256: string;
}

export class ProjectError extends Error {}

/** Unpacks a ZIP into a new temporary folder, refusing entries that would land outside it. */
function unpack(zipPath: string): string {
  let zip: AdmZip;
  try {
    zip = new AdmZip(zipPath);
  } catch {
    throw new ProjectError(`${path.basename(zipPath)} is not a readable ZIP file`);
  }
  const entries = zip.getEntries();
  if (entries.length > MAX_ENTRIES) throw new ProjectError(`The ZIP has more than ${MAX_ENTRIES} files`);
  let total = 0;
  for (const e of entries) total += e.header.size;
  if (total > MAX_UNPACKED) throw new ProjectError("The ZIP unpacks to more than 2 GB");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dk-check-"));
  for (const e of entries) {
    const target = path.resolve(dir, e.entryName);
    if (target !== dir && !target.startsWith(dir + path.sep)) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw new ProjectError("The ZIP contains an unsafe path (an entry outside its folder); it will not be deployed");
    }
  }
  zip.extractAllTo(dir, true);
  return dir;
}

/** A ZIP of a folder usually wraps everything in one folder; the server unwraps it the same way. */
function projectRoot(dir: string) {
  const entries = fs.readdirSync(dir).filter((n) => n !== "__MACOSX");
  if (entries.length === 1 && fs.statSync(path.join(dir, entries[0]!)).isDirectory()) return path.join(dir, entries[0]!);
  return dir;
}

export function isZip(p: string) {
  return /\.zip$/i.test(p);
}

/** Runs the project check on a ZIP file or a folder. */
export function checkProject(filePath: string) {
  if (!fs.existsSync(filePath)) throw new ProjectError(`${filePath} does not exist`);
  const isDir = fs.statSync(filePath).isDirectory();
  if (!isDir && !isZip(filePath)) throw new ProjectError("Only ZIP files and folders can be checked and deployed");
  const tmp = isDir ? null : unpack(filePath);
  try {
    // A folder holding one folder is unwrapped like a ZIP is (the server does the same with the upload).
    const root = projectRoot(isDir ? filePath : tmp!);
    const r = analyzeProject(root);
    const folders = (() => {
      try {
        return appFolders(root);
      } catch {
        return [];
      }
    })();
    return {
      verdict: r.verdict,
      summary: r.summary,
      framework: r.framework,
      runtime: r.runtime,
      port: r.port,
      facts: r.facts.map((f) => `${f.label}: ${f.value}`),
      problems: r.checks.filter((c) => c.level === "bad" || c.level === "warn").map((c) => ({ level: c.level, title: c.title, detail: c.detail })),
      variables: r.env
        .filter((e) => !e.platform)
        .map((e) => ({
          key: e.key,
          // Examples of secret variables are not passed on: a committed .env can hold real values.
          example: SECRET_NAME.test(e.key) || e.placeholder ? undefined : e.example || undefined,
          needsValue: e.placeholder || !e.value,
          canGenerate: e.canGenerate || undefined,
          isAppUrl: e.appUrl || undefined,
        })),
      services: r.services,
      questions: r.questions.map((q) => ({ question: q.title, detail: q.detail, default: q.default, suggested: q.suggested, options: q.options?.map((o) => o.value) })),
      appFolders: folders.length ? folders : undefined,
      error: r.error ?? undefined,
      files: r.stats.files,
    };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Only the last one is kept: plans are shown and run right after each other, and ZIPs can be big. */
let last: { path: string; stamp: string; prepared: PreparedUpload } | null = null;

/**
 * What the upload of a path is made of: size and time of the ZIP, or of every file in the folder (a folder's
 * own time does not change when a file inside it is edited). Cheap next to zipping it again.
 */
function stampOf(filePath: string, st: fs.Stats): string {
  if (!st.isDirectory()) return `${st.size}:${st.mtimeMs}`;
  const h = crypto.createHash("sha1");
  const walk = (dir: string, rel: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (SKIP.has(name)) continue;
      const full = path.join(dir, name);
      const s = fs.lstatSync(full);
      if (s.isSymbolicLink()) continue;
      if (s.isDirectory()) walk(full, `${rel}${name}/`);
      else if (s.isFile()) h.update(`${rel}${name}\0${s.size}\0${s.mtimeMs}\n`);
    }
  };
  walk(filePath, "");
  return h.digest("hex");
}

/** The bytes to upload: the ZIP as it is, or a folder zipped without node_modules, .git and build caches. */
export function prepareUpload(filePath: string): PreparedUpload {
  const st = fs.statSync(filePath);
  const stamp = stampOf(filePath, st);
  if (last && last.path === filePath && last.stamp === stamp) return last.prepared;
  let zip: Uint8Array;
  if (st.isDirectory()) {
    const z = new AdmZip();
    const add = (dir: string, rel: string) => {
      for (const name of fs.readdirSync(dir)) {
        if (SKIP.has(name)) continue;
        const full = path.join(dir, name);
        const s = fs.lstatSync(full);
        if (s.isSymbolicLink()) continue;
        const relName = rel ? `${rel}/${name}` : name;
        if (s.isDirectory()) add(full, relName);
        else if (s.isFile()) z.addFile(relName, fs.readFileSync(full));
      }
    };
    add(filePath, "");
    zip = z.toBuffer();
  } else {
    if (!isZip(filePath)) throw new ProjectError("Only ZIP files and folders can be deployed");
    zip = fs.readFileSync(filePath);
  }
  const prepared = { zip, bytes: zip.byteLength, sha256: crypto.createHash("sha256").update(zip).digest("hex") };
  last = { path: filePath, stamp, prepared };
  return prepared;
}

export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
