CREATE TABLE IF NOT EXISTS "cleanup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" varchar(20) NOT NULL,
	"user_id" uuid,
	"freed_bytes" bigint DEFAULT 0 NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cleanup_runs" ADD CONSTRAINT "cleanup_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
