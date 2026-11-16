CREATE TABLE "script_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"idempotency_key" text,
	"created_at" bigint NOT NULL,
	"data" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "script_runs_canvas_idx" ON "script_runs" USING btree ("canvas_id");--> statement-breakpoint
CREATE UNIQUE INDEX "script_runs_key_idx" ON "script_runs" USING btree ("canvas_id","idempotency_key");