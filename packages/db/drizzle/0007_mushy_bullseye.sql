CREATE TABLE IF NOT EXISTS "host_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_key" varchar(300) NOT NULL,
	"item_label" text NOT NULL,
	"kind" varchar(20) NOT NULL,
	"action" varchar(40) NOT NULL,
	"target" jsonb NOT NULL,
	"plan" text NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"message" text,
	"undoable" boolean DEFAULT false NOT NULL,
	"requested_by" uuid,
	"requested_at" timestamp DEFAULT now(),
	"finished_at" timestamp,
	"undo_by" uuid,
	"undo_at" timestamp,
	"undo_message" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "host_actions" ADD CONSTRAINT "host_actions_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "host_actions" ADD CONSTRAINT "host_actions_undo_by_users_id_fk" FOREIGN KEY ("undo_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_actions_item_idx" ON "host_actions" ("item_key");