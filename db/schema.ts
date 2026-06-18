import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
  decimal,
  jsonb,
  unique,
  uniqueIndex,
  varchar,
  index,
  check,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// Organisations table — companies or groups users belong to
export const organisations = pgTable('organisations', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // US-AUD-5.3.1 SC1: opt-in agency attribution badge on exported deliverables
  agencyAttributionEnabled: boolean('agency_attribution_enabled').notNull().default(false),
  // US-LEGAL-1.6: explicit opt-in required before any inputs/outputs are used for model improvement.
  // Enterprise (Tier 4) accounts are locked to false and cannot opt in.
  dataTrainingOptIn: boolean('data_training_opt_in').notNull().default(false),
  // US-LEGAL-3.1: EU AI Act Art.50 — outbound AI content footer
  aiDisclosureFooterEnabled: boolean('ai_disclosure_footer_enabled').notNull().default(false),
  aiDisclosureFooterText: text('ai_disclosure_footer_text'),
  // Referral Program Expansion: extra assistant slots unlocked by redeeming referral tokens.
  // Stacks ON TOP of the Stripe tier's assistantLimit, so plan syncing is never touched (AC2.2/AC4.2).
  bonusAssistants: integer('bonus_assistants').notNull().default(0),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Core users table — the central entity all other tables reference
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  // DEPRECATED (US-DB-1.3.1): use userOrganisations junction table for all new queries.
  // Retained for zero-downtime migration; scheduled for removal in following sprint.
  organisationId: integer('organisation_id').references(() => organisations.id),
  email: text('email').notNull().unique(),

  // Authentication & Verification State
  status: text('status').notNull().default('pending_verification'),
  verificationToken: text('verification_token'),
  tokenExpiresAt: timestamp('token_expires_at'),
  // Rate-limit fence: set to NOW() each time a magic link is sent.
  // Concurrent requests check this with a DB-level conditional update to prevent race conditions.
  lastMagicLinkSentAt: timestamp('last_magic_link_sent_at'),

  // Platform role — 'user' (default) | 'admin' | 'super_admin'
  role: text('role').notNull().default('user'),

  // US-GAP-8.2: Referral programme — unique share code
  referralCode: text('referral_code').unique(),

  // US-GAP-2.1.1: Account deletion cooling-off period (24h)
  pendingDeletion: boolean('pending_deletion').default(false),
  pendingDeletionAt: timestamp('pending_deletion_at'),          // when deletion was requested
  deletionToken: text('deletion_token'),                         // hashed cancellation token

  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Junction table linking users to organisations with a role
export const userOrganisations = pgTable("user_organisations", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("member"),
  joinedAt: timestamp("joined_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.3.1: unique membership — prevents duplicate invite rows
  unique("user_organisations_user_org_unique").on(t.userId, t.organisationId),
]);

// Leads table — Interest capture for pending AI roles
export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  opportunityReason: text('opportunity_reason').notNull(),
  action: text('action').notNull().default('notify user of AI Assistant readiness'),
  // Notification lifecycle: 'notification_pending' | 'notification_sent' | 'contacted' | 'converted' | 'lost'
  status: text('status').notNull().default('notification_pending'),
  // Lead enrichment fields (US-SALES-1.1 / US-SALES-1.2)
  leadType: text('lead_type'),            // 'role_request' | 'enterprise_inquiry' | 'waitlist' | 'referral'
  source: text('source'),                 // 'assistants_page' | 'website' | 'workspace' | 'api'
  userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
  organisationId: integer('organisation_id').references(() => organisations.id, { onDelete: 'set null' }),
  name: text('name'),
  company: text('company'),
  teamSize: text('team_size'),
  useCase: text('use_case'),
  priority: text('priority'),             // 'high' | 'medium' | 'low'
  assignedTo: integer('assigned_to').references(() => users.id, { onDelete: 'set null' }),
  salesNotes: text('sales_notes'),
  lastContactedAt: timestamp('last_contacted_at'),
  resolvedAt: timestamp('resolved_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  emailRoleUnique: unique('email_role_unique').on(t.email, t.opportunityReason)
}));

// Plans table — subscription or service plans associated with a user
export const plans = pgTable("plans", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  masterPlanId: integer("master_plan_id").references(() => masterPlans.id),
  planName: text("plan_name").notNull(),
  planType: text("plan_type").notNull().default("subscription"),
  // status: 'active' | 'past_due' | 'cancelling' | 'cancelled' | 'downgrading' | 'expired'
  // past_due = payment failed; assistants still run during gracePeriodEndsAt window
  status: text("status").notNull().default("active"),
  maxSeats: integer("max_seats"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  // Grace period end: set to NOW()+7d on first payment failure; assistants pause after this date
  gracePeriodEndsAt: timestamp("grace_period_ends_at"),
  // Stripe references — stored at subscription creation; used for upgrade/downgrade/cancel
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  cancelledAt: timestamp("cancelled_at"),               // set when status transitions to 'cancelled' (US-GAP-4.2.1)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.4.1: Enforces exactly one active/past_due plan per organisation at the DB level.
  // BUG-P0-4: Was plain index() — changed to uniqueIndex() so the DB actually enforces the constraint.
  uniqueIndex("plans_one_active_per_org_unique").on(t.organisationId).where(sql`status IN ('active', 'past_due')`),
  // US-DB-1.1.1: Hot-path indexes for plan lookups
  index("plans_user_status_idx").on(t.userId, t.status),
  index("plans_org_idx").on(t.organisationId),
  index("plans_stripe_sub_idx").on(t.stripeSubscriptionId),
]);

// US-DB-1.4.1: Atomic usage counters — one row per org per billing period.
// Cap checks are done as a single atomic UPDATE (not SELECT then INSERT) to eliminate
// the check-then-insert race condition where two concurrent requests both pass the cap check.
export const usageCounters = pgTable("usage_counters", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  // First day of the calendar month in UTC — e.g. 2026-06-01 00:00:00 UTC
  periodStart: timestamp("period_start").notNull(),
  taskCount:       integer("task_count").notNull().default(0),
  tokenCount:      integer("token_count").notNull().default(0),
  assistantCount:  integer("assistant_count").notNull().default(0),
  connectionCount: integer("connection_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  orgPeriodUnique: unique("usage_counters_org_period_unique").on(t.organisationId, t.periodStart),
}));

// Billing information table — stored billing address and contact details per user
export const billingInformation = pgTable("billing_information", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  fullName: text("full_name").notNull(),
  email: text("email"),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  country: text("country"),
  postalCode: text("postal_code"),
  vatNumber: text("vat_number"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Payments table — individual payment transactions made by a user
export const payments = pgTable("payments", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),
  planId: integer("plan_id")
      .references(() => plans.id, { onDelete: "cascade" }),
  masterPlanId: integer("master_plan_id").references(() => masterPlans.id),
  amount: numeric("amount", { precision: 12, scale: 2 }).notNull(),
  // US-DB-1.2.1: default corrected from 'USD' to 'GBP' (platform bills in GBP)
  currency: text("currency").notNull().default("GBP"),
  status: text("status").notNull().default("pending"),
  paymentMethod: text("payment_method"),
  externalPaymentId: text("external_payment_id"),
  description: text("description"),
  // Card details — brand/last4/expiry/postcode stored at payment time; PAN and CVC never stored
  cardBrand: text("card_brand"),
  cardLast4: text("card_last4"),
  cardExpMonth: integer("card_exp_month"),
  cardExpYear: integer("card_exp_year"),
  cardPostalCode: text("card_postal_code"),
  metadata: jsonb("metadata"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  check("payments_currency_check", sql`${t.currency} IN ('GBP', 'EUR', 'USD')`),
  // US-DB-1.1.1: Org-level and user-level payment lookups
  index("payments_org_idx").on(t.organisationId),
  index("payments_user_idx").on(t.userId),
]);

// AI assistants table — AI agents configured by or assigned to a user
export const aiAssistants = pgTable("ai_assistants", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  masterAssistantId: integer("master_assistant_id").references(() => masterAssistants.id),
  name: text("name").notNull(),
  aiAssistantJobRole: text("ai_assistant_job_role"),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt"),
  // US-GOV-3.1.1: EU AI Act Art. 52 disclosure — required before activation
  disclosureText: text("disclosure_text"),
  // US-GOV-1.2.1: Deployer acknowledgment that the system prompt has been reviewed against prohibited-use categories
  prohibitedUseAcknowledged: boolean("prohibited_use_acknowledged").notNull().default(false),
  // US-SMM-2.4.1: How many days ahead the assistant keeps the post queue filled (1–30, default 7)
  draftHorizonDays: integer("draft_horizon_days").notNull().default(7),
  // US-SMM-2.4.2: Review queue cut-off — hours before scheduled publish time; unapproved posts become 'missed' (1–24, default 2)
  reviewCutoffHours: integer("review_cutoff_hours").notNull().default(2),
  // US-SMM-2.4.2: Notification preference — 'immediate' | 'daily_digest' | 'red_urgency_only'
  reviewNotifPreference: text("review_notif_preference").notNull().default('immediate'),
  // US-SMM-2.4.2: Time for daily digest notifications in HH:MM UTC (only used when reviewNotifPreference='daily_digest')
  reviewDigestTime: text("review_digest_time").notNull().default('09:00'),
  isActive: boolean("is_active").notNull().default(true),
  configuration: jsonb("configuration"),

  // Flexible schema expansion for role-specific answers
  onboardingContext: jsonb("onboarding_context"),

  // US-GDPR-2.2.3: set when an org member leaves and their assets are tombstoned;
  // non-null signals that this assistant's knowledge base may be incomplete.
  knowledgeStaleAt: timestamp("knowledge_stale_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // provisioningStatus: 'pending' | 'complete' | 'failed' | 'cancelled' | 'paused_limit' | 'paused_payment'
  provisioningStatus: text("provisioning_status").default("pending"),
}, (t) => [
  // US-DB-1.3.1: assistants are org-owned & member-shared — names are unique per organisation.
  // (userId is retained as creator/attribution only.)
  unique("ai_assistants_org_name_unique").on(t.organisationId, t.name),
  // US-DB-1.1.1: Hot-path indexes for assistant lookups
  index("ai_assistants_org_active_idx").on(t.organisationId, t.isActive),
  index("ai_assistants_user_active_idx").on(t.userId, t.isActive),
  check("ai_assistants_review_notif_pref_check", sql`${t.reviewNotifPreference} IN ('immediate', 'daily_digest', 'red_urgency_only')`),
]);

// User profiles table — extended profile details for a user
export const userProfiles = pgTable("user_profiles", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" })
      .unique(),
  displayName: text("display_name"),
  avatarUrl: text("avatar_url"),
  bio: text("bio"),
  timezone: text("timezone"),
  notifyWins: boolean('notify_wins').default(true).notNull(),
  notifyBilling: boolean('notify_billing').default(true).notNull(),
  notifyAvailability: boolean('notify_availability').default(false).notNull(),
  // Email delivery preferences — one key per notification category.
  // Shape: Record<string, boolean>. Missing key = use category default.
  // Transactional keys (payment_confirmation, account_creation,
  // account_cancellation) are always true in the application layer
  // and cannot be opted out by the user.
  emailPreferences: jsonb("email_preferences"),
  language: text("language").default("en"),
  preferences: jsonb("preferences"),
  legalConsents: jsonb("legal_consents"),
  // US-ONB-2.2.1: tracks whether the first-login welcome modal has been shown
  firstLoginWelcomeSeen: boolean("first_login_welcome_seen").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Notifications table — in-app notifications delivered to a user
// ADR-001 (US-DB-1.2.1): This is the CANONICAL notifications table. Use this for all new code.
// See userNotifications below — that table is deprecated and retained only for legacy reads.
export const notifications = pgTable("notifications", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  title: text("title").notNull(),
  message: text("message"),
  isRead: boolean("is_read").notNull().default(false),
  readAt: timestamp("read_at"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Notification inbox query — userId + isRead + createdAt
  index("notifications_user_read_idx").on(t.userId, t.isRead, t.createdAt),
]);

// US-ONB-2.1.2: Notification log — deduplicates timed onboarding emails
// Prevents sending the same email type (e.g. '24h_reminder') more than once per user.
export const notificationLog = pgTable("notification_log", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  sentAt: timestamp("sent_at").defaultNow().notNull(),
}, (t) => [
  index("notification_log_user_type_idx").on(t.userId, t.type),
]);

// ── Vault Secrets — US-AUD-4.2.1 SC1/SC2 ────────────────────────────────────
// Stores AES-256-GCM encrypted credential payloads. DB never holds plaintext.
// refKey format: 'aura/user-<id>/<service>-<type>' e.g. 'aura/user-42/google-oauth-access'
export const vaultSecrets = pgTable("vault_secrets", {
  id: serial().primaryKey(),
  refKey: text("ref_key").notNull().unique(), // logical path — stored in systemConnections.vaultRefKey
  encryptedPayload: text("encrypted_payload").notNull(), // AES-256-GCM ciphertext (base64)
  iv: text("iv").notNull(),                              // GCM nonce (base64, 12 bytes)
  authTag: text("auth_tag").notNull(),                   // GCM auth tag (base64, 16 bytes)
  // US-GDPR-3.1.1: KEK/DEK hierarchy — per-user DEK encrypted with master KEK
  // Null on legacy rows (pre-migration); vault.ts handles both cases during migration window.
  encryptedDek: text("encrypted_dek"),                  // DEK wrapped by KEK (format: iv:authTag:ciphertext, all base64)
  // US-DB-1.3.1: relational ownership for GDPR erasure and breach response enumeration.
  // Backfilled by parsing refKey convention 'aura/user-{id}/...' on existing rows.
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// System connections table — OAuth tokens and credentials for third-party service integrations
export const systemConnections = pgTable("system_connections", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  // US-DB-1.3.1: org tenancy — mandatory for multi-tenant isolation.
  // NOT NULL; backfilled from users.organisationId on existing rows before constraint applied.
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  // US-DB-1.3.1: per-assistant connection scoping — enables appConnectionLimit cap by assistantId.
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(),
  connectionType: text("connection_type").notNull().default("oauth"), // 'oauth', 'api_key', 'legacy'

  // US-AUD-4.2.1 SC1: vault reference key replaces plaintext tokens
  // Format: 'aura/user-<id>/<serviceName>-<connectionType>'
  vaultRefKey: text("vault_ref_key"),

  // US-DB-1.6.1: plaintext accessToken and refreshToken columns dropped.
  // All credentials are now stored exclusively in vault_secrets (KEK/DEK encrypted).
  // Pre-migration assertion: ensure zero non-null rows exist before applying db:push.
  tokenExpiresAt: timestamp("token_expires_at"),

  // SC3: documented minimum scopes per integration (comma-separated)
  scopes: text("scopes"),

  // Public identifier (e.g., Legacy Username or connected email)
  externalUserId: text("external_user_id"),

  // Connection Health Status
  status: text("status").notNull().default("active"), // 'active', 'expired', 'failed', 'revoked'
  isActive: boolean("is_active").notNull().default(true),

  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.3.1: indexes for org-scoped and assistant-scoped connection queries
  index("system_connections_org_active_idx").on(t.organisationId, t.isActive),
  index("system_connections_assistant_active_idx").on(t.assistantId, t.isActive),
  // US-DB-1.1.1: User-level connection lookups
  index("system_connections_user_active_idx").on(t.userId, t.isActive),
]);

// ── Integration API Call Audit Log — US-AUD-4.2.1 SC6 ───────────────────────
// Records every API call made on behalf of a user using a stored credential.
// Retained 90 days (enforced by a scheduled cleanup job).
export const integrationApiCalls = pgTable("integration_api_calls", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  integrationId: integer("integration_id").references(() => systemConnections.id, { onDelete: "set null" }),
  endpoint: text("endpoint").notNull(), // redacted URL — path only, no query params (SC6)
  httpStatus: integer("http_status"),
  calledAt: timestamp("called_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: 90-day pruning job and per-user API call history
  index("integration_api_calls_user_called_idx").on(t.userId, t.calledAt),
]);

// ── Webhook idempotency log — prevents double-processing Stripe events ────────
// One row per Stripe event ID; inserted before handling, acts as a distributed lock.
export const processedWebhookEvents = pgTable("processed_webhook_events", {
  id: serial().primaryKey(),
  stripeEventId: text("stripe_event_id").notNull().unique(),
  eventType: text("event_type").notNull(),
  processedAt: timestamp("processed_at").defaultNow().notNull(),
});

// MASTER CATALOG TABLES
export const masterPlans = pgTable("master_plans", {
  id: serial().primaryKey(),
  tierKey: text("tier_key").notNull().unique(),
  name: text("name").notNull(),
  monthlyPriceGbp: numeric("monthly_price_gbp", { precision: 10, scale: 2 }).notNull(),
  // Capacity limits — enforced at runtime; null = unlimited
  assistantLimit: integer("assistant_limit"),           // max active AI assistants (total per account)
  monthlyTaskLimit: integer("monthly_task_limit"),      // max task runs per calendar month
  monthlyTokenLimit: integer("monthly_token_limit"),    // max LLM tokens per calendar month; null = unlimited
  appConnectionLimit: integer("app_connection_limit"),  // max OAuth/API integrations per assistant; null = unlimited
  seatLimit: integer("seat_limit"),                     // max workspace members (users in the same org); null = solo only (1 seat)
  storageLimitBytes: integer("storage_limit_bytes"),    // US-STOR-1.1.2: max object storage per org; null = unlimited
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Plan prices — per-currency pricing for each master plan (US-I18N-2.1 SC1)
// Source of truth for multi-currency checkout; GBP row mirrors masterPlans.monthlyPriceGbp.
export const planPrices = pgTable("plan_prices", {
  id: serial("id").primaryKey(),
  masterPlanId: integer("master_plan_id").notNull().references(() => masterPlans.id, { onDelete: "cascade" }),
  currency: text("currency").notNull(),                     // ISO 4217: 'GBP' | 'USD' | 'EUR' | 'AUD' | 'CAD'
  monthlyPriceMajorUnit: numeric("monthly_price_major_unit", { precision: 10, scale: 2 }).notNull(),
  stripePriceId: text("stripe_price_id"),                  // Stripe Price object ID for this plan+currency combo
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  planCurrencyUnique: unique("plan_currency_unique").on(t.masterPlanId, t.currency),
}));

// Task runs — one row per automated task execution; used for monthly volume tracking (SC3)
export const taskRuns = pgTable("task_runs", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  taskType: text("task_type").notNull().default("automated"),  // 'automated' | 'manual' | 'scheduled'
  // US-DB-1.5.1: Full state machine — pending|running|reviewing|suspended|completed|failed|skipped|terminated
  status: text("status").notNull().default("pending"),
  anomalyCount: integer("anomaly_count").notNull().default(0), // US-GOV-4.2.1: incremented on each kill-switch trigger; ≥2 → permanent termination
  tokensUsed: integer("tokens_used").default(0),               // LLM tokens consumed by this run
  // US-GOV-4.1.1: Hard execution budget tracking
  llmCallCount: integer("llm_call_count").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  costGbp: numeric("cost_gbp", { precision: 10, scale: 6 }).notNull().default('0'),
  wallClockStartedAt: timestamp("wall_clock_started_at"),
  suspendReason: text("suspend_reason"),
  budgetSnapshot: jsonb("budget_snapshot"),
  // US-DB-1.5.1: Worker lease columns — FOR UPDATE SKIP LOCKED queue
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  attemptCount: integer("attempt_count").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  lockedBy: text("locked_by"),           // worker/function instance identifier
  lockedAt: timestamp("locked_at"),
  leaseExpiresAt: timestamp("lease_expires_at"),
  // US-DB-1.5.1: Quality-reviewer loop columns
  reviewerAssistantId: integer("reviewer_assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  reviewVerdict: text("review_verdict"),  // 'approved' | 'revise' | 'escalated'
  reviewCycleCount: integer("review_cycle_count").notNull().default(0),
  // metadata JSONB shape (US-AUD-2.1.1):
  //   { confidenceLevel: 'green' | 'amber' | 'red',
  //     verifyHint: string | null,
  //     model: string,
  //     promptTokens: number, completionTokens: number }
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.5.1: Partial index for O(claimable) queue polling — scans only pending/expired-lease rows
  index("task_runs_claimable_idx").on(t.createdAt).where(sql`status = 'pending' OR status = 'running'`),
  // US-DB-1.1.1: Monthly usage aggregation and per-assistant run history
  index("task_runs_user_created_idx").on(t.userId, t.createdAt),
  index("task_runs_org_created_idx").on(t.organisationId, t.createdAt),
  index("task_runs_assistant_idx").on(t.assistantId),
  check("task_runs_status_check", sql`${t.status} IN ('pending', 'running', 'reviewing', 'suspended', 'completed', 'failed', 'skipped', 'terminated')`),
]);

export const masterAssistants = pgTable("master_assistants", {
  id: serial().primaryKey(),
  roleKey: text("role_key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  category: text("category").notNull().default("Administration"),
  iconKey: text("icon_key").notNull().default("document"),
  iconColor: text("icon_color").notNull().default("blue"),
  comingSoon: boolean("coming_soon").notNull().default(false),
  // US-AUD-2.3.1 SC2: task completions required to unlock early access (null = no milestone gate)
  milestoneTasksRequired: integer("milestone_tasks_required").default(25),
  isActive: boolean("is_active").notNull().default(true),
  // US-ADM-4.1.1: Lifecycle state machine — draft|review|beta|live|deprecated|archived
  lifecycleState: text("lifecycle_state").notNull().default("draft"),
  // Points to the current active assistant_versions row
  // US-DB-1.2.1: AnyPgColumn callback required — assistantVersions is defined after masterAssistants (circular reference)
  currentVersionId: integer("current_version_id").references((): AnyPgColumn => assistantVersions.id, { onDelete: "set null" }),
  // For deprecated assistants — ID of the recommended replacement (self-reference)
  replacementAssistantId: integer("replacement_assistant_id").references((): AnyPgColumn => masterAssistants.id, { onDelete: "set null" }),
  // US-GDPR-1.2.1: Confirms the Article 52 special-category refusal clause is present
  // in this assistant's current system prompt version. Set true by admin on version create.
  specialCategoryClauseEnabled: boolean("special_category_clause_enabled").notNull().default(false),
  // US-GOV-1.1.1: EU AI Act risk classification — minimal | limited | high_risk_borderline | high_risk
  riskClassification: text("risk_classification").notNull().default("limited"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  check("master_assistants_lifecycle_check", sql`${t.lifecycleState} IN ('draft', 'review', 'beta', 'live', 'deprecated', 'archived')`),
]);

// US-ADM-4.1.1: Immutable version history for master assistant prompts/config
export const assistantVersions = pgTable("assistant_versions", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  versionNumber: integer("version_number").notNull(),
  systemPrompt: text("system_prompt"),
  config: jsonb("config"),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  changeNote: text("change_note").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  unique("assistant_versions_assistant_id_version_number_key").on(t.assistantId, t.versionNumber),
]);

// US-GOV-1.1.1: Risk assessments for high-risk EU AI Act assistants
export const riskAssessments = pgTable("risk_assessments", {
  id: serial().primaryKey(),
  masterAssistantId: integer("master_assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  // Workspace org that submitted the assessment (null = global/platform-level)
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  assessmentVersion: text("assessment_version").notNull().default("1.0"),
  assessorId: integer("assessor_id").references(() => users.id, { onDelete: "set null" }),
  assessedAt: timestamp("assessed_at").defaultNow().notNull(),
  findings: text("findings"),
  approvalStatus: text("approval_status").notNull().default("pending"), // pending | approved | rejected
  approvedById: integer("approved_by_id").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Waitlist table — interest signups for coming-soon assistant roles
export const waitlist = pgTable("waitlist", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  masterAssistantId: integer("master_assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  source: text("source").notNull().default("public"), // 'public' | 'registered'
  notified: boolean("notified").notNull().default(false),
  // US-AUD-5.1.1 SC1/SC2: referral programme fields
  referralCode: text("referral_code").unique(),           // 8-char alphanumeric, generated on signup
  queuePositionBonus: integer("queue_position_bonus").notNull().default(0), // negative = moves forward; deducted from raw position
  day1AccessGranted: boolean("day1_access_granted").notNull().default(false), // SC3: 3 referrals
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  emailRoleUnique: unique("waitlist_email_role_unique").on(t.email, t.masterAssistantId),
}));

// ── Waitlist Referrals — US-AUD-5.1.1 SC2/SC5 ────────────────────────────────
// Tracks each referral event: who referred whom for which assistant.
export const waitlistReferrals = pgTable("waitlist_referrals", {
  id: serial().primaryKey(),
  referralCode: text("referral_code").notNull(),           // code that was used
  referrerId: integer("referrer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referredEmail: text("referred_email").notNull(),          // email of the person who used the link
  masterAssistantId: integer("master_assistant_id").notNull().references(() => masterAssistants.id, { onDelete: "cascade" }),
  convertedAt: timestamp("converted_at"),                   // null = pending; set when referred user joins
  referrerIpHash: text("referrer_ip_hash"),                 // SC5: hashed IP for self-referral detection
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── User Referrals — US-GAP-8.2 ──────────────────────────────────────────────
// Tracks referral relationships: who referred whom, status, and reward.
export const userReferrals = pgTable("user_referrals", {
  id: serial().primaryKey(),
  referrerId: integer("referrer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referredUserId: integer("referred_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  referralCode: text("referral_code").notNull(),          // the code that was used
  status: text("status").notNull().default("pending"),    // 'pending' | 'qualified' | 'rewarded'
  qualifiedAt: timestamp("qualified_at"),                 // when referred user made first paid invoice
  rewardedAt: timestamp("rewarded_at"),                   // when £10 credit was applied
  stripeBalanceTxId: text("stripe_balance_tx_id"),        // Stripe customer balance transaction id
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueReferred: unique("user_referrals_referred_unique").on(t.referredUserId),
}));

// ── Reward Redemptions — Referral Program Expansion ──────────────────────────
// Audit trail + double-spend guard for the referral token vault. Each row records
// a redemption: 'credit_10' (1 token → £10 Stripe credit) or 'free_assistant'
// (5 tokens → +1 bonus_assistants). availableTokens = matured qualified referrals
// minus SUM(tokensSpent) here. Written only by owner-role backend functions, so it
// stays out of the RLS crown-jewels set (like user_referrals).
export const rewardRedemptions = pgTable("reward_redemptions", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  type: text("type").notNull(),                  // 'credit_10' | 'free_assistant'
  tokensSpent: integer("tokens_spent").notNull(),
  stripeBalanceTxId: text("stripe_balance_tx_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("reward_redemptions_user_idx").on(t.userId),
]);

// US-HELP-1.3.1: Help articles for the public Help Center
export const helpArticles = pgTable('help_articles', {
  id: uuid('id').defaultRandom().primaryKey(),
  category: text('category').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  title: text('title').notNull().unique(),
  contentMd: text('content_md').notNull(),
  isPublished: boolean('is_published').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('idx_help_articles_category').on(t.category, t.sortOrder),
]);
// Audit logs table — immutable ledger for system compliance and tracking
export const auditLogs = pgTable("audit_logs", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id), // Can be null for system-level events
  actionType: text("action_type").notNull(), // e.g., 'CREATE', 'UPDATE', 'DELETE'
  resourceType: text("resource_type").notNull(), // e.g., 'users', 'user_profiles'
  resourceId: text("resource_id").notNull(), // The ID of the affected row (stored as text for flexibility)
  previousState: jsonb("previous_state"),
  newState: jsonb("new_state"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
// Brandassets

// Workspace Assets table — Centralized knowledge base for AI Assistant RAG pipeline
export const workspaceAssets = pgTable("workspace_assets", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
  uploaderId: integer("uploader_id")
      .references(() => users.id, { onDelete: "set null" }),

  name: text("name").notNull(),
  assetType: text("asset_type").notNull(), // 'file', 'url', or 'text'
  category: text("category").notNull(),

  // NEW COLUMNS FOR TEXT RULES ENGINE
  isActive: boolean("is_active").default(true).notNull(),
  priority: integer("priority").default(0).notNull(),

  storageUrl: text("storage_url"),
  externalUrl: text("external_url"),
  extractedText: text("extracted_text"),
  // US-STOR-1.1.1 AC14: R2 object-storage lifecycle is `pending` → `confirmed` → `deleted`
  // (default `pending`). This table is dual-purpose: the RAG knowledge-base pipeline also uses
  // `processing` → `ready` for text/URL assets that never touch R2. The CHECK constraint below
  // enforces the full set of valid states for both lifecycles.
  status: text("status").notNull().default("pending"),

  // US-STOR-1.1.1 AC14: R2 object storage fields
  r2Key: text("r2_key"),                               // full R2 object key — never returned in API responses (AC15)
  mimeType: text("mime_type"),
  fileSizeBytes: integer("file_size_bytes"),
  originalFilename: text("original_filename"),
  deletedAt: timestamp("deleted_at"),                  // soft-delete timestamp; null = not deleted

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and uploader-level asset lookups
  index("workspace_assets_org_idx").on(t.organisationId),
  index("workspace_assets_uploader_idx").on(t.uploaderId),
  // US-STOR-1.1.1 AC14: enforce valid status values. R2 object lifecycle: pending|confirmed|deleted;
  // RAG knowledge-base lifecycle (text/URL assets): processing|ready|failed (set in process-asset-background.ts).
  check("workspace_assets_status_check", sql`${t.status} IN ('pending', 'confirmed', 'deleted', 'processing', 'ready', 'failed')`),
]);

// US-STOR-1.1.2 AC1: Storage usage tracker — one row per org, updated atomically on upload/delete
export const storageUsage = pgTable("storage_usage", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().unique()
      .references(() => organisations.id, { onDelete: "cascade" }),
  usedBytes: integer("used_bytes").notNull().default(0),
  // AC4: tracks last time an 80% quota warning email was sent (one per 7-day window)
  quotaWarningLastSentAt: timestamp("quota_warning_last_sent_at"),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
// Support Tickets Table — For user help requests and issue tracking
export const supportTickets = pgTable("support_tickets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),

  subject: text("subject").notNull(),
  category: text("category").notNull(),
  description: text("description").notNull(),

  // Status lifecycle: 'new' | 'open' | 'pending_customer' | 'resolved' | 'closed'
  status: text("status").notNull().default("open"),

  // Helpdesk fields (US7)
  priority: text("priority").notNull().default("normal"), // 'low' | 'normal' | 'high' | 'urgent'
  assignedTo: integer("assigned_to").references(() => users.id, { onDelete: "set null" }),
  firstResponseAt: timestamp("first_response_at"),
  resolvedAt: timestamp("resolved_at"),
  closedAt: timestamp("closed_at"),
  slaBreachedAt: timestamp("sla_breached_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Ticket Replies Table — threaded conversation history for each support ticket (US7)
export const ticketReplies = pgTable("ticket_replies", {
  id: serial("id").primaryKey(),
  ticketId: integer("ticket_id")
      .notNull()
      .references(() => supportTickets.id, { onDelete: "cascade" }),
  authorId: integer("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  // isInternal: true = private note (yellow, not emailed to customer)
  isInternal: boolean("is_internal").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// AI Model Config Table — runtime routing rules; admin-editable without deploys (US13)
export const aiModelConfig = pgTable("ai_model_config", {
  id: serial("id").primaryKey(),
  // Logical slot: 'primary' | 'fallback' | 'moderation'
  slot: text("slot").notNull().unique(),
  provider: text("provider").notNull().default("openai"), // 'openai' | 'anthropic' | 'google'
  model: text("model").notNull(),                         // e.g. 'gpt-4o' | 'claude-3-5-sonnet-20241022'
  isActive: boolean("is_active").notNull().default(true),
  // Optional per-slot spend cap (USD cents per month); null = unlimited
  monthlyBudgetCents: integer("monthly_budget_cents"),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  check("ai_model_config_provider_check", sql`${t.provider} IN ('openai', 'anthropic', 'google')`),
]);
// User Notifications Table — Global feed for alerts, tickets, and billing
// DEPRECATED (US-DB-1.2.1 ADR-001): userNotifications duplicates the notifications table.
// Canonical table is notifications (above). All new writes/reads must use notifications.
// Remove this table after all legacy callers are migrated.
export const userNotifications = pgTable("user_notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),

  title: text("title").notNull(),
  message: text("message").notNull(),
  type: text("type").notNull(), // e.g., 'ticket_created', 'billing_alert'
  referenceId: text("reference_id"), // e.g., The specific Ticket ID

  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Notification inbox query — userId + isRead + createdAt
  index("user_notifications_user_read_idx").on(t.userId, t.isRead, t.createdAt),
]);
// Onboarding Drafts Table — Stores auto-save progress for incomplete setups.
// Multi-row: a user (and org) may have several in-progress assistant drafts at once,
// each rendered as an "Onboarding" card. (Previously keyed by user_id = one draft/user.)
export const onboardingDrafts = pgTable("onboarding_drafts", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Org that owns the draft — lets the My Team view list drafts org-wide. Nullable so legacy
  // rows survive the migration; populated on create going forward.
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  currentStep: integer("current_step").default(2).notNull(),
  onboardingPath: text("onboarding_path").notNull(),
  // Card metadata: role icon key + chosen name (null → "Unnamed {Role}").
  roleKey: text("role_key"),
  displayName: text("display_name"),
  draftData: jsonb("draft_data").default({}).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Tracks when the last abandoned-onboarding reminder was sent to avoid duplicate emails
  reminderSentAt: timestamp("reminder_sent_at"),
}, (t) => [
  index("onboarding_drafts_user_idx").on(t.userId),
  index("onboarding_drafts_org_idx").on(t.organisationId),
]);

// Content Assets Table — Media Hub (My Content)
// Stores user-uploaded images, videos, and external links for assistant use
export const contentAssets = pgTable("content_assets", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),

  // Asset identity
  name: text("name").notNull(),
  assetType: text("asset_type").notNull(), // 'image' | 'video' | 'link'
  mimeType: text("mime_type"),
  fileSize: integer("file_size"),

  // Storage — one of these will be populated
  storageKey: text("storage_key"),
  storageUrl: text("storage_url"),
  externalUrl: text("external_url"),

  // Lifecycle status: pending → scheduled | rejected; scheduled → posted
  status: text("status").notNull().default("pending"), // pending|scheduled|posted|rejected
  rejectionReason: text("rejection_reason"),

  // Scheduling / publication
  // DEPRECATED (US-DB-1.2.1): use scheduledPostAssets junction table. Retained for migration window.
  scheduledPostId: integer("scheduled_post_id"),
  postedAt: timestamp("posted_at"),
  rejectedAt: timestamp("rejected_at"),

  // Data retention — populated when status changes to posted/rejected
  retentionDeleteAfter: timestamp("retention_delete_after"),
  purgedAt: timestamp("purged_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and user-level content asset lookups
  index("content_assets_org_idx").on(t.organisationId),
  index("content_assets_user_idx").on(t.userId),
]);

// Invoices table — one row per generated invoice, created on every successful payment
export const invoices = pgTable("invoices", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),
  planId: integer("plan_id")
      .references(() => plans.id, { onDelete: "set null" }),
  invoiceNumber: text("invoice_number").notNull().unique(),
  issueDate: timestamp("issue_date").notNull().defaultNow(),
  billingPeriodStart: timestamp("billing_period_start"),
  billingPeriodEnd: timestamp("billing_period_end"),
  planName: text("plan_name").notNull(),
  subtotal: numeric("subtotal", { precision: 12, scale: 2 }).notNull(),
  taxRate: numeric("tax_rate", { precision: 5, scale: 4 }).notNull().default('0'),
  taxAmount: numeric("tax_amount", { precision: 12, scale: 2 }).notNull().default('0'),
  total: numeric("total", { precision: 12, scale: 2 }).notNull(),
  currency: text("currency").notNull().default("GBP"),
  status: text("status").notNull().default("paid"),   // 'paid' | 'void' | 'refunded'
  stripeInvoiceId: text("stripe_invoice_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  check("invoices_currency_check", sql`${t.currency} IN ('GBP', 'EUR', 'USD')`),
  // US-DB-1.1.1: Org-level and user-level invoice lookups
  index("invoices_org_idx").on(t.organisationId),
  index("invoices_user_idx").on(t.userId),
]);

// Scheduled Posts Table — Content Calendar & Post Governance
export const scheduledPosts = pgTable("scheduled_posts", {
  id: serial("id").primaryKey(),
  assistantId: integer("assistant_id")
      .references(() => aiAssistants.id, { onDelete: "set null" }),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id")
      .references(() => organisations.id, { onDelete: "cascade" }),

  // Publishing logistics
  platform: text("platform").notNull(),         // facebook|instagram|linkedin|x
  postFormat: text("post_format").notNull(),     // text|image|carousel|reel|story|thread|video
  publishDate: timestamp("publish_date").notNull(),
  publishedAt: timestamp("published_at"),
  platformPostId: text("platform_post_id"),      // external ID after publish
  platformPostUrl: text("platform_post_url"),    // live URL after publish

  // Content & creative
  caption: text("caption"),
  // DEPRECATED (US-DB-1.2.1): use scheduledPostAssets junction table for all new queries.
  // Retained until one-time migration script populates scheduledPostAssets from existing rows; drop after migration.
  contentAssetIds: jsonb("content_asset_ids").default([]),
  linkUrl: text("link_url"),
  ctaText: text("cta_text"),
  hashtags: text("hashtags"),                    // space-separated or newline-separated
  mentions: text("mentions"),
  utmParams: text("utm_params"),

  // Workflow & governance
  // Status: draft | in_review | approved | scheduled | published | rejected | cancelled | missed
  status: text("status").notNull().default("draft"),
  ownerId: integer("owner_id")
      .references(() => users.id, { onDelete: "set null" }),
  ownerLabel: text("owner_label"),               // e.g. "AI: Marketing Mike" or "Jane Smith"
  isAutonomous: boolean("is_autonomous").default(false).notNull(),
  campaign: text("campaign"),
  pillar: text("pillar"),

  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  cancelledAt: timestamp("cancelled_at"),
  // US-SMM-2.4.2: Timestamp when post transitioned to 'missed' status
  missedAt: timestamp("missed_at"),
  // US-SMM-2.4.2: Whether a red-urgency push notification has already been sent (prevents duplicate alerts)
  redAlertSentAt: timestamp("red_alert_sent_at"),

  // US-SMM-2.2.2: structured rejection — revised post chain
  revisedFromPostId: integer("revised_from_post_id"),    // FK to scheduledPosts.id (self-ref)
  isRevised: boolean("is_revised").notNull().default(false),

  // US-GOV-2.2.1: Confidence scoring & factual claim detection
  confidenceScore: text("confidence_score"),             // 'green' | 'amber' | 'red' | null (not yet scored)
  factualClaimsCount: integer("factual_claims_count"),   // number of factual claims detected
  factualClaims: jsonb("factual_claims"),                // array of { claim, claimType, sourceAvailable }
  confidenceAssessedAt: timestamp("confidence_assessed_at"),
  confidenceAssessmentMs: integer("confidence_assessment_ms"), // duration of scoring call

  // US-GOV-3.2.1: C2PA provenance — FK set at publish time
  provenanceContentId: text("provenance_content_id"),      // references contentProvenance.contentId

  // US-SMM-3.1.1: LLM generation job linkage
  jobId: text("job_id"),                                   // FK to contentGenerationJobs.jobId
  blueprintId: integer("blueprint_id").references(() => aiBlueprints.id, { onDelete: "set null" }),
  suggestedMediaDescription: text("suggested_media_description"),
  conflictNotice: text("conflict_notice"),              // set when context prompt conflicted with a strict rule
  generatedAt: timestamp("generated_at"),
  // US-SMM-3.4.1: On-demand generation trigger type
  triggerType: text("trigger_type"),                       // 'on_demand' | 'scheduled' | null

  // US-SMM-3.2.1: Instagram connection
  connectionId: integer("connection_id").references(() => systemConnections.id, { onDelete: "set null" }),

  // US-SMM-3.3.1/3.3.2: Publishing pipeline
  // Status extensions: 'publishing' | 'paused' | 'failed' in addition to existing statuses
  containerId: text("container_id"),                       // Instagram step-1 media container ID
  attemptCount: integer("attempt_count").notNull().default(0),
  retryAt: timestamp("retry_at"),
  failureReason: jsonb("failure_reason"),                  // { errorCode, errorMessage, errorSubcode, isRetryable }

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and user-level scheduled post lookups
  index("scheduled_posts_org_idx").on(t.organisationId),
  index("scheduled_posts_user_idx").on(t.userId),
  // US-SMM-3.3.1: Partial index for publish queue polling
  index("scheduled_posts_publish_queue_idx").on(t.publishDate).where(sql`status = 'scheduled' AND platform = 'instagram'`),
  check("scheduled_posts_status_check", sql`${t.status} IN ('draft', 'in_review', 'approved', 'scheduled', 'published', 'rejected', 'cancelled', 'missed')`),
]);

// US-DB-1.2.1: Junction table replacing scheduledPosts.contentAssetIds JSONB array.
// Provides referential integrity: GDPR purge of a contentAsset now cascades correctly.
// Migration: one-time script reads scheduledPosts.contentAssetIds[] and inserts rows here;
// scheduledPosts.contentAssetIds is deprecated and will be dropped after migration.
export const scheduledPostAssets = pgTable("scheduled_post_assets", {
  scheduledPostId: integer("scheduled_post_id").notNull().references(() => scheduledPosts.id, { onDelete: "cascade" }),
  contentAssetId: integer("content_asset_id").notNull().references(() => contentAssets.id, { onDelete: "cascade" }),
  position: integer("position").notNull().default(0),
}, (t) => [
  unique("scheduled_post_assets_pk").on(t.scheduledPostId, t.contentAssetId),
]);

// ── DPA Requests — US-AUD-4.1.1 SC3 ──────────────────────────────────────────
// Stores Data Processing Agreement request submissions from the /trust.html page.
// On insert: (a) email sent to platform legal contact, (b) auto-acknowledgement sent to requester.
// ── DPA Acceptances — US-GDPR-1.1.1 ─────────────────────────────────────────
// Append-only evidence of Article 28 DPA consent per organisation.
// Each row is legally admissible proof per Article 28(9).
// No application-level DELETE or UPDATE should ever touch this table.
export const dpaAcceptances = pgTable("dpa_acceptances", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  acceptedAt: timestamp("accepted_at").defaultNow().notNull(),
  version: text("version").notNull(),          // DPA version string, e.g. '1.0'
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  email: text("email").notNull(),              // email of accepting user (captured before any anonymisation)
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const dpaRequests = pgTable("dpa_requests", {
  id: serial().primaryKey(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  email: text("email").notNull(),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
});

// ── Rate Limit Attempts — US-GAP-7.1.1 ───────────────────────────────────────
// Tracks request attempts per key (IP address or userId) and endpoint.
// Old rows are pruned automatically by the rate-limit utility (keep last 24h).
// key: IP address (for public endpoints) or `user:<userId>` (for auth'd endpoints)
export const rateLimitAttempts = pgTable("rate_limit_attempts", {
  id: serial().primaryKey(),
  key: text("key").notNull(),          // IP or 'user:<id>'
  endpoint: text("endpoint").notNull(), // e.g. 'register', 'login', 'onboarding', 'support'
  attemptedAt: timestamp("attempted_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: checkRateLimit called on every public endpoint — must use index scan
  index("rate_limit_key_endpoint_idx").on(t.key, t.endpoint, t.attemptedAt),
]);

// ── Referral Attribution — US-AUD-5.3.1 SC5 ──────────────────────────────────
// Records new signups that originated from an agency attribution badge link.
export const referralAttribution = pgTable("referral_attribution", {
  id: serial().primaryKey(),
  referrerOrgId: integer("referrer_org_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  newUserId: integer("new_user_id").references(() => users.id, { onDelete: "set null" }),
  sourceType: text("source_type").notNull().default("agency_badge"), // 'agency_badge'
  convertedAt: timestamp("converted_at").defaultNow().notNull(),
});

// ── User Churn Signals — US-AUD-3.1.1 SC1 ────────────────────────────────────
// One row per unique signal event per user. interventionSentAt null = not yet sent.
export const userChurnSignals = pgTable("user_churn_signals", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // SC2–SC6 signal types
  signalType: text("signal_type").notNull(), // 'no_tasks_7d' | 'repeated_task_failure' | 'integration_disconnected_48h' | 'upgrade_intent_not_converted' | 'early_support_ticket'
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  interventionSentAt: timestamp("intervention_sent_at"),
  metadata: jsonb("metadata"),
});

// ── Page Events — US-AUD-3.1.1 SC5 ──────────────────────────────────────────
// Tracks significant page views for churn signal detection (Signal 4: pricing page view).
export const pageEvents = pgTable("page_events", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  pagePath: text("page_path").notNull(), // e.g. '/pricing.html'
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Win-Back Email Opt-Outs — US-GAP-4.2.1 SC5 ──────────────────────────────
// Records users who have unsubscribed from win-back email sequences.
export const winBackOptOuts = pgTable("win_back_opt_outs", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().unique().references(() => users.id, { onDelete: "cascade" }),
  optedOutAt: timestamp("opted_out_at").defaultNow().notNull(),
});

// ── GDPR Erasure Log — US-GAP-2.1.2 SC3 / US-GAP-2.1.1 SC5 ─────────────────
// Anonymised record retained after account deletion for compliance audit.
export const gdprErasureLog = pgTable("gdpr_erasure_log", {
  id: serial().primaryKey(),
  emailHash: text("email_hash").notNull(),                      // SHA-256 of the deleted email
  requesterType: text("requester_type").notNull(),              // 'user' | 'admin'
  requestedBy: integer("requested_by"),                         // admin userId if requester='admin'
  erasedAt: timestamp("erased_at").defaultNow().notNull(),
  metadata: jsonb("metadata"),                                  // US-GDPR-2.2.1: asset purge counts, partial failures
});

// ── Vector Embeddings Deletion Map — US-GDPR-2.2.2 ─────────────────────────
// Tracks every chunk embedded into a vector store so erasure can delete them.
// Populated by RAG pipeline work; the erasure paths already query this table.
// Any future RAG work MUST insert a row here before writing to the vector store.
export const vectorEmbeddings = pgTable("vector_embeddings", {
  id: serial().primaryKey(),
  sourceType: text("source_type").notNull(), // 'workspace_asset' | 'conversation'
  sourceId: integer("source_id").notNull(),  // FK to workspace_assets.id or task_runs.id
  vectorStoreId: text("vector_store_id").notNull(), // external record ID (pgvector rowid or Pinecone ID)
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Org-level and user-level embedding lookups + GDPR erasure queries
  index("vector_embeddings_org_idx").on(t.organisationId),
  index("vector_embeddings_user_idx").on(t.userId),
]);

// ── Data Export Requests — US-GAP-2.2.1 SC5 ─────────────────────────────────
// Tracks data export requests to enforce 24-hour rate limit.
export const dataExportRequests = pgTable("data_export_requests", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  requestedAt: timestamp("requested_at").defaultNow().notNull(),
  downloadToken: text("download_token"),            // signed token for the download link
  downloadUrl: text("download_url"),                // signed S3/storage URL (if generated)
  expiresAt: timestamp("expires_at"),               // 24h from generation
  status: text("status").notNull().default("pending"), // 'pending' | 'ready' | 'expired'
});

// ── Cancellation Reasons — US-GAP-4.1.1 SC2 ─────────────────────────────────
// Stores exit survey responses for product analytics.
export const cancellationReasons = pgTable("cancellation_reasons", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(), // 'too_expensive' | 'not_using' | 'missing_feature' | 'competitor' | 'technical' | 'business_closed' | 'other'
  freeText: text("free_text"),      // optional additional context
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── User Milestones — US-AUD-1.1.1 SC4 ───────────────────────────────────────
// Records one-time achievement events per user (e.g. first task complete).
export const userMilestones = pgTable("user_milestones", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  milestone: text("milestone").notNull(), // e.g. 'first_task_complete'
  completedAt: timestamp("completed_at").defaultNow().notNull(),
  metadata: jsonb("metadata"),
}, (t) => ({
  userMilestoneUnique: unique("user_milestone_unique").on(t.userId, t.milestone),
}));

// ── Admin Audit Log — US-ADM-5.1.1 ───────────────────────────────────────────
// Append-only ledger of every privileged admin action.
// Application layer enforces no UPDATE/DELETE on this table.
export const adminAuditLog = pgTable("admin_audit_log", {
  id: serial().primaryKey(),
  adminId: integer("admin_id").references(() => users.id),    // who performed the action
  action: text("action").notNull(),                             // one of the 13 defined action types
  targetType: text("target_type"),                              // e.g. 'user', 'subscription', 'assistant'
  targetId: text("target_id"),                                  // affected record id
  previousState: jsonb("previous_state"),
  newState: jsonb("new_state"),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  reason: text("reason"),                                       // mandatory for destructive actions
  metadata: jsonb("metadata"),                                  // extra context (sessionId, extensionDays, etc.)
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Admin audit log viewer filter queries
  index("admin_audit_log_admin_created_idx").on(t.adminId, t.createdAt),
  index("admin_audit_log_target_idx").on(t.targetType, t.targetId),
]);

// ── Platform Config — US-ADM-3.2.1 kill switches ─────────────────────────────
export const platformConfig = pgTable("platform_config", {
  key: varchar("key", { length: 255 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  reason: text("reason"),
});

// ── Feature Flags — US-ADM-4.2.1 ─────────────────────────────────────────────
export const featureFlags = pgTable("feature_flags", {
  key: varchar("key", { length: 255 }).primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  rolloutPercentage: integer("rollout_percentage").notNull().default(0),
  allowedWorkspaceIds: integer("allowed_workspace_ids").array(),
  allowedTiers: text("allowed_tiers").array(),
  description: text("description"),
  updatedBy: integer("updated_by").references(() => users.id),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Supported Languages — US-ADM-1.7.2: platform-level i18n reference data ───
export const supportedLanguages = pgTable("supported_languages", {
  code: varchar("code", { length: 10 }).primaryKey(),  // BCP-47 tag, e.g. 'en-GB', 'fr'
  name: text("name").notNull(),                         // display name, e.g. 'English (UK)'
  nativeName: text("native_name"),                      // e.g. 'Français'
  isActive: boolean("is_active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
});

// ── AI Usage Log — US-ADM-3.1.1 COGS Dashboard ───────────────────────────────
export const aiUsageLog = pgTable("ai_usage_log", {
  id: serial().primaryKey(),
  workspaceId: integer("workspace_id").references(() => organisations.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  // US-DB-1.2.1: added FK references (previously bare integers)
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  model: text("model").notNull(),                              // e.g. 'gpt-4o-mini'
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  costUsd: decimal("cost_usd", { precision: 10, scale: 6 }).notNull().default("0"),
  taskRunId: integer("task_run_id").references(() => taskRuns.id, { onDelete: "set null" }),
  sessionId: text("session_id"),
  // US-GDPR-4.2.2: Article 30 RoPA — data categories present in the prompt.
  // Valid values: 'general' | 'business_context' | 'pii_redacted' | 'special_category_suspected' | 'financial' | 'health'
  dataCategories: text("data_categories").array().notNull().default(sql`'{general}'`),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── AI Model Pricing — per-model token cost rates for COGS calculation (US-ADM-3.1.1) ──
// Distinct from aiModelConfig (routing slots, US13). Uses a different DB table name.
export const aiModelPricing = pgTable("ai_model_pricing", {
  id: serial().primaryKey(),
  modelKey: varchar("model_key", { length: 100 }).unique().notNull(),  // must match the 'model' string logged in aiUsageLog
  displayName: text("display_name").notNull(),
  inputCostPer1kTokens: decimal("input_cost_per_1k_tokens", { precision: 10, scale: 6 }).notNull(),
  outputCostPer1kTokens: decimal("output_cost_per_1k_tokens", { precision: 10, scale: 6 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Billing Reconciliation Log — US-ADM-2.3.1 ────────────────────────────────
export const billingReconciliationLog = pgTable("billing_reconciliation_log", {
  id: serial().primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  totalChecked: integer("total_checked").notNull().default(0),
  mismatchCount: integer("mismatch_count").notNull().default(0),
  results: jsonb("results"),
  status: text("status").notNull().default("success"), // 'success' | 'failed'
  errorMessage: text("error_message"),
});

// ── Lead Analysis Runs — US-SALES-1.1 Part 4 ────────────────────────────────
export const leadAnalysisRuns = pgTable("lead_analysis_runs", {
  id: serial("id").primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  leadsCreated: integer("leads_created").notNull().default(0),
  leadsUpdated: integer("leads_updated").notNull().default(0),
  patternCounts: jsonb("pattern_counts"),  // { trial_expiry, never_onboarded, cancellation_approaching, upgrade_candidates }
  status: text("status").notNull().default("success"), // 'success' | 'failed'
  errorMessage: text("error_message"),
});

// ── Agent Run Events — US-GOV-4.2.2: Per-run full audit trail (6-month retention) ──
export const agentRunEvents = pgTable("agent_run_events", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").notNull().references(() => taskRuns.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(), // 'llm_call' | 'tool_call' | 'human_intervention' | 'suspension' | 'termination'
  eventIndex: integer("event_index").notNull(),
  toolName: text("tool_name"),             // present for tool_call events
  inputPayload: jsonb("input_payload"),    // sanitised — PII pseudonymised before storage
  outputPayload: jsonb("output_payload"),  // sanitised
  durationMs: integer("duration_ms"),
  costGbp: decimal("cost_gbp", { precision: 10, scale: 6 }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Agent Run Summaries — retained 2 years for billing/compliance ──────────────
export const agentRunSummaries = pgTable("agent_run_summaries", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").notNull().references(() => taskRuns.id, { onDelete: "cascade" }).unique(),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  totalLlmCalls: integer("total_llm_calls").notNull().default(0),
  totalToolCalls: integer("total_tool_calls").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  totalCostGbp: decimal("total_cost_gbp", { precision: 10, scale: 6 }).notNull().default("0"),
  wallClockMinutes: decimal("wall_clock_minutes", { precision: 8, scale: 2 }),
  terminationReason: text("termination_reason"), // 'completed' | 'anomaly_suspended' | 'anomaly_terminated' | 'user_cancelled' | 'error'
  humanInterventionCount: integer("human_intervention_count").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Legal Holds — US-GOV-4.2.2: pause retention deletion for a workspace ───────
export const legalHolds = pgTable("legal_holds", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  placedBy: integer("placed_by").references(() => users.id, { onDelete: "set null" }),
  liftedBy: integer("lifted_by").references(() => users.id, { onDelete: "set null" }),
  placedAt: timestamp("placed_at").defaultNow().notNull(),
  liftedAt: timestamp("lifted_at"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Pending Actions — US-GOV-4.1.2: HITL approval queue for Tier 3/4 agent actions ──
export const pendingActions = pgTable("pending_actions", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }), // deployer who must approve
  actionType: text("action_type").notNull(),       // e.g. 'send_email', 'delete_record', 'bulk_charge'
  reversibilityTier: integer("reversibility_tier").notNull(), // 0-4
  actionPayload: jsonb("action_payload").notNull(), // sanitised proposed action details
  affectedRecordCount: integer("affected_record_count"),
  status: text("status").notNull().default("pending"), // 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled'
  approvedBy: integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at"),
  rejectedAt: timestamp("rejected_at"),
  rejectionReason: text("rejection_reason"),
  expiresAt: timestamp("expires_at").notNull(), // auto-cancelled after 24h
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Action Policies — US-GOV-4.1.2: Per-assistant HITL tier overrides ────────
export const actionPolicies = pgTable("action_policies", {
  id: serial().primaryKey(),
  // null assistantId = platform-wide default; non-null = assistant-level override
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  // Minimum tier that requires HITL — assistants can raise this, never lower below platform min
  hitlMinimumTier: integer("hitl_minimum_tier").notNull().default(3), // default: Tier 3+ requires approval
  // Per-integration type overrides (jsonb map: { send_email: 2, delete_record: 3 })
  integrationTypeMinTiers: jsonb("integration_type_min_tiers"),
  // Tier 2 rate limit: max Tier 2 actions per run before queuing kicks in
  tier2RateLimit: integer("tier2_rate_limit").notNull().default(10),
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Agent Anomaly Thresholds — US-GOV-4.2.1: Platform-wide and workspace-level kill-switch config ──
export const agentAnomalyThresholds = pgTable("agent_anomaly_thresholds", {
  id: serial().primaryKey(),
  // null organisationId = platform-wide default; non-null = workspace override
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  loopDetectionLimit: integer("loop_detection_limit").notNull().default(5),   // consecutive identical calls
  toolRateMultiplier: integer("tool_rate_multiplier").notNull().default(2),   // 2x 7-day rolling average
  errorRatePercent: integer("error_rate_percent").notNull().default(20),      // % within 5-min window
  consecutiveRateLimitHits: integer("consecutive_rate_limit_hits").notNull().default(3),
  justification: text("justification"),  // required for workspace overrides
  createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Agent Anomaly Events — US-GOV-4.2.1: Full audit trail of kill-switch activations ──
export const agentAnomalies = pgTable("agent_anomalies", {
  id: serial().primaryKey(),
  taskRunId: integer("task_run_id").references(() => taskRuns.id, { onDelete: "cascade" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  // Anomaly type: 'loop' | 'rate_spike' | 'error_rate' | 'consecutive_429'
  anomalyType: text("anomaly_type").notNull(),
  // Snapshot of tool call sequence that triggered the anomaly
  toolCallExcerpt: jsonb("tool_call_excerpt"),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
  // Manual resume tracking
  resumedAt: timestamp("resumed_at"),
  resumedBy: integer("resumed_by").references(() => users.id, { onDelete: "set null" }),
  resumeAcknowledgement: text("resume_acknowledgement"),
  // If same anomaly fires again in same run → permanently terminated
  terminatedAt: timestamp("terminated_at"),
  status: text("status").notNull().default("suspended"), // 'suspended' | 'resumed' | 'terminated'
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Security Incidents — US-GDPR-3.2.1: Article 33/34 breach response state machine ──
// States: detected → contained → notified_controller → notified_regulator → closed
export const securityIncidents = pgTable("security_incidents", {
  id: serial().primaryKey(),
  title: text("title").notNull(),
  description: text("description").notNull(),
  severity: text("severity").notNull(), // 'low' | 'medium' | 'high' | 'critical'
  status: text("status").notNull().default("detected"), // 'detected' | 'contained' | 'notified_controller' | 'notified_regulator' | 'closed'
  dataTypesAffected: jsonb("data_types_affected"), // string[] e.g. ['oauth_tokens','email']
  affectedUserCount: integer("affected_user_count"),
  affectedUserIds: jsonb("affected_user_ids"), // number[] — for targeted revocation/notification
  discoveredAt: timestamp("discovered_at").defaultNow().notNull(),
  containedAt: timestamp("contained_at"),
  controllerNotifiedAt: timestamp("controller_notified_at"),
  regulatorNotifiedAt: timestamp("regulator_notified_at"),
  closedAt: timestamp("closed_at"),
  // ICO notification form fields (pre-populated by admin, logged on submission)
  regulatorNotificationBody: jsonb("regulator_notification_body"),
  reportedBy: integer("reported_by").references(() => users.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── JWT Blocklist — US-ADM-1.3.2: immediately invalidate tokens on GDPR erasure ──
// Stores the JTI (or userId+iat pair) of revoked tokens so auth-guard and all
// functions can reject them before natural expiry.
export const jwtBlocklist = pgTable("jwt_blocklist", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull(),
  // 'jti' when JWT has an explicit ID; 'userId' when we block all tokens for a user
  blockType: text("block_type").notNull().default("userId"), // 'userId' | 'jti'
  jti: text("jti"),
  reason: text("reason").notNull(), // 'gdpr_erasure' | 'account_delete' | 'admin_revoke'
  expiresAt: timestamp("expires_at"),  // can be NULL meaning indefinite
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  // US-DB-1.1.1: Blocklist check on every authenticated request — must use index scan
  index("jwt_blocklist_user_type_idx").on(t.userId, t.blockType),
  index("jwt_blocklist_jti_idx").on(t.jti),
]);

// ── Billing Overrides — US-ADM-2.1.1 ─────────────────────────────────────────
// US-LEGAL-1.1: Signed per-integration consent record — user authorises the assistant
// to act on a connected service. Required before the assistant can send outbound actions.
export const integrationAuthorizations = pgTable("integration_authorizations", {
  id: serial().primaryKey(),
  workspaceId: integer("workspace_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  authorizedByUserId: integer("authorized_by_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  integrationType: text("integration_type").notNull(), // 'gmail' | 'google_calendar' | 'twitter' | 'linkedin' | etc.
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  humanApprovalRequired: boolean("human_approval_required").notNull().default(true),
  // US-GOV-3.1.2: Custom AI disclosure footer text for outbound emails. Must contain 'AI'.
  disclosureText: text("disclosure_text"),
  // US-GOV-4.2.3: OAuth scope minimisation — scopes actually granted at consent time
  grantedScopes: text("granted_scopes").array(),
  lastUsedAt: timestamp("last_used_at"),
  lastScopeChangedAt: timestamp("last_scope_changed_at"),
  authorizedAt: timestamp("authorized_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
  revokedByUserId: integer("revoked_by_user_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => ({
  workspaceIntegrationUnique: unique("integration_auth_workspace_type_unique").on(t.workspaceId, t.integrationType, t.assistantId),
}));

// US-LEGAL-1.7: IP audit log — tracks every contractor/founder contribution and
// whether a valid present-tense IP assignment deed is on file.
export const ipAuditLog = pgTable("ip_audit_log", {
  id: serial().primaryKey(),
  contributorName: text("contributor_name").notNull(),
  contributorType: text("contributor_type").notNull(), // 'founder' | 'contractor' | 'employee'
  contributionScope: text("contribution_scope").notNull(), // brief description of what was contributed
  engagementStart: timestamp("engagement_start"),
  engagementEnd: timestamp("engagement_end"),
  assignmentLanguage: text("assignment_language").notNull().default("unknown"), // 'hereby_assigns' | 'agrees_to_assign' | 'none' | 'unknown'
  deedOnFile: boolean("deed_on_file").notNull().default(false),
  deedSignedAt: timestamp("deed_signed_at"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── Content Rules Library — US-SMM-2.2.2 ─────────────────────────────────────
// Per-assistant rules saved when a reviewer rejects a post with "apply as rule".
// Injected into generation instructions for all future drafts by that assistant.
export const contentRules = pgTable("content_rules", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  workspaceId: integer("workspace_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  ruleText: text("rule_text").notNull(),
  platform: text("platform"),                              // null = all platforms
  createdByUserId: integer("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  isActive: boolean("is_active").notNull().default(true),
  note: text("note"),                                      // optional note explaining the reason
  origin: text("origin").notNull().default('manual'),      // 'manual' | 'rejection_feedback'
  originPostId: integer("origin_post_id"),                 // FK to scheduledPosts.id (set null on delete)
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at"),
  previousText: text("previous_text"),                     // text before last edit
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Stripe Disputes — US-ADM-2.2.1 ──────────────────────────────────────────
export const stripeDisputes = pgTable("stripe_disputes", {
  id: serial().primaryKey(),
  stripeDisputeId: text("stripe_dispute_id").notNull().unique(),
  stripeChargeId: text("stripe_charge_id"),
  userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  amount: integer("amount"),           // in pence
  currency: text("currency").default("gbp"),
  reason: text("reason"),              // e.g. 'fraudulent', 'product_not_received'
  status: text("status").notNull(),    // 'warning_needs_response' | 'needs_response' | 'under_review' | 'won' | 'lost'
  evidenceDeadline: timestamp("evidence_deadline"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── ToS Acceptances — US-GOV-1.2.1 ──────────────────────────────────────────
export const tosAcceptances = pgTable("tos_acceptances", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  acceptedAt: timestamp("accepted_at").defaultNow().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
});

// ── Prompt Probe Attempts — US-LEGAL-2.3 ────────────────────────────────────
export const promptProbeAttempts = pgTable("prompt_probe_attempts", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  queryContent: text("query_content"),
  responseFragment: text("response_fragment"),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
});

export const billingOverrides = pgTable("billing_overrides", {
  id: serial().primaryKey(),
  workspaceId: integer("workspace_id").references(() => organisations.id, { onDelete: "cascade" }),
  adminId: integer("admin_id").references(() => users.id),
  action: text("action").notNull(), // 'comp_month' | 'upgrade_tier' | 'downgrade_tier' | 'extend_trial' | 'pause_subscription'
  amount: decimal("amount", { precision: 10, scale: 2 }),
  reason: text("reason").notNull(),
  stripeRef: text("stripe_ref"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── Bias Audit — US-GOV-3.3.1 ────────────────────────────────────────────────
// Quarterly prompt review records
export const biasAuditReviews = pgTable("bias_audit_reviews", {
  id: serial().primaryKey(),
  reviewerId: integer("reviewer_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  reviewDate: timestamp("review_date").defaultNow().notNull(),
  promptsReviewed: integer("prompts_reviewed").notNull().default(0),
  findingsCount: integer("findings_count").notNull().default(0),
  actionsRequired: text("actions_required"), // free-text summary
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Bias incidents — raised by statistical sampling or manual review
// Retained minimum 3 years (regulatory evidence)
export const biasIncidents = pgTable("bias_incidents", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  detectionMethod: text("detection_method").notNull(), // 'statistical_sampling' | 'manual_review' | 'user_report'
  findingsSummary: text("findings_summary").notNull(),
  investigatorId: integer("investigator_id").references(() => users.id, { onDelete: "set null" }),
  resolution: text("resolution"),
  resolvedAt: timestamp("resolved_at"),
  // Reactivation gate: deployer must acknowledge corrective actions before assistant resumes
  deployerAckAt: timestamp("deployer_ack_at"),
  deployerAckUserId: integer("deployer_ack_user_id").references(() => users.id, { onDelete: "set null" }),
  deployerAckNote: text("deployer_ack_note"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  // Retention: must not be deleted before 3 years
  retainUntil: timestamp("retain_until").notNull(),
});

// Monthly statistical sampling reports (one row per run)
export const biasSamplingReports = pgTable("bias_sampling_reports", {
  id: serial().primaryKey(),
  runAt: timestamp("run_at").defaultNow().notNull(),
  sampledCount: integer("sampled_count").notNull().default(0),
  flaggedAnomalies: integer("flagged_anomalies").notNull().default(0),
  // Full JSON report stored here; downloadable as CSV via admin endpoint
  reportData: jsonb("report_data"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ── OAuth Scope Minimisation — US-GOV-4.2.3 ──────────────────────────────────
// Platform-level registry: capability → minimum required scopes per integration type
// ── Content Provenance — US-GOV-3.2.1: C2PA-compatible metadata for AI-generated content ─────
export const contentProvenance = pgTable("content_provenance", {
  id: serial("id").primaryKey(),
  contentId: text("content_id").notNull().unique(),      // stable UUID assigned at generation time
  creatorSystem: text("creator_system").notNull().default("Aura-Assist"),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "cascade" }),
  workspaceIdHash: text("workspace_id_hash").notNull(), // pseudonymised org identifier (HMAC)
  modelUsedHash: text("model_used_hash").notNull(),      // SHA-256 of model name — not exposed directly
  hitlReviewed: boolean("hitl_reviewed").notNull().default(false),
  hitlReviewedAt: timestamp("hitl_reviewed_at"),
  generatedAt: timestamp("generated_at").notNull().defaultNow(),
  publishedAt: timestamp("published_at"),
  c2paSchemaVersion: text("c2pa_schema_version").notNull().default("1.0"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => [
  index("content_provenance_org_idx").on(t.organisationId),
  index("content_provenance_assistant_idx").on(t.assistantId),
]);

export const oauthScopeRegistry = pgTable("oauth_scope_registry", {
  id: serial().primaryKey(),
  integrationType: text("integration_type").notNull(), // 'gmail' | 'google_calendar' | 'slack' etc.
  capability: text("capability").notNull(),             // 'send_email' | 'read_calendar' etc.
  requiredScopes: text("required_scopes").array().notNull(), // e.g. ['https://www.googleapis.com/auth/gmail.send']
  scopeJustification: text("scope_justification").notNull(), // shown to deployer at consent
  maximumAllowedScopes: text("maximum_allowed_scopes").array(), // SuperAdmin enforced ceiling
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  capabilityUnique: unique("oauth_scope_capability_unique").on(t.integrationType, t.capability),
}));

// US-ADM-4.2.1: Compiled assistant blueprints — one row per compile run.
// blueprintVersion is a hash of all contributing source record IDs + updatedAt values;
// any source change produces a new hash, automatically marking the cached blueprint stale.
export const aiBlueprints = pgTable("ai_blueprints", {
  id: serial().primaryKey(),
  assistantId: integer("assistant_id").notNull().references(() => aiAssistants.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  blueprintVersion: text("blueprint_version").notNull(),   // SHA-256 hex of contributing record IDs+timestamps
  compiledAt: timestamp("compiled_at").defaultNow().notNull(),
  compiledBy: text("compiled_by").notNull().default("system"), // 'system' | admin userId as string
  triggerType: text("trigger_type").notNull().default("admin-manual"), // 'admin-manual' | 'system-auto' | 'dry-run'
  sections: jsonb("sections").notNull(),      // Record<sectionKey, { content, sources, status }>
  missingFields: jsonb("missing_fields").notNull().default('[]'), // MissingField[]
  completenessPercent: integer("completeness_percent").notNull().default(0),
  sentAt: timestamp("sent_at"),
  sentByAdminId: integer("sent_by_admin_id").references(() => users.id, { onDelete: "set null" }),
}, (t) => [
  index("ai_blueprints_assistant_idx").on(t.assistantId, t.compiledAt),
  index("ai_blueprints_version_idx").on(t.blueprintVersion),
]);

// US-SMM-3.1.1: Async content generation job queue
export const contentGenerationJobs = pgTable("content_generation_jobs", {
  id: serial().primaryKey(),
  jobId: text("job_id").notNull().unique(),                // UUID assigned at request time
  blueprintId: integer("blueprint_id").references(() => aiBlueprints.id, { onDelete: "set null" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("queued"),      // queued | processing | completed | failed
  attempt: integer("attempt").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  nextRetryAt: timestamp("next_retry_at"),
  errorMessage: text("error_message"),
  resultPostId: integer("result_post_id"),                 // scheduledPosts.id once created
  // US-SMM-3.4.1: On-demand generation fields
  contextPrompt: text("context_prompt"),                   // optional user-supplied context (≤500 chars)
  triggerType: text("trigger_type").default("scheduled"),  // 'on_demand' | 'scheduled' | 'admin_test'
  platform: text("platform"),                              // overrides blueprint default platform
  // US-ADM-4.3.3: Admin test generation fields
  adminId: integer("admin_id").references(() => users.id, { onDelete: "set null" }),
  tokensInput: integer("tokens_input"),                    // Anthropic input token count
  tokensOutput: integer("tokens_output"),                  // Anthropic output token count
  savedAsReference: boolean("saved_as_reference").default(false), // admin pinned this run as a reference snapshot
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  index("content_jobs_status_idx").on(t.status, t.createdAt),
  index("content_jobs_org_idx").on(t.organisationId, t.status),
]);

// US-SMM-3.3.1: Per-tick cron execution log
export const publishCronLog = pgTable("publish_cron_log", {
  id: serial().primaryKey(),
  tickAt: timestamp("tick_at").defaultNow().notNull(),
  postsProcessed: integer("posts_processed").notNull().default(0),
  postsSucceeded: integer("posts_succeeded").notNull().default(0),
  postsFailed: integer("posts_failed").notNull().default(0),
  durationMs: integer("duration_ms"),
  overrunAlert: boolean("overrun_alert").notNull().default(false),
});

// US-SMM-3.3.2: Per-org/platform rate limit state
export const rateLimitStates = pgTable("rate_limit_states", {
  id: serial().primaryKey(),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id, { onDelete: "cascade" }),
  platform: text("platform").notNull(),                    // 'instagram' | 'facebook' etc.
  rateLimitedUntil: timestamp("rate_limited_until").notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => [
  unique("rate_limit_states_org_platform_unique").on(t.organisationId, t.platform),
]);
