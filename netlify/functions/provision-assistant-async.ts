import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb, withUpdatedAt } from '../../db/client';
import { aiAssistants, auditLogs, dpaAcceptances, masterAssistants, notifications, organisations, plans, riskAssessments, users, supportTickets } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';
import { requireTosAcceptance, checkProhibitedUsePatterns } from '../../src/utils/tos-gate';
import { CURRENT_DPA_VERSION } from './accept-dpa';
import Stripe from 'stripe';

const stripe = process.env.STRIPE_SECRET_KEY
    ? new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2026-05-27.dahlia' })
    : null;

const EU_COUNTRY_CODES = new Set([
    'AT','BE','BG','CY','CZ','DE','DK','EE','ES','FI','FR','GR','HR','HU',
    'IE','IT','LT','LU','LV','MT','NL','PL','PT','RO','SE','SI','SK',
]);

async function isEuOrg(stripeCustomerId: string | null | undefined): Promise<boolean> {
    if (!stripe || !stripeCustomerId) return false;
    try {
        const customer = await stripe.customers.retrieve(stripeCustomerId) as Stripe.Customer;
        const country = customer.address?.country;
        return country ? EU_COUNTRY_CODES.has(country.toUpperCase()) : false;
    } catch {
        return false;
    }
}

export const handler: Handler = async (event) => {
    const { assistantId } = JSON.parse(event.body!);
    const db = getDb();

    // US-ADM-3.2.1: Global AI kill switch check
    if (await isGlobalAiDisabled()) {
        return { statusCode: 503, body: JSON.stringify({ error: 'AI services are temporarily unavailable. Please try again later.' }) };
    }

    try {
        // Perform complex API integrations (Meta/LinkedIn) here
        // ... (API calls) ...

        // US-GOV-3.1.1 / US-GDPR-1.1.1: Pre-activation checks
        const [preCheck] = await db
            .select({ disclosureText: aiAssistants.disclosureText, organisationId: aiAssistants.organisationId, masterAssistantId: aiAssistants.masterAssistantId, userId: aiAssistants.userId })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);

        if (!preCheck?.disclosureText?.trim()) {
            console.warn(`[provision-assistant-async] Blocked activation for assistant ${assistantId}: disclosureText missing (EU AI Act Art. 52)`);
            return { statusCode: 422, body: JSON.stringify({ error: 'AI disclosure text is required before this assistant can be activated (EU AI Act Art. 52).' }) };
        }

        // US-GOV-1.2.1 AC5: Block all write/activation operations until user has accepted current ToS
        if (preCheck?.userId) {
            const tosBlock = await requireTosAcceptance(preCheck.userId);
            if (tosBlock) {
                console.warn(`[provision-assistant-async] Blocked activation for assistant ${assistantId}: ToS not accepted (userId=${preCheck.userId})`);
                return tosBlock;
            }
        }

        // US-GOV-1.2.1 AC4: Detect prohibited-use patterns in system prompt; require ack flag + log it
        const [assistantFull] = await db
            .select({ systemPrompt: aiAssistants.systemPrompt, prohibitedUseAcknowledged: aiAssistants.prohibitedUseAcknowledged })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);

        if (assistantFull?.systemPrompt) {
            const puCheck = checkProhibitedUsePatterns(assistantFull.systemPrompt);
            if (puCheck.detected) {
                // If the deployer has not acknowledged prohibited-use categories, block activation
                if (!assistantFull.prohibitedUseAcknowledged) {
                    console.warn(`[provision-assistant-async] Blocked activation for assistant ${assistantId}: prohibited-use patterns detected (${puCheck.categories.join(', ')}) without acknowledgment`);
                    return {
                        statusCode: 422,
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            error: 'The assistant\'s system prompt contains content that falls under prohibited-use categories. Please review the Terms of Service (clauses 10.3 and 11.4) and acknowledge compliance before activating.',
                            code: 'PROHIBITED_USE_ACK_REQUIRED',
                            categories: puCheck.categories,
                        }),
                    };
                }

                // Log the acknowledgment in audit_logs
                if (preCheck?.userId) {
                    const { CURRENT_TOS_VERSION } = await import('./accept-tos');
                    await db.insert(auditLogs).values({
                        userId: preCheck.userId,
                        actionType: 'PROHIBITED_USE_ACK',
                        resourceType: 'ai_assistants',
                        resourceId: String(assistantId),
                        newState: {
                            categories: puCheck.categories,
                            tosVersion: CURRENT_TOS_VERSION,
                            acknowledgedAt: new Date().toISOString(),
                        },
                    }).catch(() => {});
                }
            }
        }

        // US-GDPR-1.1.1: Block activation if organisation has not accepted the current DPA version
        if (preCheck?.organisationId) {
            const [dpa] = await db
                .select({ id: dpaAcceptances.id })
                .from(dpaAcceptances)
                .where(and(
                    eq(dpaAcceptances.organisationId, preCheck.organisationId),
                    eq(dpaAcceptances.version, CURRENT_DPA_VERSION),
                ))
                .limit(1);

            if (!dpa) {
                console.warn(`[provision-assistant-async] Blocked activation for assistant ${assistantId}: DPA not accepted for org ${preCheck.organisationId}`);
                return { statusCode: 403, body: JSON.stringify({ error: 'Your organisation must accept the Data Processing Agreement before activating an assistant.', code: 'DPA_REQUIRED' }) };
            }
        }

        // US-GOV-1.1.1: Block EU-market activation of high_risk assistants without an approved risk assessment
        if (preCheck?.organisationId && preCheck.masterAssistantId) {
            const [master] = await db
                .select({ riskClassification: masterAssistants.riskClassification })
                .from(masterAssistants)
                .where(eq(masterAssistants.id, preCheck.masterAssistantId))
                .limit(1);

            if (master?.riskClassification === 'high_risk') {
                // Determine EU jurisdiction via Stripe billing country
                const [plan] = await db
                    .select({ stripeCustomerId: plans.stripeCustomerId })
                    .from(plans)
                    .where(eq(plans.userId, preCheck.userId!))
                    .limit(1);

                const euJurisdiction = await isEuOrg(plan?.stripeCustomerId);

                if (euJurisdiction) {
                    // Check for an approved risk assessment for this assistant + org
                    const [assessment] = await db
                        .select({ id: riskAssessments.id })
                        .from(riskAssessments)
                        .where(and(
                            eq(riskAssessments.masterAssistantId, preCheck.masterAssistantId),
                            eq(riskAssessments.organisationId, preCheck.organisationId),
                            eq(riskAssessments.approvalStatus, 'approved'),
                        ))
                        .limit(1);

                    if (!assessment) {
                        console.warn(`[provision-assistant-async] Blocked EU activation for assistant ${assistantId}: high_risk classification requires approved conformity assessment`);
                        return { statusCode: 403, body: JSON.stringify({
                            error: 'This assistant is classified as High Risk under the EU AI Act. A completed conformity assessment must be approved before EU-market deployment.',
                            code: 'HIGH_RISK_EU_BLOCKED',
                        }) };
                    }
                }
            }
        }

        // Guard: only update if still 'pending' — prevents race condition where
        // two parallel invocations both try to complete the same assistant.
        const [updated] = await db.update(aiAssistants)
            .set(withUpdatedAt({ provisioningStatus: 'complete', isActive: true }))
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.provisioningStatus, 'pending')))
            .returning();

        // ── US2 Sc3: "Provisioning complete" in-app notification ─────────────
        if (updated?.userId) {
            try {
                await db.insert(notifications).values({
                    userId: updated.userId,
                    type: 'provisioning_complete',
                    title: 'Workspace Provisioned',
                    message: `Onboarding your digital assistant is complete. Your Be More Swan setup is complete — ${updated.name} is ready to work.`,
                });
            } catch (notifErr) {
                console.warn('[provision-assistant-async] Notification insert failed (non-blocking):', notifErr);
            }

            // US-GAP-6.2.1 SC1/SC2: Assistant ready confirmation email
            try {
                const [userRecord] = await db
                    .select({ email: users.email, firstName: users.firstName })
                    .from(users)
                    .where(eq(users.id, updated.userId))
                    .limit(1);

                if (userRecord) {
                    const baseUrl   = process.env.BASE_URL || '';
                    const dashUrl   = `${baseUrl}/workspace.html`;
                    const intUrl    = `${baseUrl}/workspace.html#integrations`;
                    const role      = (updated as any).assistantRole || (updated as any).role || 'AI Assistant';
                    const firstName = userRecord.firstName || 'there';

                    sendEmail({
                        to: userRecord.email,
                        subject: `${updated.name} is ready!`,
                        html: `<p>Hi ${firstName},</p>
                               <p>Great news — <strong>${updated.name}</strong> is fully set up and ready to work for you.</p>
                               <p><strong>Role:</strong> ${role}</p>
                               <p>Your assistant is already briefed on your business and ready to start generating content, scheduling posts, and handling the tasks you've assigned.</p>
                               <p style="margin-top:24px;">
                                 <a href="${dashUrl}" style="background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                                   Go to My Dashboard →
                                 </a>
                               </p>
                               <p style="margin-top:12px;font-size:0.875rem;">
                                 Want to get more from ${updated.name}? <a href="${intUrl}">Connect your tools</a> to enable automations.
                               </p>
                               <p>The Be More Swan Team</p>`,
                    }).catch(() => {});
                }
            } catch (emailErr) {
                console.warn('[provision-assistant-async] Ready email failed (non-blocking):', emailErr);
            }
        }

        return { statusCode: 200, body: 'Done' };
    } catch (e) {
        // US-GAP-6.2.1 SC4: Provisioning failure — send failure email + create support ticket
        const failedAssistant = await db
            .update(aiAssistants)
            .set(withUpdatedAt({ provisioningStatus: 'failed' }))
            .where(eq(aiAssistants.id, assistantId))
            .returning()
            .catch(() => []);

        const failed = failedAssistant[0];
        if (failed?.userId) {
            const [userRecord] = await db
                .select({ email: users.email, firstName: users.firstName })
                .from(users)
                .where(eq(users.id, failed.userId))
                .limit(1)
                .catch(() => []);

            if (userRecord) {
                const baseUrl = process.env.BASE_URL || '';
                // SC4a: failure email
                sendEmail({
                    to: userRecord.email,
                    subject: `There was an issue setting up your assistant`,
                    html: `<p>Hi ${userRecord.firstName || 'there'},</p>
                           <p>Unfortunately, we encountered an issue while setting up <strong>${failed.name || 'your assistant'}</strong>. Our team has been automatically notified and will investigate.</p>
                           <p>We'll be in touch shortly to resolve this. In the meantime, if you have any questions please reply to this email or visit <a href="${baseUrl}/billing.html">your billing page</a>.</p>
                           <p>We're sorry for the inconvenience.</p>
                           <p>The Be More Swan Team</p>`,
                }).catch(() => {});

                // SC4b: auto-create support ticket
                db.insert(supportTickets).values({
                    userId: failed.userId,
                    subject: `Provisioning failure — ${failed.name || 'assistant'} (ID: ${assistantId})`,
                    category: 'provisioning_failure',
                    description: `Automated report: assistant provisioning failed for assistant ID ${assistantId} (name: ${failed.name}). User: ${userRecord.email}. Error: ${(e as any)?.message || 'unknown'}`,
                    status: 'open',
                    priority: 'high',
                }).catch(() => {});
            }
        }

        return { statusCode: 500, body: 'Failed' };
    }
};