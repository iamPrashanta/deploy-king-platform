import nodemailer from "nodemailer";
import { getEmailSettings, isConfigured, smtpPassword, type EmailSettingsStored } from "./settings";

/**
 * Sending email over the SMTP server saved in Settings › Email.
 * Tests replace the transport with setTransportForTests, so no mail leaves the machine.
 */

export type MailMessage = { to: string | string[]; subject: string; text: string; html?: string; replyTo?: string };
export type MailTransport = { sendMail(msg: { from: string; to: string; subject: string; text: string; html?: string; replyTo?: string }): Promise<unknown> };

let testTransport: MailTransport | null = null;
/** Tests only: every message goes to this transport instead of an SMTP server. Pass null to undo. */
export function setTransportForTests(t: MailTransport | null) {
  testTransport = t;
}

export class EmailNotSetUp extends Error {
  constructor() {
    super("Email is not set up. Add an SMTP server in Settings › Email.");
    this.name = "EmailNotSetUp";
  }
}

/** "Deploy King <no-reply@x>" when the saved address has no name of its own. */
export function fromHeader(from: string) {
  const f = from.trim();
  return /<[^>]+>/.test(f) ? f : `Deploy King <${f}>`;
}

export function transportFor(s: EmailSettingsStored): MailTransport {
  if (testTransport) return testTransport;
  const pass = smtpPassword(s);
  return nodemailer.createTransport({
    host: s.host,
    port: s.port,
    secure: s.security === "tls",
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: s.user ? { user: s.user, pass: pass ?? "" } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  }) as unknown as MailTransport;
}

/** Whether email can be sent at all. */
export async function emailReady(): Promise<boolean> {
  return isConfigured(await getEmailSettings());
}

/** Sends one message to each address (so recipients do not see each other). Throws EmailNotSetUp when there is no SMTP server. */
export async function sendMail(msg: MailMessage, settings?: EmailSettingsStored | null) {
  const s = settings ?? (await getEmailSettings());
  if (!isConfigured(s)) throw new EmailNotSetUp();
  const transport = transportFor(s);
  const to = (Array.isArray(msg.to) ? msg.to : [msg.to]).filter(Boolean);
  for (const addr of to) {
    await transport.sendMail({ from: fromHeader(s.from), to: addr, subject: msg.subject, text: msg.text, html: msg.html, replyTo: msg.replyTo });
  }
  return { sent: to.length };
}
