CREATE TABLE "built_hooks" (
	"canvas_id" text PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"secret" text NOT NULL,
	"mappings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"captures" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"built_page_id" text,
	"last_delivery" jsonb,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL
);
