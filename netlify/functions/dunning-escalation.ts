// netlify/functions/dunning-escalation.ts
// US-GAP-3.2.2: Dunning Email — Day 3 and Day 7 Escalation
//
// Scheduled daily at 09:00 UTC (schedule: "0 9 * * *")
// Scans all past_due plans and sends escalation emails based on days since first failure.
//
// Day 1 email: sent when 1–2 days have elapsed since first payment failure (soft warning)
// Day 3 email (SC1/SC2): sent when 3–6 days have elapsed since first payment failure
// Day 7 email (SC3/SC4): sent when 7+ days have elapsed (grace period end — final notice)
// SC5: Stop on payment — invoice.paid webhook resets plan to 'active' so these users are excluded

import type { Handler } from '@netlify/functions';
import { eq, and, lte, gte, isNotNull } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, plans, processedWebhookEvents } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

const BASE_URL = process.env.BASE_URL || '';

async function runDunningEscalation() {
    const db = getDb();
    const now = new Date();

    // Find all past_due plans that have a gracePeriodEndsAt set
    // gracePeriodEndsAt = firstFailureDate + 7 days
    // Day 3 window: gracePeriodEndsAt is between now+1d and now+4d (i.e., failure was 3–6 days ago)
    // Day 7 window: gracePeriodEndsAt is within the next 24h (i.e., failure was 7+ days ago)

    const day1Start = new Date(now.getTime() + 5  * 24 * 60 * 60 * 1000); // grace expires in 5–6 days = day 1–2
    const day1End   = new Date(now.getTime() + 6  * 24 * 60 * 60 * 1000);
    const day3Start = new Date(now.getTime() + 1  * 24 * 60 * 60 * 1000); // grace expires in 1–4 days = day 3–6
    const day3End   = new Date(now.getTime() + 4  * 24 * 60 * 60 * 1000);
    const day7End   = new Date(now.getTime() + 1  * 24 * 60 * 60 * 1000); // grace expires within 24h = day 7

    // Fetch all past_due plans with grace period info and user email
    const pastDuePlans = await db
        .select({
            planId: plans.id,
            userId: plans.userId,
            stripeCustomerId: plans.stripeCustomerId,
            gracePeriodEndsAt: plans.gracePeriodEndsAt,
        })
        .from(plans)
        .where(and(
            eq(plans.status, 'past_due'),
            isNotNull(plans.gracePeriodEndsAt),
        ));

    for (const plan of pastDuePlans) {
        const graceEnd = plan.gracePeriodEndsAt instanceof Date
            ? plan.gracePeriodEndsAt
            : new Date(plan.gracePeriodEndsAt as string);

        const isDay7 = graceEnd <= day7End;  // grace period expires within 24h
        const isDay3 = !isDay7 && graceEnd >= day3Start && graceEnd <= day3End;
        const isDay1 = !isDay7 && !isDay3 && graceEnd >= day1Start && graceEnd <= day1End;

        if (!isDay1 && !isDay3 && !isDay7) continue;

        const emailType = isDay7 ? 'day7' : isDay3 ? 'day3' : 'day1';
        const dedupeKey = `dunning:${plan.planId}:${emailType}`;

        // SC5/Idempotency: skip if already sent
        const [alreadySent] = await db
            .select({ id: processedWebhookEvents.id })
            .from(processedWebhookEvents)
            .where(eq(processedWebhookEvents.stripeEventId, dedupeKey))
            .limit(1);

        if (alreadySent) continue;

        // Mark as sent before dispatch to prevent duplicate sends
        await db.insert(processedWebhookEvents)
            .values({ stripeEventId: dedupeKey, eventType: `dunning_${emailType}_email_sent` })
            .onConflictDoNothing();

        // Fetch user record
        const [userRecord] = await db
            .select({ email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, plan.userId!))
            .limit(1);

        if (!userRecord) continue;

        // Generate Stripe billing portal URL
        let portalUrl = `${BASE_URL}/billing.html`;
        if (stripe && plan.stripeCustomerId) {
            try {
                const portal = await stripe.billingPortal.sessions.create({
                    customer: plan.stripeCustomerId,
                    return_url: `${BASE_URL}/billing.html`,
                });
                portalUrl = portal.url;
            } catch { /* fallback to billing.html */ }
        }

        const name = userRecord.firstName || 'there';

        if (isDay1) {
            // Day 1 soft warning email
            await sendEmail({
                to: userRecord.email,
                subject: `Payment failed — please update your details`,
                html: `<p>Hi ${name},</p>
                       <p>We were unable to process your Aura subscription payment. This can happen when a card expires or a bank declines an automated charge.</p>
                       <p>Your assistants remain active for now, but <strong>please update your payment details as soon as possible</strong> to avoid any interruption to your service.</p>
                       <p style="margin-top:24px;">
                         <a href="${portalUrl}" style="background:#f59e0b;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                           Update Payment Details →
                         </a>
                       </p>
                       <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                         Need help? <a href="mailto:hello@aura-assist.com">Contact our support team</a>.
                       </p>
                       <p>The Aura Team</p>`,
            }).catch(err => console.warn('[dunning-escalation] Day 1 email failed:', err));

        } else if (isDay3) {
            // SC1/SC2: Day 3 escalation email
            await sendEmail({
                to: userRecord.email,
                subject: `Your assistants are paused — update payment to restore access`,
                html: `<p>Hi ${name},</p>
                       <p>We still haven't been able to process your subscription payment, and <strong>your Aura assistants are currently paused</strong>.</p>
                       <p>⚠️ If payment isn't resolved within the next <strong>4 days</strong>, your account will be cancelled and access to your assistants will be permanently removed.</p>
                       <p>Don't lose the work you've built — update your payment details now to restore access immediately.</p>
                       <p style="margin-top:24px;">
                         <a href="${portalUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                           Restore Access Now →
                         </a>
                       </p>
                       <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                         Need help? <a href="mailto:hello@aura-assist.com">Contact our support team</a>.
                       </p>
                       <p>The Aura Team</p>`,
            }).catch(err => console.warn('[dunning-escalation] Day 3 email failed:', err));

        } else {
            // SC3/SC4: Day 7 final notice email
            await sendEmail({
                to: userRecord.email,
                subject: `Final notice — your account will be cancelled tomorrow`,
                html: `<p>Hi ${name},</p>
                       <p>This is your final notice. Your subscription payment has been outstanding for 7 days, and <strong>your account will be cancelled tomorrow</strong>.</p>
                       <p>⛔ <strong>What happens when your account is cancelled:</strong></p>
                       <ul>
                         <li>All your AI assistants will be permanently deactivated</li>
                         <li>Your scheduled content and automation will stop</li>
                         <li>Your account data is retained for 30 days, after which it will be deleted</li>
                       </ul>
                       <p>Update your payment details right now to prevent cancellation and restore full access.</p>
                       <p style="margin-top:24px;">
                         <a href="${portalUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                           Update Payment Details →
                         </a>
                       </p>
                       <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
                         Would you like to discuss your situation? <a href="mailto:hello@aura-assist.com">Contact our support team</a> — we may be able to help.
                       </p>
                       <p>The Aura Team</p>`,
            }).catch(err => console.warn('[dunning-escalation] Day 7 email failed:', err));
        }
    }
}

export const handler: Handler = async () => {
    try {
        await runDunningEscalation();
        return { statusCode: 200 };
    } catch (err) {
        console.error('[dunning-escalation]', err);
        return { statusCode: 500 };
    }
});
