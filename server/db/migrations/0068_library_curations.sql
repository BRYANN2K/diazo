CREATE TABLE "library_curations" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"status" text NOT NULL,
	"job" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "library_curations_owner_idx" ON "library_curations" USING btree ("owner_id");