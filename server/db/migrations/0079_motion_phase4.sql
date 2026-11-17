CREATE TABLE "blender_ops" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"tool" text NOT NULL,
	"klass" text NOT NULL,
	"args" jsonb,
	"state" text NOT NULL,
	"result" jsonb,
	"error" text,
	"device_id" text,
	"requested_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "render_jobs" ADD COLUMN "engine" text;--> statement-breakpoint
CREATE INDEX "blender_ops_state_idx" ON "blender_ops" USING btree ("state","requested_by");