import { Handler } from '@netlify/functions';
import { and, eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, dpaAcceptances, notifications, users, supportTickets } from '../../db/schema';
import { sendEmail } from '../../src/utils/email';
import { isGlobalAiDisabled } from '../../src/utils/platform-config';

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
            .select({ disclosureText: aiAssistants.disclosureText, organisationId: aiAssistants.organisationId })
            .from(aiAssistants)
            .where(eq(aiAssistants.id, assistantId))
            .limit(1);

        if (!preCheck?.disclosureText?.trim()) {
            console.warn(`[provision-assistant-async] Blocked activation for assistant ${assistantId}: disclosureText missing (EU AI Act Art. 52)`);
            return { statusCode: 422, body: JSON.stringify({ error: 'AI disclosure text is required before this assistant can be activated (EU AI Act Art. 52).' }) };
        }

        // US-GDPR-1.1.1: Block activation if organisation has not accepted the DPA
        if (preCheck?.organisationId) {
            const [dpa] = await db
                .select({ id: dpaAcceptances.id })
                .from(dpaAcceptances)
                .where(eq(dpaAcceptances.organisationId, preCheck.organisationId))
                .limit(1);

            if (!dpa) {
                console.warn(`[provision-assistant-async] Blocked activation for assistant ${assistantId}: DPA not accepted for org ${preCheck.organisationId}`);
                return { statusCode: 403, body: JSON.stringify({ error: 'Your organisation must accept the Data Processing Agreement before activating an assistant.', code: 'DPA_REQUIRED' }) };
            }
        }

        // Guard: only update if still 'pending' — prevents race condition where
        // two parallel invocations both try to complete the same assistant.
        const [updated] = await db.update(aiAssistants)
            .set({ provisioningStatus: 'complete', isActive: true })
            .where(and(eq(aiAssistants.id, assistantId), eq(aiAssistants.provisioningStatus, 'pending')))
            .returning();

        // ── US2 Sc3: "Provisioning complete" in-app notification ─────────────
        if (updated?.userId) {
            try {
                await db.insert(notifications).values({
                    userId: updated.userId,
                    type: 'provisioning_complete',
                    title: 'Workspace Provisioned',
                    message: `Onboarding your digital assistant is complete. Your Aura Assist setup is complete — ${updated.name} is ready to work.`,
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
                               <p>The Aura Team</p>`,
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
            .set({ provisioningStatus: 'failed' })
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
                           <p>The Aura Team</p>`,
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