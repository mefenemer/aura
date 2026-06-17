CREATE TABLE "ai_assistants" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"organisation_id" integer,
	"master_assistant_id" integer,
	"name" text NOT NULL,
	"ai_assistant_job_role" text,
	"model" text NOT NULL,
	"system_prompt" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"configuration" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "billing_information" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"country" text,
	"postal_code" text,
	"vat_number" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_assistants" (
	"id" serial PRIMARY KEY,
	"role_key" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"description" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "master_plans" (
	"id" serial PRIMARY KEY,
	"tier_key" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"monthly_price_gbp" numeric(10,2) NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"message" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"read_at" timestamp,
	"metadata" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"organisation_id" integer,
	"plan_id" integer,
	"master_plan_id" integer,
	"amount" numeric(12,2) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payment_method" text,
	"external_payment_id" text,
	"description" text,
	"metadata" jsonb,
	"paid_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "plans" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"master_plan_id" integer,
	"plan_name" text NOT NULL,
	"plan_type" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"max_seats" integer,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_connections" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"service_name" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"token_expires_at" timestamp,
	"scopes" text,
	"external_user_id" text,
	"metadata" jsonb,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_organisations" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL,
	"organisation_id" integer NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"id" serial PRIMARY KEY,
	"user_id" integer NOT NULL UNIQUE,
	"display_name" text,
	"avatar_url" text,
	"bio" text,
	"timezone" text,
	"language" text DEFAULT 'en',
	"preferences" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_assistants" ADD CONSTRAINT "ai_assistants_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_assistants" ADD CONSTRAINT "ai_assistants_organisation_id_organisations_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "ai_assistants" ADD CONSTRAINT "ai_assistants_master_assistant_id_master_assistants_id_fkey" FOREIGN KEY ("master_assistant_id") REFERENCES "master_assistants"("id");--> statement-breakpoint
ALTER TABLE "billing_information" ADD CONSTRAINT "billing_information_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organisation_id_organisations_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_plan_id_plans_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_master_plan_id_master_plans_id_fkey" FOREIGN KEY ("master_plan_id") REFERENCES "master_plans"("id");--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_master_plan_id_master_plans_id_fkey" FOREIGN KEY ("master_plan_id") REFERENCES "master_plans"("id");--> statement-breakpoint
ALTER TABLE "system_connections" ADD CONSTRAINT "system_connections_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_organisations" ADD CONSTRAINT "user_organisations_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_organisations" ADD CONSTRAINT "user_organisations_organisation_id_organisations_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;