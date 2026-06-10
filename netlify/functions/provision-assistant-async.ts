import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { aiAssistants, notifications } from '../../db/schema';

export const handler: Handler = async (event) => {
    const { assistantId } = JSON.parse(event.body!);
    const db = getDb();

    try {
        // Perform complex API integrations (Meta/LinkedIn) here
        // ... (API calls) ...

        const [updated] = await db.update(aiAssistants)
            .set({ provisioningStatus: 'complete', isActive: true })
            .where(eq(aiAssistants.id, assistantId))
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
        }

        return { statusCode: 200, body: 'Done' };
    } catch (e) {
        await db.update(aiAssistants).set({ provisioningStatus: 'failed' }).where(eq(aiAssistants.id, assistantId));
        return { statusCode: 500, body: 'Failed' };
    }
};