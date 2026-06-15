/**
 * netlify/functions/referral.ts
 *
 * US-GAP-8.2: Workspace Referral Programme
 *
 * GET  /referral  → return caller's referral code + activity list
 * POST /referral  → generate / regenerate referral code (idempotent)
 */

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
import { users, userReferrals } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;
const BASE_URL  = process.env.DEPLOY_URL || process.env.URL || 'https://aura-digital-assistant.netlify.app';
const REWARD_GBP = 10;

function getAuth(event: any): number | null {
    if (!jwtSecret) return null;
    const match = (event.headers.cookie || '').match(/aura_session=([^;]+)/);
    if (!match) return null;
    try { return (jwt.verify(match[1], jwtSecret) as { userId: number }).userId; } catch { return null; }
}

/** Generate an 8-character alphanumeric code */
function generateCode(): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
}

export const handler: Handler = async (event) => {
    const callerId = getAuth(event);
    if (!callerId) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    const db = getDb();

    // ── GET: fetch code + activity ─────────────────────────────────
    if (event.httpMethod === 'GET') {
        const [user] = await db.select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            referralCode: users.referralCode,
        }).from(users).where(eq(users.id, callerId)).limit(1);

        if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

        // Fetch referrals made by this user
        const referrals = await db
            .select({
                id: userReferrals.id,
                status: userReferrals.status,
                createdAt: userReferrals.createdAt,
                qualifiedAt: userReferrals.qualifiedAt,
                rewardedAt: userReferrals.rewardedAt,
                referredFirstName: users.firstName,
                referredLastName: users.lastName,
                referredEmail: users.email,
            })
            .from(userReferrals)
            .leftJoin(users, eq(userReferrals.referredUserId, users.id))
            .where(eq(userReferrals.referrerId, callerId))
            .orderBy(desc(userReferrals.createdAt));

        const totalRewarded = referrals.filter(r => r.status === 'rewarded').length;
        const shareLink = user.referralCode
            ? `${BASE_URL}/register.html?ref=${user.referralCode}`
            : null;

        return {
            statusCode: 200,
            body: JSON.stringify({
                referralCode: user.referralCode,
                shareLink,
                rewardGbp: REWARD_GBP,
                totalRewarded,
                totalPending: referrals.filter(r => r.status === 'pending').length,
                totalQualified: referrals.filter(r => r.status === 'qualified').length,
                referrals: referrals.map(r => ({
                    id: r.id,
                    status: r.status,
                    createdAt: r.createdAt,
                    qualifiedAt: r.qualifiedAt,
                    rewardedAt: r.rewardedAt,
                    name: [r.referredFirstName, r.referredLastName].filter(Boolean).join(' ') || 'Invited user',
                    email: r.referredEmail,
                })),
            }),
        };
    }

    // ── POST: generate / return existing code ──────────────────────
    if (event.httpMethod === 'POST') {
        const [user] = await db.select({ referralCode: users.referralCode })
            .from(users).where(eq(users.id, callerId)).limit(1);

        if (!user) return { statusCode: 404, body: JSON.stringify({ error: 'User not found.' }) };

        let code = user.referralCode;
        if (!code) {
            // Generate a unique code (retry on collision, max 5 attempts)
            for (let attempt = 0; attempt < 5; attempt++) {
                const candidate = generateCode();
                const [existing] = await db.select({ id: users.id })
                    .from(users).where(eq(users.referralCode, candidate)).limit(1);
                if (!existing) {
                    await db.update(users).set({ referralCode: candidate }).where(eq(users.id, callerId));
                    code = candidate;
                    break;
                }
            }
            if (!code) return { statusCode: 500, body: JSON.stringify({ error: 'Could not generate a unique code. Please try again.' }) };
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                referralCode: code,
                shareLink: `${BASE_URL}/register.html?ref=${code}`,
                rewardGbp: REWARD_GBP,
            }),
        };
    }

    return { statusCode: 405, body: 'Method Not Allowed' };
};
