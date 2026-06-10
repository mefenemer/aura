import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  numeric,
  jsonb,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

// Organisations table — companies or groups users belong to
export const organisations = pgTable('organisations', {
  id: serial('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  // US-AUD-5.3.1 SC1: opt-in agency attribution badge on exported deliverables
  agencyAttributionEnabled: boolean('agency_attribution_enabled').notNull().default(false),
  createdAt: timestamp('created_at').defaultNow(),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// Core users table — the central entity all other tables reference
export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  firstName: text('first_name'),
  lastName: text('last_name'),
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
});

// Leads table — Interest capture for pending AI roles
export const leads = pgTable('leads', {
  id: serial('id').primaryKey(),
  email: text('email').notNull(),
  opportunityReason: text('opportunity_reason').notNull(),
  action: text('action').notNull().default('notify user of AI Assistant readiness'),
  // Notification lifecycle: 'notification_pending' | 'notification_sent'
  status: text('status').notNull().default('notification_pending'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
}, (t) => ({
  // Composite unique constraint ensures we don't duplicate interest for the same role
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
  // status: 'active' | 'past_due' | 'cancelling' | 'cancelled'
  // past_due = payment failed; assistants still run during gracePeriodEndsAt window
  status: text("status").notNull().default("active"),
  maxSeats: integer("max_seats"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
  // Grace period end: set to NOW()+7d on first payment failure; assistants pause after this date
  gracePeriodEndsAt: timestamp("grace_period_ends_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
  currency: text("currency").notNull().default("USD"),
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
});

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
  isActive: boolean("is_active").notNull().default(true),
  configuration: jsonb("configuration"),

  // Flexible schema expansion for role-specific answers
  onboardingContext: jsonb("onboarding_context"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // provisioningStatus: 'pending' | 'complete' | 'failed' | 'cancelled' | 'paused_limit' | 'paused_payment'
  provisioningStatus: text("provisioning_status").default("pending"),
}, (t) => ({
  // DB-level unique guard prevents race-condition duplicates during concurrent onboarding submissions
  userNameUnique: unique("ai_assistants_user_name_unique").on(t.userId, t.name),
}));

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// Notifications table — in-app notifications delivered to a user
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
});

// ── Vault Secrets — US-AUD-4.2.1 SC1/SC2 ────────────────────────────────────
// Stores AES-256-GCM encrypted credential payloads. DB never holds plaintext.
// refKey format: 'aura/user-<id>/<service>-<type>' e.g. 'aura/user-42/google-oauth-access'
export const vaultSecrets = pgTable("vault_secrets", {
  id: serial().primaryKey(),
  refKey: text("ref_key").notNull().unique(), // logical path — stored in systemConnections.vaultRefKey
  encryptedPayload: text("encrypted_payload").notNull(), // AES-256-GCM ciphertext (base64)
  iv: text("iv").notNull(),                              // GCM nonce (base64, 12 bytes)
  authTag: text("auth_tag").notNull(),                   // GCM auth tag (base64, 16 bytes)
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// System connections table — OAuth tokens and credentials for third-party service integrations
export const systemConnections = pgTable("system_connections", {
  id: serial().primaryKey(),
  userId: integer("user_id").references(() => users.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(),
  connectionType: text("connection_type").notNull().default("oauth"), // 'oauth', 'api_key', 'legacy'

  // US-AUD-4.2.1 SC1: vault reference key replaces plaintext tokens
  // Format: 'aura/user-<id>/<serviceName>-<connectionType>'
  vaultRefKey: text("vault_ref_key"),

  // DEPRECATED (SC1): kept nullable for zero-downtime migration; cleared after vault migration
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
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
});

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
});

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
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// Task runs — one row per automated task execution; used for monthly volume tracking (SC3)
export const taskRuns = pgTable("task_runs", {
  id: serial().primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").references(() => organisations.id, { onDelete: "set null" }),
  assistantId: integer("assistant_id").references(() => aiAssistants.id, { onDelete: "set null" }),
  taskType: text("task_type").notNull().default("automated"),  // 'automated' | 'manual' | 'scheduled'
  status: text("status").notNull().default("completed"),       // 'completed' | 'failed' | 'skipped'
  tokensUsed: integer("tokens_used").default(0),               // LLM tokens consumed by this run
  // metadata JSONB shape (US-AUD-2.1.1):
  //   { confidenceLevel: 'green' | 'amber' | 'red',   // AI self-assessed confidence (SC5)
  //     verifyHint: string | null,                      // AMBER/RED: what to verify
  //     model: string,                                  // model used for this run
  //     promptTokens: number, completionTokens: number }
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

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
  createdAt: timestamp("created_at").defaultNow().notNull(),
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

// Add this to your existing db/schema.ts file

export const helpArticles = pgTable('help_articles', {
  id: serial('id').primaryKey(),
  title: varchar('title', { length: 255 }).notNull(),
  description: text('description').notNull(),
  category: varchar('category', { length: 100 }).notNull(),
  icon: varchar('icon', { length: 50 }).notNull(),
  readTime: varchar('read_time', { length: 50 }).default('3 min read'),
  createdAt: timestamp('created_at').defaultNow()
});
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
  status: text("status").notNull().default("processing"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
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
});
// User Notifications Table — Global feed for alerts, tickets, and billing
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
});
// Onboarding Drafts Table — Stores auto-save progress for incomplete setups
export const onboardingDrafts = pgTable("onboarding_drafts", {
  userId: integer("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  currentStep: integer("current_step").default(2).notNull(),
  onboardingPath: text("onboarding_path").notNull(),
  draftData: jsonb("draft_data").default({}).notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  // Tracks when the last abandoned-onboarding reminder was sent to avoid duplicate emails
  reminderSentAt: timestamp("reminder_sent_at"),
});

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
  scheduledPostId: integer("scheduled_post_id"),
  postedAt: timestamp("posted_at"),
  rejectedAt: timestamp("rejected_at"),

  // Data retention — populated when status changes to posted/rejected
  retentionDeleteAfter: timestamp("retention_delete_after"),
  purgedAt: timestamp("purged_at"),

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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
});

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
  contentAssetIds: jsonb("content_asset_ids").default([]),  // array of contentAssets.id
  linkUrl: text("link_url"),
  ctaText: text("cta_text"),
  hashtags: text("hashtags"),                    // space-separated or newline-separated
  mentions: text("mentions"),
  utmParams: text("utm_params"),

  // Workflow & governance
  // Status: draft | in_review | approved | scheduled | published | rejected | cancelled
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

  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ── DPA Requests — US-AUD-4.1.1 SC3 ──────────────────────────────────────────
// Stores Data Processing Agreement request submissions from the /trust.html page.
// On insert: (a) email sent to platform legal contact, (b) auto-acknowledgement sent to requester.
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
});

// ── GDPR Erasure Log — US-GAP-2.1.2 SC3 ──────────────────────────────────────
// Anonymised record retained after any user account deletion.
// Stores only a hashed email (SHA-256), not the plaintext address.
export const gdprErasureLog = pgTable("gdpr_erasure_log", {
  id: serial().primaryKey(),
  emailHash: text("email_hash").notNull(),   // SHA-256 of the deleted user's email
  requesterType: text("requester_type").notNull(), // 'user' | 'admin'
  requesterAdminId: integer("requester_admin_id"), // admin userId if requesterType='admin'
  erasedAt: timestamp("erased_at").defaultNow().notNull(),
});

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
