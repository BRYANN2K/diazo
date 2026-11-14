CREATE TABLE "code_links" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_id" text NOT NULL,
	"path" text NOT NULL,
	"export_name" text,
	"source" text NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "code_links_target_idx" ON "code_links" USING btree ("canvas_id","target_kind","target_id");