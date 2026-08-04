CREATE TYPE "public"."article_status" AS ENUM('queued', 'researching', 'brief_ready', 'generating', 'draft_ready', 'approved', 'publishing', 'published', 'failed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."credit_txn_type" AS ENUM('grant_subscription', 'grant_topup', 'grant_promo', 'reserve', 'consume', 'release', 'expire', 'adjustment');--> statement-breakpoint
CREATE TYPE "public"."health_check_result" AS ENUM('ok', 'auth_failed', 'permission_denied', 'not_found', 'rate_limited', 'unreachable', 'schema_mismatch', 'unknown_error');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('wordpress', 'wordpress_com', 'webflow', 'shopify', 'ghost', 'notion', 'wix', 'framer', 'webhook', 'nextjs_blog');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('pending', 'healthy', 'degraded', 'broken', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TYPE "public"."job_event_level" AS ENUM('debug', 'info', 'warn', 'error');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('pending', 'running', 'succeeded', 'failed', 'dead_lettered', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('product_onboarding_analysis', 'keyword_research', 'article_research', 'article_generate', 'article_publish', 'integration_health_check', 'gsc_sync', 'planner_recalculate');--> statement-breakpoint
CREATE TYPE "public"."keyword_source" AS ENUM('ai_research', 'user_manual', 'gsc_striking_distance', 'gsc_cannibalization_fix', 'competitor_gap', 'refresh');--> statement-breakpoint
CREATE TYPE "public"."keyword_status" AS ENUM('suggested', 'approved', 'scheduled', 'processing', 'done', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."org_role" AS ENUM('owner', 'admin', 'editor', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('onboarding', 'active', 'paused', 'archived');--> statement-breakpoint
CREATE TYPE "public"."publication_attempt_status" AS ENUM('succeeded', 'failed_retryable', 'failed_permanent');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('trialing', 'active', 'past_due', 'paused', 'canceled', 'incomplete');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"lookup_hash" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_api_key_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"metadata" jsonb,
	"ip_prefix" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "org_role" DEFAULT 'editor' NOT NULL,
	"token_hash" text NOT NULL,
	"status" "invitation_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"invited_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organization_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "org_role" DEFAULT 'editor' NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"logo_url" text,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_preferences" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"email_on_article_ready" boolean DEFAULT true NOT NULL,
	"email_on_publish_failed" boolean DEFAULT true NOT NULL,
	"email_weekly_digest" boolean DEFAULT true NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"full_name" text,
	"avatar_url" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integration_health_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"integration_id" uuid NOT NULL,
	"result" "health_check_result" NOT NULL,
	"duration_ms" integer,
	"http_status" smallint,
	"message" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"provider" "integration_provider" NOT NULL,
	"status" "integration_status" DEFAULT 'pending' NOT NULL,
	"label" text,
	"encrypted_credentials" text NOT NULL,
	"credentials_iv" text NOT NULL,
	"credentials_key_version" smallint DEFAULT 1 NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"publish_as_draft" boolean DEFAULT true NOT NULL,
	"is_primary" boolean DEFAULT true NOT NULL,
	"last_health_check_at" timestamp with time zone,
	"last_health_check_result" "health_check_result",
	"last_error_message" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"token_expires_at" timestamp with time zone,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_brand_profiles" (
	"product_id" uuid PRIMARY KEY NOT NULL,
	"business_summary" text,
	"target_audience" text,
	"value_proposition" text,
	"tone_of_voice" text,
	"forbidden_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"style_reference_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"competitor_domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"brand_colors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"image_style" text DEFAULT 'illustration' NOT NULL,
	"crawl_snapshot" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"website_url" text NOT NULL,
	"status" "product_status" DEFAULT 'onboarding' NOT NULL,
	"content_language" text DEFAULT 'en-US' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"publish_hour" smallint DEFAULT 9 NOT NULL,
	"active_weekdays" jsonb DEFAULT '[0,1,2,3,4,5,6]'::jsonb NOT NULL,
	"target_word_count_min" integer DEFAULT 1200 NOT NULL,
	"target_word_count_max" integer DEFAULT 1700 NOT NULL,
	"auto_approve_brief" boolean DEFAULT true NOT NULL,
	"auto_approve_draft" boolean DEFAULT true NOT NULL,
	"approval_timeout_hours" integer DEFAULT 48,
	"closed_loop_planner_enabled" boolean DEFAULT true NOT NULL,
	"last_planner_run_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "article_publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"attempt_number" smallint NOT NULL,
	"status" "publication_attempt_status" NOT NULL,
	"http_status" smallint,
	"error_message" text,
	"error_code" text,
	"external_id" text,
	"published_url" text,
	"duration_ms" integer,
	"next_retry_at" timestamp with time zone,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "article_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"article_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"content_markdown" text NOT NULL,
	"content_json" jsonb,
	"title" text,
	"meta_description" text,
	"created_via" text NOT NULL,
	"created_by_user_id" uuid,
	"llm_provider" text,
	"llm_model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micro_usd" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"keyword_id" uuid,
	"status" "article_status" DEFAULT 'queued' NOT NULL,
	"title" text,
	"slug" text,
	"meta_description" text,
	"excerpt" text,
	"current_version_id" uuid,
	"brief" jsonb,
	"brief_approved_at" timestamp with time zone,
	"brief_approved_by" uuid,
	"draft_approved_at" timestamp with time zone,
	"draft_approved_by" uuid,
	"approved_by_timeout" boolean DEFAULT false NOT NULL,
	"quality_score" jsonb,
	"word_count" integer,
	"featured_image_url" text,
	"published_url" text,
	"external_id" text,
	"published_at" timestamp with time zone,
	"refresh_of_article_id" uuid,
	"failure_reason" text,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "internal_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_article_id" uuid NOT NULL,
	"target_article_id" uuid NOT NULL,
	"anchor_text" text NOT NULL,
	"relevance_score" numeric(4, 3),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "keyword_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"pillar_article_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "keywords" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"cluster_id" uuid,
	"term" text NOT NULL,
	"status" "keyword_status" DEFAULT 'suggested' NOT NULL,
	"source" "keyword_source" DEFAULT 'ai_research' NOT NULL,
	"search_volume" integer,
	"difficulty" numeric(5, 2),
	"cpc" numeric(10, 2),
	"search_intent" text,
	"priority_score" numeric(5, 2) DEFAULT '50' NOT NULL,
	"priority_rationale" text,
	"scheduled_for" timestamp with time zone,
	"embedding" vector(1536),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"article_id" uuid,
	"storage_path" text NOT NULL,
	"mime_type" text NOT NULL,
	"width" integer,
	"height" integer,
	"size_bytes" integer,
	"alt_text" text,
	"generation_prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cannibalization_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"query" text NOT NULL,
	"competing_pages" jsonb NOT NULL,
	"severity" text NOT NULL,
	"recommended_action" text NOT NULL,
	"resolved_action" text,
	"resolved_at" timestamp with time zone,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gsc_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"site_url" text NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"credentials_iv" text NOT NULL,
	"credentials_key_version" integer DEFAULT 1 NOT NULL,
	"connected_email" text,
	"last_synced_at" timestamp with time zone,
	"last_synced_date" date,
	"last_sync_error" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"connected_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "gsc_daily_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"article_id" uuid,
	"date" date NOT NULL,
	"page" text NOT NULL,
	"query" text NOT NULL,
	"country" text,
	"device" text,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"ctr" numeric(6, 5) DEFAULT '0' NOT NULL,
	"position" numeric(6, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "planner_decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"keyword_id" uuid,
	"article_id" uuid,
	"decision" text NOT NULL,
	"priority_before" numeric(5, 2),
	"priority_after" numeric(5, 2),
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"article_id" uuid,
	"type" "credit_txn_type" NOT NULL,
	"amount" integer NOT NULL,
	"reservation_id" uuid,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone,
	"description" text,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "stripe_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"processed_at" timestamp with time zone,
	"processing_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_subscription_id" text,
	"stripe_price_id" text,
	"status" "subscription_status" DEFAULT 'trialing' NOT NULL,
	"seats" integer DEFAULT 1 NOT NULL,
	"articles_per_cycle" integer DEFAULT 30 NOT NULL,
	"current_period_start" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"cancel_at" timestamp with time zone,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"articles_generated" integer DEFAULT 0 NOT NULL,
	"articles_published" integer DEFAULT 0 NOT NULL,
	"articles_failed" integer DEFAULT 0 NOT NULL,
	"images_generated" integer DEFAULT 0 NOT NULL,
	"llm_cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"level" "job_event_level" DEFAULT 'info' NOT NULL,
	"step" text NOT NULL,
	"message" text NOT NULL,
	"details" jsonb,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"type" "job_type" NOT NULL,
	"status" "job_status" DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"queue_job_id" text,
	"target_type" text,
	"target_id" uuid,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"max_attempts" smallint DEFAULT 5 NOT NULL,
	"priority" smallint DEFAULT 50 NOT NULL,
	"scheduled_for" timestamp with time zone,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"next_retry_at" timestamp with time zone,
	"last_error" text,
	"last_error_code" text,
	"trace_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_violations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"subject" text NOT NULL,
	"scope" text NOT NULL,
	"violations" integer DEFAULT 1 NOT NULL,
	"blocked_until" timestamp with time zone,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"target_url" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attempt_number" smallint DEFAULT 1 NOT NULL,
	"http_status" smallint,
	"response_body_snippet" text,
	"error_message" text,
	"duration_ms" integer,
	"next_retry_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_api_key_id_api_keys_id_fk" FOREIGN KEY ("actor_api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integration_health_checks" ADD CONSTRAINT "integration_health_checks_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integrations" ADD CONSTRAINT "integrations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "integrations" ADD CONSTRAINT "integrations_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "product_brand_profiles" ADD CONSTRAINT "product_brand_profiles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "products" ADD CONSTRAINT "products_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_publications" ADD CONSTRAINT "article_publications_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_publications" ADD CONSTRAINT "article_publications_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "article_versions" ADD CONSTRAINT "article_versions_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_brief_approved_by_users_id_fk" FOREIGN KEY ("brief_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "articles" ADD CONSTRAINT "articles_draft_approved_by_users_id_fk" FOREIGN KEY ("draft_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_source_article_id_articles_id_fk" FOREIGN KEY ("source_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "internal_links" ADD CONSTRAINT "internal_links_target_article_id_articles_id_fk" FOREIGN KEY ("target_article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "keyword_clusters" ADD CONSTRAINT "keyword_clusters_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "keywords" ADD CONSTRAINT "keywords_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "keywords" ADD CONSTRAINT "keywords_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "keywords" ADD CONSTRAINT "keywords_cluster_id_keyword_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."keyword_clusters"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "keywords" ADD CONSTRAINT "keywords_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "cannibalization_issues" ADD CONSTRAINT "cannibalization_issues_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gsc_connections" ADD CONSTRAINT "gsc_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gsc_connections" ADD CONSTRAINT "gsc_connections_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gsc_connections" ADD CONSTRAINT "gsc_connections_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gsc_daily_metrics" ADD CONSTRAINT "gsc_daily_metrics_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "gsc_daily_metrics" ADD CONSTRAINT "gsc_daily_metrics_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planner_decisions" ADD CONSTRAINT "planner_decisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planner_decisions" ADD CONSTRAINT "planner_decisions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planner_decisions" ADD CONSTRAINT "planner_decisions_keyword_id_keywords_id_fk" FOREIGN KEY ("keyword_id") REFERENCES "public"."keywords"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "planner_decisions" ADD CONSTRAINT "planner_decisions_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "usage_counters" ADD CONSTRAINT "usage_counters_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "job_events" ADD CONSTRAINT "job_events_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "jobs" ADD CONSTRAINT "jobs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_lookup_hash_uq" ON "api_keys" USING btree ("lookup_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_logs_target_idx" ON "audit_logs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_hash_uq" ON "invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_org_email_pending_uq" ON "invitations" USING btree ("organization_id",lower("email")) WHERE "invitations"."status" = 'pending';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitations_org_idx" ON "invitations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "org_members_org_user_uq" ON "organization_members" USING btree ("organization_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_user_idx" ON "organization_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "org_members_org_role_idx" ON "organization_members" USING btree ("organization_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_uq" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "organizations_owner_idx" ON "organizations" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integration_health_checks_int_idx" ON "integration_health_checks" USING btree ("integration_id","checked_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "integrations_product_primary_uq" ON "integrations" USING btree ("product_id") WHERE "integrations"."is_primary" = true and "integrations"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_product_idx" ON "integrations" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_org_idx" ON "integrations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "integrations_health_due_idx" ON "integrations" USING btree ("last_health_check_at") WHERE "integrations"."deleted_at" is null and "integrations"."status" <> 'disabled';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "products_org_domain_uq" ON "products" USING btree ("organization_id",lower("domain")) WHERE "products"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_org_status_idx" ON "products" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "products_active_scheduling_idx" ON "products" USING btree ("status","publish_hour") WHERE "products"."status" = 'active' and "products"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "article_publications_attempt_uq" ON "article_publications" USING btree ("article_id","integration_id","attempt_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "article_publications_article_idx" ON "article_publications" USING btree ("article_id","attempted_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "article_versions_article_number_uq" ON "article_versions" USING btree ("article_id","version_number");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "article_versions_article_idx" ON "article_versions" USING btree ("article_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "articles_product_slug_uq" ON "articles" USING btree ("product_id","slug") WHERE "articles"."slug" is not null and "articles"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "articles_keyword_uq" ON "articles" USING btree ("keyword_id") WHERE "articles"."keyword_id" is not null and "articles"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "articles_product_created_idx" ON "articles" USING btree ("product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "articles_review_queue_idx" ON "articles" USING btree ("organization_id","status","updated_at" DESC NULLS LAST) WHERE "articles"."status" in ('brief_ready','draft_ready');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "articles_awaiting_approval_idx" ON "articles" USING btree ("status","updated_at") WHERE "articles"."status" in ('brief_ready','draft_ready');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "articles_embedding_hnsw_idx" ON "articles" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "internal_links_pair_uq" ON "internal_links" USING btree ("source_article_id","target_article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "internal_links_target_idx" ON "internal_links" USING btree ("target_article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keyword_clusters_product_idx" ON "keyword_clusters" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "keywords_product_term_uq" ON "keywords" USING btree ("product_id",lower("term")) WHERE "keywords"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keywords_queue_idx" ON "keywords" USING btree ("product_id","status","priority_score" DESC NULLS LAST) WHERE "keywords"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keywords_scheduled_idx" ON "keywords" USING btree ("scheduled_for") WHERE "keywords"."status" = 'scheduled' and "keywords"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keywords_cluster_idx" ON "keywords" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "keywords_embedding_hnsw_idx" ON "keywords" USING hnsw ("embedding" vector_cosine_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_article_idx" ON "media_assets" USING btree ("article_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_assets_product_idx" ON "media_assets" USING btree ("product_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cannibalization_product_query_open_uq" ON "cannibalization_issues" USING btree ("product_id",lower("query")) WHERE "cannibalization_issues"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cannibalization_product_idx" ON "cannibalization_issues" USING btree ("product_id","severity");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gsc_connections_product_uq" ON "gsc_connections" USING btree ("product_id") WHERE "gsc_connections"."is_active" = true;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gsc_connections_sync_due_idx" ON "gsc_connections" USING btree ("last_synced_at") WHERE "gsc_connections"."is_active" = true;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "gsc_daily_metrics_dimensions_uq" ON "gsc_daily_metrics" USING btree ("product_id","date","page","query","country","device");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gsc_striking_distance_idx" ON "gsc_daily_metrics" USING btree ("product_id","date" DESC NULLS LAST,"position") WHERE "gsc_daily_metrics"."position" >= 8 and "gsc_daily_metrics"."position" <= 20;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gsc_query_page_idx" ON "gsc_daily_metrics" USING btree ("product_id","query","page");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "gsc_article_date_idx" ON "gsc_daily_metrics" USING btree ("article_id","date" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planner_decisions_product_created_idx" ON "planner_decisions" USING btree ("product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planner_decisions_run_idx" ON "planner_decisions" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "planner_decisions_keyword_idx" ON "planner_decisions" USING btree ("keyword_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "credit_ledger_idempotency_uq" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_org_created_idx" ON "credit_ledger" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_reservation_idx" ON "credit_ledger" USING btree ("reservation_id") WHERE "credit_ledger"."reservation_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "credit_ledger_expiry_idx" ON "credit_ledger" USING btree ("expires_at") WHERE "credit_ledger"."expires_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "stripe_events_event_id_uq" ON "stripe_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "stripe_events_unprocessed_idx" ON "stripe_events" USING btree ("received_at") WHERE "stripe_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_org_uq" ON "subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "subscriptions_stripe_sub_uq" ON "subscriptions" USING btree ("stripe_subscription_id") WHERE "subscriptions"."stripe_subscription_id" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_stripe_customer_idx" ON "subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "subscriptions_period_end_idx" ON "subscriptions" USING btree ("current_period_end");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "usage_counters_scope_period_uq" ON "usage_counters" USING btree ("organization_id","product_id","period_start");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "usage_counters_org_idx" ON "usage_counters" USING btree ("organization_id","period_start" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_events_job_created_idx" ON "job_events" USING btree ("job_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "jobs_idempotency_uq" ON "jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_product_created_idx" ON "jobs" USING btree ("product_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_pending_scheduled_idx" ON "jobs" USING btree ("status","scheduled_for") WHERE "jobs"."status" in ('pending','running');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_dead_letter_idx" ON "jobs" USING btree ("organization_id","finished_at" DESC NULLS LAST) WHERE "jobs"."status" = 'dead_lettered';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_target_idx" ON "jobs" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "rate_limit_subject_scope_uq" ON "rate_limit_violations" USING btree ("subject","scope");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_blocked_idx" ON "rate_limit_violations" USING btree ("blocked_until") WHERE "rate_limit_violations"."blocked_until" is not null;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_org_created_idx" ON "webhook_deliveries" USING btree ("organization_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_retry_idx" ON "webhook_deliveries" USING btree ("next_retry_at") WHERE "webhook_deliveries"."delivered_at" is null and "webhook_deliveries"."next_retry_at" is not null;