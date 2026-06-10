// src/utils/vault.ts
// US-AUD-4.2.1: AES-256-GCM secrets vault backed by PostgreSQL.
// Plaintext credentials NEVER appear in DB columns, logs, or error messages (SC2).
//
// Env required:
//   VAULT_KEY  — 64 hex chars (32 bytes) e.g. openssl rand -hex 32

import crypto from 'crypto';
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { vaultSecrets } from '../../db/schema';

const ALGORITHM = 'aes-256-gcm';

function getVaultKey(): Buffer {
    const hex = process.env.VAULT_KEY;
    if (!hex || hex.length !== 64) {
        throw new Error('VAULT_KEY env var is missing or not 64 hex chars.');
    }
    return Buffer.from(hex, 'hex');
}

/** Encrypt a plain-text payload. Returns { encryptedPayload, iv, authTag } all base64. */
function encrypt(plaintext: string): { encryptedPayload: string; iv: string; authTag: string } {
    const key = getVaultKey();
    const iv = crypto.randomBytes(12); // 96-bit nonce for GCM
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
        encryptedPayload: encrypted.toString('base64'),
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
    };
}

/** Decrypt a vault row back to plain-text. */
function decrypt(encryptedPayload: string, iv: string, authTag: string): string {
    const key = getVaultKey();
    const decipher = crypto.createDecipheriv(
        ALGORITHM,
        key,
        Buffer.from(iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(authTag, 'base64'));
    const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedPayload, 'base64')),
        decipher.final(),
    ]);
    return decrypted.toString('utf8');
}

/** Build a canonical vault reference key for a connection. */
export function buildRefKey(userId: number, serviceName: string, connectionType: string): string {
    // e.g. 'aura/user-42/google-oauth'
    const safeService = serviceName.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    const safeType = connectionType.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    return `aura/user-${userId}/${safeService}-${safeType}`;
}

/**
 * Store (or overwrite) a secret in the vault.
 * @param db     Drizzle DB instance
 * @param refKey Logical vault path (from buildRefKey)
 * @param payload Any JSON-serialisable credential object
 */
export async function storeSecret(
    db: NodePgDatabase<any>,
    refKey: string,
    payload: Record<string, unknown>
): Promise<void> {
    const plaintext = JSON.stringify(payload);
    const { encryptedPayload, iv, authTag } = encrypt(plaintext);

    await db
        .insert(vaultSecrets)
        .values({ refKey, encryptedPayload, iv, authTag })
        .onConflictDoUpdate({
            target: vaultSecrets.refKey,
            set: { encryptedPayload, iv, authTag, updatedAt: new Date() },
        });
}

/**
 * Retrieve and decrypt a secret from the vault.
 * Returns the parsed payload, or null if not found.
 */
export async function getSecret(
    db: NodePgDatabase<any>,
    refKey: string
): Promise<Record<string, unknown> | null> {
    const [row] = await db
        .select()
        .from(vaultSecrets)
        .where(eq(vaultSecrets.refKey, refKey))
        .limit(1);
    if (!row) return null;
    const plaintext = decrypt(row.encryptedPayload, row.iv, row.authTag);
    return JSON.parse(plaintext);
}

/**
 * Delete a single secret from the vault (SC5: per-connection revocation).
 */
export async function deleteSecret(
    db: NodePgDatabase<any>,
    refKey: string
): Promise<void> {
    await db.delete(vaultSecrets).where(eq(vaultSecrets.refKey, refKey));
}

/**
 * Delete all vault secrets whose refKey starts with the given prefix (SC4: org revocation).
 * Uses SQL LIKE: prefix must be safe (no SQL wildcards injected).
 */
export async function deleteSecretsByPrefix(
    db: NodePgDatabase<any>,
    prefix: string
): Promise<number> {
    const { sql, like } = await import('drizzle-orm');
    const result = await db
        .delete(vaultSecrets)
        .where(like(vaultSecrets.refKey, `${prefix}%`))
        .returning({ id: vaultSecrets.id });
    return result.length;
}

/**
 * Log an integration API call. Caller must strip query params from endpoint (SC6).
 */
export async function logApiCall(
    db: NodePgDatabase<any>,
    opts: { userId: number; integrationId?: number | null; endpoint: string; httpStatus?: number | null }
): Promise<void> {
    const { integrationApiCalls } = await import('../../db/schema');
    await db.insert(integrationApiCalls).values({
        userId: opts.userId,
        integrationId: opts.integrationId ?? null,
        endpoint: opts.endpoint,
        httpStatus: opts.httpStatus ?? null,
    });
}
