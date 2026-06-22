// netlify/functions/notifications.ts
import { HandlerEvent } from '@netlify/functions';
import { eq, and, desc } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, notifications } from '../../db/schema';
import { kindOf } from '../../src/utils/notification-actions';

const jwtSecret = process.env.JWT_SECRET;

// Notification "kind" classification (action vs info) lives in src/utils/notification-actions.ts
// as the single source of truth — imported here so the inbox/badge and the server-side
// auto-resolver agree on what counts as an "action". Unknown types default to 'info'.

export const handler = async (event: HandlerEvent) => {
    if (!jwtSecret) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // 1. Authenticate the User
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
        // -------------------------------------------------------------
        // GET: Fetch all notifications for the user OR get unread count
        // -------------------------------------------------------------
        if (event.httpMethod === 'GET') {
            const { queryStringParameters } = event;
            const allNotes = await db.select()
                .from(notifications)
                .where(eq(notifications.userId, userId))
                .orderBy(desc(notifications.createdAt));

            // Counts for the sidebar badge. actionCount = open (unread) action items —
            // the meaningful "things you must deal with" number the badge now reflects.
            if (queryStringParameters && queryStringParameters.action === 'count') {
                const unread = allNotes.filter(n => !n.isRead).length;
                const actionCount = allNotes.filter(n => !n.isRead && kindOf(n.type) === 'action').length;
                return { statusCode: 200, body: JSON.stringify({ unreadCount: unread, actionCount }) };
            }

            // Annotate each notification with its kind so the client can split the list
            // into Action required / Updates without duplicating the classification.
            const annotated = allNotes.map(n => ({ ...n, kind: kindOf(n.type) }));
            return { statusCode: 200, body: JSON.stringify({ notifications: annotated }) };
        }

        // -------------------------------------------------------------
        // PATCH: Mark a SINGLE notification as read
        // -------------------------------------------------------------
        if (event.httpMethod === 'PATCH') {
            const body = JSON.parse(event.body || '{}');
            const { notificationId } = body;

            if (!notificationId) return { statusCode: 400, body: JSON.stringify({ error: 'Missing notificationId' }) };

            // Ensure the user owns this notification before updating
            await db.update(notifications)
                .set({ isRead: true })
                // Note: removed readAt to strictly match your schema
                .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // -------------------------------------------------------------
        // PUT: Bulk action - Mark ALL as read
        // -------------------------------------------------------------
        if (event.httpMethod === 'PUT') {
            await db.update(notifications)
                .set({ isRead: true })
                .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (error) {
        console.error('Notifications API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};