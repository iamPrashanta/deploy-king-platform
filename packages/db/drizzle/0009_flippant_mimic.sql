CREATE TABLE IF NOT EXISTS "alert_state" (
	"kind" varchar(20) NOT NULL,
	"item_key" varchar(300) NOT NULL,
	"title" text NOT NULL,
	"last_sent_at" timestamp DEFAULT now() NOT NULL,
	"suppressed" integer DEFAULT 0 NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "alert_state_kind_item_key_pk" PRIMARY KEY("kind","item_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_destinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"kind" varchar(20) NOT NULL,
	"location" text NOT NULL,
	"keep_last" integer,
	"built_in" boolean DEFAULT false NOT NULL,
	"last_check_at" timestamp,
	"last_check_ok" boolean,
	"last_check_message" text,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_key" varchar(200) NOT NULL,
	"target_type" varchar(12) NOT NULL,
	"db_instance_id" uuid,
	"site_id" uuid,
	"volume_name" varchar(60),
	"schedule" varchar(100) NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"keep" integer DEFAULT 7 NOT NULL,
	"destination_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "backup_policies_target_key_unique" UNIQUE("target_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backup_restores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"backup_id" uuid NOT NULL,
	"target_key" varchar(200) NOT NULL,
	"target_name" varchar(255) NOT NULL,
	"mode" varchar(8) NOT NULL,
	"into" varchar(8) NOT NULL,
	"new_name" varchar(100),
	"verify_checksum" boolean DEFAULT true NOT NULL,
	"safety_backup" boolean DEFAULT true NOT NULL,
	"stop_app" boolean DEFAULT false NOT NULL,
	"safety_backup_id" uuid,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"result_db_instance_id" uuid,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_key" varchar(200) NOT NULL,
	"target_type" varchar(12) NOT NULL,
	"db_instance_id" uuid,
	"site_id" uuid,
	"volume_name" varchar(60),
	"target_name" varchar(255) NOT NULL,
	"engine" varchar(12) NOT NULL,
	"trigger" varchar(12) DEFAULT 'manual' NOT NULL,
	"status" varchar(12) DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"file_name" varchar(255),
	"size_bytes" bigint,
	"sha256" varchar(64),
	"duration_ms" integer,
	"error" text,
	"copies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"policy_id" uuid,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"started_at" timestamp,
	"finished_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "db_connections" (
	"db_instance_id" uuid PRIMARY KEY NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer DEFAULT 5432 NOT NULL,
	"database" varchar(100) NOT NULL,
	"encrypted_url" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "github_app_installations" (
	"installation_id" bigint PRIMARY KEY NOT NULL,
	"provider_id" uuid NOT NULL,
	"account" varchar(100) NOT NULL,
	"account_type" varchar(20) NOT NULL,
	"repository_selection" varchar(12) DEFAULT 'selected' NOT NULL,
	"suspended_at" timestamp,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "session_devices" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"ip" varchar(64),
	"user_agent" varchar(500),
	"method" varchar(20),
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ssh_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"label" varchar(120) NOT NULL,
	"type" varchar(20) NOT NULL,
	"public_key" text NOT NULL,
	"fingerprint" varchar(100) NOT NULL,
	"encrypted_private_key" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"has_passphrase" boolean DEFAULT false NOT NULL,
	"imported" boolean DEFAULT false NOT NULL,
	"from_address" varchar(255),
	"restrict" boolean DEFAULT true NOT NULL,
	"rotate_after_days" integer,
	"rotated_from_id" uuid,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ssh_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(80) NOT NULL,
	"host" varchar(255) NOT NULL,
	"port" integer DEFAULT 22 NOT NULL,
	"username" varchar(64) NOT NULL,
	"auth_method" varchar(20) DEFAULT 'key' NOT NULL,
	"key_id" uuid,
	"encrypted_password" text,
	"password_iv" varchar(64),
	"password_auth_tag" varchar(64),
	"seen_host_key_type" varchar(40),
	"seen_host_key_fingerprint" varchar(100),
	"host_key_type" varchar(40),
	"host_key_fingerprint" varchar(100),
	"host_key_trusted_at" timestamp,
	"rules" jsonb NOT NULL,
	"status" varchar(30) DEFAULT 'waiting_key' NOT NULL,
	"status_note" text,
	"system" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"timeout_sec" integer DEFAULT 10 NOT NULL,
	"jump_server_id" uuid,
	"setup_done" boolean DEFAULT false NOT NULL,
	"last_check_at" timestamp,
	"last_used_at" timestamp,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ssh_servers_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ssh_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"user_id" uuid,
	"actor" varchar(120) NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp,
	"end_reason" varchar(60),
	"commands" integer DEFAULT 0 NOT NULL,
	"recording_path" text,
	"recording_bytes" bigint DEFAULT 0 NOT NULL,
	"ip" varchar(64)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_two_factor" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"secret_enc" text NOT NULL,
	"iv" varchar(64) NOT NULL,
	"auth_tag" varchar(64) NOT NULL,
	"enabled_at" timestamp,
	"recovery_hashes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_step" bigint,
	"failures" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp,
	"reset_by" uuid,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_destinations" ADD CONSTRAINT "backup_destinations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_db_instance_id_db_instances_id_fk" FOREIGN KEY ("db_instance_id") REFERENCES "public"."db_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_policies" ADD CONSTRAINT "backup_policies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_backup_id_backups_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backups"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backup_restores" ADD CONSTRAINT "backup_restores_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backups" ADD CONSTRAINT "backups_db_instance_id_db_instances_id_fk" FOREIGN KEY ("db_instance_id") REFERENCES "public"."db_instances"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backups" ADD CONSTRAINT "backups_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backups" ADD CONSTRAINT "backups_policy_id_backup_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."backup_policies"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "backups" ADD CONSTRAINT "backups_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "db_connections" ADD CONSTRAINT "db_connections_db_instance_id_db_instances_id_fk" FOREIGN KEY ("db_instance_id") REFERENCES "public"."db_instances"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "github_app_installations" ADD CONSTRAINT "github_app_installations_provider_id_git_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."git_providers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_devices" ADD CONSTRAINT "session_devices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "session_devices" ADD CONSTRAINT "session_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ssh_servers" ADD CONSTRAINT "ssh_servers_key_id_ssh_keys_id_fk" FOREIGN KEY ("key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ssh_servers" ADD CONSTRAINT "ssh_servers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ssh_sessions" ADD CONSTRAINT "ssh_sessions_server_id_ssh_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."ssh_servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ssh_sessions" ADD CONSTRAINT "ssh_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_two_factor" ADD CONSTRAINT "user_two_factor_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alert_state_sent_idx" ON "alert_state" ("last_sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "backups_target_idx" ON "backups" ("target_key","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "session_devices_user_idx" ON "session_devices" ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ssh_sessions_server" ON "ssh_sessions" ("server_id","started_at");