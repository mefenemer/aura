// netlify/functions/get-ai-credit-balance.ts
// Epic 2, US4: returns the org's AI generation credit balance (applies the monthly grant first).
// GET → { balance, held, imageCost, videoCost }

import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client';
import { requireTenant } from '../../src/utils/tenant';
import { getBalance, IMAGE_CREDIT_COST, VIDEO_CREDIT_COST } from '../../src/utils/ai-credits';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'GET') return { statusCode: 405, body: 'Method Not Allowed' };

    const db = getDb();
    const ctx = await requireTenant(event, db);
    if ('error' in ctx) return ctx.error;

    const { balance, held } = await getBalance(db, ctx.organisationId);
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ balance, held, imageCost: IMAGE_CREDIT_COST, videoCost: VIDEO_CREDIT_COST }),
    };
};
