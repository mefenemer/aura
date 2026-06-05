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
  status: text("status").notNull().default("active"),
  maxSeats: integer("max_seats"),
  startedAt: timestamp("started_at").defaultNow().notNull(),
  expiresAt: timestamp("expires_at"),
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
  metadata: jsonb("metadata"),
  paidAt: timestamp("paid_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// AI assistants table — AI agents configured by or assigned to a user
export const aiAssistants = pgTable("ai_assistants", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  organisationId: integer("organisation_id").notNull().references(() => organisations.id,
      {
        onDelete: "cascade",
      }),
  masterAssistantId: integer("master_assistant_id").references(() => masterAssistants.id),
  name: text("name").notNull(),
  aiAssistantJobRole: text("ai_assistant_job_role"),
  model: text("model").notNull(),
  systemPrompt: text("system_prompt"),
  isActive: boolean("is_active").notNull().default(true),
  configuration: jsonb("configuration"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

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

// System connections table — OAuth tokens and credentials for third-party service integrations
export const systemConnections = pgTable("system_connections", {
  id: serial().primaryKey(),
  userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  serviceName: text("service_name").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: timestamp("token_expires_at"),
  scopes: text("scopes"),
  externalUserId: text("external_user_id"),
  metadata: jsonb("metadata"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// MASTER CATALOG TABLES
export const masterPlans = pgTable("master_plans", {
  id: serial().primaryKey(),
  tierKey: text("tier_key").notNull().unique(),
  name: text("name").notNull(),
  monthlyPriceGbp: numeric("monthly_price_gbp", { precision: 10, scale: 2 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const masterAssistants = pgTable("master_assistants", {
  id: serial().primaryKey(),
  roleKey: text("role_key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
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