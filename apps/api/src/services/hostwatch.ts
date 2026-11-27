import fs from "fs-extra";
import { db, hostItems, platformSettings, sites } from "@dbbkp/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { planFor, syncResults } from "./hostactions";
import { alertHostUrgent } from "@dbbkp/notify";

/**
 * Watching the server for things an intruder leaves behind.
 *
 * scripts/host-scan.py runs on the host every few minutes and writes a list of what is there: users,
 * admin rights, SSH keys and settings, scheduled jobs, services, startup files, listening ports and
 * containers, plus running programs and outgoing connections that show a sign of trouble.
 * This file compares each list with what the admin has already accepted (the baseline):
 *   - the very first list is shown once for review ("initial"), without raising alarms
 *   - after that, anything not in the baseline is a finding ("new"), and anything whose checksum
 *     differs is a finding ("changed"), whether or not it looks bad
 *   - the admin answers each finding: expected (it joins the baseline) or look later
 * Known bad signs (downloads piped into a shell, programs in temporary folders, miner names) only
 * raise how urgent a finding is. They are not what finds it.
 *
 * Steps 1 and 2 of claude/intrusion-watch-plan.md. Removing things from the panel comes later; until then
 * each finding says how to remove it by hand.
 */

export const HOST_SCAN_FILE = process.env.HOST_SCAN_FILE || "/host-scan/inventory.json";
/** The scan runs every 5 minutes; this long without a report means the watcher has stopped. */
const SILENT_AFTER_MS = 20 * 60_000;
const SNOOZE_MS = 24 * 60 * 60_000;
const MAX_ITEMS = 5000;

export const KINDS = ["user", "admin", "ssh_key", "sshd", "cron", "unit", "startup", "port", "process", "outbound", "container"] as const;
export type Kind = (typeof KINDS)[number];
export type Severity = "urgent" | "check" | "note";
export type Status = "initial" | "accepted" | "new" | "changed";

export type ReportItem = { kind: Kind; key: string; label: string; detail: Record<string, any>; fp: string };
/** scanned: the kinds really read this time. Missing in reports from older scan scripts. */
export type Report = { version: number; generatedAt: string; hostname: string; asRoot?: boolean; scanned?: string[]; items: ReportItem[] };
export type Known = { key: string; kind: string; fingerprint: string; status: Status; present: boolean; detail: Record<string, any> };

// ─── How urgent, and why ─────────────────────────────────────────────────────

const RISKY: Array<[RegExp, string]> = [
  [/(curl|wget|fetch)\b[^|;&]*\|\s*(ba|z|da)?sh\b/i, "It downloads something and runs it straight away."],
  [/base64\s+(-d|--decode)|\beval\b.*\$\(/i, "It runs hidden (encoded) commands."],
  [/(^|[\s"'=])\/(dev\/shm|tmp|var\/tmp)\//i, "It runs from a temporary folder, where real software is not installed."],
  [/\/dev\/tcp\/|\bnc(at)?\b.*\s-[a-z]*e\b|bash\s+-i\b/i, "It opens a remote shell to another machine."],
  [/xmrig|minerd|cpuminer|kdevtmpfsi|kinsing|stratum\+tcp|cryptonight/i, "It carries the name of a known coin miner."],
];
const risk = (text: unknown) => (typeof text === "string" ? RISKY.find(([re]) => re.test(text))?.[1] ?? null : null);

export type Assessment = { severity: Severity; reason: string };

/** How urgent a new or changed thing is, in one plain sentence. `admins`: users who can act as root. */
export function assess(item: ReportItem, change: "new" | "changed", admins: Set<string>, before?: Record<string, any>): Assessment {
  const d = item.detail ?? {};
  const urgent = (reason: string): Assessment => ({ severity: "urgent", reason });
  const check = (reason: string): Assessment => ({ severity: "check", reason });
  const note = (reason: string): Assessment => ({ severity: "note", reason });

  switch (item.kind) {
    case "user": {
      if (d.emptyPassword) return urgent(`${item.label} can sign in with no password at all.`);
      if (d.uid === 0 && item.label !== "root") return urgent(`${item.label} has user id 0, which makes it the same as root.`);
      if (change === "new") return d.login ? check(`A new account that can sign in to the server.`) : note(`A system account that cannot sign in. Packages create these.`);
      if (d.login && before && !before.login) return urgent(`${item.label} could not sign in before and now can.`);
      if (before && d.hasPassword && !before.hasPassword) return check(`${item.label} now has a password and can sign in with it.`);
      if (before && d.passwordChanged !== before.passwordChanged) return check(`The password of ${item.label} was changed${d.passwordChanged ? ` on ${d.passwordChanged}` : ""}.`);
      return d.login ? check(`The account ${item.label} was changed.`) : note(`A system account was changed.`);
    }
    case "admin":
      return urgent(d.rule ? `A sudo rule lets ${item.label} run commands as root: ${d.rule}` : `${d.user} can run anything as root (${d.via}).`);
    case "ssh_key": {
      const who = d.user === "root" ? "root" : admins.has(d.user) ? `${d.user}, who has admin rights,` : d.user;
      const reason = `Whoever holds this key can sign in as ${who} without a password.`;
      return d.user === "root" || admins.has(d.user) ? urgent(reason) : check(reason);
    }
    case "sshd": {
      const v = String(d.value ?? "").toLowerCase();
      if (d.setting === "PermitRootLogin" && v === "yes") return urgent("root can now sign in over SSH with a password.");
      if (d.setting === "PasswordAuthentication" && v === "yes" && change === "changed") return urgent("SSH accepts passwords again, so sign-ins can be guessed.");
      if (d.setting === "PermitEmptyPasswords" && v === "yes") return urgent("SSH accepts accounts that have no password.");
      if (d.setting === "AuthorizedKeysFile" && change === "changed") return urgent("SSH now reads sign-in keys from a different file, which the key list above does not cover.");
      if (d.setting === "Port") return check(`SSH now listens on port ${d.value}.`);
      return note(`The SSH setting ${d.setting} is now "${d.value}".`);
    }
    case "cron": {
      const bad = risk(d.command);
      if (bad) return urgent(`Runs as ${d.user} (${d.schedule}). ${bad}`);
      return check(d.script ? `A script that runs ${d.schedule} as root.` : `Runs as ${d.user} on a schedule (${d.schedule}).`);
    }
    case "unit": {
      const bad = risk(d.runs);
      const what = d.timer ? "timer" : "service";
      if (bad) return urgent(`A ${what}${d.enabled ? " that starts at every boot" : ""}. ${bad}`);
      if (d.origin === "package") return note(`A ${what} that came with a package, most likely from an install or update.`);
      if (d.origin === "home") return check(`A ${what} in a user's own folder. It starts when that user signs in.`);
      return check(d.enabled ? `A ${what} that starts at every boot.` : `A ${what} that is installed but does not start by itself.`);
    }
    case "startup": {
      if (d.file === "/etc/ld.so.preload" && (d.loads?.length ?? 0) > 0) return urgent(`Every program on the server now loads ${d.loads.join(", ")} first. This is how files and programs are hidden.`);
      if (d.file === "/etc/rc.local") return check("This file runs as root at every boot.");
      return check(d.file?.startsWith("/etc/") ? "This file runs for every user who signs in." : "This file runs every time that user signs in.");
    }
    case "port": {
      const bad = risk(d.program);
      if (bad) return urgent(`${d.program ?? "A program"} listens on port ${d.port}. ${bad}`);
      if (change === "changed" && before && before.program !== d.program) return check(`Port ${d.port} is now held by ${d.program ?? "another program"} (before: ${before.program ?? "unknown"}).`);
      return d.public ? check(`${d.program ?? "A program"} accepts connections from outside on port ${d.port}.`) : note(`${d.program ?? "A program"} listens on port ${d.port}, reachable from this server only.`);
    }
    case "process": {
      const signs: string[] = d.signs ?? [];
      const where = d.container ? ` inside container ${d.container}` : "";
      const copies = d.count > 1 ? ` (${d.count} copies)` : "";
      if (signs.includes("miner")) return urgent(`A coin miner is running${where}${copies}. It uses the server's CPU for someone else.`);
      if (signs.includes("temp")) return urgent(`A program is running from a temporary folder${where}${copies}. Real software is not installed there; this is where intruders drop theirs.`);
      if (signs.includes("fake-kernel")) return urgent(`A program calls itself "${d.command}" to look like part of the system kernel. Real kernel threads are not programs.`);
      if (signs.includes("deleted")) return urgent(`A program is running whose file was deleted after it started${where}. Programs that hide do this.`);
      if (signs.includes("hidden")) return check(`A program is running from a hidden folder in ${d.user ?? "a user"}'s home${where}.`);
      if (signs.includes("cpu")) return check(`Kept ${d.cpuPct}% of a CPU core busy for ${d.minutes} minutes${where}. Coin miners do this; so do video encoders and builds.`);
      if (signs.includes("old-copy")) return note(`An old copy is still running after its package was updated. Restart it so the update takes effect.`);
      return check("A program with an unusual sign is running.");
    }
    case "outbound": {
      const who = d.program ? `${d.program}${d.pid ? ` (process ${d.pid})` : ""}` : "A program";
      if (d.kind === "pool") return urgent(`${who} is connected to ${d.remote} on port ${d.port}, a port coin-mining pools use.`);
      if (d.kind === "chat") return urgent(`${who} is connected to ${d.remote} on port ${d.port}, a chat port that hijacked servers are controlled through.`);
      return check(`${who} is connected to ${d.remote} on port ${d.port}. Mining pools often use this port, though other software can too.`);
    }
    case "container": {
      const power = [d.privileged && "full access to the server", d.hostPid && "the server's own processes", d.hostNetwork && "the server's network", d.riskyMounts?.length && `the server's ${d.riskyMounts.join(", ")}`].filter(Boolean);
      if (power.length) return urgent(`Container ${d.name} has ${power.join(", ")}. Whoever controls it controls the server.`);
      if (change === "changed" && before && before.image !== d.image) return check(`Container ${d.name} now runs a different image: ${d.image} (before: ${before.image}).`);
      return check(`A container the panel did not start: ${d.name} (${d.image})${d.running ? "" : ", stopped"}.`);
    }
  }
  return check("Something on the server changed.");
}

// ─── Comparing a report with what is known ───────────────────────────────────

/** Things the platform makes itself. Accepted without asking, so its own install never looks like a break-in. */
const OWN = new Set(["user:dbbkp", "admin:dbbkp:group docker", "unit:dbbkp.service", "unit:dbbkp-scan.service", "unit:dbbkp-scan.timer", "unit:dbbkp-act.service", "unit:dbbkp-act.path", "unit:dbbkp-act.timer"]);
/** The platform's own containers. The API mounts the Docker socket and the agent sees the host's processes on purpose. */
const CORE_CONTAINERS = new Set(["dbbkp-postgres", "dbbkp-redis", "dbbkp-traefik", "dbbkp-api", "dbbkp-worker", "dbbkp-agent", "dbbkp-panel"]);

/**
 * Made by the platform itself, so accepted without asking. An app container counts only when its label names an
 * app that really exists: a label is easy to copy onto a container of one's own.
 */
function isOwn(key: string, kind: string, detail: Record<string, any> | undefined, siteIds: Set<string>) {
  if (OWN.has(key)) return true;
  if (kind !== "container" || !detail) return false;
  if (detail.site) return siteIds.has(detail.site) && !detail.privileged && !detail.hostPid && !(detail.riskyMounts?.length > 0);
  return CORE_CONTAINERS.has(detail.name);
}

export type Change = {
  insert: Array<{ kind: Kind; key: string; label: string; detail: Record<string, any>; fingerprint: string; status: Status; severity: Severity; reason: string }>;
  update: Array<{ key: string; set: Record<string, any> }>;
  /** Initial items that are gone before anyone reviewed them. */
  drop: string[];
  /** Accepted or open items that are no longer on the server. */
  gone: string[];
};

/** What to write for one report. Pure: no clock, no database. */
export function reconcile(known: Known[], report: Report, opts: { siteIds?: Set<string> } = {}): Change {
  const siteIds = opts.siteIds ?? new Set<string>();
  const out: Change = { insert: [], update: [], drop: [], gone: [] };
  const first = known.length === 0;
  const byKey = new Map(known.map((k) => [k.key, k]));
  const admins = new Set(report.items.filter((i) => i.kind === "admin" && i.detail?.user).map((i) => i.detail.user as string));
  const seen = new Set<string>();
  const kindsSeen = new Set<string>();

  for (const item of report.items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    kindsSeen.add(item.kind);
    const old = byKey.get(item.key);
    if (!old) {
      const a = assess(item, "new", admins);
      const status: Status = first ? "initial" : isOwn(item.key, item.kind, item.detail, siteIds) ? "accepted" : "new";
      out.insert.push({ kind: item.kind, key: item.key, label: item.label, detail: item.detail, fingerprint: item.fp, status, severity: a.severity, reason: a.reason });
      continue;
    }
    if (old.fingerprint === item.fp) {
      if (!old.present) out.update.push({ key: old.key, set: { present: true } }); // back as it was: nothing to report
      continue;
    }
    const a = assess(item, "changed", admins, old.detail);
    const set: Record<string, any> = { label: item.label, detail: item.detail, fingerprint: item.fp, present: true, severity: a.severity, reason: a.reason };
    if (old.status === "accepted" && !isOwn(old.key, item.kind, item.detail, siteIds)) Object.assign(set, { status: "changed", previous: old.detail, snoozedUntil: null, changedAt: "now" });
    out.update.push({ key: old.key, set });
  }

  // Kinds that were not read this time (a tool was missing or failed): their items are not "removed".
  // Older scan scripts do not say what they read; then a kind counts as read when any item of it came back.
  const scanned = report.scanned ? new Set(report.scanned) : kindsSeen;
  for (const k of known) {
    if (seen.has(k.key) || !k.present || !scanned.has(k.kind)) continue;
    if (k.status === "initial") out.drop.push(k.key);
    else out.gone.push(k.key);
  }
  return out;
}

// ─── How to remove it by hand ────────────────────────────────────────────────

const safe = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9._@:\/~+-]{1,200}$/.test(s);

/** Until the panel can remove things itself (with a copy and an undo), this is what the admin runs. */
export function howToRemove(row: { kind: string; key: string; label: string; detail: Record<string, any>; previous?: Record<string, any> | null }): { text: string; command?: string } {
  const d = row.detail ?? {};
  switch (row.kind) {
    case "user":
      return { text: "Lock the account and end its sessions. Delete it only once you are sure nothing needs it.", command: safe(row.label) ? `sudo usermod -L -s /usr/sbin/nologin ${row.label} && sudo pkill -KILL -u ${row.label}` : undefined };
    case "admin": {
      if (d.rule) return { text: `Remove this line from ${d.file}. Use visudo so a mistake cannot lock you out.`, command: safe(d.file) ? `sudo visudo -f ${d.file}` : undefined };
      const group = row.key.match(/:group ([a-z]+)$/)?.[1];
      if (group) return { text: `Take ${d.user} out of the ${group} group. It applies the next time they sign in, so end their sessions too.`, command: safe(d.user) ? `sudo gpasswd -d ${d.user} ${group} && sudo pkill -KILL -u ${d.user}` : undefined };
      return { text: `Lock ${d.user}, then give it its own user id (or delete it) with vipw.`, command: safe(d.user) ? `sudo usermod -L ${d.user} && sudo vipw` : undefined };
    }
    case "ssh_key":
      return { text: `Open ${d.file} and delete the line for this key${d.comment ? ` (it ends with "${d.comment}")` : ""}. The command lists each line with its fingerprint so you can find it.`, command: safe(d.file) ? `sudo ssh-keygen -lf ${d.file}` : undefined };
    case "sshd":
      return { text: `Set ${d.setting} back${row.previous?.value ? ` to "${row.previous.value}"` : ""} in /etc/ssh/sshd_config or a file in /etc/ssh/sshd_config.d, then check and reload. Keep your current session open until a new sign-in works.`, command: "sudo sshd -t && sudo systemctl reload ssh" };
    case "cron":
      if (d.script) return { text: "Stop the script from running, then look at what it does before deleting it.", command: safe(d.file) ? `sudo chmod -x ${d.file}` : undefined };
      return String(d.file).includes("/var/spool/cron")
        ? { text: `Delete this line from ${d.user}'s scheduled jobs.`, command: safe(d.user) ? `sudo crontab -u ${d.user} -e` : undefined }
        : { text: `Delete this line from ${d.file}.`, command: safe(d.file) ? `sudoedit ${d.file}` : undefined };
    case "unit":
      if (d.origin === "home") return { text: `Delete ${d.file}, then end that user's sessions so it stops.` };
      return { text: "Stop it, keep it from starting again, and move its file aside so you can still look at it.", command: safe(row.label) && safe(d.file) ? `sudo systemctl disable --now ${row.label} && sudo mv ${d.file} /root/removed-${row.label} && sudo systemctl daemon-reload` : undefined };
    case "startup":
      if (d.file === "/etc/ld.so.preload") return { text: "Empty /etc/ld.so.preload. The library it loads can hide files and programs from you, so do this from a rescue system if you can, and treat the server as broken into.", command: "sudo mv /etc/ld.so.preload /root/removed-ld.so.preload" };
      return { text: `Open ${d.file} and remove what was added. The panel keeps a checksum, not the content, so it cannot show you the difference.`, command: safe(d.file) ? `sudoedit ${d.file}` : undefined };
    case "port":
      return { text: "Find the program behind the port and stop it. The second command blocks the port from outside right now.", command: Number.isInteger(d.port) ? `sudo ss -ltnup 'sport = :${d.port}' ; sudo ufw deny ${d.port}/${d.protocol === "udp" ? "udp" : "tcp"}` : undefined };
    case "process": {
      const pids = (d.pids ?? []).filter((n: unknown) => Number.isInteger(n) && (n as number) > 1).slice(0, 10) as number[];
      const name = safe(row.label) ? row.label : "program";
      if ((d.signs ?? []).includes("old-copy")) return { text: "Restart the service this program belongs to, so the updated version runs." };
      if (d.container) return { text: `It runs inside container ${d.container}. Stop the container, then look at how its app was broken into before starting it again.`, command: /^[0-9a-f]{12}$/.test(d.container) ? `sudo docker stop ${d.container}` : undefined };
      if (!pids.length) return { text: "Find the program and stop it. Then look at the other findings: something usually starts it again." };
      return {
        text: "Freeze it, keep a copy of the program for later, then stop it. It usually comes back: look for a scheduled job, a service or a startup file among the other findings and remove that too.",
        command: `sudo kill -STOP ${pids.join(" ")} ; sudo cp /proc/${pids[0]}/exe /root/evidence-${name}-${pids[0]} ; sudo kill -KILL ${pids.join(" ")}`,
      };
    }
    case "outbound": {
      const ip = typeof d.remote === "string" && /^[0-9a-fA-F:.]{3,45}$/.test(d.remote) ? d.remote : null;
      const pid = Number.isInteger(d.pid) ? d.pid : null;
      return {
        text: "Block the address, then stop the program that made the connection. It is likely listed under running programs too.",
        command: ip ? `sudo ufw deny out to ${ip}${pid ? ` ; sudo kill -KILL ${pid}` : ""}` : undefined,
      };
    }
    case "container": {
      const rt = d.runtime === "podman" ? "podman" : "docker";
      return {
        text: "Keep it from starting again and stop it. It is kept, so you can still look inside; remove it once you know what it was.",
        command: safe(d.name) ? `sudo ${rt} update --restart=no ${d.name} ; sudo ${rt} stop ${d.name}` : undefined,
      };
    }
  }
  return { text: "Look at it on the server before removing it." };
}

// ─── Reading the report and writing the result ───────────────────────────────

const META_KEY = "hostwatch";
export type WatchMeta = { generatedAt: string; hostname: string; asRoot: boolean; ingestedAt: string; items: number };

export async function getMeta(): Promise<WatchMeta | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, META_KEY)).limit(1);
  return (row?.value as WatchMeta) ?? null;
}

/** Throws on anything that is not a report this version understands. The file comes from the host, so it is checked like any input. */
export function parseReport(text: string): Report {
  const r = JSON.parse(text);
  if (r?.version !== 1 || !Array.isArray(r.items) || typeof r.generatedAt !== "string" || Number.isNaN(Date.parse(r.generatedAt))) throw new Error("not a version 1 host report");
  if (r.items.length > MAX_ITEMS) throw new Error(`more than ${MAX_ITEMS} items`);
  const items: ReportItem[] = [];
  for (const i of r.items) {
    if (!i || !(KINDS as readonly string[]).includes(i.kind) || typeof i.key !== "string" || !i.key || i.key.length > 300 || typeof i.fp !== "string" || i.fp.length > 64) continue;
    items.push({ kind: i.kind, key: i.key, label: String(i.label ?? i.key).slice(0, 300), detail: i.detail && typeof i.detail === "object" ? i.detail : {}, fp: i.fp });
  }
  const scanned = Array.isArray(r.scanned) ? r.scanned.filter((k: unknown) => (KINDS as readonly string[]).includes(k as string)) : undefined;
  return { version: 1, generatedAt: r.generatedAt, hostname: String(r.hostname ?? "").slice(0, 120), asRoot: r.asRoot !== false, scanned, items };
}

export async function ingest(report: Report): Promise<{ added: number; changed: number; gone: number }> {
  const known = (await db
    .select({ key: hostItems.key, kind: hostItems.kind, fingerprint: hostItems.fingerprint, status: hostItems.status, present: hostItems.present, detail: hostItems.detail })
    .from(hostItems)) as Known[];
  const siteIds = new Set((await db.select({ id: sites.id }).from(sites)).map((x) => x.id));
  const change = reconcile(known, report, { siteIds });
  const now = new Date();
  for (let i = 0; i < change.insert.length; i += 200) {
    await db.insert(hostItems).values(change.insert.slice(i, i + 200).map((r) => ({ ...r, firstSeenAt: now, lastSeenAt: now }))).onConflictDoNothing();
  }
  for (const u of change.update) {
    const set = { ...u.set };
    if (set.changedAt === "now") set.changedAt = now;
    await db.update(hostItems).set(set).where(eq(hostItems.key, u.key));
  }
  for (let i = 0; i < change.drop.length; i += 200) await db.delete(hostItems).where(inArray(hostItems.key, change.drop.slice(i, i + 200)));
  for (let i = 0; i < change.gone.length; i += 200) await db.update(hostItems).set({ present: false }).where(inArray(hostItems.key, change.gone.slice(i, i + 200)));
  await db.update(hostItems).set({ lastSeenAt: now }).where(eq(hostItems.present, true));
  // Alerts for urgent findings that are new or changed in this report (at most one per finding per hour).
  const urgentNow = [
    ...change.insert.filter((r) => r.status === "new" && r.severity === "urgent").map((r) => ({ key: r.key, label: r.label, reason: r.reason, status: "new" })),
    ...change.update.filter((u) => u.set.status === "changed" && u.set.severity === "urgent").map((u) => ({ key: u.key, label: String(u.set.label), reason: String(u.set.reason), status: "changed" })),
  ];
  for (const f of urgentNow.slice(0, 20)) await alertHostUrgent(f);
  const value: WatchMeta = { generatedAt: report.generatedAt, hostname: report.hostname, asRoot: report.asRoot !== false, ingestedAt: now.toISOString(), items: report.items.length };
  await db.insert(platformSettings).values({ key: META_KEY, value }).onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedAt: now } });
  return { added: change.insert.filter((r) => r.status === "new").length, changed: change.update.filter((u) => u.set.status === "changed").length, gone: change.gone.length };
}

let lastMtime = 0;
/** Reads the report if the host wrote a newer one. Returns what changed, or null when there was nothing new to read. */
export async function checkReport(file = HOST_SCAN_FILE) {
  const st = await fs.stat(file).catch(() => null);
  if (!st || st.mtimeMs === lastMtime || st.size > 8 * 1024 * 1024) return null;
  const report = parseReport(await fs.readFile(file, "utf8"));
  lastMtime = st.mtimeMs;
  const meta = await getMeta();
  if (meta && Date.parse(meta.generatedAt) >= Date.parse(report.generatedAt)) return null; // already read (the API restarted)
  return ingest(report);
}

export function startHostWatch() {
  setInterval(() => syncResults().catch((e) => console.error("[HostWatch] could not read action results:", e?.message ?? e)), 15_000);
  console.log(`[HostWatch] Reading the host scan from ${HOST_SCAN_FILE} once a minute`);
  const tick = () => checkReport().then((r) => r && (r.added || r.changed) && console.log(`[HostWatch] ${r.added} new, ${r.changed} changed`)).catch((e) => console.error("[HostWatch] could not read the report:", e?.message ?? e));
  setTimeout(tick, 20_000);
  setInterval(tick, 60_000);
}

// ─── What the panel asks ─────────────────────────────────────────────────────

const open = () => sql`${hostItems.status} in ('new', 'changed') and (${hostItems.snoozedUntil} is null or ${hostItems.snoozedUntil} < now())`;

export async function summary() {
  const meta = await getMeta();
  const rows = await db.select({ status: hostItems.status, severity: hostItems.severity, n: sql<number>`count(*)::int` }).from(hostItems).where(sql`${hostItems.status} = 'initial' or ${hostItems.status} = 'accepted' or (${open()})`).groupBy(hostItems.status, hostItems.severity);
  const count = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((n, r) => n + r.n, 0);
  const isOpen = (r: (typeof rows)[number]) => r.status === "new" || r.status === "changed";
  return {
    /** false until the host has sent its first report: the scan is not installed, or has not run yet. */
    installed: !!meta,
    hostname: meta?.hostname ?? null,
    lastReportAt: meta?.generatedAt ?? null,
    /** The watcher has stopped reporting. An intruder would stop it first, so this is urgent by itself. */
    silent: !!meta && Date.now() - Date.parse(meta.generatedAt) > SILENT_AFTER_MS,
    asRoot: meta?.asRoot ?? true,
    urgent: count((r) => isOpen(r) && r.severity === "urgent"),
    check: count((r) => isOpen(r) && r.severity === "check"),
    note: count((r) => isOpen(r) && r.severity === "note"),
    toReview: count((r) => r.status === "initial"),
    baseline: count((r) => r.status === "accepted"),
  };
}

const RANK = sql`case ${hostItems.severity} when 'urgent' then 0 when 'check' then 1 else 2 end`;

export async function findings() {
  const rows = await db.select().from(hostItems).where(open()).orderBy(RANK, sql`coalesce(${hostItems.changedAt}, ${hostItems.firstSeenAt}) desc`).limit(500);
  return rows.map((r) => {
    const plan = planFor(r as any);
    // What "Remove" will do, in words. The target itself is rebuilt on the server when the admin confirms.
    return { ...r, remove: howToRemove(r as any), autoRemove: plan ? { text: plan.text, warning: plan.warning ?? null } : null };
  });
}

export const listByStatus = (status: "initial" | "accepted", kind?: Kind) =>
  db.select().from(hostItems).where(kind ? and(eq(hostItems.status, status), eq(hostItems.kind, kind)) : eq(hostItems.status, status)).orderBy(RANK, hostItems.kind, hostItems.label).limit(MAX_ITEMS);

/**
 * expected: it joins the baseline. later: hidden for a day, then shown again.
 * dismiss: only for a finding that is no longer on the server (it was removed). The row is deleted, so the
 * same thing coming back is a new finding again; the audit log keeps the record.
 */
export async function decide(ids: string[], answer: "expected" | "later" | "dismiss", userId: string, note?: string) {
  const now = new Date();
  if (answer === "dismiss") {
    return db.delete(hostItems).where(and(inArray(hostItems.id, ids), inArray(hostItems.status, ["new", "changed"]), eq(hostItems.present, false))).returning({ key: hostItems.key, label: hostItems.label, severity: hostItems.severity });
  }
  const set = answer === "expected" ? { status: "accepted", previous: null, snoozedUntil: null, decidedBy: userId, decidedAt: now, note: note ?? null } : { snoozedUntil: new Date(now.getTime() + SNOOZE_MS) };
  const done = await db.update(hostItems).set(set).where(and(inArray(hostItems.id, ids), inArray(hostItems.status, ["new", "changed"]))).returning({ key: hostItems.key, label: hostItems.label, severity: hostItems.severity });
  return done;
}

/** The one-time review after the first scan: everything on the list becomes the baseline. */
export async function acceptInitial(userId: string) {
  const done = await db.update(hostItems).set({ status: "accepted", decidedBy: userId, decidedAt: new Date() }).where(eq(hostItems.status, "initial")).returning({ id: hostItems.id });
  return done.length;
}
