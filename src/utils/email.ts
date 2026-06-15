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

// sendEmail is an alias for sendMagicLinkEmail used by most Netlify functions
export const sendEmail = async ({ to, subject, html }: SendEmailParams) => {
    if (!resendApiKey) {
        console.warn(`[DEV MODE] RESEND_API_KEY missing. Simulated email to ${to}`);
        return null;
    }

    try {
        const data = await resend.emails.send({
            from: 'Aura Assist <noreply@aura-assist.com>',
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

export function buildAnnualRenewalEmail(firstName: string, renewalDay: string, amount: string): string {
    return `
        <p>Hi ${firstName},</p>
        <p>Your Aura-Assist annual subscription will automatically renew on <strong>${renewalDay}</strong>${amount ? ` for <strong>${amount}</strong>` : ''}.</p>
        <p>If you wish to cancel before this date, you can do so at any time from your <a href="https://aura-assist.com/billing.html">account settings</a>. Cancellations take effect at the end of your current billing period.</p>
        <p>If you have any questions, reply to this email or contact our support team.</p>
        <p>Thank you for being an Aura-Assist customer.</p>
        <p>— The Aura-Assist Team</p>
    `;
}

export function buildDunningEmail(firstName: string, amount: string, nextRetryLine: string, assistantWarning: string, portalUrl: string): string {
    return `<p>Hi ${firstName},</p>
            <p>We were unable to process your subscription payment.</p>
            <p>💰 <strong>Amount:</strong> ${amount}</p>
            ${nextRetryLine}
            ${assistantWarning}
            <p style="margin-top:24px;">
              <a href="${portalUrl}" style="background:#dc2626;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">
                Update Payment Details →
              </a>
            </p>
            <p style="margin-top:16px;font-size:0.875rem;color:#6b7280;">
              Questions? <a href="mailto:hello@aura-assist.com">Contact our support team</a>.
            </p>
            <p>The Aura Team</p>`;
}

export const sendMagicLinkEmail = async ({ to, subject, html }: SendEmailParams) => {
    if (!resendApiKey) {
        console.warn(`[DEV MODE] RESEND_API_KEY missing. Simulated email to ${to}`);
        return null;
    }

    try {
        const data = await resend.emails.send({
            // IMPORTANT: You must verify this domain in your Resend dashboard
            from: 'Aura Assist <noreply@aura-assist.com>',
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