// purge-ghost-accounts.ts  (US5)
// Scheduled Netlify function — runs every hour via cron.
// Permanently deletes user accounts that are STILL in 'pending_verification'
// AND whose token_expires_at timestamp is now in the past.
//
// Cascade deletion: Drizzle schema has onDelete:'cascade' on user_profiles
// and user_organisations, so a single DELETE from users wipes all orphaned rows.
//
// Scenario 3 safety: active users and pending users whose token is still valid
// are NEVER touched.

import type { Config } from '@netlify/functions';
import { lt, eq, and, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users } from '../../db/schema';

export default async function handler(): Promise<void> {
    const db = getDb();
    const now = new Date();

    try {
        // Target: pending_verification + expired token
        const ghosts = await db
            .select({ id: users.id, email: users.email })
            .from(users)
            .where(
                and(
                    eq(users.status, 'pending_verification'),
                    isNotNull(users.tokenExpiresAt),
                    lt(users.tokenExpiresAt, now),
                )
            );

        if (ghosts.length === 0) {
            console.log('[purge-ghost-accounts] Nothing to purge.');
            return;
        }

        // Cascade-delete each ghost; cascades wipe user_profiles + user_organisations
        let purged = 0;
        for (const ghost of ghosts) {
            try {
                await db.delete(users).where(eq(users.id, ghost.id));
                purged++;
            } catch (err) {
                console.error(`[purge-ghost-accounts] Failed to delete user ${ghost.id}:`, err);
            }
        }

        console.log(`[purge-ghost-accounts] Purged ${purged}/${ghosts.length} ghost accounts.`);
    } catch (err) {
        console.error('[purge-ghost-accounts] Fatal error:', err);
    }
}

// Run every hour
export const config: Config = {
    schedule: '0 * * * *',
};
