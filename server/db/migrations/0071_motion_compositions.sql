CREATE TABLE "composition_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"composition_id" text NOT NULL,
	"canvas_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"saved_at" bigint NOT NULL,
	"saved_by" text NOT NULL,
	"saved_by_kind" text,
	"run_id" text
);
--> statement-breakpoint
CREATE TABLE "compositions" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text NOT NULL,
	"duration" double precision NOT NULL,
	"fps" integer NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"poster_time" double precision,
	"tracks" jsonb NOT NULL,
	"revision" integer NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "render_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text NOT NULL,
	"composition_id" text NOT NULL,
	"format" text NOT NULL,
	"target" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"fps" integer NOT NULL,
	"range_start" double precision NOT NULL,
	"range_end" double precision NOT NULL,
	"status" text NOT NULL,
	"progress" real NOT NULL,
	"output_asset_id" text,
	"error" text,
	"claimed_by" text,
	"claimed_at" bigint,
	"created_by" text NOT NULL,
	"created_by_name" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"finished_at" bigint
);
--> statement-breakpoint
CREATE INDEX "composition_versions_composition_idx" ON "composition_versions" USING btree ("composition_id");--> statement-breakpoint
CREATE INDEX "composition_versions_canvas_idx" ON "composition_versions" USING btree ("canvas_id");--> statement-breakpoint
CREATE UNIQUE INDEX "compositions_page_idx" ON "compositions" USING btree ("canvas_id","page_id");--> statement-breakpoint
CREATE INDEX "compositions_canvas_idx" ON "compositions" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "render_jobs_canvas_idx" ON "render_jobs" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "render_jobs_composition_idx" ON "render_jobs" USING btree ("composition_id");