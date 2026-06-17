// src/utils/audit.ts
import { getDb } from '../../db/client';
import { auditLogs } from '../../db/schema';
import { pseudonymiseIp } from './ip-pseudonymise';

interface AuditEvent {
    userId?: number;
    actionType: 'CREATE' | 'UPDATE' | 'DELETE';
    resourceType: string;
    resourceId: string | number;
    previousState?: any;
    newState?: any;
    ipAddress?: string;
    userAgent?: string;
}

export const logAuditEvent = (event: AuditEvent) => {
    // We do NOT 'await' this internally or return the promise.
    // This allows the Node.js event loop to process the insert asynchronously in the background,
    // ensuring the primary user request returns instantly without latency.

    const db = getDb();

    db.insert(auditLogs).values({
        userId: event.userId,
        actionType: event.actionType,
        resourceType: event.resourceType,
        resourceId: String(event.resourceId), // Cast to string for schema consistency
        previousState: event.previousState || null,
        newState: event.newState || null,
        ipAddress: pseudonymiseIp(event.ipAddress) ?? null,
        userAgent: event.userAgent || null,
    }).catch(error => {
        // Log to server console only; do not disrupt the user's flow
        console.error('[AUDIT LOG FAILURE] Failed to write to immutable ledger:', error);
    });
};