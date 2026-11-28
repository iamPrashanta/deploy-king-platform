import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { db, users } from "@dbbkp/db";
import { logAudit } from "@dbbkp/audit";
import {
  alertSettingsView,
  deliver,
  emailSettingsView,
  getAlertSettings,
  getEmailSettings,
  isConfigured,
  recentAlerts,
  renderTestEmail,
  saveAlertSettings,
  saveEmailSettings,
  sendMail,
} from "@dbbkp/notify";
import { router, adminProcedure, type Context } from "../trpc";

/** Settings › Email and Settings › Alerts. Admins only, and only in the panel. */
function panelOnly(ctx: Context) {
  if (ctx.apiToken) throw new TRPCError({ code: "FORBIDDEN", message: "Email and alerts can only be changed in the panel." });
}

const address = z.string().trim().toLowerCase().email().max(255);
/** "no-reply@example.com" or "Deploy King <no-reply@example.com>" */
const fromInput = z
  .string()
  .trim()
  .max(255)
  .refine((v) => v === "" || /^[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+$/.test(v) || /^[^<>\r\n]{0,80}<[^<>@\s]+@[^<>@\s]+\.[^<>@\s]+>$/.test(v), "An address such as no-reply@example.com");
const urlInput = z
  .string()
  .trim()
  .max(500)
  .refine((v) => v === "" || /^https?:\/\/[^\s/]+/i.test(v), "Starts with https:// or http://");
const hostInput = z.string().trim().max(255).regex(/^[a-zA-Z0-9.-]*$/, "A host name such as smtp.example.com");

function smtpError(e: any) {
  const msg = String(e?.response || e?.message || e).replace(/\s+/g, " ").slice(0, 300);
  return new TRPCError({ code: "BAD_REQUEST", message: `The SMTP server did not accept the email: ${msg}` });
}

export const notifyRouter = router({
  email: adminProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    return emailSettingsView();
  }),

  saveEmail: adminProcedure
    .input(
      z.object({
        host: hostInput,
        port: z.number().int().min(1).max(65535),
        security: z.enum(["tls", "starttls", "none"]),
        user: z.string().trim().max(255),
        /** Leave out to keep the saved password; "" removes it. */
        password: z.string().max(500).optional(),
        from: fromInput,
        panelUrl: urlInput,
        teamName: z.string().trim().max(80),
      })
    )
    .mutation(async ({ ctx, input }) => {
      panelOnly(ctx);
      await saveEmailSettings(input as Parameters<typeof saveEmailSettings>[0], ctx.user!.sub);
      logAudit("email_settings", { actorId: ctx.user!.sub, targetType: "settings", targetName: "email", metadata: { host: input.host, port: input.port, security: input.security, from: input.from, passwordChanged: input.password !== undefined }, ip: ctx.ip ?? undefined });
      return emailSettingsView();
    }),

  /** Sends a test email with the saved settings, to you or to the address given. */
  testEmail: adminProcedure.input(z.object({ to: address.optional() })).mutation(async ({ ctx, input }) => {
    panelOnly(ctx);
    const s = await getEmailSettings();
    if (!isConfigured(s)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Save the SMTP server first." });
    const [me] = await db.select({ email: users.email, username: users.username }).from(users).where(eq(users.id, ctx.user!.sub)).limit(1);
    const to = input.to ?? me?.email;
    if (!to) throw new TRPCError({ code: "BAD_REQUEST", message: "Give an address to send the test to." });
    try {
      await sendMail({ to, ...renderTestEmail(me?.username ?? "an admin") }, s);
    } catch (e) {
      logAudit("email_test", { actorId: ctx.user!.sub, targetType: "settings", targetName: "email", metadata: { to, ok: false }, ip: ctx.ip ?? undefined });
      throw smtpError(e);
    }
    logAudit("email_test", { actorId: ctx.user!.sub, targetType: "settings", targetName: "email", metadata: { to, ok: true }, ip: ctx.ip ?? undefined });
    return { sentTo: to };
  }),

  alerts: adminProcedure.query(async ({ ctx }) => {
    panelOnly(ctx);
    const [view, email, recent] = await Promise.all([alertSettingsView(), emailSettingsView(), recentAlerts(15)]);
    return { ...view, emailReady: email.configured, recent };
  }),

  saveAlerts: adminProcedure
    .input(
      z.object({
        email: z.object({ on: z.boolean(), admins: z.boolean(), to: z.array(address).max(20) }),
        webhook: z.object({ on: z.boolean() }),
        /** Leave out to keep the saved address; "" removes it. */
        webhookUrl: z.string().trim().max(1000).refine((v) => v === "" || /^https:\/\/[^\s]+$/i.test(v), "A webhook address starts with https://").optional(),
        events: z.object({
          jobFailed: z.object({ on: z.boolean(), after: z.number().int().min(1).max(50) }),
          workerCrash: z.object({ on: z.boolean() }),
          deployFailed: z.object({ on: z.boolean() }),
          hostUrgent: z.object({ on: z.boolean() }),
        }),
      })
    )
    .mutation(async ({ ctx, input }) => {
      panelOnly(ctx);
      const after = await saveAlertSettings(input as Parameters<typeof saveAlertSettings>[0], ctx.user!.sub);
      logAudit("alert_settings", { actorId: ctx.user!.sub, targetType: "settings", targetName: "alerts", metadata: { email: after.email.on, webhook: after.webhook.on && !!after.webhook.url, webhookChanged: input.webhookUrl !== undefined, events: after.events }, ip: ctx.ip ?? undefined });
      return alertSettingsView();
    }),

  /** Sends a test alert on every channel that is on, and says what each one answered. */
  testAlert: adminProcedure.mutation(async ({ ctx }) => {
    panelOnly(ctx);
    const s = await getAlertSettings();
    if (!s.email.on && !(s.webhook.on && s.webhook.url)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Switch on email or a webhook first, and save." });
    const result = await deliver(s, { kind: "test", key: "test", title: "Test alert from Deploy King", text: `Sent by ${ctx.user!.username} from Settings › Alerts. Real alerts look like this.`, link: "/settings?tab=alerts" });
    logAudit("alert_test", { actorId: ctx.user!.sub, targetType: "settings", targetName: "alerts", metadata: result, ip: ctx.ip ?? undefined });
    return result;
  }),
});
