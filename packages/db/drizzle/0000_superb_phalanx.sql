CREATE TABLE IF NOT EXISTS "ai_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"node_id" uuid,
	"intent_type" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'pending',
	"params" jsonb,
	"reasoning" text,
	"risk_score" integer,
	"trace_id" varchar(100),
	"approved_by" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name" varchar(100) NOT NULL,
	"type" varchar(50) NOT NULL,
	"baseUrl" text,
	"api_key_id" uuid,
	"model" varchar(100),
	"is_active" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"tenant_id" uuid,
	"title" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" varchar(100) NOT NULL,
	"actor_id" uuid,
	"actor_email" varchar(255),
	"target_id" uuid,
	"target_type" varchar(50),
	"target_name" varchar(255),
	"metadata" jsonb,
	"ip" varchar(50),
	"user_agent" varchar(500),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"trigger" varchar(30) DEFAULT 'manual' NOT NULL,
	"input" jsonb,
	"steps" jsonb DEFAULT '{}'::jsonb,
	"error" text,
	"created_at" timestamp DEFAULT now(),
	"started_at" timestamp,
	"finished_at" timestamp,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"enabled" boolean DEFAULT false NOT NULL,
	"graph" jsonb NOT NULL,
	"trigger_type" varchar(30) DEFAULT 'manual' NOT NULL,
	"schedule" varchar(100),
	"webhook_token" varchar(64),
	"last_run_at" timestamp,
	"last_run_status" varchar(20),
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "automations_webhook_token_unique" UNIQUE("webhook_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "container_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"docker_id" varchar(128) NOT NULL,
	"node_id" uuid,
	"site_id" uuid,
	"tenant_id" uuid,
	"runtime" varchar(50),
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "container_instances_docker_id_unique" UNIQUE("docker_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cron_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"command" text NOT NULL,
	"schedule" varchar(100) NOT NULL,
	"active" boolean DEFAULT true,
	"last_run_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "db_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(20) NOT NULL,
	"name" varchar(100) NOT NULL,
	"db_user" varchar(100) NOT NULL,
	"site_id" uuid,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "db_instances_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"status" varchar(20) DEFAULT 'queued' NOT NULL,
	"trigger" varchar(20) DEFAULT 'manual' NOT NULL,
	"runtime" varchar(30),
	"commit_sha" varchar(64),
	"commit_message" text,
	"image_tag" varchar(255),
	"port" integer,
	"container_name" varchar(128),
	"log" text,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"started_at" timestamp,
	"finished_at" timestamp,
	"duration_ms" integer,
	"prompt" jsonb,
	"answers" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(50) NOT NULL,
	"external_id" varchar(255),
	"name" varchar(255),
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid,
	"target_id" uuid,
	"relation" varchar(100) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_integrity_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"file_path" text NOT NULL,
	"hash" varchar(64) NOT NULL,
	"inode" varchar(50),
	"permissions" varchar(10),
	"entropy" integer,
	"is_executable" boolean DEFAULT false,
	"last_seen_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "git_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" varchar(20) DEFAULT 'github' NOT NULL,
	"name" varchar(100) NOT NULL,
	"login" varchar(100),
	"avatar_url" text,
	"encrypted_token" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bull_job_id" varchar(100),
	"type" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'waiting' NOT NULL,
	"payload" text,
	"result" text,
	"error" text,
	"created_at" timestamp DEFAULT now(),
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"type" varchar(30) NOT NULL,
	"source_type" varchar(50),
	"source_id" uuid,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "memory_summaries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"category" varchar(50),
	"content" text NOT NULL,
	"start_time" timestamp,
	"end_time" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "network_telemetry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"container_id" varchar(128),
	"direction" varchar(10) NOT NULL,
	"protocol" varchar(10),
	"local_addr" varchar(100),
	"remote_addr" varchar(100),
	"remote_port" integer,
	"remote_asn" integer,
	"remote_country" varchar(2),
	"dns_request" text,
	"risk_score" integer DEFAULT 0,
	"timestamp" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_hardening_state" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"overall_score" integer DEFAULT 0,
	"compliance_status" varchar(20) DEFAULT 'unknown',
	"actual_config" jsonb,
	"drift_details" jsonb,
	"last_scanned_at" timestamp DEFAULT now(),
	CONSTRAINT "node_hardening_state_node_id_unique" UNIQUE("node_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "node_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"cpu_usage" integer,
	"memory_usage" integer,
	"disk_usage" integer,
	"network_rx_kb" integer,
	"network_tx_kb" integer,
	"timestamp" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"token_hash" text NOT NULL,
	"ip" varchar(64),
	"public_ip" varchar(64),
	"os" varchar(100),
	"arch" varchar(20),
	"cpu_cores" integer,
	"memory_mb" integer,
	"docker_version" varchar(50),
	"agent_version" varchar(50),
	"status" varchar(20) DEFAULT 'offline' NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb,
	"last_heartbeat_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "permissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"description" text,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"pipeline_id" uuid NOT NULL,
	"bull_job_id" varchar(100),
	"status" varchar(20) DEFAULT 'waiting' NOT NULL,
	"commit_sha" varchar(40),
	"log" text,
	"runner" varchar(20) DEFAULT 'docker',
	"image" varchar(255),
	"exit_code" integer,
	"error" text,
	"created_at" timestamp DEFAULT now(),
	"started_at" timestamp,
	"finished_at" timestamp,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipelines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"repo_url" text NOT NULL,
	"branch" varchar(255) DEFAULT 'main',
	"build_command" text,
	"deploy_command" text,
	"env_vars" text,
	"enabled" boolean DEFAULT true,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "platform_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"site_id" uuid,
	"category" varchar(50) NOT NULL,
	"type" varchar(100) NOT NULL,
	"severity" varchar(20) DEFAULT 'info',
	"summary" text NOT NULL,
	"details" jsonb,
	"actor_id" uuid,
	"trace_id" varchar(100),
	"correlation_id" varchar(100),
	"timestamp" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "process_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"container_id" varchar(128),
	"pid" integer NOT NULL,
	"ppid" integer,
	"name" varchar(255) NOT NULL,
	"command" text,
	"cpu_usage" integer,
	"memory_usage" integer,
	"user" varchar(100),
	"sockets" jsonb,
	"risk_score" integer DEFAULT 0,
	"threat_signals" jsonb,
	"timestamp" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "role_permissions" (
	"role_id" uuid,
	"permission_id" uuid,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(50) NOT NULL,
	"description" text,
	"is_system" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key_name" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"description" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "secrets_key_name_unique" UNIQUE("key_name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"plan_id" uuid,
	"action" varchar(100) NOT NULL,
	"actor_id" uuid,
	"status" varchar(20) DEFAULT 'success',
	"before_state" jsonb,
	"after_state" jsonb,
	"rollback_snapshot_id" varchar(100),
	"correlation_id" varchar(100),
	"error" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"type" varchar(50) NOT NULL,
	"severity" varchar(20) DEFAULT 'high' NOT NULL,
	"message" text NOT NULL,
	"details" text,
	"resolved" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"name" varchar(100) NOT NULL,
	"mode" varchar(20) DEFAULT 'monitor',
	"ssh_policy" jsonb,
	"firewall_policy" jsonb,
	"user_policy" jsonb,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_remediation_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"policy_id" uuid,
	"status" varchar(20) DEFAULT 'pending',
	"planned_changes" jsonb,
	"rollback_data" jsonb,
	"risk_level" varchar(20) DEFAULT 'medium',
	"created_by" uuid,
	"approved_by" uuid,
	"applied_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_threats" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"site_id" uuid,
	"container_id" varchar(128),
	"type" varchar(50) NOT NULL,
	"severity" varchar(20) DEFAULT 'high',
	"status" varchar(20) DEFAULT 'active',
	"details" jsonb,
	"detected_at" timestamp DEFAULT now(),
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"host" varchar(255) NOT NULL,
	"ssh_user" varchar(255) DEFAULT 'root' NOT NULL,
	"ssh_port" integer DEFAULT 22,
	"ssh_key_path" text,
	"is_local" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"last_activity_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_env_vars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"key" varchar(255) NOT NULL,
	"encrypted_value" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"domain" varchar(255) NOT NULL,
	"type" varchar(20) DEFAULT 'static' NOT NULL,
	"doc_root" text NOT NULL,
	"port" integer,
	"pm2_name" varchar(100),
	"source" varchar(20) DEFAULT 'zip' NOT NULL,
	"repo_url" text,
	"git_provider_id" uuid,
	"image" text,
	"volumes" jsonb DEFAULT '[]'::jsonb,
	"auto_deploy" boolean DEFAULT true,
	"branch" varchar(100) DEFAULT 'main',
	"build_command" text,
	"start_command" text,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"php_version" varchar(10) DEFAULT '8.2',
	"node_version" varchar(10),
	"ssl_enabled" boolean DEFAULT false,
	"ssl_expiry" timestamp,
	"nginx_config" text,
	"active" boolean DEFAULT true,
	"is_preview" boolean DEFAULT false,
	"parent_site_id" uuid,
	"current_tag" varchar(100),
	"cpu_limit" integer DEFAULT 1,
	"memory_limit" integer DEFAULT 512,
	"pids_limit" integer DEFAULT 256,
	"is_read_only" boolean DEFAULT false,
	"desired_status" varchar(20) DEFAULT 'active',
	"last_reconciled_at" timestamp,
	"expires_at" timestamp,
	"is_temporary" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "sites_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "terminal_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"node_id" uuid,
	"site_id" uuid,
	"session_type" varchar(30) DEFAULT 'container' NOT NULL,
	"target_container_id" varchar(100),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"idle_timeout_at" timestamp,
	"recording" text,
	"started_at" timestamp DEFAULT now(),
	"last_activity_at" timestamp DEFAULT now(),
	"ended_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_roles" (
	"user_id" uuid,
	"role_id" uuid,
	"tenant_id" uuid,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"username" varchar(100) NOT NULL,
	"password_hash" text NOT NULL,
	"role" varchar(20) DEFAULT 'user' NOT NULL,
	"must_change_password" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_id" uuid,
	"name" varchar(255) NOT NULL,
	"order" integer NOT NULL,
	"action" varchar(100) NOT NULL,
	"params" jsonb,
	"status" varchar(20) DEFAULT 'pending',
	"result" jsonb,
	"error" text,
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"name" varchar(255) NOT NULL,
	"type" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'pending',
	"trace_id" varchar(100),
	"context" jsonb,
	"error" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_intents" ADD CONSTRAINT "ai_intents_session_id_ai_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_sessions"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_intents" ADD CONSTRAINT "ai_intents_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_intents" ADD CONSTRAINT "ai_intents_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_providers" ADD CONSTRAINT "ai_providers_api_key_id_secrets_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."secrets"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_sessions" ADD CONSTRAINT "ai_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automation_runs" ADD CONSTRAINT "automation_runs_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_instances" ADD CONSTRAINT "container_instances_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_instances" ADD CONSTRAINT "container_instances_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_instances" ADD CONSTRAINT "container_instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "db_instances" ADD CONSTRAINT "db_instances_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_source_id_entities_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "entity_relations" ADD CONSTRAINT "entity_relations_target_id_entities_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_integrity_snapshots" ADD CONSTRAINT "file_integrity_snapshots_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "git_providers" ADD CONSTRAINT "git_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "memory_summaries" ADD CONSTRAINT "memory_summaries_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "network_telemetry" ADD CONSTRAINT "network_telemetry_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "node_hardening_state" ADD CONSTRAINT "node_hardening_state_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "node_metrics" ADD CONSTRAINT "node_metrics_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_logs" ADD CONSTRAINT "pipeline_logs_run_id_pipeline_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."pipeline_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_runs" ADD CONSTRAINT "pipeline_runs_pipeline_id_pipelines_id_fk" FOREIGN KEY ("pipeline_id") REFERENCES "public"."pipelines"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_events" ADD CONSTRAINT "platform_events_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_events" ADD CONSTRAINT "platform_events_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "platform_events" ADD CONSTRAINT "platform_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "process_snapshots" ADD CONSTRAINT "process_snapshots_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_actions" ADD CONSTRAINT "security_actions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_actions" ADD CONSTRAINT "security_actions_plan_id_security_remediation_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."security_remediation_plans"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_actions" ADD CONSTRAINT "security_actions_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_policies" ADD CONSTRAINT "security_policies_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_remediation_plans" ADD CONSTRAINT "security_remediation_plans_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_remediation_plans" ADD CONSTRAINT "security_remediation_plans_policy_id_security_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."security_policies"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_remediation_plans" ADD CONSTRAINT "security_remediation_plans_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_remediation_plans" ADD CONSTRAINT "security_remediation_plans_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_threats" ADD CONSTRAINT "security_threats_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "security_threats" ADD CONSTRAINT "security_threats_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_env_vars" ADD CONSTRAINT "site_env_vars_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sites" ADD CONSTRAINT "sites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sites" ADD CONSTRAINT "sites_git_provider_id_git_providers_id_fk" FOREIGN KEY ("git_provider_id") REFERENCES "public"."git_providers"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_node_id_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."nodes"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "terminal_sessions" ADD CONSTRAINT "terminal_sessions_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_env_vars_site_key" ON "site_env_vars" ("site_id","key");