ALTER TABLE "libraries" ADD COLUMN "describe_items" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "library_item_meta" ADD COLUMN "suggested" jsonb;