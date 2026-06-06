// netlify/functions/notifications.ts
import { HandlerEvent } from '@netlify/functions';
import { eq, and, desc } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import { getDb } from '../../db/client';
import { users, notifications } from '../../db/schema';

const jwtSecret = process.env.JWT_SECRET;

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
        // GET: Fetch all notifications for the user
        // -------------------------------------------------------------
        if (event.httpMethod === 'GET') {
            const userNotifications = await db.select()
                .from(notifications)
                .where(eq(notifications.userId, userId))
                .orderBy(desc(notifications.createdAt));

            return { statusCode: 200, body: JSON.stringify({ notifications: userNotifications }) };
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
                .set({ isRead: true, readAt: new Date() })
                .where(and(eq(notifications.id, notificationId), eq(notifications.userId, userId)));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        // -------------------------------------------------------------
        // PUT: Bulk action - Mark ALL as read
        // -------------------------------------------------------------
        if (event.httpMethod === 'PUT') {
            await db.update(notifications)
                .set({ isRead: true, readAt: new Date() })
                .where(and(eq(notifications.userId, userId), eq(notifications.isRead, false)));

            return { statusCode: 200, body: JSON.stringify({ success: true }) };
        }

        return { statusCode: 405, body: 'Method Not Allowed' };

    } catch (error) {
        console.error('Notifications API Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Internal Server Error' }) };
    }
};