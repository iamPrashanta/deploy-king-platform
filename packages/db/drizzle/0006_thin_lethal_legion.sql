CREATE TABLE IF NOT EXISTS "host_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" varchar(20) NOT NULL,
	"key" varchar(300) NOT NULL,
	"label" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"status" varchar(12) NOT NULL,
	"severity" varchar(8) DEFAULT 'check' NOT NULL,
	"reason" text,
	"previous" jsonb,
	"present" boolean DEFAULT true NOT NULL,
	"first_seen_at" timestamp DEFAULT now(),
	"last_seen_at" timestamp DEFAULT now(),
	"changed_at" timestamp,
	"snoozed_until" timestamp,
	"decided_by" uuid,
	"decided_at" timestamp,
	"note" text,
	CONSTRAINT "host_items_key_unique" UNIQUE("key")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "host_items" ADD CONSTRAINT "host_items_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_items_status_idx" ON "host_items" ("status");