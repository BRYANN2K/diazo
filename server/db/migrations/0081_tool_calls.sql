CREATE TABLE "tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text,
	"source" text NOT NULL,
	"tool" text NOT NULL,
	"actor_name" text NOT NULL,
	"actor_kind" text NOT NULL,
	"owner_id" text,
	"run_id" text,
	"input_bytes" integer NOT NULL,
	"result_bytes" integer NOT NULL,
	"image_pixels" integer DEFAULT 0 NOT NULL,
	"ms" integer NOT NULL,
	"failed" boolean DEFAULT false NOT NULL,
	"at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tool_calls_canvas_idx" ON "tool_calls" USING btree ("canvas_id","at");--> statement-breakpoint
CREATE INDEX "tool_calls_run_idx" ON "tool_calls" USING btree ("run_id");