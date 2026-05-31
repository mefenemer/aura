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
            { roleKey: 'reporting', name: 'Data Analyst', description: 'Generating summaries, pulling metrics, or creating dashboards.', isActive: false }
        ]).onConflictDoNothing({ target: masterAssistants.roleKey });

        console.log('✅ Seeding completed successfully!');
    } catch (error) {
        console.error('❌ Error during seeding:', error);
    } finally {
        // Always close the database connection gracefully
        await sql.end();
    }
}

seed();