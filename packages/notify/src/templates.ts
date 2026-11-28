/**
 * The emails Deploy King sends, as plain text and simple HTML.
 * Every value is escaped: names, notes and app names come from people.
 */

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const ROLE: Record<string, string> = { admin: "Admin", developer: "Developer", viewer: "Viewer" };

/** 27 Nov 2026 */
export function emailDate(d: Date) {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
}

export type InviteEmailInput = {
  inviter: string;
  inviterEmail?: string | null;
  /** The team or panel name; empty means "Deploy King". */
  teamName?: string | null;
  email: string;
  role: string;
  allApps: boolean;
  apps: string[];
  note?: string | null;
  url: string;
  expiresAt: Date;
};

/** The invitation, as drawn in the TeamEmail artboard. */
export function renderInviteEmail(i: InviteEmailInput) {
  const team = i.teamName?.trim() || "";
  const role = ROLE[i.role] ?? i.role;
  const apps = i.role === "admin" || i.allApps ? "All apps" : i.apps.length ? i.apps.join(", ") : "None yet. You can create your own.";
  const who = i.inviterEmail ? `${i.inviter} (${i.inviterEmail})` : i.inviter;
  const subject = team ? `${i.inviter} invited you to ${team} on Deploy King` : `${i.inviter} invited you to Deploy King`;
  const heading = team ? `You are invited to join ${team}` : "You are invited to join a Deploy King panel";
  const lead = team ? `${who} invited you to work in the ${team} panel on Deploy King.` : `${who} invited you to work in their panel on Deploy King.`;
  const expires = emailDate(i.expiresAt);
  const once = `The link works once, only for ${i.email}, and expires on ${expires}.`;
  const unexpected = "You did not expect this? Ignore this email. Nobody gets access unless the link is used, and Deploy King will never ask for your password by email.";

  const text = [
    heading,
    "",
    lead,
    "",
    `Your role: ${role}`,
    `Apps: ${apps}`,
    ...(i.note ? [`Note: "${i.note}"`] : []),
    "",
    "Accept invitation:",
    i.url,
    "",
    once,
    "",
    unexpected,
  ].join("\n");

  const row = (k: string, v: string) =>
    `<tr><td style="padding:6px 0;color:#6b7280;font-size:13px;width:110px;vertical-align:top">${esc(k)}</td><td style="padding:6px 0;font-size:14px;color:#111113">${v}</td></tr>`;
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f3ef;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#111113">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e3dc;border-radius:12px">
<tr><td style="padding:28px 32px">
<div style="font-weight:700;font-size:15px;margin-bottom:20px">Deploy King</div>
<h1 style="margin:0 0 10px;font-size:22px;font-weight:600">${esc(heading)}</h1>
<p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:#374151">${esc(lead)}</p>
<table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;margin-bottom:18px">
${row("Your role", esc(role))}
${row("Apps", esc(apps))}
${i.note ? row("Note", `&ldquo;${esc(i.note)}&rdquo;`) : ""}
</table>
<a href="${esc(i.url)}" style="display:inline-block;background:#2f5bff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:8px">Accept invitation</a>
<p style="margin:18px 0 6px;font-size:13px;color:#374151">${esc(once)}</p>
<p style="margin:0 0 18px;font-size:12px;color:#6b7280;font-family:JetBrains Mono,Consolas,monospace;word-break:break-all">${esc(i.url)}</p>
<p style="margin:0;font-size:12px;line-height:1.6;color:#6b7280;border-top:1px solid #e5e3dc;padding-top:14px">${esc(unexpected)}</p>
</td></tr></table>
</body></html>`;
  return { subject, text, html };
}

/** A short email for one alert. */
export function renderAlertEmail(a: { title: string; text: string; link?: string | null }) {
  const text = [a.title, "", a.text, ...(a.link ? ["", a.link] : []), "", "You get this because alerts are switched on in Deploy King, Settings › Alerts. The same alert is sent at most once an hour."].join("\n");
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f3ef;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#111113">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e5e3dc;border-radius:12px">
<tr><td style="padding:24px 28px">
<div style="font-weight:700;font-size:15px;margin-bottom:16px">Deploy King</div>
<h1 style="margin:0 0 10px;font-size:18px;font-weight:600">${esc(a.title)}</h1>
<p style="margin:0 0 16px;font-size:14px;line-height:1.6;color:#374151;white-space:pre-wrap">${esc(a.text)}</p>
${a.link ? `<a href="${esc(a.link)}" style="display:inline-block;background:#2f5bff;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px">Open in Deploy King</a>` : ""}
<p style="margin:18px 0 0;font-size:12px;color:#6b7280">You get this because alerts are switched on in Settings › Alerts. The same alert is sent at most once an hour.</p>
</td></tr></table>
</body></html>`;
  return { subject: `[Deploy King] ${a.title}`, text, html };
}

/** A test message for the "Send test email" button. */
export function renderTestEmail(by: string) {
  const text = `This is a test email from Deploy King, sent by ${by}.\n\nIf you can read this, invitations and alerts can be emailed from this panel.`;
  return {
    subject: "Deploy King test email",
    text,
    html: `<!doctype html><html><body style="font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#111113;padding:24px"><p style="font-weight:700">Deploy King</p><p>This is a test email from Deploy King, sent by ${esc(by)}.</p><p>If you can read this, invitations and alerts can be emailed from this panel.</p></body></html>`,
  };
}
