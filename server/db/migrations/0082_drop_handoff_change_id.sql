-- Rows launched before the brief existed still hold the change pack
-- (changeId, files); get_handoff reads brief.frames, so fold them into an
-- empty-frames brief — which also frees the base64 the packs kept.
UPDATE "frame_dev_tasks"
SET "handoff" = jsonb_build_object(
  'title', "handoff"->>'title',
  'canvasId', "canvas_id",
  'frames', '[]'::jsonb,
  'warnings', '["Launched before briefs: send the frame again."]'::jsonb
)
WHERE "handoff" ? 'files';
--> statement-breakpoint
ALTER TABLE "frame_dev_tasks" DROP COLUMN "handoff_change_id";