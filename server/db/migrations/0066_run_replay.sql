ALTER TABLE "activity" ADD COLUMN "run_id" text;--> statement-breakpoint
ALTER TABLE "frame_versions" ADD COLUMN "run_id" text;--> statement-breakpoint
CREATE INDEX "activity_run_idx" ON "activity" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "frame_versions_run_idx" ON "frame_versions" USING btree ("run_id");