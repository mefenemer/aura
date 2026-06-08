import * as crypto from 'crypto';

// Use a 32-byte hex string stored in your Netlify Environment Variables
// e.g., crypto.randomBytes(32).toString('hex')
const ENCRYPTION_KEY = process.env.SYSTEM_ENCRYPTION_KEY;
const IV_LENGTH = 16; // For AES, this is always 16

if (!ENCRYPTION_KEY) {
    console.warn("WARNING: SYSTEM_ENCRYPTION_KEY is not set. Using a volatile fallback for development.");
}

const key = ENCRYPTION_KEY ? Buffer.from(ENCRYPTION_KEY, 'hex') : crypto.randomBytes(32);

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

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, undefined, 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}