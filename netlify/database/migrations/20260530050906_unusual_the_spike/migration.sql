DROP TABLE "ai_assistants";--> statement-breakpoint
DROP TABLE "billing_information";--> statement-breakpoint
DROP TABLE "notifications";--> statement-breakpoint
DROP TABLE "payments";--> statement-breakpoint
DROP TABLE "plans";--> statement-breakpoint
DROP TABLE "system_connections";--> statement-breakpoint
DROP TABLE "user_organisations";--> statement-breakpoint
DROP TABLE "user_profiles";--> statement-breakpoint
ALTER TABLE "organisations" DROP COLUMN "description";--> statement-breakpoint
ALTER TABLE "organisations" DROP COLUMN "logo_url";--> statement-breakpoint
ALTER TABLE "organisations" ALTER COLUMN "created_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ALTER COLUMN "updated_at" DROP NOT NULL;