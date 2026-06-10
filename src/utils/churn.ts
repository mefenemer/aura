// src/utils/churn.ts
// US-AUD-3.1.1: Churn signal helpers for inline detection (Signals 2 & 5).
// Called from task-run and support-ticket creation flows.

import { eq, and, gte, count, isNull } from 'drizzle-orm';
import { taskRuns, userChurnSignals, userNotifications, supportTickets, users } from '../../db/schema';
import { sendEmail } from './email';

const BASE_URL = process.env.BASE_URL || '';

// ─────────────────────────────────────────────────────────────────────────────
// SC7: Deduplication helper
// ─────────────────────────────────────────────────────────────────────────────
export async function isRecentlySignalled(db: any, userId: number, signalType: string): Promise<boolean> {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const [existing] = await db
        .select({ id: userChurnSignals.id })
        .from(userChurnSignals)
        .where(
            and(
                eq(userChurnSignals.userId, userId),
                eq(userChurnSignals.signalType, signalType),
                gte(userChurnSignals.detectedAt, sevenDaysAgo)
            )
        )
        .limit(1);
    return !!existing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 2: Same task retried 3+ times in 24h without 'approved' (SC3)
// Call from task-run creation/completion handler.
// ─────────────────────────────────────────────────────────────────────────────
export async function checkRepeatedTaskFailure(
    db: any,
    userId: number,
    assistantId: number,
    taskCategory: string
): Promise<void> {
    try {
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

        // Count non-approved runs for this user+assistant+category in last 24h
        const [result] = await db
            .select({ cnt: count() })
            .from(taskRuns)
            .where(
                and(
                    eq(taskRuns.userId, userId),
                    eq(taskRuns.assistantId, assistantId),
                    gte(taskRuns.createdAt, oneDayAgo)
                )
            );

        const runCount = Number(result?.cnt ?? 0);
        if (runCount < 3) return;

        // SC7: dedup
        if (await isRecentlySignalled(db, userId, 'repeated_task_failure')) return;

        await db.insert(userChurnSignals).values({
            userId,
            signalType: 'repeated_task_failure',
            metadata: { assistantId, taskCategory, runCount, detectedAt: new Date().toISOString() },
        });

        // In-app contextual prompt
        await db.insert(userNotifications).values({
            userId,
            title: 'Having trouble with this task?',
            message: 'Having trouble with this task? Here are 3 tips to get better outputs [link to help article]',
            type: 'churn_signal',
            referenceId: String(assistantId),
        });

        // Mark intervention sent
        await db
            .update(userChurnSignals)
            .set({ interventionSentAt: new Date() })
            .where(
                and(
                    eq(userChurnSignals.userId, userId),
                    eq(userChurnSignals.signalType, 'repeated_task_failure'),
                    isNull(userChurnSignals.interventionSentAt)
                )
            );
    } catch { /* non-critical — never throw from churn helpers */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal 5: Support ticket raised by user with account age <= 30 days (SC6)
// Call from support-ticket creation handler after the ticket row is inserted.
// ─────────────────────────────────────────────────────────────────────────────
export async function checkEarlySupportTicket(
    db: any,
    userId: number,
    ticketId: number
): Promise<void> {
    try {
        const [user] = await db
            .select({ createdAt: users.createdAt, email: users.email, firstName: users.firstName })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);
        if (!user) return;

        const accountAgeDays = (Date.now() - new Date(user.createdAt).getTime()) / (1000 * 60 * 60 * 24);
        if (accountAgeDays > 30) return;

        if (await isRecentlySignalled(db, userId, 'early_support_ticket')) return;

        await db.insert(userChurnSignals).values({
            userId,
            signalType: 'early_support_ticket',
            metadata: { ticketId, accountAgeDays: Math.round(accountAgeDays), detectedAt: new Date().toISOString() },
            interventionSentAt: new Date(),
        });

        // SC6b: Set ticket priority to 'urgent' and flag with metadata
        await db
            .update(supportTickets)
            .set({
                priority: 'urgent',
                updatedAt: new Date(),
            })
            .where(eq(supportTickets.id, ticketId));

    } catch { /* non-critical */ }
}
