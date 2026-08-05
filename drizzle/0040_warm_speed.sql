ALTER TABLE "model_definition" ADD COLUMN "media_adapter" text;--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN "media_config" jsonb DEFAULT '{}'::jsonb NOT NULL;