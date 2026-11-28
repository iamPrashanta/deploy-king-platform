import { db, auditLogs } from "@dbbkp/db";

// All known actions — extend this as the platform grows
export type AuditAction =
  | "login"
  | "logout"
  | "deploy"
  | "rollback"
  | "site_create"
  | "site_delete"
  | "file_edit"
  | "file_read"
  | "cron_create"
  | "cron_delete"
  | "cron_update"
  | "cron_run"
  | "worker_change"
  | "db_create"
  | "db_delete"
  | "secret_set"
  | "secret_read"
  | "ssl_issued"
  | "ssl_renewed"
  | "dns_create"
  | "dns_delete"
  | "pipeline_run"
  | "pipeline_create"
  | "pipeline_delete"
  | "threat_detected"
  | "threat_resolved"
  | "user_create"
  | "user_delete"
  | "intent_authorized"
  | "intent_denied"
  | "api_token_create"
  | "api_token_revoke"
  | "capacity_override"
  | "capacity_settings"
  | "cleanup_run"
  | "cleanup_remove"
  | "cleanup_settings"
  | "host_baseline_accept"
  | "host_finding_decide"
  | "host_remove"
  | "host_undo"
  | "team_invite"
  | "team_invite_cancel"
  | "team_accept"
  | "team_member_update"
  | "team_member_suspend"
  | "team_member_remove"
  | "access_request_decide"
  // servers agent: Servers & SSH
  | "ssh_server_add"
  | "ssh_server_update"
  | "ssh_server_delete"
  | "ssh_key_create"
  | "ssh_key_import"
  | "ssh_key_delete"
  | "ssh_key_install"
  | "ssh_key_rotate"
  | "ssh_host_trust"
  | "ssh_host_refused"
  | "ssh_test"
  | "ssh_terminal_open"
  | "ssh_terminal_close"
  | "ssh_terminal_denied"
  | "ssh_settings"
  // security agent: 2-step sign-in, sessions, email, alerts, GitHub App
  | "two_factor_enable"
  | "two_factor_disable"
  | "two_factor_reset"
  | "two_factor_recovery_used"
  | "two_factor_recovery_new"
  | "team_rules"
  | "team_sign_out_everywhere"
  | "team_token_revoke"
  | "email_settings"
  | "email_test"
  | "alert_settings"
  | "alert_test"
  | "github_app_create"
  | "github_app_install"
  | "github_app_remove"
  // data agent: databases, backups, restores, files
  | "db_connect"
  | "backup_run"
  | "backup_restore"
  | "backup_policy"
  | "backup_destination"
  | "file_upload"
  | "file_delete"
  | "folder_create"
  // tickets agent: Deploy King Desktop (the local admin, tickets: apps/api/src/services/tickets.ts)
  | "user_update"
  | "ticket_refused"
  | "ticket_wrong_file";

export interface AuditContext {
  /** UUID of the user performing the action */
  actorId?: string;
  actorEmail?: string;
  /** ID of the resource being acted upon */
  targetId?: string;
  /** Type of resource: site | pipeline | db | secret | user */
  targetType?: string;
  targetName?: string;
  /** Any extra structured data to store */
  metadata?: Record<string, any>;
  /** Request IP address */
  ip?: string;
  userAgent?: string;
}

/**
 * Log an audit event to the database.
 * Non-throwing — if the insert fails it logs to stderr but does NOT crash the request.
 */
export async function logAudit(
  action: AuditAction,
  ctx: AuditContext = {}
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      action,
      actorId: ctx.actorId ?? null,
      actorEmail: ctx.actorEmail ?? null,
      targetId: ctx.targetId ?? null,
      targetType: ctx.targetType ?? null,
      targetName: ctx.targetName ?? null,
      metadata: ctx.metadata ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null,
    });
  } catch (err) {
    // Non-fatal: never crash the caller
    console.error("[Audit] Failed to write audit log:", err);
  }
}
