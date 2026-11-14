CREATE TABLE "libraries" (
	"canvas_id" text PRIMARY KEY NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rules" jsonb NOT NULL,
	"taxonomy" jsonb NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"index_state" jsonb,
	"rules_version" integer DEFAULT 1 NOT NULL,
	"disabled_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"updated_by" text
);
--> statement-breakpoint
CREATE TABLE "library_item_meta" (
	"canvas_id" text NOT NULL,
	"item_id" text NOT NULL,
	"label" text,
	"description" text,
	"category" text,
	"tags" jsonb,
	"status" text,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" bigint,
	"updated_at" bigint NOT NULL,
	"updated_by" text,
	CONSTRAINT "library_item_meta_canvas_id_item_id_pk" PRIMARY KEY("canvas_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "library_items" (
	"canvas_id" text NOT NULL,
	"item_id" text NOT NULL,
	"parent_id" text,
	"frame_id" text NOT NULL,
	"page_id" text NOT NULL,
	"position" integer NOT NULL,
	"label" text NOT NULL,
	"description" text NOT NULL,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"category" text NOT NULL,
	"tags" jsonb NOT NULL,
	"mode" text NOT NULL,
	"locator" jsonb NOT NULL,
	"box" jsonb,
	"scripted" boolean NOT NULL,
	"status" text NOT NULL,
	"findings" jsonb NOT NULL,
	"hash" text NOT NULL,
	"rev" integer NOT NULL,
	"search_text" text NOT NULL,
	"source_url" text,
	"license" text,
	"indexed_at" bigint NOT NULL,
	CONSTRAINT "library_items_canvas_id_item_id_pk" PRIMARY KEY("canvas_id","item_id")
);
--> statement-breakpoint
CREATE INDEX "library_items_frame_idx" ON "library_items" USING btree ("canvas_id","frame_id");--> statement-breakpoint
CREATE INDEX "library_items_parent_idx" ON "library_items" USING btree ("canvas_id","parent_id");--> statement-breakpoint
CREATE INDEX "library_items_category_idx" ON "library_items" USING btree ("canvas_id","category");