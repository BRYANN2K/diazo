CREATE TABLE "scene_media" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"page_id" text NOT NULL,
	"asset_id" text NOT NULL,
	"kind" text NOT NULL,
	"trim_in" double precision NOT NULL,
	"trim_out" double precision,
	"cuts" jsonb NOT NULL,
	"beats" jsonb,
	"transcript" jsonb,
	"generation" jsonb,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "scene_media_page_idx" ON "scene_media" USING btree ("canvas_id","page_id");--> statement-breakpoint
CREATE UNIQUE INDEX "scene_media_asset_idx" ON "scene_media" USING btree ("page_id","asset_id");