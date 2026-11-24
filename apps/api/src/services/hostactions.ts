import path from "node:path";
import fs from "fs-extra";
import { db, hostActions, hostItems, users } from "@dbbkp/db";
import { and, desc, eq, inArray } from "drizzle-orm";

/**
 * "Remove" and "Undo" for findings on the Security page.
 *
 * The API cannot change the server: it runs in a container. It writes a request file naming one action
 * from a fixed list and its target; scripts/host-act.py, running as root on the server, checks it again,
 * keeps a copy of whatever it changes, does it, and writes a result. Undo works for 30 days.
 *
 *   <dir>/requests/<id>.json         written here
 *   <dir>/results/<id>.json          written by the helper, read here
 *   <dir>/results/helper.json        the helper's heartbeat: it is installed and running
 *
 * Step 3 of claude/intrusion-watch-plan.md.
 */

export const HOST_ACTIONS_DIR = process.env.HOST_ACTIONS_DIR || "/host-actions";
const HELPER_STALE_MS = 15 * 60_000;
const UNDO_DAYS = 30;

export type Plan = { action: string; target: Record<string, any>; text: string; warning?: string };
type Item = { kind: string; key: string; label: string; detail: Record<string, any> };

const lastPart = (key: string) => key.split(":").pop() ?? "";

/** What "Remove" does for this finding, in words, or null when it must be done by hand. The target is rebuilt here, never taken from the browser. */
export function planFor(item: Item): Plan | null {
  const d = item.detail ?? {};
  switch (item.kind) {
    case "user":
      if (item.label === "root" || d.uid === 0) return null;
      return { action: "lock-user", target: { user: item.label }, text: `Lock the account ${item.label}: it can no longer sign in, and its open sessions end.`, warning: `Programs running as ${item.label} stop too. The account and its files are kept; undo unlocks it.` };
    case "admin": {
      if (d.rule) return { action: "remove-sudo-rule", target: { file: d.file, ruleHash: lastPart(item.key) }, text: `Remove this sudo rule from ${d.file}: ${d.rule}`, warning: "The file is checked with visudo before it is replaced, so a mistake cannot break sudo." };
      const group = item.key.match(/:group ([a-z_][a-z0-9_.-]*)$/)?.[1];
      if (!group) return null; // user id 0: fixed by hand
      return { action: "remove-group", target: { user: d.user, group }, text: `Take ${d.user} out of the ${group} group.`, warning: "It applies from their next sign-in. Lock the account as well if it should not be used at all." };
    }
    case "ssh_key":
      return { action: "remove-ssh-key", target: { user: d.user, fingerprint: d.fingerprint, file: d.file }, text: `Remove the key ${d.comment ? `"${d.comment}" ` : ""}(${String(d.fingerprint).slice(0, 20)}…) from ${d.file}.`, warning: "If this is a key you use yourself, you will not be able to sign in with it any more. Keep another way in until you are sure." };
    case "cron":
      if (d.script) return { action: "disable-cron-script", target: { file: d.file }, text: `Stop ${d.file} from running ${d.schedule}. The file is kept, without permission to run.` };
      return { action: "remove-cron-line", target: { file: d.file, lineHash: lastPart(item.key) }, text: `Remove this scheduled job from ${d.file}: ${d.command}` };
    case "unit": {
      const user = item.key.match(/^unit:~([^/]+)\//)?.[1];
      if (d.origin === "home") return { action: "disable-unit", target: { name: item.label, file: d.file, origin: "home", user }, text: `Move ${item.label} out of ${user}'s folder, so it no longer starts when they sign in.` };
      return {
        action: "disable-unit",
        target: { name: item.label, file: d.file, origin: d.origin, enabled: !!d.enabled },
        text: `Stop ${item.label} and keep it from starting again${d.origin === "admin" ? "; its file is moved aside" : ""}.`,
        warning: d.origin === "package" ? "It came with a package. Removing the package is the clean fix; this only switches it off." : undefined,
      };
    }
    case "process": {
      if ((d.signs ?? []).includes("old-copy")) return null;
      const temp = (d.signs ?? []).some((s: string) => ["temp", "hidden", "deleted", "miner"].includes(s)) && !d.container;
      return {
        action: "stop-process",
        target: { exe: d.exe, pids: d.pids, container: d.container ?? null },
        text: `Freeze and stop ${d.count > 1 ? `the ${d.count} copies of ` : ""}${d.exe}, keeping a copy of the program for later${temp ? ", and move its file to quarantine" : ""}.`,
        warning: "If a scheduled job, service or startup file starts it again, remove that too: it is usually among the other findings.",
      };
    }
    case "outbound":
      return { action: "block-address", target: { ip: d.remote }, text: `Block every connection from this server to ${d.remote}.`, warning: d.pid ? `The program that connected (${d.program ?? "process " + d.pid}) keeps running; stop it from its own finding.` : undefined };
    case "container":
      return { action: "stop-container", target: { name: d.name, runtime: d.runtime, restart: d.restart ?? "no" }, text: `Stop container ${d.name} and keep it from starting again. It is kept, so you can look inside it.` };
  }
  return null; // SSH settings, startup files and ports: a mistake there can lock you out, so they stay manual
}

export async function helperStatus() {
  try {
    const hb = await fs.readJson(path.join(HOST_ACTIONS_DIR, "results", "helper.json"));
    const at = Date.parse(hb.at);
    return { installed: true, running: hb.version === 1 && Date.now() - at < HELPER_STALE_MS, lastSeenAt: hb.at as string, actions: (hb.actions ?? []) as string[] };
  } catch {
    return { installed: false, running: false, lastSeenAt: null, actions: [] as string[] };
  }
}

async function writeRequest(id: string, body: Record<string, any>) {
  const dir = path.join(HOST_ACTIONS_DIR, "requests");
  await fs.ensureDir(dir);
  const tmp = path.join(dir, `.${id}.tmp`);
  await fs.writeJson(tmp, { version: 1, id, ...body });
  await fs.rename(tmp, path.join(dir, `${id}.json`)); // the helper sees the whole file or nothing
}

export class ActionError extends Error {}

export async function requestRemoval(itemId: string, user: { sub: string; username: string }) {
  const [item] = await db.select().from(hostItems).where(eq(hostItems.id, itemId)).limit(1);
  if (!item || !["new", "changed"].includes(item.status)) throw new ActionError("That finding is no longer open.");
  if (!item.present) throw new ActionError("It is already gone from the server. Clear the finding instead.");
  const plan = planFor(item as Item);
  if (!plan) throw new ActionError("This one has to be fixed by hand on the server.");
  const helper = await helperStatus();
  if (!helper.running) throw new ActionError("The helper on the server is not running, so nothing can be removed from here.");
  if (!helper.actions.includes(plan.action)) throw new ActionError("The helper on the server is too old for this. Run install-scan.sh again to update it.");
  const busy = await db.select({ id: hostActions.id }).from(hostActions).where(and(eq(hostActions.itemKey, item.key), inArray(hostActions.status, ["pending", "undo-pending"]))).limit(1);
  if (busy.length) throw new ActionError("The server is already working on this one.");
  const [row] = await db.insert(hostActions).values({ itemKey: item.key, itemLabel: item.label, kind: item.kind, action: plan.action, target: plan.target, plan: plan.text, requestedBy: user.sub }).returning();
  await writeRequest(row.id, { action: plan.action, target: plan.target, requestedBy: user.username });
  return row;
}

export async function requestUndo(actionId: string, user: { sub: string; username: string }) {
  const [row] = await db.select().from(hostActions).where(eq(hostActions.id, actionId)).limit(1);
  if (!row || row.status !== "done" || !row.undoable) throw new ActionError("There is nothing to undo for this.");
  if (row.finishedAt && Date.now() - new Date(row.finishedAt).getTime() > UNDO_DAYS * 86400_000) throw new ActionError(`Undo is only possible for ${UNDO_DAYS} days.`);
  if (!(await helperStatus()).running) throw new ActionError("The helper on the server is not running, so nothing can be undone from here.");
  await db.update(hostActions).set({ status: "undo-pending", undoBy: user.sub, undoAt: new Date() }).where(eq(hostActions.id, row.id));
  await writeRequest(`${row.id}.undo`, { action: "undo", target: {}, requestedBy: user.username });
  return row;
}

/** Reads the helper's answers for everything still waiting. */
export async function syncResults() {
  const waiting = await db.select().from(hostActions).where(inArray(hostActions.status, ["pending", "undo-pending"]));
  let changed = 0;
  for (const row of waiting) {
    const undo = row.status === "undo-pending";
    const file = path.join(HOST_ACTIONS_DIR, "results", `${row.id}${undo ? ".undo" : ""}.json`);
    const res = await fs.readJson(file).catch(() => null);
    if (!res) continue;
    const message = String(res.message ?? "").slice(0, 1000);
    await db
      .update(hostActions)
      .set(undo ? { status: res.ok ? "undone" : "done", undoMessage: message } : { status: res.ok ? "done" : "failed", message, undoable: !!res.undoable, finishedAt: new Date() })
      .where(eq(hostActions.id, row.id));
    changed++;
  }
  return changed;
}

export async function listActions(limit = 100) {
  const rows = await db
    .select({ a: hostActions, by: users.username })
    .from(hostActions)
    .leftJoin(users, eq(users.id, hostActions.requestedBy))
    .orderBy(desc(hostActions.requestedAt))
    .limit(limit);
  return rows.map(({ a, by }) => ({
    ...a,
    requestedByName: by,
    canUndo: a.status === "done" && a.undoable && !!a.finishedAt && Date.now() - new Date(a.finishedAt).getTime() < UNDO_DAYS * 86400_000,
  }));
}
