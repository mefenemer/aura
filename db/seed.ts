import { config } from 'dotenv';
import * as path from 'path';

// Tell dotenv exactly where to find the .env file
config({ path: path.resolve(process.cwd(), '.env') });

import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { masterPlans, masterAssistants } from './schema';

// Grab the database URL directly from the environment
const connectionString = process.env.NETLIFY_DATABASE_URL;

if (!connectionString) {
    throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing from the environment.");
}

// Set max connections to 1 since this is a one-off script
const sql = postgres(connectionString, { max: 1 });
const db = drizzle({ client: sql });

async function seed() {
    console.log('🌱 Starting database seed...');

    try {
        // 1. Seed the Master Plans
        console.log('Seeding Master Plans...');
        await db.insert(masterPlans).values([
            { tierKey: 'buster', name: 'The Busywork Buster', monthlyPriceGbp: '20.00' },
            { tierKey: 'saver', name: 'The Workflow Saver', monthlyPriceGbp: '50.00' },
            { tierKey: 'employee', name: 'The Digital Employee', monthlyPriceGbp: '100.00' }
        ]).onConflictDoNothing({ target: masterPlans.tierKey });
        // ^ onConflictDoNothing prevents duplicate errors if you run this twice!

        // 2. Seed the Master Assistants
        console.log('Seeding Master Assistants...');
        await db.insert(masterAssistants).values([
            { roleKey: 'social_media', name: 'Social Media Manager', description: 'Organic content creation and automated publishing.' },
            { roleKey: 'paid_ads', name: 'Performance Marketer', description: 'Ad generation, campaign publishing, and audience targeting.' },
            { roleKey: 'data_entry', name: 'Inventory & Order Manager', description: 'Managing cross-platform orders, syncing stock, and automating fulfillment logs.' },
            { roleKey: 'custom', name: 'Operations Manager', description: 'A unique, multi-step process that does not fit standard roles.' },

            // Including the "Coming Soon" roles so they are ready for launch!
            { roleKey: 'community_mgmt', name: 'Community Manager', description: 'Monitoring comments, answering DMs, and engaging with followers.', isActive: false },
            { roleKey: 'inbox', name: 'Support Specialist', description: 'Categorizing emails, drafting replies, or handling customer queries.', isActive: false },
            { roleKey: 'reporting', name: 'Data Analyst', description: 'Generating summaries, pulling metrics, or creating dashboards.', isActive: false },
            { roleKey: 'receipt_admin', name: 'Receipt & Invoice Organizer', description: 'Automatically monitors your inbox for digital receipts and invoices, extracts key data, and updates your master accounting spreadsheets.', isActive: false },
            { roleKey: 'lead_welcomer', name: 'New Lead Welcomer', description: 'Instantly engages with new leads from your website forms, drafting personalized welcome emails and updating your CRM records', isActive: false },
            { roleKey: 'seo', name: 'SEO Content Strategist', description: 'Analyzes target keywords and drafts optimized blog posts and landing page copy to improve your search engine rankings.', isActive: false }
        ]).onConflictDoNothing({ target: masterAssistants.roleKey });

        console.log('✅ Seeding completed successfully!');
    } catch (error) {
        console.error('❌ Error during seeding:', error);
    } finally {
        // Always close the database connection gracefully
        await sql.end();
    }
}

// Add to db/seed.ts (Make sure to import helpArticles at the top)

console.log("Seeding Help Articles...");

import { getDb } from './client'; // Adjust path if necessary
import { helpArticles } from './schema'; // Adjust path if necessary

// Wrap everything inside an async execution wrapper
(async () => {
    try {
        console.log("Starting Database Seeding...");
        const db = getDb();

        // Your help articles dataset execution block
        await db.insert(helpArticles).values([
            {
                title: "Understanding Your Workspace",
                description: "A complete tour of the Aura-Assist dashboard, metrics, and how to interpret your digital team's time-saved analytics.",
                category: "Getting Started",
                icon: "layout",
                readTime: "4 min read"
            },
            {
                title: "Aura-Assist Glossary of Terms",
                description: "Definitions for commonly used terms including Compute Power, Automations, Workflows, and Active vs. Resting states.",
                category: "Getting Started",
                icon: "book",
                readTime: "2 min read"
            },
            {
                title: "Navigating the Interface",
                description: "How to effectively use the sidebar, mobile hamburger menu, and quick-action shortcuts to manage your team.",
                category: "Getting Started",
                icon: "compass",
                readTime: "3 min read"
            },
            {
                title: "How to Hire & Provision Assistants",
                description: "A step-by-step guide to browsing the catalog, requesting custom roles, and deploying new assistants to your workspace.",
                category: "Assistants",
                icon: "bot",
                readTime: "5 min read"
            },
            {
                title: "Updating Assistant Guidelines",
                description: "Learn how to edit the operational rules, tone of voice, and boundary constraints for your active digital employees.",
                category: "Assistants",
                icon: "edit",
                readTime: "4 min read"
            },
            {
                title: "Updating Account Settings",
                description: "How to change your email, password, and global timezone so your assistants operate on your local schedule.",
                category: "Account & Settings",
                icon: "user",
                readTime: "2 min read"
            },
            {
                title: "Managing Notification Preferences",
                description: "Control how often Aura-Assist interrupts you. Set up daily digests, billing alerts, and waitlist updates.",
                category: "Account & Settings",
                icon: "bell",
                readTime: "3 min read"
            },
            {
                title: "Compute Budgets & Preferences",
                description: "Understanding how AI processing power is billed at cost, and how to adjust your monthly safety caps to prevent surprise bills.",
                category: "Account & Settings",
                icon: "credit-card",
                readTime: "4 min read"
            },
            {
                title: "Data Security & Compliance",
                description: "Detailed information on our encryption standards, privacy policies, and how your data is sandboxed from public AI models.",
                category: "Compliance",
                icon: "shield",
                readTime: "6 min read"
            }
        ]);

        console.log("🌱 Database seeding completed successfully!");
        process.exit(0);
    } catch (error) {
        console.error("❌ Seeding execution failed:", error);
        process.exit(1);
    }
})();

console.log("Help Articles Seeded!");

seed();