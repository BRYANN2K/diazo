CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"kind" text NOT NULL,
	"agent" text NOT NULL,
	"label" text NOT NULL,
	"provider" text NOT NULL,
	"payer_id" text,
	"models" jsonb NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"cost_usd" double precision,
	"cost_estimated" boolean NOT NULL,
	"outcome" text NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "frame_versions" ADD COLUMN "run_id" text;--> statement-breakpoint
CREATE INDEX "agent_runs_canvas_idx" ON "agent_runs" USING btree ("canvas_id","started_at");--> statement-breakpoint
CREATE INDEX "activity_run_idx" ON "activity" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "frame_versions_run_idx" ON "frame_versions" USING btree ("run_id");