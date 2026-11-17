CREATE TABLE "script_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"owner_id" text,
	"idempotency_key" text,
	"created_at" bigint NOT NULL,
	"record" jsonb NOT NULL,
	"response" jsonb,
	"undo" jsonb
);
--> statement-breakpoint
CREATE INDEX "script_runs_canvas_idx" ON "script_runs" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "script_runs_created_idx" ON "script_runs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "script_runs_key_idx" ON "script_runs" USING btree ("canvas_id","idempotency_key");