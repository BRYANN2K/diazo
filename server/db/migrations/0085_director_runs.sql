CREATE TABLE "director_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text NOT NULL,
	"task_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"asker_id" text,
	"agent" text NOT NULL,
	"runner" jsonb,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"stage" text NOT NULL,
	"pass" integer NOT NULL,
	"max_passes" integer NOT NULL,
	"budgets" jsonb NOT NULL,
	"spent" jsonb NOT NULL,
	"passes" jsonb NOT NULL,
	"open_issues" jsonb NOT NULL,
	"reason" text,
	"start_sig" text NOT NULL,
	"end_sig" text,
	"effective_writes" integer NOT NULL,
	"started_at" bigint NOT NULL,
	"ended_at" bigint
);
--> statement-breakpoint
CREATE INDEX "director_runs_page_idx" ON "director_runs" USING btree ("canvas_id","page_id","started_at");