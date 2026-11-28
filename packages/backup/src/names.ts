/**
 * Pure helpers for backups: names, labels, keep rules. No I/O, so they can be checked on fixed inputs.
 */

export type TargetRef = { type: "database"; id: string } | { type: "volume"; siteId: string; volume: string };

export const targetKey = (t: TargetRef) => (t.type === "database" ? `db:${t.id}` : `vol:${t.siteId}:${t.volume}`);

export function parseTargetKey(key: string): TargetRef | null {
  const db = /^db:([0-9a-f-]{36})$/.exec(key);
  if (db) return { type: "database", id: db[1]! };
  const vol = /^vol:([0-9a-f-]{36}):([a-z0-9][a-z0-9_-]{0,40})$/.exec(key);
  if (vol) return { type: "volume", siteId: vol[1]!, volume: vol[2]! };
  return null;
}

/** Safe for a file or folder name: lowercase letters, digits, - and _. */
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "backup";

const pad = (n: number) => String(n).padStart(2, "0");

/** "shop-db_2026-11-14_0200.dump": PostgreSQL custom format (compressed); volumes are .tar.gz. */
export function backupFileName(name: string, engine: string, at: Date, trigger = "manual") {
  const stamp = `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}_${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  const ext = engine === "files" ? "tar.gz" : engine === "mysql" ? "sql.gz" : "dump";
  return `${slug(name)}_${stamp}${trigger === "safety" ? "_safety" : ""}.${ext}`;
}

/** The folder a target's files go in at every destination. */
export const targetFolder = (name: string) => slug(name);

/** "shop_db_restore_1114": the name of a new copy. Database names here are lowercase letters, digits and _. */
export function restoreCopyName(dbName: string, at: Date, taken: (name: string) => boolean) {
  // PostgreSQL names stop at 63 characters; leave room for "_restore_1114" and a "_2"
  const base = `${dbName.replace(/[^a-z0-9_]/g, "_").slice(0, 46)}_restore_${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  if (!taken(base)) return base;
  for (let i = 2; i < 100; i++) if (!taken(`${base}_${i}`)) return `${base}_${i}`;
  return `${base}_${Date.now() % 100000}`;
}

/** The folder inside a volume that a "new copy" file restore goes into. */
export function restoreFolderName(at: Date) {
  return `restore-${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;
}

export function kindLabel(engine: string, volume?: string | null) {
  if (engine === "pgsql") return "PostgreSQL dump";
  if (engine === "mysql") return "MySQL dump";
  return `Files · ${volume ?? "volume"}`;
}

/**
 * Which backups a keep rule removes. `rows` are the backups of one target that still have a copy, any order.
 * Keeps the newest `keep`; never removes the newest good one, so a target is never left without a backup.
 */
export function overKeep<T extends { id: string; createdAt: Date | string | null }>(rows: T[], keep: number): T[] {
  if (keep <= 0) return [];
  const sorted = [...rows].sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
  return sorted.slice(Math.max(1, keep));
}

/** postgres://user:••••••@host:5432/db. Never contains the password. */
export function maskedUrl(parts: { scheme?: string; user: string; host: string; port: number | string; database: string }) {
  return `${parts.scheme ?? "postgres"}://${parts.user}:••••••@${parts.host}:${parts.port}/${parts.database}`;
}

/** Takes the password out of any URL-looking text (for error messages and logs). */
export function hidePasswords(text: string) {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s]+@/gi, "$1••••••@");
}

/** Parses a postgres:// URL. Returns null when it is not one. */
export function parsePgUrl(url: string): { user: string; password: string; host: string; port: number; database: string; params: URLSearchParams } | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "postgres:" && u.protocol !== "postgresql:") return null;
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!u.hostname || !database || !u.username) return null;
    return { user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), host: u.hostname, port: Number(u.port || 5432), database, params: u.searchParams };
  } catch {
    return null;
  }
}
