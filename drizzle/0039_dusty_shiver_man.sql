CREATE TABLE "run_summary" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text,
	"user_id" text NOT NULL,
	"model" text,
	"terminal_state" text NOT NULL,
	"error_type" text,
	"error_detail" jsonb DEFAULT '{}'::jsonb,
	"ttft_ms" integer,
	"total_ms" integer,
	"queued_ms" integer,
	"tool_call_count" integer DEFAULT 0 NOT NULL,
	"tool_error_count" integer DEFAULT 0 NOT NULL,
	"tool_calls_by_name" jsonb DEFAULT '{}'::jsonb,
	"tool_errors_by_name" jsonb DEFAULT '{}'::jsonb,
	"approval_request_count" integer DEFAULT 0 NOT NULL,
	"approval_deny_count" integer DEFAULT 0 NOT NULL,
	"num_turns" integer DEFAULT 0 NOT NULL,
	"resumed_from_run_id" text,
	"recovered_from_state" text,
	"eval_tag" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_summary_run_id_unique" UNIQUE("run_id")
);
--> statement-breakpoint
CREATE INDEX "run_summary_session_id_idx" ON "run_summary" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "run_summary_user_id_idx" ON "run_summary" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "run_summary_created_at_idx" ON "run_summary" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "run_summary_terminal_state_idx" ON "run_summary" USING btree ("terminal_state");--> statement-breakpoint
CREATE INDEX "run_summary_eval_tag_idx" ON "run_summary" USING btree ("eval_tag");