CREATE TABLE IF NOT EXISTS "cron_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"trigger" varchar(12) DEFAULT 'schedule' NOT NULL,
	"triggered_by" uuid,
	"status" varchar(12) DEFAULT 'running' NOT NULL,
	"exit_code" integer,
	"output" text,
	"container" varchar(128),
	"started_at" timestamp DEFAULT now(),
	"finished_at" timestamp,
	"duration_ms" integer
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "site_workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"name" varchar(40) NOT NULL,
	"command" text NOT NULL,
	"copies" integer DEFAULT 1 NOT NULL,
	"memory_limit" integer DEFAULT 256 NOT NULL,
	"restart" boolean DEFAULT true NOT NULL,
	"graceful_stop" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "name" varchar(120) DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "timezone" varchar(64) DEFAULT 'UTC' NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "run_in" varchar(60) DEFAULT 'web' NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "timeout_sec" integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "notify_on_failure" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "last_status" varchar(12);--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "last_exit_code" integer;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "last_duration_ms" integer;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "fail_streak" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD COLUMN "updated_at" timestamp DEFAULT now();--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_job_id_cron_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."cron_jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cron_runs" ADD CONSTRAINT "cron_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_workers" ADD CONSTRAINT "site_workers_site_id_sites_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."sites"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "site_workers" ADD CONSTRAINT "site_workers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cron_runs_job_idx" ON "cron_runs" ("job_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "site_workers_site_name" ON "site_workers" ("site_id","name");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
