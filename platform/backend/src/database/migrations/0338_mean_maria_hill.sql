-- drizzle-migration-linter: allow-breaking
-- drizzle-migration-linter: reason=All flagged constraints are rollout-safe: the FK and both unique indexes on kb_external_user_group are on a brand-new empty table, and the connector_runs single-flight index is replaced by a strictly-narrower composite (connector_id, run_type) — old writers only ever set run_type='content' (the default), so their content-run single-flight guarantee is preserved with no dedupe risk.
CREATE TABLE "kb_external_user_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"connector_id" uuid NOT NULL,
	"connector_type" text NOT NULL,
	"group_id" text NOT NULL,
	"external_account_id" text NOT NULL,
	"display_name" text,
	"member_email" text,
	"account_type" text,
	"stale" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "connector_runs_one_running_per_connector_idx";--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "run_type" text DEFAULT 'content' NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD COLUMN "acl_sync_generation" bigint;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "last_permission_sync_at" timestamp;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "last_permission_sync_status" text;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "acl_config_epoch" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base_connectors" ADD COLUMN "permission_sync_interval_seconds" integer DEFAULT 1800 NOT NULL;--> statement-breakpoint
ALTER TABLE "kb_external_user_group" ADD CONSTRAINT "kb_external_user_group_connector_id_knowledge_base_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."knowledge_base_connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "kb_external_user_group_unique_idx" ON "kb_external_user_group" USING btree ("connector_id","group_id","external_account_id");--> statement-breakpoint
CREATE INDEX "kb_external_user_group_member_email_idx" ON "kb_external_user_group" USING btree ("member_email");--> statement-breakpoint
CREATE INDEX "kb_external_user_group_connector_id_idx" ON "kb_external_user_group" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connector_runs_one_running_per_connector_run_type_idx" ON "connector_runs" USING btree ("connector_id","run_type") WHERE status = 'running';--> statement-breakpoint
ALTER TABLE "connector_runs" ADD COLUMN "stats" jsonb;
