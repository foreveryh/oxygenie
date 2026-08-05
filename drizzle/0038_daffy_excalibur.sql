CREATE TABLE "canvas_asset" (
	"id" uuid PRIMARY KEY NOT NULL,
	"canvas_id" uuid NOT NULL,
	"type" text NOT NULL,
	"rel_path" text,
	"meta" jsonb DEFAULT '{}'::jsonb,
	"pos_x" real NOT NULL,
	"pos_y" real NOT NULL,
	"width" real NOT NULL,
	"height" real NOT NULL,
	"group_id" uuid,
	"source_asset_ids" uuid[] DEFAULT '{}',
	"status" text DEFAULT 'ready' NOT NULL,
	"created_by_task" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "canvas_workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_user_id" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "generation_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canvas_id" uuid NOT NULL,
	"session_id" text,
	"origin" text NOT NULL,
	"kind" text NOT NULL,
	"model_slug" text,
	"params" jsonb DEFAULT '{}'::jsonb,
	"input_asset_ids" uuid[] DEFAULT '{}',
	"reserved_slots" integer[] DEFAULT '{}',
	"status" text DEFAULT 'queued' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_session" ADD COLUMN "canvas_id" uuid;--> statement-breakpoint
ALTER TABLE "canvas_asset" ADD CONSTRAINT "canvas_asset_canvas_id_canvas_workspace_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvas_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canvas_workspace" ADD CONSTRAINT "canvas_workspace_owner_user_id_user_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generation_task" ADD CONSTRAINT "generation_task_canvas_id_canvas_workspace_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvas_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_canvas_asset_canvas" ON "canvas_asset" USING btree ("canvas_id");--> statement-breakpoint
CREATE INDEX "idx_canvas_workspace_owner" ON "canvas_workspace" USING btree ("owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_generation_task_canvas" ON "generation_task" USING btree ("canvas_id");--> statement-breakpoint
ALTER TABLE "agent_session" ADD CONSTRAINT "agent_session_canvas_id_canvas_workspace_id_fk" FOREIGN KEY ("canvas_id") REFERENCES "public"."canvas_workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_agent_session_canvas" ON "agent_session" USING btree ("canvas_id");