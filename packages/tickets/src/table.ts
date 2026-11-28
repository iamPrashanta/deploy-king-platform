/**
 * The classification table: every request that can change something on a Deploy King machine, and
 * the ticket it needs.
 *
 *   deploy   puts code on the machine or starts a release: counts toward the plan's deploys
 *   delete   takes something away for good
 *   change   everything else that changes something
 *   exempt   needs no ticket (see EXEMPT below for the only reasons)
 *
 * Written from the real code: the tRPC routers in apps/api/src/trpc/routers, the REST routes in
 * apps/api/src/routes and the MCP tools in apps/api/src/mcp/tools.ts. A name that is NOT listed here
 * is treated as `change`, so a new mutation is never free by accident; tests/local/checks/ticketunit.ts
 * fails until it is listed.
 *
 * `kind` is the label the app sends to the control server with the ticket request (60 characters at
 * most). "create-app" matters there: the plan's running-apps limit is checked for it.
 */
import type { TicketAction } from "./types";

export type Entry = "exempt" | { action: TicketAction; kind: string };

const deploy = (kind: string): Entry => ({ action: "deploy", kind });
const change = (kind: string): Entry => ({ action: "change", kind });
const del = (kind: string): Entry => ({ action: "delete", kind });
/**
 * Why a mutation needs no ticket. Only these reasons:
 *  - signing in, or asking for an account, by someone who has no session yet;
 *  - the signed-in person's own password and 2-step sign-in;
 *  - git.inspect, the project check: it reads a repository and changes nothing, and the MCP read
 *    tool check_repo runs the very same procedure.
 */
const EXEMPT: Entry = "exempt";

/** Every tRPC mutation of the API's appRouter, as "<router>.<procedure>". Queries never need a ticket. */
export const TRPC_MUTATIONS: Readonly<Record<string, Entry>> = {
  // auth: sign-in and its 2-step part, and one's own password (a forced change is part of signing in)
  "auth.login": EXEMPT,
  "auth.loginCode": EXEMPT,
  "auth.setupStart": EXEMPT,
  "auth.setupConfirm": EXEMPT,
  "auth.changePassword": EXEMPT,

  // automations: workflows
  "automations.create": change("create-workflow"),
  "automations.update": change("update-workflow"),
  "automations.setEnabled": change("switch-workflow"),
  "automations.duplicate": change("duplicate-workflow"),
  "automations.rotateWebhook": change("rotate-workflow-address"),
  "automations.execute": change("run-workflow"),
  "automations.delete": del("delete-workflow"),

  // backup: backups, schedules, destinations, restores
  "backup.runNow": change("run-backup"),
  "backup.retry": change("retry-backup"),
  "backup.savePolicy": change("backup-schedule"),
  "backup.setPolicyEnabled": change("switch-backup-schedule"),
  "backup.deletePolicy": del("delete-backup-schedule"),
  "backup.addDestination": change("add-backup-destination"),
  "backup.updateDestination": change("update-backup-destination"),
  "backup.checkDestination": change("check-backup-destination"),
  "backup.removeDestination": del("remove-backup-destination"),
  "backup.restore": change("restore-backup"),
  "backup.pgsql": change("run-backup"),
  "backup.seed": change("seed-database"),

  // cron: scheduled jobs
  "cron.create": change("scheduled-job"),
  "cron.update": change("update-scheduled-job"),
  "cron.setActive": change("switch-scheduled-job"),
  "cron.runNow": change("run-scheduled-job"),
  "cron.delete": del("delete-scheduled-job"),

  // database
  "database.create": change("create-database"),
  "database.connectExisting": change("connect-database"),
  "database.revealConnection": change("reveal-database-address"),
  "database.delete": del("delete-database"),

  // files: an app's volumes and source
  "files.write": change("edit-file"),
  "files.writeFile": change("edit-file"),
  "files.mkdir": change("create-folder"),
  "files.remove": del("delete-file"),
  "files.delete": del("delete-file"),

  // git: connections to GitHub, the GitHub App, the project check
  "git.connectGithub": change("connect-github"),
  "git.disconnect": del("disconnect-github"),
  "git.appManifest": change("github-app"),
  "git.appComplete": change("github-app"),
  "git.appSync": change("github-app"),
  "git.appRemove": del("remove-github-app"),
  "git.inspect": EXEMPT,

  // host: the server watch
  "host.acceptInitial": change("accept-server-baseline"),
  "host.decide": change("answer-finding"),
  "host.remove": del("remove-from-server"),
  "host.undo": change("undo-removal"),

  // infra: scans of the machine (older), alerts
  "infra.scan": change("server-scan"),
  "infra.health": change("server-scan"),
  "infra.disk": change("server-scan"),
  "infra.network": change("server-scan"),
  "infra.resolveAlert": change("resolve-alert"),

  // mcp: tokens for AI agents
  "mcp.createToken": change("create-agent-token"),
  "mcp.revokeToken": change("revoke-agent-token"),

  // nodes
  "nodes.setTags": change("node-tags"),
  "nodes.delete": del("remove-node"),

  // notify: email and alerts
  "notify.saveEmail": change("email-settings"),
  "notify.testEmail": change("test-email"),
  "notify.saveAlerts": change("alert-settings"),
  "notify.testAlert": change("test-alert"),

  // pipeline (older build-and-deploy jobs)
  "pipeline.create": change("create-pipeline"),
  "pipeline.update": change("update-pipeline"),
  "pipeline.run": deploy("run-pipeline"),
  "pipeline.delete": del("delete-pipeline"),

  // secrets
  "secrets.set": change("set-secret"),
  "secrets.delete": del("delete-secret"),

  // security
  "security.resolveThreat": change("resolve-threat"),
  "security.terminateProcess": change("stop-process"),
  "security.quarantineContainer": change("pause-container"),

  // servers: Servers & SSH
  "servers.create": change("add-server"),
  "servers.update": change("update-server"),
  "servers.finish": change("add-server"),
  "servers.setRules": change("server-rules"),
  "servers.setPassword": change("server-password"),
  "servers.prepareKey": change("create-ssh-key"),
  "servers.useKey": change("choose-ssh-key"),
  "servers.installKey": change("install-ssh-key"),
  "servers.probe": change("check-server"),
  "servers.trust": change("trust-server"),
  "servers.test": change("test-server"),
  "servers.disconnect": change("disconnect-server"),
  "servers.generateKey": change("create-ssh-key"),
  "servers.importKey": change("import-ssh-key"),
  "servers.rotateKey": change("rotate-ssh-key"),
  "servers.saveSettings": change("ssh-settings"),
  "servers.deleteKey": del("delete-ssh-key"),
  "servers.remove": del("remove-server"),

  // sites: apps
  "sites.create": deploy("create-app"),
  "sites.redeploy": deploy("redeploy"),
  "sites.rollback": deploy("rollback"),
  "sites.update": change("app-settings"),
  "sites.answer": change("answer-deploy-question"),
  "sites.envSet": change("env-change"),
  "sites.envSetMany": change("env-change"),
  "sites.envSetBuildTime": change("env-change"),
  "sites.envUnset": change("env-change"),
  "sites.delete": del("delete-app"),

  // system: cleanup, capacity, the apps network
  "system.cleanup": del("cleanup"),
  "system.cleanupRemove": del("remove-leftover"),
  "system.setAutoCleanup": change("cleanup-settings"),
  "system.setCapacity": change("capacity-settings"),
  "system.fixNetwork": change("fix-network"),

  // team: accepting an invitation and asking for access are done by people without a session
  "team.accept": EXEMPT,
  "team.requestAccess": EXEMPT,
  "team.invite": change("invite-member"),
  "team.renewInvite": change("renew-invitation"),
  "team.cancelInvite": change("cancel-invitation"),
  "team.decideRequest": change("answer-access-request"),
  "team.updateMember": change("update-member"),
  "team.setSuspended": change("suspend-member"),
  "team.setRules": change("team-rules"),
  "team.resetTwoFactor": change("reset-member-2-step"),
  "team.signOutEverywhere": change("sign-out-member"),
  "team.revokeMemberToken": change("revoke-member-token"),
  "team.remove": del("remove-member"),

  // twoFactor: one's own 2-step sign-in
  "twoFactor.start": EXEMPT,
  "twoFactor.confirm": EXEMPT,
  "twoFactor.disable": EXEMPT,
  "twoFactor.newRecoveryCodes": EXEMPT,

  // workers
  "workers.create": change("add-worker"),
  "workers.update": change("update-worker"),
  "workers.restart": change("restart-worker"),
  "workers.delete": del("delete-worker"),
};

/**
 * Every MCP tool (POST /mcp, method "tools/call"), by name. Tools that only look are exempt. One
 * tool call is one request and needs one ticket, however many procedures it runs inside the API.
 */
export const MCP_TOOLS: Readonly<Record<string, Entry>> = {
  list_apps: EXEMPT,
  get_app: EXEMPT,
  get_deploy_log: EXEMPT,
  get_app_logs: EXEMPT,
  check_repo: EXEMPT,
  list_workflows: EXEMPT,
  get_workflow_run: EXEMPT,
  platform_status: EXEMPT,
  check_fit: EXEMPT,
  get_capacity: EXEMPT,
  list_security_findings: EXEMPT,
  wait_for_deploy: EXEMPT,
  list_scheduled_jobs: EXEMPT,
  list_workers: EXEMPT,
  list_databases: EXEMPT,

  create_app: deploy("create-app"),
  deploy_app: deploy("redeploy"),
  rollback_app: deploy("rollback"),
  answer_deploy_question: change("answer-deploy-question"),
  set_env: change("env-change"),
  run_workflow: change("run-workflow"),
  add_scheduled_job: change("scheduled-job"),
  add_worker: change("add-worker"),
  create_database: change("create-database"),
  delete_app: del("delete-app"),
};

export type RestRule = { method: string; path: string; entry: Entry; zip?: true };

/**
 * The REST routes that are not plain reads, by method and exact path (compared without regard to
 * letter case or a trailing slash, as Express does).
 */
export const REST_ROUTES: readonly RestRule[] = [
  // A project ZIP that becomes a new app. A ticket may name the file's SHA-256.
  { method: "POST", path: "/api/sites/upload", entry: deploy("create-app"), zip: true },
  { method: "POST", path: "/mcp/upload", entry: deploy("create-app"), zip: true },
  // Files into a volume of an app
  { method: "POST", path: "/api/files/upload", entry: change("upload-files") },
  // Older routes of the first panel (admins only)
  { method: "POST", path: "/api/backup/pgsql", entry: change("run-backup") },
  { method: "POST", path: "/api/backup/seed/pgsql", entry: change("seed-database") },
  { method: "POST", path: "/api/infra/health-check", entry: change("server-scan") },
  { method: "POST", path: "/api/infra/disk", entry: change("server-scan") },
  { method: "POST", path: "/api/infra/network", entry: change("server-scan") },
  { method: "POST", path: "/api/infra/scan", entry: change("server-scan") },
];

/**
 * Whole areas that never need a ticket, whatever the method:
 *  - /api/auth      signing in (registering is closed on a desktop machine anyway)
 *  - /api/desktop   the app's own key gives the session and the assistant's token; nothing works before these
 *  - /webhooks      GitHub calls these, signed with the webhook secret
 *  - /hooks         workflow trigger addresses, called by other services with their secret token
 *  - /internal      the worker and the machine's own agents, with the internal key
 */
export const EXEMPT_PREFIXES: readonly string[] = ["/api/auth", "/api/desktop", "/webhooks", "/hooks", "/internal"];

/**
 * Messages on the WebSocket (/ws) that change something. Opening a terminal gives a shell, so the
 * message that opens one carries the ticket as `ticket`; typing, resizing and closing belong to the
 * terminal that was opened. Subscribing to logs and metrics only reads.
 */
export const WS_MESSAGES: Readonly<Record<string, Entry>> = {
  "terminal.open": change("open-terminal"),
  "ssh.open": change("open-server-terminal"),
  "terminal.input": EXEMPT,
  "terminal.resize": EXEMPT,
  "terminal.close": EXEMPT,
  "ssh.input": EXEMPT,
  "ssh.resize": EXEMPT,
  "ssh.close": EXEMPT,
  subscribe: EXEMPT,
  unsubscribe: EXEMPT,
};
