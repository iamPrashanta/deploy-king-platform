import {
  bigint,
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  boolean,
  integer,
  jsonb,
  primaryKey,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// ─── USERS ───────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: varchar("role", { length: 20 }).notNull().default("user"), // admin | user
  mustChangePassword: boolean("must_change_password").default(false),
  // Team. null = a user from before teams existed (the older role tables decide for them).
  teamRole: varchar("team_role", { length: 20 }), // admin | developer | viewer
  allApps: boolean("all_apps").notNull().default(false), // sees every app, not only the ones shared with them
  grants: jsonb("grants").$type<{ createApps?: boolean; deleteApps?: boolean; terminal?: boolean; agentTokens?: boolean }>().notNull().default({}),
  suspendedAt: timestamp("suspended_at"), // set = cannot sign in, tokens stop working
  invitedBy: uuid("invited_by"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── SESSIONS (Auth & Activity) ─────────────────────────────────────────────
export const sessions = pgTable("sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lastActivityAt: timestamp("last_activity_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── SERVERS ─────────────────────────────────────────────────────────────────
export const servers = pgTable("servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  host: varchar("host", { length: 255 }).notNull(),
  sshUser: varchar("ssh_user", { length: 255 }).notNull().default("root"),
  sshPort: integer("ssh_port").default(22),
  sshKeyPath: text("ssh_key_path"),
  isLocal: boolean("is_local").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── JOBS ─────────────────────────────────────────────────────────────────────
export const jobs = pgTable("jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  bullJobId: varchar("bull_job_id", { length: 100 }),
  type: varchar("type", { length: 50 }).notNull(),
  name: varchar("name", { length: 100 }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("waiting"),
  payload: text("payload"),
  result: text("result"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  finishedAt: timestamp("finished_at"),
});

// ─── PIPELINES ────────────────────────────────────────────────────────────────
export const pipelines = pgTable("pipelines", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  repoUrl: text("repo_url").notNull(),
  branch: varchar("branch", { length: 255 }).default("main"),
  buildCommand: text("build_command"),
  deployCommand: text("deploy_command"),
  envVars: text("env_vars"),
  enabled: boolean("enabled").default(true),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── PIPELINE RUNS ────────────────────────────────────────────────────────────
export const pipelineRuns = pgTable("pipeline_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  pipelineId: uuid("pipeline_id").notNull().references(() => pipelines.id, { onDelete: "cascade" }),
  bullJobId: varchar("bull_job_id", { length: 100 }),
  status: varchar("status", { length: 20 }).notNull().default("waiting"),
  commitSha: varchar("commit_sha", { length: 40 }),
  log: text("log"),
  runner: varchar("runner", { length: 20 }).default("docker"),
  image: varchar("image", { length: 255 }),
  exitCode: integer("exit_code"),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  durationMs: integer("duration_ms"),
});

// ─── GIT PROVIDERS ────────────────────────────────────────────────────────────
// A connected GitHub account. The token lets the panel list repositories and
// branches and lets the worker clone private repositories. Stored encrypted.
export const gitProviders = pgTable("git_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 20 }).notNull().default("github"),
  name: varchar("name", { length: 100 }).notNull(),
  login: varchar("login", { length: 100 }),
  avatarUrl: text("avatar_url"),
  encryptedToken: text("encrypted_token").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  authTag: varchar("auth_tag", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

export type SiteVolume = { name: string; mountPath: string };

// ─── SITES ────────────────────────────────────────────────────────────────────
export type SiteHealthDetail = {
  restarts: number;
  exitCode: number | null;
  outOfMemory: boolean;
  lastOutput: string;
  since: string;
};

export const sites = pgTable("sites", {
  id: uuid("id").defaultRandom().primaryKey(),
  // Owner of the site. Every ownership check in the API, gateway and worker keys on this.
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  domain: varchar("domain", { length: 255 }).notNull().unique(),
  type: varchar("type", { length: 20 }).notNull().default("static"),
  docRoot: text("doc_root").notNull(),
  port: integer("port"),
  pm2Name: varchar("pm2_name", { length: 100 }),
  source: varchar("source", { length: 20 }).notNull().default("zip"), // git | zip | image
  repoUrl: text("repo_url"),
  gitProviderId: uuid("git_provider_id").references(() => gitProviders.id, { onDelete: "set null" }),
  image: text("image"), // for source = image, e.g. "n8nio/n8n:latest"
  volumes: jsonb("volumes").$type<SiteVolume[]>().default([]),
  autoDeploy: boolean("auto_deploy").default(true),
  branch: varchar("branch", { length: 100 }).default("main"),
  buildCommand: text("build_command"),
  startCommand: text("start_command"),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  phpVersion: varchar("php_version", { length: 10 }).default("8.2"),
  nodeVersion: varchar("node_version", { length: 10 }), // overrides package.json engines; set from a mid-deploy answer
  sslEnabled: boolean("ssl_enabled").default(false),
  sslExpiry: timestamp("ssl_expiry"),
  nginxConfig: text("nginx_config"),
  active: boolean("active").default(true),
  isPreview: boolean("is_preview").default(false),
  parentSiteId: uuid("parent_site_id"),
  currentTag: varchar("current_tag", { length: 100 }),

  // Resource Quotas
  cpuLimit: integer("cpu_limit").default(1),
  memoryLimit: integer("memory_limit").default(512),
  pidsLimit: integer("pids_limit").default(256),
  isReadOnly: boolean("is_read_only").default(false),
  
  // Reconciliation
  desiredStatus: varchar("desired_status", { length: 20 }).default("active"),
  lastReconciledAt: timestamp("last_reconciled_at"),

  // Runtime health, kept by the reconciler: a deploy can pass its health check and the app can still start crashing later.
  health: varchar("health", { length: 20 }).notNull().default("ok"), // ok | crashing
  healthDetail: jsonb("health_detail").$type<SiteHealthDetail | null>(),
  healthChangedAt: timestamp("health_changed_at"),
  restartsSeen: integer("restarts_seen").notNull().default(0), // the container's restart count at the last check

  // Build from a subfolder of the repository (monorepos), e.g. "apps/web". Empty = repository root.
  rootDirectory: varchar("root_directory", { length: 255 }),
  
  // Expiration
  expiresAt: timestamp("expires_at"),
  isTemporary: boolean("is_temporary").default(false),
  
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── DEPLOYMENTS ──────────────────────────────────────────────────────────────
// One row per deploy attempt. Gives the UI real history, build logs and a
// rollback target (the image tag) without anyone having to remember a SHA.
export const deployments = pgTable("deployments", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  // queued | building | starting | waiting_input | active | failed | superseded
  status: varchar("status", { length: 20 }).notNull().default("queued"),
  // manual | webhook | rollback | reconcile | preview
  trigger: varchar("trigger", { length: 20 }).notNull().default("manual"),
  runtime: varchar("runtime", { length: 30 }), // what was actually built (detected when site.type = auto)
  commitSha: varchar("commit_sha", { length: 64 }),
  commitMessage: text("commit_message"),
  imageTag: varchar("image_tag", { length: 255 }),
  port: integer("port"), // port the image serves on; needed to run it again on rollback
  containerName: varchar("container_name", { length: 128 }),
  log: text("log"),
  error: text("error"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  durationMs: integer("duration_ms"),
  // A question the running deploy is waiting on (status = waiting_input), and the answers given so far.
  prompt: jsonb("prompt").$type<DeployPrompt | null>(),
  answers: jsonb("answers").$type<Record<string, string>>().default({}),
});

export type DeployPromptOption = { value: string; label: string; detail?: string };
export type DeployPrompt = {
  id: string;
  kind: "confirm" | "select";
  title: string;
  detail?: string;
  options?: DeployPromptOption[];
  default: string;
  askedAt: string;
  expiresAt: string;
};

// ─── SITE ENVIRONMENT VARIABLES ──────────────────────────────────────────────
// Encrypted at rest with the platform MASTER_KEY (AES-256-GCM), injected into
// the site container at deploy time.
export const siteEnvVars = pgTable("site_env_vars", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  key: varchar("key", { length: 255 }).notNull(),
  encryptedValue: text("encrypted_value").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  authTag: varchar("auth_tag", { length: 64 }).notNull(),
  // Also passed to the image build (NEXT_PUBLIC_*, VITE_* and similar are read at build time, not at start).
  buildTime: boolean("build_time").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({
  siteKey: uniqueIndex("site_env_vars_site_key").on(t.siteId, t.key),
}));

// ─── DB INSTANCES ─────────────────────────────────────────────────────────────
export const dbInstances = pgTable("db_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: varchar("type", { length: 20 }).notNull(),
  name: varchar("name", { length: 100 }).notNull().unique(),
  dbUser: varchar("db_user", { length: 100 }).notNull(),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── PIPELINE LOGS ──────────────────────────────────────────────────────────
export const pipelineLogs = pgTable("pipeline_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  runId: uuid("run_id").notNull().references(() => pipelineRuns.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── SECURITY ALERTS ──────────────────────────────────────────────────────────
export const securityAlerts = pgTable("security_alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 20 }).notNull().default("high"),
  message: text("message").notNull(),
  details: text("details"),
  resolved: boolean("resolved").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// ─── SECRETS ──────────────────────────────────────────────────────────────────
export const secrets = pgTable("secrets", {
  id: uuid("id").defaultRandom().primaryKey(),
  keyName: varchar("key_name", { length: 255 }).notNull().unique(),
  encryptedValue: text("encrypted_value").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  authTag: varchar("auth_tag", { length: 64 }).notNull(),
  description: text("description"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── AUDIT LOGS ──────────────────────────────────────────────────────────────
export const auditLogs = pgTable("audit_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  action: varchar("action", { length: 100 }).notNull(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  actorEmail: varchar("actor_email", { length: 255 }),
  targetId: uuid("target_id"),
  targetType: varchar("target_type", { length: 50 }),
  targetName: varchar("target_name", { length: 255 }),
  metadata: jsonb("metadata"),
  ip: varchar("ip", { length: 50 }),
  userAgent: varchar("user_agent", { length: 500 }),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── CRON JOBS ───────────────────────────────────────────────────────────────
export const cronJobs = pgTable("cron_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 120 }).notNull().default(""),
  command: text("command").notNull(),
  // Five-field cron text, in `timezone`.
  schedule: varchar("schedule", { length: 100 }).notNull(),
  timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
  // "web" (the app's own container) or "worker:<name>"
  runIn: varchar("run_in", { length: 60 }).notNull().default("web"),
  /** A run is stopped after this long. */
  timeoutSec: integer("timeout_sec").notNull().default(600),
  notifyOnFailure: boolean("notify_on_failure").notNull().default(true),
  active: boolean("active").default(true),
  lastRunAt: timestamp("last_run_at"),
  // ok | failed | timeout | skipped
  lastStatus: varchar("last_status", { length: 12 }),
  lastExitCode: integer("last_exit_code"),
  lastDurationMs: integer("last_duration_ms"),
  /** Failed runs in a row; 0 after a success. */
  failStreak: integer("fail_streak").notNull().default(0),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// One row per run of a scheduled job, kept for 30 days.
export const cronRuns = pgTable("cron_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  jobId: uuid("job_id").notNull().references(() => cronJobs.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  // schedule | manual
  trigger: varchar("trigger", { length: 12 }).notNull().default("schedule"),
  triggeredBy: uuid("triggered_by").references(() => users.id, { onDelete: "set null" }),
  // running | ok | failed | timeout | skipped
  status: varchar("status", { length: 12 }).notNull().default("running"),
  exitCode: integer("exit_code"),
  /** The last 64 KB of output, secrets hidden. */
  output: text("output"),
  container: varchar("container", { length: 128 }),
  startedAt: timestamp("started_at").defaultNow(),
  finishedAt: timestamp("finished_at"),
  durationMs: integer("duration_ms"),
}, (t) => ({ byJob: index("cron_runs_job_idx").on(t.jobId, t.startedAt) }));

// Background processes of an app: same image and variables, no web traffic.
export const siteWorkers = pgTable("site_workers", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 40 }).notNull(),
  command: text("command").notNull(),
  copies: integer("copies").notNull().default(1),
  /** Memory limit of each copy, in MB. Counted in the capacity ledger. */
  memoryLimit: integer("memory_limit").notNull().default(256),
  /** Start it again when it stops. */
  restart: boolean("restart").notNull().default(true),
  /** Give it 30 seconds to finish on deploy instead of 5. */
  gracefulStop: boolean("graceful_stop").notNull().default(true),
  enabled: boolean("enabled").notNull().default(true),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (t) => ({ siteName: uniqueIndex("site_workers_site_name").on(t.siteId, t.name) }));

// ─── UNIFIED EVENT BUS ────────────────────────────────────────────────────────
export const platformEvents = pgTable("platform_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  
  category: varchar("category", { length: 50 }).notNull(), // deployment | security | infra | compliance | auth
  type: varchar("type", { length: 100 }).notNull(), // e.g. site.crash, ssh.login, drift.detected
  severity: varchar("severity", { length: 20 }).default("info"),
  
  summary: text("summary").notNull(),
  details: jsonb("details"),
  
  actorId: uuid("actor_id").references(() => users.id),
  traceId: varchar("trace_id", { length: 100 }),
  correlationId: varchar("correlation_id", { length: 100 }),
  
  timestamp: timestamp("timestamp").defaultNow(),
});

// ─── INFRASTRUCTURE KNOWLEDGE & MEMORY ───────────────────────────────────────
export const memoryChunks = pgTable("memory_chunks", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id"),
  
  type: varchar("type", { length: 30 }).notNull(), // episodic | semantic | procedural | operational
  sourceType: varchar("source_type", { length: 50 }), // event | policy | remediation | doc
  sourceId: uuid("source_id"),
  
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  
  // Note: embedding would be a vector type in pgvector. 
  // For drizzle-pg we'll use a placeholder or custom type if available.
  // embedding: customVector("embedding", { dimensions: 1536 }),
  
  createdAt: timestamp("created_at").defaultNow(),
});

export const memorySummaries = pgTable("memory_summaries", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id),
  
  category: varchar("category", { length: 50 }), // daily_digest | deployment_summary | incident_report
  content: text("content").notNull(),
  
  startTime: timestamp("start_time"),
  endTime: timestamp("end_time"),
  
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── NODES ──────────────────────────────────────────────────────────────────
export const nodes = pgTable("nodes", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  hostname: varchar("hostname", { length: 255 }).notNull(),
  tokenHash: text("token_hash").notNull(),
  ip: varchar("ip", { length: 64 }),
  publicIp: varchar("public_ip", { length: 64 }),
  os: varchar("os", { length: 100 }),
  arch: varchar("arch", { length: 20 }),
  cpuCores: integer("cpu_cores"),
  memoryMb: integer("memory_mb"),
  dockerVersion: varchar("docker_version", { length: 50 }),
  agentVersion: varchar("agent_version", { length: 50 }),
  status: varchar("status", { length: 20 }).notNull().default("offline"),
  tags: jsonb("tags").$type<string[]>().default([]),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── NODE METRICS ──────────────────────────────────────────────────────────
export const nodeMetrics = pgTable("node_metrics", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").notNull().references(() => nodes.id, { onDelete: "cascade" }),
  cpuUsage: integer("cpu_usage"),
  memoryUsage: integer("memory_usage"),
  diskUsage: integer("disk_usage"),
  networkRxKb: integer("network_rx_kb"),
  networkTxKb: integer("network_tx_kb"),
  timestamp: timestamp("timestamp").defaultNow(),
});

// ─── TERMINAL SESSIONS ──────────────────────────────────────────────────────────
export const terminalSessions = pgTable("terminal_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "set null" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
  sessionType: varchar("session_type", { length: 30 }).notNull().default("container"),
  targetContainerId: varchar("target_container_id", { length: 100 }),
  status: varchar("status", { length: 20 }).notNull().default("active"),
  idleTimeoutAt: timestamp("idle_timeout_at"),
  recording: text("recording"),
  startedAt: timestamp("started_at").defaultNow(),
  lastActivityAt: timestamp("last_activity_at").defaultNow(),
  endedAt: timestamp("ended_at"),
});

// ─── RBAC ─────────────────────────────────────────────────────────────────────
export const roles = pgTable("roles", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 50 }).notNull().unique(),
  description: text("description"),
  isSystem: boolean("is_system").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const permissions = pgTable("permissions", {
  id: uuid("id").defaultRandom().primaryKey(),
  key: varchar("key", { length: 100 }).notNull().unique(),
  description: text("description"),
});

export const rolePermissions = pgTable("role_permissions", {
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
  permissionId: uuid("permission_id").references(() => permissions.id, { onDelete: "cascade" }),
}, (t) => ({
  pk: primaryKey({ columns: [t.roleId, t.permissionId] }),
}));

export const userRoles = pgTable("user_roles", {
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
  roleId: uuid("role_id").references(() => roles.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id"),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.roleId] }),
}));

// ─── CONTAINER TRACKING ───────────────────────────────────────────────────────
export const containerInstances = pgTable("container_instances", {
  id: uuid("id").defaultRandom().primaryKey(),
  dockerId: varchar("docker_id", { length: 128 }).notNull().unique(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  tenantId: uuid("tenant_id"),
  runtime: varchar("runtime", { length: 50 }),
  createdBy: uuid("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── EDR & PROCESS EXPLORER ─────────────────────────────────────────
export const processSnapshots = pgTable("process_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  containerId: varchar("container_id", { length: 128 }),
  pid: integer("pid").notNull(),
  ppid: integer("ppid"),
  name: varchar("name", { length: 255 }).notNull(),
  command: text("command"),
  cpuUsage: integer("cpu_usage"),
  memoryUsage: integer("memory_usage"),
  user: varchar("user", { length: 100 }),
  sockets: jsonb("sockets"),
  riskScore: integer("risk_score").default(0),
  threatSignals: jsonb("threat_signals"),
  timestamp: timestamp("timestamp").defaultNow(),
});

export const securityThreats = pgTable("security_threats", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  containerId: varchar("container_id", { length: 128 }),
  type: varchar("type", { length: 50 }).notNull(),
  severity: varchar("severity", { length: 20 }).default("high"),
  status: varchar("status", { length: 20 }).default("active"),
  details: jsonb("details"),
  detectedAt: timestamp("detected_at").defaultNow(),
  resolvedAt: timestamp("resolved_at"),
});

// ─── FIM & NETWORK TELEMETRY ──────────────────────────────────────────────────
export const fileIntegritySnapshots = pgTable("file_integrity_snapshots", {
  id: uuid("id").defaultRandom().primaryKey(),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  filePath: text("file_path").notNull(),
  hash: varchar("hash", { length: 64 }).notNull(),
  inode: varchar("inode", { length: 50 }),
  permissions: varchar("permissions", { length: 10 }),
  entropy: integer("entropy"),
  isExecutable: boolean("is_executable").default(false),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
});

export const networkTelemetry = pgTable("network_telemetry", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  containerId: varchar("container_id", { length: 128 }),
  direction: varchar("direction", { length: 10 }).notNull(),
  protocol: varchar("protocol", { length: 10 }),
  localAddr: varchar("local_addr", { length: 100 }),
  remoteAddr: varchar("remote_addr", { length: 100 }),
  remotePort: integer("remote_port"),
  remoteAsn: integer("remote_asn"),
  remoteCountry: varchar("remote_country", { length: 2 }),
  dnsRequest: text("dns_request"),
  riskScore: integer("risk_score").default(0),
  timestamp: timestamp("timestamp").defaultNow(),
});

// ─── SECURITY HARDENING & COMPLIANCE ──────────────────────────────────────────
export const securityPolicies = pgTable("security_policies", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 100 }).notNull(),
  mode: varchar("mode", { length: 20 }).default("monitor"),
  sshPolicy: jsonb("ssh_policy"),
  firewallPolicy: jsonb("firewall_policy"),
  userPolicy: jsonb("user_policy"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const nodeHardeningState = pgTable("node_hardening_state", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }).unique(),
  overallScore: integer("overall_score").default(0),
  complianceStatus: varchar("compliance_status", { length: 20 }).default("unknown"),
  actualConfig: jsonb("actual_config"),
  driftDetails: jsonb("drift_details"),
  lastScannedAt: timestamp("last_scanned_at").defaultNow(),
});

export const securityRemediationPlans = pgTable("security_remediation_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  policyId: uuid("policy_id").references(() => securityPolicies.id),
  status: varchar("status", { length: 20 }).default("pending"),
  plannedChanges: jsonb("planned_changes"),
  rollbackData: jsonb("rollback_data"),
  riskLevel: varchar("risk_level", { length: 20 }).default("medium"),
  createdBy: uuid("created_by").references(() => users.id),
  approvedBy: uuid("approved_by").references(() => users.id),
  appliedAt: timestamp("applied_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const securityActions = pgTable("security_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  nodeId: uuid("node_id").references(() => nodes.id, { onDelete: "cascade" }),
  planId: uuid("plan_id").references(() => securityRemediationPlans.id),
  
  action: varchar("action", { length: 100 }).notNull(), // e.g. disable_root_ssh
  actorId: uuid("actor_id").references(() => users.id),
  
  status: varchar("status", { length: 20 }).default("success"), // success | failed | reverted
  
  beforeState: jsonb("before_state"),
  afterState: jsonb("after_state"),
  
  rollbackSnapshotId: varchar("rollback_snapshot_id", { length: 100 }),
  correlationId: varchar("correlation_id", { length: 100 }),
  
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── AI INTELLIGENCE GATEWAY ─────────────────────────────────────────────────
export const aiProviders = pgTable("ai_providers", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id"),
  name: varchar("name", { length: 100 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(), // openai | anthropic | ollama | gemini
  baseUrl: text("baseUrl"),
  apiKeyId: uuid("api_key_id").references(() => secrets.id), // Link to encrypted secret
  model: varchar("model", { length: 100 }),
  isActive: boolean("is_active").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const aiSessions = pgTable("ai_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => users.id),
  tenantId: uuid("tenant_id"),
  title: varchar("title", { length: 255 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const aiIntents = pgTable("ai_intents", {
  id: uuid("id").defaultRandom().primaryKey(),
  sessionId: uuid("session_id").references(() => aiSessions.id),
  nodeId: uuid("node_id").references(() => nodes.id),
  
  intentType: varchar("intent_type", { length: 100 }).notNull(), // restart_workload | harden_node | quarantine
  status: varchar("status", { length: 20 }).default("pending"), // pending | approved | executed | rejected
  
  params: jsonb("params"),
  reasoning: text("reasoning"),
  riskScore: integer("risk_score"),
  
  traceId: varchar("trace_id", { length: 100 }),
  approvedBy: uuid("approved_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── INFRASTRUCTURE KNOWLEDGE GRAPH ──────────────────────────────────────────
export const entities = pgTable("entities", {
  id: uuid("id").defaultRandom().primaryKey(),
  type: varchar("type", { length: 50 }).notNull(), // node | container | site | user | domain | alert | session
  externalId: varchar("external_id", { length: 255 }), // e.g. nodeId or siteId
  name: varchar("name", { length: 255 }),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const entityRelations = pgTable("entity_relations", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceId: uuid("source_id").references(() => entities.id, { onDelete: "cascade" }),
  targetId: uuid("target_id").references(() => entities.id, { onDelete: "cascade" }),
  relation: varchar("relation", { length: 100 }).notNull(), // OWNS | RUNS | ACCESSED | TRIGGERED | CAUSED
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

// ─── WORKFLOW ENGINE ─────────────────────────────────────────────────────────
export const workflows = pgTable("workflows", {
  id: uuid("id").defaultRandom().primaryKey(),
  tenantId: uuid("tenant_id"),
  name: varchar("name", { length: 255 }).notNull(),
  type: varchar("type", { length: 50 }).notNull(), // deployment | remediation | backup | audit
  status: varchar("status", { length: 20 }).default("pending"), // pending | running | completed | failed | cancelled
  
  traceId: varchar("trace_id", { length: 100 }),
  context: jsonb("context"),
  
  error: text("error"),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const workflowSteps = pgTable("workflow_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  workflowId: uuid("workflow_id").references(() => workflows.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  order: integer("order").notNull(),
  
  action: varchar("action", { length: 100 }).notNull(), // e.g. docker.pull, node.harden, notify.admin
  params: jsonb("params"),
  
  status: varchar("status", { length: 20 }).default("pending"),
  result: jsonb("result"),
  error: text("error"),
  
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
});

// ─── AUTOMATIONS (visual workflows) ───────────────────────────────────────────
export type AutomationGraph = {
  nodes: Array<{ id: string; type: string; position: { x: number; y: number }; data: Record<string, any> }>;
  edges: Array<{ id: string; source: string; target: string; sourceHandle?: string | null }>;
};

export type AutomationStep = {
  status: "running" | "success" | "failed" | "skipped";
  startedAt: string;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  branch?: string;
  attempts?: number;
};

export const automations = pgTable("automations", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 255 }).notNull(),
  description: text("description"),
  enabled: boolean("enabled").notNull().default(false),
  graph: jsonb("graph").$type<AutomationGraph>().notNull(),
  // Derived from the graph's trigger node on save, so triggers can be looked up without parsing graphs.
  triggerType: varchar("trigger_type", { length: 30 }).notNull().default("manual"), // manual | schedule | webhook | deployment
  schedule: varchar("schedule", { length: 100 }),
  webhookToken: varchar("webhook_token", { length: 64 }).unique(),
  lastRunAt: timestamp("last_run_at"),
  lastRunStatus: varchar("last_run_status", { length: 20 }),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const automationRuns = pgTable("automation_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  automationId: uuid("automation_id").notNull().references(() => automations.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 20 }).notNull().default("queued"), // queued | running | success | failed
  trigger: varchar("trigger", { length: 30 }).notNull().default("manual"),
  input: jsonb("input"),
  steps: jsonb("steps").$type<Record<string, AutomationStep>>().default({}),
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  durationMs: integer("duration_ms"),
});

// ─── API TOKENS (AI agents over MCP) ─────────────────────────────────────────
// A token acts as its user, limited by its scope. Only a SHA-256 of the token is
// stored; the token itself is shown once, when it is created.
export const apiTokens = pgTable(
  "api_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 100 }).notNull(),
    scope: varchar("scope", { length: 20 }).notNull().default("read"), // read | deploy | full
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    prefix: varchar("prefix", { length: 16 }).notNull(), // first characters, so people can tell tokens apart
    expiresAt: timestamp("expires_at"),
    lastUsedAt: timestamp("last_used_at"),
    lastUsedIp: varchar("last_used_ip", { length: 64 }),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({ byUser: index("api_tokens_user_idx").on(t.userId) })
);

// Every MCP tool call, for the activity list on the AI agents page.
export const mcpCalls = pgTable(
  "mcp_calls",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tokenId: uuid("token_id").references(() => apiTokens.id, { onDelete: "set null" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    tool: varchar("tool", { length: 60 }).notNull(),
    args: jsonb("args"), // secret values are removed before saving
    ok: boolean("ok").notNull(),
    error: text("error"),
    durationMs: integer("duration_ms"),
    ip: varchar("ip", { length: 64 }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({ byUserTime: index("mcp_calls_user_time_idx").on(t.userId, t.createdAt) })
);

// ─── EXPORTS ──────────────────────────────────────────────────────────────────
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Site = typeof sites.$inferSelect;
export type Deployment = typeof deployments.$inferSelect;
export type GitProvider = typeof gitProviders.$inferSelect;
export type Automation = typeof automations.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
// An invitation to join the team. The link carries a token; only its hash is kept here.
export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    role: varchar("role", { length: 20 }).notNull(), // admin | developer | viewer
    allApps: boolean("all_apps").notNull().default(false),
    siteIds: jsonb("site_ids").$type<string[]>().notNull().default([]),
    grants: jsonb("grants").$type<{ createApps?: boolean; deleteApps?: boolean; terminal?: boolean; agentTokens?: boolean }>().notNull().default({}),
    note: text("note"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    invitedBy: uuid("invited_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedBy: uuid("accepted_by").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({ byEmail: index("invitations_email_idx").on(t.email) })
);

// Apps shared with a member who was not given every app.
export const siteAccess = pgTable(
  "site_access",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    siteId: uuid("site_id").notNull().references(() => sites.id, { onDelete: "cascade" }),
    grantedBy: uuid("granted_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.userId, t.siteId] }) })
);

// "Request access" from the public sign-up page. The owner approves (which creates an invitation) or declines.
export const accessRequests = pgTable("access_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 255 }).notNull(),
  name: varchar("name", { length: 120 }).notNull(),
  message: text("message"),
  status: varchar("status", { length: 20 }).notNull().default("pending"), // pending | approved | declined
  decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  ip: varchar("ip", { length: 64 }),
  createdAt: timestamp("created_at").defaultNow(),
});

// Platform-wide settings an admin can change in the panel. One row per key, e.g. "capacity".
export const platformSettings = pgTable("platform_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: uuid("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// What the host scan found on the server: users, admin rights, SSH keys and settings, scheduled jobs,
// services, startup files, listening ports. One row per thing; `status` says whether the admin has accepted it.
export const hostItems = pgTable("host_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  kind: varchar("kind", { length: 20 }).notNull(),
  key: varchar("key", { length: 300 }).notNull().unique(),
  label: text("label").notNull(),
  detail: jsonb("detail").$type<Record<string, any>>().notNull().default({}),
  fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
  // initial (first scan, waiting for the one-time review) | accepted (the baseline) | new | changed
  status: varchar("status", { length: 12 }).notNull(),
  // urgent | check | note
  severity: varchar("severity", { length: 8 }).notNull().default("check"),
  reason: text("reason"),
  /** What it looked like when it was last accepted, for a "changed" finding. */
  previous: jsonb("previous").$type<Record<string, any> | null>(),
  /** false: it was on the server and is not any more. */
  present: boolean("present").notNull().default(true),
  firstSeenAt: timestamp("first_seen_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  changedAt: timestamp("changed_at"),
  snoozedUntil: timestamp("snoozed_until"),
  decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at"),
  note: text("note"),
}, (t) => ({ byStatus: index("host_items_status_idx").on(t.status) }));

// "Remove" and "Undo" on the Security page. Carried out on the server by scripts/host-act.py; this is the record.
export const hostActions = pgTable("host_actions", {
  id: uuid("id").defaultRandom().primaryKey(),
  itemKey: varchar("item_key", { length: 300 }).notNull(),
  itemLabel: text("item_label").notNull(),
  kind: varchar("kind", { length: 20 }).notNull(),
  action: varchar("action", { length: 40 }).notNull(),
  target: jsonb("target").$type<Record<string, any>>().notNull(),
  /** What the admin was told would happen. */
  plan: text("plan").notNull(),
  // pending | done | failed | undo-pending | undone | undo-failed
  status: varchar("status", { length: 16 }).notNull().default("pending"),
  message: text("message"),
  undoable: boolean("undoable").notNull().default(false),
  requestedBy: uuid("requested_by").references(() => users.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at").defaultNow(),
  finishedAt: timestamp("finished_at"),
  undoBy: uuid("undo_by").references(() => users.id, { onDelete: "set null" }),
  undoAt: timestamp("undo_at"),
  undoMessage: text("undo_message"),
}, (t) => ({ byItem: index("host_actions_item_idx").on(t.itemKey) }));

// One row per cleanup run, automatic or by hand: what was removed and how much it freed.
export const cleanupRuns = pgTable("cleanup_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  // manual | weekly | disk
  trigger: varchar("trigger", { length: 20 }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  freedBytes: bigint("freed_bytes", { mode: "number" }).notNull().default(0),
  results: jsonb("results").$type<Array<{ kind: string; removed: number; bytes: number; errors: string[] }>>().notNull().default([]),
  createdAt: timestamp("created_at").defaultNow(),
});

export type Invitation = typeof invitations.$inferSelect;
export type CronJob = typeof cronJobs.$inferSelect;
export type CronRun = typeof cronRuns.$inferSelect;
export type SiteWorker = typeof siteWorkers.$inferSelect;
export type AccessRequest = typeof accessRequests.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type McpCall = typeof mcpCalls.$inferSelect;
export type SiteEnvVar = typeof siteEnvVars.$inferSelect;
export type Pipeline = typeof pipelines.$inferSelect;
export type AuditLog = typeof auditLogs.$inferSelect;
export type Secret = typeof secrets.$inferSelect;
export type Node = typeof nodes.$inferSelect;
export type NodeMetric = typeof nodeMetrics.$inferSelect;
export type TerminalSession = typeof terminalSessions.$inferSelect;
export type Role = typeof roles.$inferSelect;
export type Permission = typeof permissions.$inferSelect;
export type ContainerInstance = typeof containerInstances.$inferSelect;
export type ProcessSnapshot = typeof processSnapshots.$inferSelect;
export type SecurityThreat = typeof securityThreats.$inferSelect;
export type FileIntegritySnapshot = typeof fileIntegritySnapshots.$inferSelect;
export type NetworkTelemetry = typeof networkTelemetry.$inferSelect;
export type SecurityPolicy = typeof securityPolicies.$inferSelect;
export type NodeHardeningState = typeof nodeHardeningState.$inferSelect;
export type SecurityRemediationPlan = typeof securityRemediationPlans.$inferSelect;
export type SecurityAction = typeof securityActions.$inferSelect;
export type PlatformEvent = typeof platformEvents.$inferSelect;
export type MemoryChunk = typeof memoryChunks.$inferSelect;
export type MemorySummary = typeof memorySummaries.$inferSelect;
export type AIProviderConfig = typeof aiProviders.$inferSelect;
export type AISession = typeof aiSessions.$inferSelect;
export type AIIntentLog = typeof aiIntents.$inferSelect;
export type Entity = typeof entities.$inferSelect;
export type EntityRelation = typeof entityRelations.$inferSelect;
export type Workflow = typeof workflows.$inferSelect;
export type WorkflowStep = typeof workflowSteps.$inferSelect;

// ─── SERVERS & SSH (servers agent) ───────────────────────────────────────────
// Other servers this panel signs in to over SSH. Admins only. Private keys and stored passwords are
// encrypted with MASTER_KEY (AES-256-GCM, @dbbkp/security) and never leave the API.

export type SshAccessRules = {
  adminsOnly: boolean; // only admins can open a terminal
  askPassword: boolean; // ask for the panel password before a terminal opens
  record: boolean; // record terminal sessions (kept 30 days)
  idleMinutes: number; // close idle sessions after this many minutes; 0 = never
  allowAutomation: boolean; // workflows and AI agents may run commands (each still needs approval)
};

export type SshSystemInfo = {
  os?: string;
  cpus?: number;
  memoryMb?: number;
  memoryUsedMb?: number;
  diskTotalGb?: number;
  diskFreeGb?: number;
  uptimeSec?: number;
  load?: number;
  cpuPct?: number;
  docker?: string | null;
  passwordAuth?: boolean | null; // the server still offers password sign-in
  sudo?: "root" | "nopass" | "pass" | "none";
  latencyMs?: number;
  seenFrom?: string; // the address this panel connects from, as the server sees it
  checkedAt?: string;
};

export const sshKeys = pgTable("ssh_keys", {
  id: uuid("id").defaultRandom().primaryKey(),
  label: varchar("label", { length: 120 }).notNull(),
  type: varchar("type", { length: 20 }).notNull(), // ed25519 | rsa4096 | ecdsa
  publicKey: text("public_key").notNull(), // one OpenSSH line: "<algo> <base64> <comment>"
  fingerprint: varchar("fingerprint", { length: 100 }).notNull(), // SHA256:...
  encryptedPrivateKey: text("encrypted_private_key").notNull(),
  iv: varchar("iv", { length: 64 }).notNull(),
  authTag: varchar("auth_tag", { length: 64 }).notNull(),
  hasPassphrase: boolean("has_passphrase").notNull().default(false),
  imported: boolean("imported").notNull().default(false),
  fromAddress: varchar("from_address", { length: 255 }), // from="..." lock; null = usable from anywhere
  restrict: boolean("restrict").notNull().default(true), // no port, agent or X11 forwarding
  rotateAfterDays: integer("rotate_after_days"), // null = never remind
  rotatedFromId: uuid("rotated_from_id"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at"),
});

export const sshServers = pgTable("ssh_servers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 80 }).notNull().unique(),
  host: varchar("host", { length: 255 }).notNull(),
  port: integer("port").notNull().default(22),
  username: varchar("username", { length: 64 }).notNull(),
  authMethod: varchar("auth_method", { length: 20 }).notNull().default("key"), // key | password-once | password
  keyId: uuid("key_id").references(() => sshKeys.id, { onDelete: "set null" }),
  // Only for "password every time".
  encryptedPassword: text("encrypted_password"),
  passwordIv: varchar("password_iv", { length: 64 }),
  passwordAuthTag: varchar("password_auth_tag", { length: 64 }),
  // Trust on first use: what the server showed the first time, and what the admin confirmed.
  seenHostKeyType: varchar("seen_host_key_type", { length: 40 }),
  seenHostKeyFingerprint: varchar("seen_host_key_fingerprint", { length: 100 }),
  hostKeyType: varchar("host_key_type", { length: 40 }),
  hostKeyFingerprint: varchar("host_key_fingerprint", { length: 100 }),
  hostKeyTrustedAt: timestamp("host_key_trusted_at"),
  rules: jsonb("rules").$type<SshAccessRules>().notNull(),
  // waiting_key | waiting_trust | connected | unreachable | auth_failed | host_key_changed
  status: varchar("status", { length: 30 }).notNull().default("waiting_key"),
  statusNote: text("status_note"),
  system: jsonb("system").$type<SshSystemInfo>().notNull().default({}),
  timeoutSec: integer("timeout_sec").notNull().default(10),
  jumpServerId: uuid("jump_server_id"),
  setupDone: boolean("setup_done").notNull().default(false),
  lastCheckAt: timestamp("last_check_at"),
  lastUsedAt: timestamp("last_used_at"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// One row per terminal opened on a server. The recording (asciicast v2, output only) is a file on disk, kept 30 days.
export const sshSessions = pgTable("ssh_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverId: uuid("server_id").notNull().references(() => sshServers.id, { onDelete: "cascade" }),
  userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
  actor: varchar("actor", { length: 120 }).notNull(), // who, in words: a username or "Workflow: nightly check"
  startedAt: timestamp("started_at").notNull().defaultNow(),
  endedAt: timestamp("ended_at"),
  endReason: varchar("end_reason", { length: 60 }), // ended | idle | disconnected | server-closed | error
  commands: integer("commands").notNull().default(0),
  recordingPath: text("recording_path"),
  recordingBytes: bigint("recording_bytes", { mode: "number" }).notNull().default(0),
  ip: varchar("ip", { length: 64 }),
}, (t) => ({
  byServer: index("ssh_sessions_server").on(t.serverId, t.startedAt),
}));

export type SshKey = typeof sshKeys.$inferSelect;
export type SshServer = typeof sshServers.$inferSelect;
export type SshSession = typeof sshSessions.$inferSelect;
