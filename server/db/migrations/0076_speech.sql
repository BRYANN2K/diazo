CREATE TABLE "speech_custom_models" (
	"id" text PRIMARY KEY NOT NULL,
	"model" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speech_installs" (
	"id" text PRIMARY KEY NOT NULL,
	"model_id" text NOT NULL,
	"engine" text NOT NULL,
	"revision" text NOT NULL,
	"state" text NOT NULL,
	"bytes" bigint NOT NULL,
	"error" text,
	"installed_by" text NOT NULL,
	"installed_at" bigint NOT NULL,
	"last_used_at" bigint
);
--> statement-breakpoint
CREATE TABLE "speech_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"device_id" text,
	"model_id" text NOT NULL,
	"input_asset_id" text,
	"input_text" text,
	"state" text NOT NULL,
	"progress" real DEFAULT 0 NOT NULL,
	"output" jsonb,
	"output_asset_id" text,
	"requested_by" text NOT NULL,
	"error" text,
	"canvas_id" text,
	"media_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "speech_preferences" (
	"user_id" text PRIMARY KEY NOT NULL,
	"prefs" jsonb NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voices" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"voice" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "speech_jobs_state_idx" ON "speech_jobs" USING btree ("state","target");--> statement-breakpoint
CREATE INDEX "voices_owner_idx" ON "voices" USING btree ("owner_id");