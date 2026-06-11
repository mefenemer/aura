// netlify/functions/account-delete-execute.ts
// US-GAP-2.1.1 SC5: Scheduled job — hard-delete accounts pending for 24+ hours
//
// Scheduled hourly (schedule: "0 * * * *")
// Also handles the GDPR erasure log entry (SC3 / US-GAP-2.1.2 SC3)

import { Handler, schedule } from '@netlify/functions';
import * as crypto from 'crypto';
import Stripe from 'stripe';
import { eq, and, lt, isNotNull, count } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, organisations, userOrganisations, gdprErasureLog, jwtBlocklist } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { purgeUserAssets } from '../../src/utils/gdpr-asset-purge';

const stripe    = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;
const BASE_URL  = process.env.BASE_URL || '';

async function executeDeleteions() {
    const db  = getDb();
    const now = new Date();
    const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    // Find users whose deletion was requested > 24h ago
    const pendingUsers = await db
        .select({
            id:               users.id,
            email:            users.email,
            firstName:        users.firstName,
            organisationId:   users.organisationId,
        })
        .from(users)
        .where(and(
            eq(users.pendingDeletion, true),
            isNotNull(users.pendingDeletionAt),
            lt(users.pendingDeletionAt, cutoff24h),
        ));

    for (const user of pendingUsers) {
        // Cancel Stripe subscription if active
        if (stripe) {
            const [activePlan] = await db
                .select({ stripeSubscriptionId: plans.stripeSubscriptionId, stripeCustomerId: plans.stripeCustomerId })
                .from(plans)
                .where(and(eq(plans.userId, user.id), eq(plans.status, 'active')))
                .limit(1);

            if (activePlan?.stripeSubscriptionId) {
                await stripe.subscriptions.cancel(activePlan.stripeSubscriptionId).catch(() => {});
            }
        }

        // US-GDPR-2.2.1: Purge workspace assets (extractedText + storageUrl nulled, isActive=false)
        const purgeResult = await purgeUserAssets(db, user.id).catch(() => ({
            assetsPurged: 0, storageBytesFreed: 0, partialFailures: ['purge_threw'],
        }));

        // US-ADM-1.3.2: Blocklist all active tokens so any cached session is invalidated
        await db.insert(jwtBlocklist).values({
            userId:    user.id,
            blockType: 'userId',
            reason:    'account_delete',
        }).catch(() => {});

        // GDPR erasure log (SC3 / US-GAP-2.1.2 SC3) — include asset purge metadata
        const emailHash = crypto.createHash('sha256').update(user.email.toLowerCase()).digest('hex');
        await db.insert(gdprErasureLog).values({
            emailHash,
            requesterType: 'user',
            requestedBy:   null,
            erasedAt:      now,
            metadata: {
                assetsPurged:      purgeResult.assetsPurged,
                embeddingsDeleted: purgeResult.embeddingsDeleted,
                storageBytesFreed: purgeResult.storageBytesFreed,
                ...(purgeResult.partialFailures.length > 0
                    ? { partialFailures: purgeResult.partialFailures, erasureStatus: 'PARTIAL' }
                    : {}),
            },
        }).catch(() => {});

        // Check if the user is the sole org member — if so, delete the org too
        if (user.organisationId) {
            const [{ memberCount }] = await db
                .select({ memberCount: count() })
                .from(userOrganisations)
                .where(eq(userOrganisations.organisationId, user.organisationId))
                .catch(() => [{ memberCount: 0 }]);

            if (!memberCount || memberCount <= 1) {
                // Sole member — delete org (cascades via ON DELETE CASCADE)
                await db.delete(organisations).where(eq(organisations.id, user.organisationId)).catch(() => {});
            }
        }

        // Hard-delete user (cascades to all related tables via ON DELETE CASCADE)
        await db.delete(users).where(eq(users.id, user.id)).catch(err => {
            console.error(`[account-delete-execute] Failed to delete user ${user.id}:`, err);
        });

        console.log(`[account-delete-execute] Deleted user ${user.id} (email hash: ${emailHash.slice(0, 8)}...)`);
    }

    return pendingUsers.length;
}

export const handler: Handler = schedule('0 * * * *', async () => {
    try {
        const deleted = await executeDeleteions();
        console.log(`[account-delete-execute] Processed ${deleted} deletion(s)`);
        return { statusCode: 200 };
    } catch (err) {
        console.error('[account-delete-execute]', err);
        return { statusCode: 500 };
    }
});
