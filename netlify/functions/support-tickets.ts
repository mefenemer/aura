// netlify/functions/support-tickets.ts
import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';
import { eq, desc } from 'drizzle-orm';
import { getDb } from '../../db/client';
// IMPORT FIXED: Added `notifications` to the import map
import { users, supportTickets, notifications } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';

const jwtSecret = process.env.JWT_SECRET;

export const handler = async (event: HandlerEvent) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // 1. Authenticate Session
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

    try {
        const db = getDb();

        // -------------------------------------------------------------
        // GET: Fetch Ticket History
        // -------------------------------------------------------------
        if (event.httpMethod === 'GET') {
            const userTickets = await db.select()
                .from(supportTickets)
                .where(eq(supportTickets.userId, userId))
                .orderBy(desc(supportTickets.createdAt));

            return { statusCode: 200, body: JSON.stringify(userTickets) };
        }

        // -------------------------------------------------------------
        // POST: Create New Ticket
        // -------------------------------------------------------------
        if (event.httpMethod === 'POST') {
            const [user] = await db.select().from(users).where(eq(users.id, userId));
            if (!user) return { statusCode: 403, body: JSON.stringify({ error: 'User not found.' }) };

            const body = JSON.parse(event.body || '{}');
            const { subject, category, description } = body;

            if (!subject || !category || !description) {
                return { statusCode: 400, body: JSON.stringify({ error: 'All fields are required.' }) };
            }

            const [newTicket] = await db.insert(supportTickets).values({
                userId: userId,
                organisationId: user.organisationId,
                subject: subject.trim(),
                category: category,
                description: description.trim(),
                status: 'open'
            }).returning();

            // NEW FIX: Insert the Notification Record to trigger the badge
            await db.insert(notifications).values({
                userId: userId,
                title: `Ticket #${newTicket.id} Created`,
                message: `Your support request "${newTicket.subject}" has been logged successfully.`,
                type: 'ticket_created',
                referenceId: String(newTicket.id),
                isRead: false
            });

            // Audit Log
            logAuditEvent({
                userId: userId,
                actionType: 'CREATE',
                resourceType: 'support_tickets',
                resourceId: newTicket.id,
                newState: { subject: newTicket.subject, category: newTicket.category }
            });

            return { statusCode: 200, body: JSON.stringify({ success: true, ticket: newTicket }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (error) {
        console.error('Support Tickets API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};