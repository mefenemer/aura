// netlify/functions/admin-gdpr-erase.ts
//
// US-ADM-1.3.2: GDPR Right to Erasure — Admin-Initiated Workflow
//
// POST /.netlify/functions/admin-gdpr-erase
//   Body: { targetUserId: number, reason: string }
//   Cookie: aura_session (must belong to super_admin or platform_admin)
//
// Performs anonymisation (not hard-delete) to satisfy 7-year financial record retention:
//   - Overwrites PII fields on the users row
//   - Cancels Stripe subscription
//   - Clears personal content (onboarding drafts, user profile narrative, etc.)
//   - Retains payments, invoices, billing rows per legal obligation
//   - Writes gdpr_erasure_log + admin_audit_log
//   - Sends confirmation email to the original address before anonymisation

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { eq, and } from 'drizzle-orm';
import Stripe from 'stripe';
import { getDb } from '../../db/client';
import {
    users, plans, gdprErasureLog, onboardingDrafts,
    userProfiles, userNotifications, notifications,
} from '../../db/schema';
import { insertAdminAuditLog, getAdminIp } from '../../src/utils/admin-audit';
import { sendEmail } from '../../src/utils/email';

const jwtSecret    = process.env.JWT_SECRET;
const stripe       = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-11-20.acacia' })
    : null;
const BASE_URL     = process.env.BASE_URL || 'https://aura-assist.com';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed.' }) };
    }
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // ── 1. Authenticate admin ────────────────────────────────────────────────
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return { statusCode: 401, body: JSON.stringify({ error: 'Not authenticated.' }) };

    let adminId: number;
    try {
        adminId = (jwt.verify(match[1], jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();
    const [adminUser] = await db
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, adminId))
        .limit(1);

    if (!adminUser || !['super_admin', 'platform_admin'].includes(adminUser.role || '')) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Requires super_admin or platform_admin role.' }) };
    }

    // ── 2. Parse and validate request ────────────────────────────────────────
    let body: { targetUserId?: number; reason?: string };
    try { body = JSON.parse(event.body || '{}'); } catch { body = {}; }

    const { targetUserId, reason } = body;
    if (!targetUserId || !reason?.trim()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'targetUserId and reason are required.' }) };
    }
    if (targetUserId === adminId) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Cannot erase your own account.' }) };
    }

    // ── 3. Load target user ───────────────────────────────────────────────────
    const [targetUser] = await db
        .select({
            id:             users.id,
            email:          users.email,
            firstName:      users.firstName,
            lastName:       users.lastName,
            organisationId: users.organisationId,
        })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);

    if (!targetUser) {
        return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };
    }

    const originalEmail = targetUser.email;

    // ── 4. Check for active Stripe disputes ──────────────────────────────────
    if (stripe) {
        const [activePlan] = await db
            .select({ stripeCustomerId: plans.stripeCustomerId })
            .from(plans)
            .where(and(eq(plans.userId, targetUserId), eq(plans.status, 'active')))
            .limit(1);

        if (activePlan?.stripeCustomerId) {
            try {
                const disputes = await stripe.disputes.list({ limit: 5 });
                // Check any charge for this customer has an open dispute
                const customerCharges = await stripe.charges.list({
                    customer: activePlan.stripeCustomerId,
                    limit: 10,
                });
                const openDisputeCharges = customerCharges.data.filter(c =>
                    c.disputed && c.dispute && (c.dispute as any).status !== 'lost' && (c.dispute as any).status !== 'won'
                );
                if (openDisputeCharges.length > 0) {
                    return {
                        statusCode: 409,
                        body: JSON.stringify({
                            error: 'Cannot erase: active Stripe dispute on this account. Resolve dispute first.',
                        }),
                    };
                }
            } catch (stripeErr) {
                console.warn('[admin-gdpr-erase] Could not check disputes — proceeding:', stripeErr);
            }
        }
    }

    const erasureUuid = crypto.randomUUID();
    const anonymisedEmail = `deleted_${erasureUuid}@deleted.invalid`;

    try {
        // ── 5. Anonymise the user record ──────────────────────────────────────
        await db.update(users)
            .set({
                email:             anonymisedEmail,
                firstName:         'Deleted',
                lastName:          'User',
                verificationToken: null,
                deletionToken:     null,
                referralCode:      null,
                updatedAt:         new Date(),
            })
            .where(eq(users.id, targetUserId));

        // ── 6. Wipe user profile personal data ───────────────────────────────
        await db.update(userProfiles)
            .set({
                displayName:       null,
                avatarUrl:         null,
                bio:               null,
                emailPreferences:  null,
                legalConsents:     null,
                preferences:       null,
                updatedAt:         new Date(),
            })
            .where(eq(userProfiles.userId, targetUserId))
            .catch(() => { /* profile may not exist — ignore */ });

        // ── 7. Clear onboarding drafts (personal content) ─────────────────────
        await db.delete(onboardingDrafts)
            .where(eq(onboardingDrafts.userId, targetUserId))
            .catch(() => {});

        // ── 8. Clear in-app notifications ─────────────────────────────────────
        await db.delete(notifications)
            .where(eq(notifications.userId, targetUserId))
            .catch(() => {});
        await db.delete(userNotifications)
            .where(eq(userNotifications.userId, targetUserId))
            .catch(() => {});

        // ── 9. Cancel Stripe subscription ─────────────────────────────────────
        if (stripe) {
            const activePlans = await db
                .select({ stripeSubscriptionId: plans.stripeSubscriptionId, id: plans.id })
                .from(plans)
                .where(eq(plans.userId, targetUserId));

            for (const plan of activePlans) {
                if (plan.stripeSubscriptionId) {
                    await stripe.subscriptions.cancel(plan.stripeSubscriptionId).catch(() => {});
                }
                await db.update(plans)
                    .set({ status: 'cancelled', cancelledAt: new Date(), updatedAt: new Date() })
                    .where(eq(plans.id, plan.id));
            }
        }

        // ── 10. Write gdpr_erasure_log ────────────────────────────────────────
        const emailHash = crypto.createHash('sha256').update(originalEmail.toLowerCase()).digest('hex');
        await db.insert(gdprErasureLog).values({
            emailHash,
            requesterType: 'admin',
            requestedBy:   adminId,
        });

        // ── 11. Write admin audit log ─────────────────────────────────────────
        await insertAdminAuditLog({
            adminId,
            action:    'gdpr_erasure',
            targetType:'user',
            targetId:   targetUserId,
            previousState: {
                email:     '[redacted]',
                firstName: targetUser.firstName,
                lastName:  targetUser.lastName,
            },
            newState: {
                email:     anonymisedEmail,
                firstName: 'Deleted',
                lastName:  'User',
            },
            reason,
            ipAddress: getAdminIp(event.headers as any),
            userAgent: event.headers['user-agent'] || undefined,
            metadata: { erasureUuid },
        });

        // ── 12. Send confirmation email to original address ───────────────────
        await sendEmail({
            to:      originalEmail,
            subject: 'Your Aura-Assist account data has been erased',
            html:    `<p>This is to confirm that your personal data has been permanently erased from Aura-Assist as requested.</p>
                      <p>Your account can no longer be accessed. Financial records required by law have been retained for the statutory period.</p>
                      <p>If you have any questions, contact our Data Protection Officer at <a href="mailto:privacy@aura-assist.com">privacy@aura-assist.com</a>.</p>`,
        }).catch(err => console.warn('[admin-gdpr-erase] Confirmation email failed (non-blocking):', err));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: true, anonymisedEmail }),
        };

    } catch (err: any) {
        console.error('[admin-gdpr-erase] Error:', err);
        return { statusCode: 500, body: JSON.stringify({ error: 'Erasure failed: ' + err.message }) };
    }
};
