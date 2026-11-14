CREATE TABLE "model_duels" (
	"id" text PRIMARY KEY NOT NULL,
	"canvas_id" text NOT NULL,
	"brief" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" bigint NOT NULL,
	"entries" jsonb NOT NULL,
	"picked_frame_id" text,
	"decided_at" bigint
);
--> statement-breakpoint
CREATE INDEX "model_duels_canvas_idx" ON "model_duels" USING btree ("canvas_id","created_at");