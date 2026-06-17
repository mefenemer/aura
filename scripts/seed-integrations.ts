import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { systemConnections } from '../db/schema';
import { config } from 'dotenv';

config();

const pgClient = postgres(process.env.NETLIFY_DATABASE_URL!);
const db = drizzle({ client: pgClient });

async function seed() {
    // Define your supported platforms here
    const supportedPlatforms = [
        { serviceName: 'Facebook', connectionType: 'oauth' },
        { serviceName: 'Instagram', connectionType: 'oauth' },
        { serviceName: 'LinkedIn', connectionType: 'oauth' },
        { serviceName: 'X', connectionType: 'oauth' }
    ];

    console.log("Seeding system integrations...");

    // Use a special user_id 0 to represent "System" or "Global"
    // This ensures they appear in the list without being tied to a real user account
    for (const platform of supportedPlatforms) {
        await db.insert(systemConnections).values({
            userId: null,
            serviceName: platform.serviceName,
            connectionType: platform.connectionType,
            status: 'pending', // Indicates it's available but not yet connected by a user
            isActive: true
        }).onConflictDoNothing();
    }

    console.log("Integrations seeded.");
    process.exit();
}

seed();