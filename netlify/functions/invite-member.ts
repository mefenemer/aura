// invite-member.ts
// POST { email, role? } — invite a new member to the caller's organisation.
// Enforces the seatLimit from the organisation owner's master plan.
// Seat limit: null = 1 seat (solo plan); 0 = unlimited; N = max N members.
//
// Flow:
//   1. Auth — must be org owner or admin
//   2. Resolve seat limit from owner's active plan
//   3. Count current seats (userOrganisations rows for the org)
//   4. Block if at limit
//   5. Generate a time-limited invite token, store on the invited user record
//   6. Send invite email via Resend

import { Handler } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { eq, and, count } from 'drizzle-orm';
import { Resend } from 'resend';
import { getDb } from '../../db/client';
import {
    users,
    userOrganisations,
    plans,
    masterPlans,
    organisations,
} from '../../db/schema';

const jwtSecret    = process.env.JWT_SECRET;
const resend       = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL   = process.env.FROM_EMAIL  || 'hello@aura-assist.com';
const APP_URL      = process.env.URL          || 'https://aura-assist.com';

export const handler: Handler = async (event) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // 1. Auth
    const cookie = (event.headers.cookie || '').match(/aura_session=([^;]+)/)?.[1];
    if (!cookie) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    let callerId: number;
    try {
        callerId = (jwt.verify(cookie, jwtSecret) as { userId: number }).userId;
    } catch {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const db = getDb();

    // 2. Resolve caller's org and role
    const [caller] = await db
        .select({ organisationId: users.organisationId, email: users.email, firstName: users.firstName })
        .from(users)
        .where(eq(users.id, callerId))
        .limit(1);

    if (!caller?.organisationId) {
        return { statusCode: 403, body: JSON.stringify({ error: 'You must be part of an organisation to invite members.' }) };
    }

    const [callerMembership] = await db
        .select({ role: userOrganisations.role })
        .from(userOrganisations)
        .where(and(
            eq(userOrganisations.userId, callerId),
            eq(userOrganisations.organisationId, caller.organisationId),
        ))
        .limit(1);

    const callerRole = callerMembership?.role || 'member';
    if (!['owner', 'admin'].includes(callerRole)) {
        return { statusCode: 403, body: JSON.stringify({ error: 'Only workspace owners and admins can invite members.' }) };
    }

    // 3. Resolve seat limit from the org owner's active plan
    const [orgOwner] = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userOrganisations, and(
            eq(userOrganisations.userId, users.id),
            eq(userOrganisations.organisationId, caller.organisationId),
            eq(userOrganisations.role, 'owner'),
        ))
        .limit(1);

    let seatLimit: number | null = 1; // default: solo plan = 1 seat = no inviting
    if (orgOwner) {
        const [ownerPlan] = await db
            .select({ seatLimit: masterPlans.seatLimit })
            .from(plans)
            .leftJoin(masterPlans, eq(plans.masterPlanId, masterPlans.id))
            .where(and(eq(plans.userId, orgOwner.id), eq(plans.status, 'active')))
            .limit(1);
        seatLimit = ownerPlan?.seatLimit ?? 1;
    }

    // 4. Count current seats
    const [{ value: currentSeats }] = await db
        .select({ value: count() })
        .from(userOrganisations)
        .where(eq(userOrganisations.organisationId, caller.organisationId));

    // seatLimit null = 1 (solo); 0 = unlimited
    const effectiveLimit = seatLimit === null ? 1 : seatLimit;
    if (effectiveLimit !== 0 && currentSeats >= effectiveLimit) {
        return {
            statusCode: 403,
            body: JSON.stringify({
                error: `Your plan allows up to ${effectiveLimit} workspace seat${effectiveLimit === 1 ? '' : 's'}. Upgrade to add more members.`,
                code: 'SEAT_LIMIT_REACHED',
                currentSeats,
                seatLimit: effectiveLimit,
            }),
        };
    }

    // 5. Parse body
    let body: { email?: string; role?: string };
    try { body = JSON.parse(event.body || '{}'); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON.' }) };
    }
    const { email, role = 'member' } = body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'A valid email address is required.' }) };
    }
    if (!['member', 'admin'].includes(role)) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Role must be "member" or "admin".' }) };
    }
    if (email.toLowerCase() === caller.email?.toLowerCase()) {
        return { statusCode: 400, body: JSON.stringify({ error: 'You cannot invite yourself.' }) };
    }

    // 6. Check if they're already a member
    const [existingMember] = await db
        .select({ id: users.id })
        .from(users)
        .innerJoin(userOrganisations, and(
            eq(userOrganisations.userId, users.id),
            eq(userOrganisations.organisationId, caller.organisationId),
        ))
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

    if (existingMember) {
        return { statusCode: 409, body: JSON.stringify({ error: 'This person is already a member of your workspace.' }) };
    }

    // 7. Generate 48-hour invite token
    const plainToken  = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(plainToken).digest('hex');
    const expiresAt   = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Upsert user record (may already exist from a different org or waitlist)
    const [existingUser] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email.toLowerCase()))
        .limit(1);

    let invitedUserId: number;
    if (existingUser) {
        await db.update(users)
            .set({ verificationToken: hashedToken, tokenExpiresAt: expiresAt })
            .where(eq(users.id, existingUser.id));
        invitedUserId = existingUser.id;
    } else {
        const [newUser] = await db.insert(users).values({
            email: email.toLowerCase(),
            status: 'pending_verification',
            verificationToken: hashedToken,
            tokenExpiresAt: expiresAt,
        }).returning({ id: users.id });
        invitedUserId = newUser.id;
    }

    // Store pending membership (role = invited until they accept)
    await db.insert(userOrganisations).values({
        userId: invitedUserId,
        organisationId: caller.organisationId,
        role: 'invited',
    }).onConflictDoNothing();

    // 8. Fetch org name for the email
    const [org] = await db
        .select({ name: organisations.name })
        .from(organisations)
        .where(eq(organisations.id, caller.organisationId))
        .limit(1);
    const orgName = org?.name || 'the workspace';
    const inviterName = caller.firstName || caller.email?.split('@')[0] || 'A team member';
    const acceptUrl = `${APP_URL}/accept-invite.html?token=${plainToken}&org=${caller.organisationId}`;

    // 9. Send invite email
    if (process.env.RESEND_API_KEY) {
        await resend.emails.send({
            from: FROM_EMAIL,
            to: email,
            subject: `${inviterName} invited you to join ${orgName} on Aura-Assist`,
            html: `
<div style="font-family:-apple-system,sans-serif;max-width:600px;margin:40px auto;background:#fff;border-radius:12px;border:1px solid #e5e7eb;overflow:hidden">
  <div style="background:#111827;padding:20px 28px">
    <span style="color:#10b981;font-size:20px;font-weight:800">Aura</span>
    <span style="color:#fff;font-size:20px;font-weight:800">-Assist</span>
  </div>
  <div style="padding:32px">
    <h2 style="margin:0 0 12px;color:#111827;font-size:22px">You're invited! 🎉</h2>
    <p style="color:#374151;margin:0 0 20px;line-height:1.6"><strong>${inviterName}</strong> has invited you to join <strong>${orgName}</strong> on Aura-Assist as a ${role}.</p>
    <a href="${acceptUrl}" style="display:inline-block;padding:14px 28px;background:#10b981;color:#fff;font-weight:700;text-decoration:none;border-radius:8px;font-size:15px">Accept Invitation</a>
    <p style="color:#6b7280;font-size:13px;margin-top:20px">This invitation expires in 48 hours. If you didn't expect this email, you can safely ignore it.</p>
  </div>
</div>`,
        }).catch(err => console.warn('[invite-member] Email send failed (non-fatal):', err.message));
    }

    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, message: `Invitation sent to ${email}.` }),
    };
};
