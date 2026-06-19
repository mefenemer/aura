// organisation-profile.ts
// GET  → returns the org's business profile (business name + assistant-facing context)
// POST → updates the business profile on the organisation
//
// Business name maps to organisations.name (also set at registration). Legal/tax/
// registered-address details are NOT here — they live in billingInformation
// (see billing-information.ts), surfaced on the same Business Information page.

import { Handler } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { organisations } from '../../db/schema';
import { requireTenant } from '../../src/utils/tenant';

const json = (statusCode: number, body: unknown) => ({
    statusCode, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

const clip = (v: unknown, max: number): string | null => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
};

export const handler: Handler = async (event) => {
    if (!['GET', 'POST'].includes(event.httpMethod || '')) return json(405, { error: 'Method Not Allowed' });

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;
    const orgId = ctx.organisationId;

    if (event.httpMethod === 'GET') {
        try {
            const [org] = await db.select({
                businessName:        organisations.name,
                industry:            organisations.industry,
                businessDescription: organisations.businessDescription,
                websiteUrl:          organisations.websiteUrl,
                socialLinks:         organisations.socialLinks,
                targetAudience:      organisations.targetAudience,
            }).from(organisations).where(eq(organisations.id, orgId)).limit(1);

            return json(200, { profile: org || null });
        } catch (err) {
            console.error('[organisation-profile GET]', err);
            return json(500, { error: 'Failed to load business profile.' });
        }
    }

    // POST
    try {
        let body: Record<string, unknown> = {};
        try { body = JSON.parse(event.body || '{}'); } catch { /* empty */ }

        const businessName = clip(body.businessName, 200);
        if (!businessName) return json(400, { error: 'Business name is required.' });

        const values = {
            name:                businessName,
            industry:            clip(body.industry, 120),
            businessDescription: clip(body.businessDescription, 2000),
            websiteUrl:          clip(body.websiteUrl, 500),
            socialLinks:         clip(body.socialLinks, 1000),
            targetAudience:      clip(body.targetAudience, 1000),
            updatedAt:           new Date(),
        };

        const [saved] = await db.update(organisations)
            .set(values).where(eq(organisations.id, orgId))
            .returning({
                businessName:        organisations.name,
                industry:            organisations.industry,
                businessDescription: organisations.businessDescription,
                websiteUrl:          organisations.websiteUrl,
                socialLinks:         organisations.socialLinks,
                targetAudience:      organisations.targetAudience,
            });

        return json(200, { success: true, profile: saved });
    } catch (err) {
        console.error('[organisation-profile POST]', err);
        return json(500, { error: 'Failed to save business profile.' });
    }
};
