ALTER TABLE "site_env_vars" ADD COLUMN "build_time" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "health" varchar(20) DEFAULT 'ok' NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "health_detail" jsonb;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "health_changed_at" timestamp;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "restarts_seen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "root_directory" varchar(255);