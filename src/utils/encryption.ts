import * as crypto from 'crypto';

// Use a 32-byte hex string stored in your Netlify Environment Variables
// e.g., crypto.randomBytes(32).toString('hex')
const ENCRYPTION_KEY = process.env.SYSTEM_ENCRYPTION_KEY;

// BUG-P0-2: AES-256-GCM requires a 12-byte (96-bit) IV per NIST SP 800-38D.
// The old value of 16 produces a non-standard GCM counter via GHASH and weakens
// the authentication guarantee. New encryptions use 12 bytes; decryption reads
// the actual IV length from stored data so existing 16-byte-IV rows are still readable.
const IV_LENGTH = 12;

// BUG-P0-2: Fail hard on missing key — a volatile random key silently makes every
// cold-start a different encryption context, corrupting all stored credentials.
if (!ENCRYPTION_KEY) {
    throw new Error('SYSTEM_ENCRYPTION_KEY must be set in production.');
}

const key = Buffer.from(ENCRYPTION_KEY, 'hex');

export function encryptCredential(text: string): string {
    if (!text) return text;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');

    // Store as IV:AuthTag:EncryptedText
    return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

export function decryptCredential(encryptedText: string): string {
    if (!encryptedText) return encryptedText;
    const parts = encryptedText.split(':');
    if (parts.length !== 3) throw new Error("Invalid encrypted text format");

    // IV length is read from the stored hex — handles both legacy 16-byte and new 12-byte IVs
    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}
