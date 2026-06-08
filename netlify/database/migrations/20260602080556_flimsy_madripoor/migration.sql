ALTER TABLE "plans" ADD COLUMN "organisation_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "status" text DEFAULT 'pending_verification' NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "verification_token" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "token_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "ai_assistants" ALTER COLUMN "organisation_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "plans" ALTER COLUMN "plan_type" SET DEFAULT 'subscription';--> statement-breakpoint
ALTER TABLE "plans" ADD CONSTRAINT "plans_organisation_id_organisations_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE;