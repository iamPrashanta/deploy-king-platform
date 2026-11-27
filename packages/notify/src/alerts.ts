import { db, alertState } from "@dbbkp/db";
import { decrypt } from "@dbbkp/security";
import { and, desc, eq, sql } from "drizzle-orm";
import { alertRecipients, getAlertSettings, panelUrl, type AlertEvents, type AlertSettingsStored } from "./settings";
import { sendMail } from "./mailer";
import { renderAlertEmail } from "./templates";

/**
 * Alerts: an email and/or a message to a webhook (Slack and Discord incoming webhooks, or anything that takes JSON)
 * when something needs a person. The same item is alerted at most once an hour; repeats in between are counted, not sent.
 */

export type AlertKind = "job_failed" | "worker_crash" | "deploy_failed" | "host_urgent" | "test";
export type Alert = { kind: AlertKind; key: string; title: string; text: string; /** a panel path such as /apps/<id>, or a full URL */ link?: string | null };
export type AlertOutcome = { sent: boolean; reason?: "event off" | "no channel" | "repeat"; result?: Record<string, string> };

export const REPEAT_WINDOW_MS = 60 * 60 * 1000;

const EVENT_OF: Record<Exclude<AlertKind, "test">, keyof AlertEvents> = {
  job_failed: "jobFailed",
  worker_crash: "workerCrash",
  deploy_failed: "deployFailed",
  host_urgent: "hostUrgent",
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal; redirect?: "manual" }) => Promise<{ ok: boolean; status: number }>;
let testFetch: FetchLike | null = null;
/** Tests only: webhook calls go here instead of the network. */
export function setWebhookFetchForTests(f: FetchLike | null) {
  testFetch = f;
}

/** The JSON body for a webhook. Slack reads `text`, Discord reads `content`; other services get both and the details. */
export function webhookBody(url: string, a: { kind: string; title: string; text: string; link?: string | null }) {
  const line = `*${a.title}*\n${a.text}${a.link ? `\n${a.link}` : ""}`;
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {}
  if (/(^|\.)discord(app)?\.com$/.test(host)) return { username: "Deploy King", content: `**${a.title}**\n${a.text}${a.link ? `\n${a.link}` : ""}`.slice(0, 1900) };
  if (/(^|\.)slack\.com$/.test(host)) return { text: line.slice(0, 3500) };
  return { text: line.slice(0, 3500), content: line.slice(0, 1900), title: a.title, kind: a.kind, link: a.link ?? null };
}

export async function postWebhook(url: string, body: unknown): Promise<string> {
  const f: FetchLike = testFetch ?? ((u, init) => fetch(u, init as RequestInit));
  try {
    const res = await f(url, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "DeployKing-Alerts" }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: "manual" });
    return res.ok ? "sent" : `HTTP ${res.status}`;
  } catch (e: any) {
    return `failed: ${String(e?.message ?? e).slice(0, 120)}`;
  }
}

async function absolute(link?: string | null) {
  if (!link) return null;
  if (/^https?:\/\//.test(link)) return link;
  const base = await panelUrl();
  return base ? base + link : null;
}

/** Sends to every channel that is switched on. Does not look at events or repeats. */
export async function deliver(s: AlertSettingsStored, a: Alert): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const link = await absolute(a.link);
  if (s.email.on) {
    const to = await alertRecipients(s);
    if (!to.length) result.email = "no recipients";
    else {
      try {
        await sendMail({ to, ...renderAlertEmail({ title: a.title, text: a.text, link }) });
        result.email = "sent";
      } catch (e: any) {
        result.email = `failed: ${String(e?.message ?? e).slice(0, 120)}`;
      }
    }
  }
  if (s.webhook.on && s.webhook.url) {
    let url = "";
    try {
      url = decrypt(s.webhook.url);
    } catch {
      result.webhook = "failed: the saved webhook address cannot be read (MASTER_KEY changed?)";
    }
    if (url) result.webhook = await postWebhook(url, webhookBody(url, { kind: a.kind, title: a.title, text: a.text, link }));
  }
  return result;
}

/**
 * Claims the right to send this alert now. Atomic: two processes raising the same alert at once send it once.
 * Returns false when the same item was alerted less than an hour ago (the repeat is counted instead).
 */
export async function claim(a: Pick<Alert, "kind" | "key" | "title">): Promise<boolean> {
  const won = await db
    .insert(alertState)
    .values({ kind: a.kind, itemKey: a.key.slice(0, 300), title: a.title, lastSentAt: new Date(), suppressed: 0, result: {} })
    .onConflictDoUpdate({
      target: [alertState.kind, alertState.itemKey],
      set: { title: a.title, lastSentAt: new Date(), suppressed: 0, result: {} },
      // Timestamps are stored as UTC wall-clock time (no zone), like every other table here.
      setWhere: sql`${alertState.lastSentAt} < ${new Date(Date.now() - REPEAT_WINDOW_MS).toISOString()}::timestamp`,
    })
    .returning({ kind: alertState.kind });
  if (won.length) return true;
  await db.update(alertState).set({ suppressed: sql`${alertState.suppressed} + 1` }).where(and(eq(alertState.kind, a.kind), eq(alertState.itemKey, a.key.slice(0, 300))));
  return false;
}

/** Raise an alert. Never throws: an alert that cannot be sent must not break the deploy, job or scan that raised it. */
export async function raiseAlert(a: Alert): Promise<AlertOutcome> {
  try {
    const s = await getAlertSettings();
    if (a.kind !== "test" && !s.events[EVENT_OF[a.kind]].on) return { sent: false, reason: "event off" };
    if (!s.email.on && !(s.webhook.on && s.webhook.url)) return { sent: false, reason: "no channel" };
    if (!(await claim(a))) return { sent: false, reason: "repeat" };
    const result = await deliver(s, a);
    await db.update(alertState).set({ result }).where(and(eq(alertState.kind, a.kind), eq(alertState.itemKey, a.key.slice(0, 300))));
    return { sent: true, result };
  } catch (e: any) {
    console.error("[Alerts] could not raise an alert:", e?.message ?? e);
    return { sent: false, result: { error: String(e?.message ?? e).slice(0, 200) } };
  }
}

export async function recentAlerts(limit = 20) {
  return db.select().from(alertState).orderBy(desc(alertState.lastSentAt)).limit(limit);
}

// ─── The events, one helper each, so callers stay one line ───────────────────

/** A scheduled job failed. Alerts once the streak reaches the number in Settings. */
export async function alertJobFailed(job: { id: string; name: string; notifyOnFailure: boolean; siteId: string }, site: { domain: string }, streak: number, status: string) {
  if (!job.notifyOnFailure) return { sent: false } as AlertOutcome;
  const s = await getAlertSettings().catch(() => null);
  if (!s || streak < s.events.jobFailed.after) return { sent: false } as AlertOutcome;
  const name = job.name || "unnamed job";
  return raiseAlert({
    kind: "job_failed",
    key: job.id,
    title: `Scheduled job "${name}" on ${site.domain} failed ${streak} time${streak === 1 ? "" : "s"} in a row`,
    text: status === "timeout" ? "The last run went past its time limit and was stopped." : "The last run ended with an error. Its output is on the job's page.",
    link: `/apps/${job.siteId}?tab=jobs`,
  });
}

export async function alertDeployFailed(site: { id: string; domain: string }, deployment: { id: string; trigger?: string | null }, error: string, stillServing = false) {
  return raiseAlert({
    kind: "deploy_failed",
    key: site.id,
    title: `Deploy of ${site.domain} failed`,
    text: `${error.split("\n").filter(Boolean).slice(-3).join("\n").slice(0, 600) || "The deploy stopped with an error."}\n${stillServing ? "The version that was live before keeps running." : "The app is not running."}`,
    link: `/apps/${site.id}`,
  });
}

export async function alertAppCrashing(site: { id: string; domain: string }, d: { restarts: number; outOfMemory: boolean; lastLine?: string | null }) {
  return raiseAlert({
    kind: "worker_crash",
    key: `app:${site.id}`,
    title: `${site.domain} keeps crashing`,
    text: `It restarted ${d.restarts} times${d.outOfMemory ? " and ran out of memory" : ""}.${d.lastLine ? `\nLast output: ${d.lastLine.slice(0, 300)}` : ""}`,
    link: `/apps/${site.id}`,
  });
}

export async function alertWorkerCrashing(site: { id: string; domain: string }, worker: { name: string; container: string }) {
  return raiseAlert({
    kind: "worker_crash",
    key: `worker:${site.id}:${worker.name}`,
    title: `Worker "${worker.name}" of ${site.domain} keeps crashing`,
    text: `The container ${worker.container} keeps restarting. Its logs are on the app's Workers tab.`,
    link: `/apps/${site.id}?tab=workers`,
  });
}

export async function alertHostUrgent(item: { key: string; label: string; reason: string; status: string }) {
  return raiseAlert({
    kind: "host_urgent",
    key: item.key,
    title: `Server watch: ${item.status === "changed" ? "changed" : "new"} urgent finding, ${item.label}`,
    text: `${item.reason}\nIf you did not do this, look at it now on the Security page.`,
    link: "/security",
  });
}
