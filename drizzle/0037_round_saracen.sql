CREATE TYPE "public"."model_protocol" AS ENUM('anthropic', 'openai-compat', 'gemini', 'custom');--> statement-breakpoint
CREATE TABLE "model_default" (
	"capability" text NOT NULL,
	"project_id" uuid,
	"model_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "global_variable" (
	"key" text PRIMARY KEY NOT NULL,
	"value_encrypted" text NOT NULL,
	"is_secret" boolean DEFAULT true NOT NULL,
	"inject_worker" boolean DEFAULT true NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_connection" ALTER COLUMN "token_env" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "model_connection" ADD COLUMN "protocol" "model_protocol" DEFAULT 'anthropic' NOT NULL;--> statement-breakpoint
ALTER TABLE "model_connection" ADD COLUMN "credential_encrypted" text;--> statement-breakpoint
ALTER TABLE "model_definition" ADD COLUMN "capabilities" jsonb DEFAULT '["chat"]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_default" ADD CONSTRAINT "model_default_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_default" ADD CONSTRAINT "model_default_model_id_model_definition_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."model_definition"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "model_default_global_uq" ON "model_default" USING btree ("capability") WHERE "model_default"."project_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "model_default_project_uq" ON "model_default" USING btree ("capability","project_id") WHERE "model_default"."project_id" IS NOT NULL;