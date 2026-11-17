ALTER TABLE "comments" ADD COLUMN "time_start" double precision;--> statement-breakpoint
ALTER TABLE "comments" ADD COLUMN "time_end" double precision;--> statement-breakpoint
ALTER TABLE "library_item_meta" ADD COLUMN "seek_safe" text;--> statement-breakpoint
ALTER TABLE "library_item_meta" ADD COLUMN "seek_safe_findings" jsonb;--> statement-breakpoint
ALTER TABLE "library_item_meta" ADD COLUMN "seek_safe_at" bigint;