import { config } from 'dotenv';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';

config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
import { users, masterPlans } from '../../db/schema';

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error('CRITICAL: NETLIFY_DATABASE_URL is missing.');
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error('CRITICAL: JWT_SECRET is missing.');
const stripeSecret = process.env.STRIPE_SECRET_KEY;
if (!stripeSecret) throw new Error('CRITICAL: STRIPE_SECRET_KEY is missing.');

const pgClient = postgres(connectionString);
const db = drizzle({ client: pgClient });
const stripe = new Stripe(stripeSecret, { apiVersion: '2026-05-27.dahlia' });

// Stripe price IDs keyed by tier — test and live environments
const isTestMode = stripeSecret.startsWith('sk_test_');
const STRIPE_PRICE_IDS: Record<string, string> = isTestMode
  ? {
      buster:   'price_1TgGNFE7lvVYjk1BAsnhUzBp',
      saver:    'price_1TgGP8E7lvVYjk1BRBeEZVd6',
      employee: 'price_1TgGPfE7lvVYjk1B1CQrS6pE',
    }
  : {
      buster:   'price_1Tg6f1CuS8qyNSsFxeUsfi4a',
      saver:    'price_1Tg6fQCuS8qyNSsF5DKmEqMu',
      employee: 'price_1Tg6fiCuS8qyNSsF787zwCwh',
    };

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    // 1. AUTH
    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;
    if (!token) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };

    let currentUserId: number;
    try {
      const decoded = jwt.verify(token, jwtSecret) as { userId: number; email: string };
      currentUserId = decoded.userId;
    } catch {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid session.' }) };
    }

    const [user] = await db.select().from(users).where(eq(users.id, currentUserId)).limit(1);
    if (!user || user.status !== 'active' || !user.organisationId) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Account not active.' }) };
    }

    const { tier, billingCycle: rawCycle } = JSON.parse(event.body || '{}');
    if (!tier) return { statusCode: 400, body: JSON.stringify({ error: 'Missing tier.' }) };

    const billingCycle: 'monthly' | 'annual' = rawCycle === 'annual' ? 'annual' : 'monthly';

    // Annual discount: 20% off (12 months × monthly price × 0.8)
    const ANNUAL_DISCOUNT = 0.80;

    // 2. LOOK UP MASTER PLAN
    const tierKey = tier.toLowerCase();
    const [masterPlan] = await db.select().from(masterPlans)
      .where(eq(masterPlans.tierKey, tierKey))
      .limit(1);
    if (!masterPlan) return { statusCode: 400, body: JSON.stringify({ error: 'Invalid plan tier.' }) };

    const stripePriceId = STRIPE_PRICE_IDS[tierKey];
    if (!stripePriceId) {
      return { statusCode: 400, body: JSON.stringify({ error: `No Stripe price configured for tier: ${tierKey}` }) };
    }

    // Compute charge amount based on billing cycle
    const monthlyGbp  = Number(masterPlan.monthlyPriceGbp);
    const chargeGbp   = billingCycle === 'annual'
        ? parseFloat((monthlyGbp * 12 * ANNUAL_DISCOUNT).toFixed(2))  // annual lump-sum
        : monthlyGbp;                                                   // monthly
    const chargePence = Math.round(chargeGbp * 100);

    const billingCycleLabel = billingCycle === 'annual'
        ? `Annual subscription (${Math.round((1 - ANNUAL_DISCOUNT) * 100)}% off)`
        : 'Monthly subscription';

    // 3. CREATE STRIPE CUSTOMER
    const customer = await stripe.customers.create({
      email: user.email,
      name: [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email,
      metadata: { auraUserId: user.id.toString() },
    });

    // 4. CREATE PAYMENT INTENT
    // setup_future_usage: 'off_session' saves the card for recurring subscription charges.
    // The webhook (payment_intent.succeeded) creates the Stripe subscription + DB records.
    // billingCycle is passed in metadata so the webhook can set interval: 'year' for annual plans.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: chargePence,
      currency: 'gbp',
      customer: customer.id,
      setup_future_usage: 'off_session',
      metadata: {
        userId:           user.id.toString(),
        organisationId:   user.organisationId.toString(),
        tier:             tierKey,
        masterPlanId:     masterPlan.id.toString(),
        stripePriceId,
        stripeCustomerId: customer.id,
        billingCycle,
      },
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        data: {
          clientSecret:      paymentIntent.client_secret,
          publishableKey:    process.env.STRIPE_PUBLISHABLE_KEY,
          planName:          masterPlan.name,
          amountGbp:         chargeGbp.toString(),
          tier:              tierKey,
          billingCycle,
          billingCycleLabel,
        },
      }),
    };
  } catch (error: any) {
    console.error('create-subscription error:', error);
    const detail = error?.message || String(error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to initialise checkout.', detail }) };
  }
};
