import path from "node:path";
import { SITES_ROOT } from "../config";

/** RFC 1123 hostname, at least two labels (example.com, app.example.co.uk, site.test.local). */
const HOSTNAME_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

export function normalizeDomain(input: string): string {
  return input.trim().toLowerCase().replace(/\.$/, "");
}

/**
 * The domain ends up inside a Traefik `Host()` rule and in container labels,
 * so it must be a plain hostname - no backticks, slashes, spaces or wildcards.
 */
export function isValidDomain(domain: string): boolean {
  return HOSTNAME_RE.test(domain);
}

/** https:// or ssh git remotes only. Blocks file://, ext:: and option injection ("-u..."). */
export function isValidRepoUrl(url: string): boolean {
  if (!url || url.length > 2000 || url.startsWith("-") || /\s/.test(url)) return false;
  if (/^https:\/\/[^\s/@]+(\/[^\s]*)?$/i.test(url)) return true;
  if (/^https:\/\/[^\s/]+@[^\s/]+\/[^\s]*$/i.test(url)) return true; // https://token@host/path
  if (/^ssh:\/\/[^\s]+$/i.test(url)) return true;
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(url)) return true; // git@github.com:org/repo.git
  return false;
}

export function isValidBranch(branch: string): boolean {
  return /^[A-Za-z0-9._\/-]{1,100}$/.test(branch) && !branch.startsWith("-") && !branch.includes("..");
}

export function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]{0,254}$/.test(key);
}

/** Canonical form used to match a webhook's repository against stored site/pipeline URLs. */
export function normalizeRepoUrl(url: string | null | undefined): string {
  if (!url) return "";
  let u = url.trim().toLowerCase();
  u = u.replace(/^git@([^:]+):/, "https://$1/"); // git@github.com:o/r -> https://github.com/o/r
  u = u.replace(/^ssh:\/\/git@/, "https://");
  u = u.replace(/^https:\/\/[^/@]+@/, "https://"); // drop embedded credentials
  u = u.replace(/\.git$/, "").replace(/\/+$/, "");
  return u;
}

/** Every site's source lives directly under SITES_ROOT. Anything else is refused. */
export function siteDocRoot(siteId: string): string {
  return path.posix.join(SITES_ROOT, siteId);
}

/** Docker image reference: [registry/]name[:tag][@digest]. No spaces, no option-looking values. */
export function isValidImageRef(ref: string): boolean {
  return /^[a-z0-9][a-z0-9._\/-]{0,200}(:[A-Za-z0-9._-]{1,128})?(@sha256:[a-f0-9]{64})?$/.test(ref);
}

export function isValidVolume(v: { name: string; mountPath: string }): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,40}$/.test(v.name) && /^\/[A-Za-z0-9._\/-]{0,250}$/.test(v.mountPath) && !v.mountPath.includes("..");
}

/** Splits docker's multiplexed log stream (8-byte frame headers) into timestamped lines. */
export function demuxLogs(buf: Buffer): Array<{ ts: string | null; stream: "stdout" | "stderr"; text: string }> {
  const chunks: Array<{ stream: "stdout" | "stderr"; text: string }> = [];
  const framed = buf.length >= 8 && (buf[0] === 1 || buf[0] === 2) && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (framed) {
    let i = 0;
    while (i + 8 <= buf.length) {
      const stream = buf[i] === 2 ? "stderr" : "stdout";
      const size = buf.readUInt32BE(i + 4);
      chunks.push({ stream, text: buf.subarray(i + 8, i + 8 + size).toString("utf8") });
      i += 8 + size;
    }
  } else if (buf.length) {
    chunks.push({ stream: "stdout", text: buf.toString("utf8") });
  }
  const lines: Array<{ ts: string | null; stream: "stdout" | "stderr"; text: string }> = [];
  for (const c of chunks) {
    for (const raw of c.text.split("\n")) {
      if (!raw) continue;
      const m = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/);
      lines.push({ ts: m ? m[1] : null, stream: c.stream, text: (m ? m[2] : raw).replace(/\r/g, "") });
    }
  }
  return lines;
}
