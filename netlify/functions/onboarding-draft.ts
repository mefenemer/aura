import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { onboardingDrafts } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

export const handler = async (event: HandlerEvent) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // Authenticate Session
    const rawCookieHeader = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookieHeader.split(';').map(c => {
            const [key, ...v] = c.trim().split('=');
            return [key, decodeURIComponent(v.join('='))];
        }).filter(([key]) => key !== '')
    );

    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let userId: number;
    try {
        const decoded = jwt.verify(sessionToken, jwtSecret) as { userId: number };
        userId = decoded.userId;
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    try {
        // GET: Fetch existing draft for hydration
        if (event.httpMethod === 'GET') {
            const [draft] = await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.userId, userId));
            return { statusCode: 200, body: JSON.stringify({ draft: draft || null }) };
        }

        // PUT: Upsert draft data (Auto-save)
        if (event.httpMethod === 'PUT' || event.httpMethod === 'PATCH') {
            const body = JSON.parse(event.body || '{}');
            const { currentStep, onboardingPath, draftData } = body;

            const [existing] = await db.select().from(onboardingDrafts).where(eq(onboardingDrafts.userId, userId));

            if (existing) {
                await db.update(onboardingDrafts).set({
                    currentStep,
                    onboardingPath,
                    draftData,
                    updatedAt: new Date()
                }).where(eq(onboardingDrafts.userId, userId));
            } else {
                await db.insert(onboardingDrafts).values({
                    userId,
                    currentStep,
                    onboardingPath,
                    draftData
                });
            }

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };
    } catch (error) {
        console.error('Onboarding Draft API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};