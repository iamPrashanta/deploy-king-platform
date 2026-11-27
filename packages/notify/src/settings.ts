import { db, platformSettings, users } from "@dbbkp/db";
import { encrypt, decrypt, type EncryptedPayload } from "@dbbkp/security";
import { eq } from "drizzle-orm";

/**
 * Email (SMTP) and alert settings, kept in platform_settings like the other panel settings.
 * Secrets (the SMTP password, the webhook URL) are stored encrypted with MASTER_KEY and never sent back to the panel.
 */

export const EMAIL_KEY = "email";
export const ALERTS_KEY = "alerts";

export type SmtpSecurity = "tls" | "starttls" | "none";

export type EmailSettingsStored = {
  host: string;
  port: number;
  security: SmtpSecurity;
  user: string;
  password: EncryptedPayload | null;
  /** The address mail comes from, e.g. no-reply@example.com or "Deploy King <no-reply@example.com>". */
  from: string;
  /** The panel's address, used for links in emails and alerts, e.g. https://panel.example.com */
  panelUrl: string;
  /** Shown in invitation emails ("You are invited to join Acme"). Empty: "Deploy King". */
  teamName: string;
};

/** What the panel is shown: everything except the password. */
export type EmailSettingsView = Omit<EmailSettingsStored, "password"> & { passwordSet: boolean; configured: boolean };

export type AlertEvents = {
  /** A scheduled job failed `after` times in a row (jobs that have "notify on failure" on). */
  jobFailed: { on: boolean; after: number };
  /** An app or one of its workers keeps crashing. */
  workerCrash: { on: boolean };
  deployFailed: { on: boolean };
  /** The server watch found something urgent. */
  hostUrgent: { on: boolean };
};

export type AlertSettingsStored = {
  email: { on: boolean; admins: boolean; to: string[] };
  webhook: { on: boolean; url: EncryptedPayload | null };
  events: AlertEvents;
};

export type AlertSettingsView = {
  email: { on: boolean; admins: boolean; to: string[] };
  webhook: { on: boolean; urlSet: boolean; urlHint: string | null };
  events: AlertEvents;
};

export const DEFAULT_EVENTS: AlertEvents = {
  jobFailed: { on: true, after: 3 },
  workerCrash: { on: true },
  deployFailed: { on: true },
  hostUrgent: { on: true },
};

const DEFAULT_ALERTS: AlertSettingsStored = { email: { on: false, admins: true, to: [] }, webhook: { on: false, url: null }, events: DEFAULT_EVENTS };

async function read<T>(key: string): Promise<T | null> {
  const [row] = await db.select().from(platformSettings).where(eq(platformSettings.key, key)).limit(1);
  return (row?.value as T) ?? null;
}

async function write(key: string, value: unknown, userId?: string | null) {
  await db
    .insert(platformSettings)
    .values({ key, value, updatedBy: userId ?? null })
    .onConflictDoUpdate({ target: platformSettings.key, set: { value, updatedBy: userId ?? null, updatedAt: new Date() } });
}

export const isConfigured = (s: EmailSettingsStored | null): s is EmailSettingsStored => !!(s && s.host && s.port && s.from);

export async function getEmailSettings(): Promise<EmailSettingsStored | null> {
  return read<EmailSettingsStored>(EMAIL_KEY);
}

export async function emailSettingsView(): Promise<EmailSettingsView> {
  const s = await getEmailSettings();
  return {
    host: s?.host ?? "",
    port: s?.port ?? 587,
    security: s?.security ?? "starttls",
    user: s?.user ?? "",
    from: s?.from ?? "",
    panelUrl: s?.panelUrl ?? "",
    teamName: s?.teamName ?? "",
    passwordSet: !!s?.password,
    configured: isConfigured(s),
  };
}

/** `password`: undefined keeps the stored one, "" removes it, anything else replaces it. */
export async function saveEmailSettings(
  input: { host: string; port: number; security: SmtpSecurity; user: string; password?: string; from: string; panelUrl: string; teamName: string },
  userId?: string | null
) {
  const old = await getEmailSettings();
  const password = input.password === undefined ? old?.password ?? null : input.password === "" ? null : encrypt(input.password);
  const value: EmailSettingsStored = {
    host: input.host.trim(),
    port: input.port,
    security: input.security,
    user: input.user.trim(),
    password,
    from: input.from.trim(),
    panelUrl: input.panelUrl.trim().replace(/\/+$/, ""),
    teamName: input.teamName.trim(),
  };
  await write(EMAIL_KEY, value, userId);
  return value;
}

export function smtpPassword(s: EmailSettingsStored): string | null {
  if (!s.password) return null;
  return decrypt(s.password);
}

/** The panel's address for links: the saved one, else PANEL_URL from the environment. */
export async function panelUrl(): Promise<string> {
  const s = await getEmailSettings();
  return (s?.panelUrl || process.env.PANEL_URL || process.env.PUBLIC_PANEL_URL || "").replace(/\/+$/, "");
}

export async function getAlertSettings(): Promise<AlertSettingsStored> {
  const s = await read<Partial<AlertSettingsStored>>(ALERTS_KEY);
  return {
    email: { ...DEFAULT_ALERTS.email, ...(s?.email ?? {}) },
    webhook: { ...DEFAULT_ALERTS.webhook, ...(s?.webhook ?? {}) },
    events: {
      jobFailed: { ...DEFAULT_EVENTS.jobFailed, ...(s?.events?.jobFailed ?? {}) },
      workerCrash: { ...DEFAULT_EVENTS.workerCrash, ...(s?.events?.workerCrash ?? {}) },
      deployFailed: { ...DEFAULT_EVENTS.deployFailed, ...(s?.events?.deployFailed ?? {}) },
      hostUrgent: { ...DEFAULT_EVENTS.hostUrgent, ...(s?.events?.hostUrgent ?? {}) },
    },
  };
}

/** Shows which service a webhook goes to without showing its secret path. */
export function webhookHint(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "…";
  }
}

export async function alertSettingsView(): Promise<AlertSettingsView> {
  const s = await getAlertSettings();
  let hint: string | null = null;
  if (s.webhook.url) {
    try {
      hint = webhookHint(decrypt(s.webhook.url));
    } catch {
      hint = "…";
    }
  }
  return { email: s.email, webhook: { on: s.webhook.on, urlSet: !!s.webhook.url, urlHint: hint }, events: s.events };
}

/** `webhookUrl`: undefined keeps the stored one, "" removes it. */
export async function saveAlertSettings(
  input: { email: { on: boolean; admins: boolean; to: string[] }; webhook: { on: boolean }; webhookUrl?: string; events: AlertEvents },
  userId?: string | null
) {
  const old = await getAlertSettings();
  const url = input.webhookUrl === undefined ? old.webhook.url : input.webhookUrl === "" ? null : encrypt(input.webhookUrl.trim());
  const value: AlertSettingsStored = {
    email: { on: input.email.on, admins: input.email.admins, to: [...new Set(input.email.to.map((t) => t.trim().toLowerCase()).filter(Boolean))] },
    webhook: { on: input.webhook.on, url },
    events: {
      jobFailed: { on: input.events.jobFailed.on, after: Math.max(1, Math.min(50, Math.round(input.events.jobFailed.after || 3))) },
      workerCrash: { on: input.events.workerCrash.on },
      deployFailed: { on: input.events.deployFailed.on },
      hostUrgent: { on: input.events.hostUrgent.on },
    },
  };
  await write(ALERTS_KEY, value, userId);
  return value;
}

/** Who gets alert emails: the admins (when chosen) plus the extra addresses. */
export async function alertRecipients(s: AlertSettingsStored): Promise<string[]> {
  const out = new Set(s.email.to);
  if (s.email.admins) {
    const admins = await db.select({ email: users.email, suspendedAt: users.suspendedAt }).from(users).where(eq(users.role, "admin"));
    for (const a of admins) if (!a.suspendedAt && a.email) out.add(a.email.toLowerCase());
  }
  return [...out];
}
