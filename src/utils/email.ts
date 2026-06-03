// src/utils/email.ts
import { Resend } from 'resend';

const resendApiKey = process.env.RESEND_API_KEY;

// Initialize the Resend client
// Note: If the key is missing (e.g., in local dev without an env var),
// we handle it gracefully below rather than crashing the whole app.
const resend = new Resend(resendApiKey);

interface SendEmailParams {
    to: string;
    subject: string;
    html: string;
}

export const sendMagicLinkEmail = async ({ to, subject, html }: SendEmailParams) => {
    if (!resendApiKey) {
        console.warn(`[DEV MODE] RESEND_API_KEY missing. Simulated email to ${to}`);
        return null;
    }

    try {
        const data = await resend.emails.send({
            // IMPORTANT: You must verify this domain in your Resend dashboard
            from: 'Aura Assist <noreply@yourdomain.com>',
            to,
            subject,
            html,
        });

        return data;
    } catch (error) {
        console.error('Resend API Error:', error);
        throw new Error('Failed to send email.');
    }
};