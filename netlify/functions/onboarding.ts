import { config } from 'dotenv';
import * as path from 'path';
import jwt from 'jsonwebtoken';
import Stripe from 'stripe';
// Try to load .env from the root of the project
config({ path: path.resolve(process.cwd(), '.env') });
import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, sql } from 'drizzle-orm';
import {
  users,
  organisations,
  userOrganisations,
  userProfiles,
  plans,
  aiAssistants,
  payments,
  notifications,
  masterPlans,
  masterAssistants,
  onboardingDrafts
} from '../../db/schema';

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) {
  throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing.");
}

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error("CRITICAL: JWT_SECRET is missing.");
}

const stripeSecret = process.env.STRIPE_SECRET_KEY;
if (!stripeSecret) {
  throw new Error("CRITICAL: STRIPE_SECRET_KEY is missing.");
}

const pgClient = postgres(connectionString);
const db = drizzle({ client: pgClient });
const stripe = new Stripe(stripeSecret, { apiVersion: '2023-10-16' });

// Helper to prevent XSS-like issues
function sanitizeText(str: string): string {
  return str.replace(/[<>]/g, "");
}

// SCENARIO 1, 2, & 4: Secure Server-Side Prompt Compilation with Dynamic Mapping
function compileServerSideBrief(clientName: string, businessName: string, assistantName: string, inputs: any) {
  if (!inputs) throw new Error("Transformation Failure: Missing inputs payload.");

  const missingFallback = "Not specified/Provided";

  // Helper to safely format arrays (like platforms, strict rules, and anecdotes)
  const formatArray = (arr: any[], fallback: string) => {
    if (!arr || !Array.isArray(arr) || arr.length === 0) return fallback;
    const validItems = arr.filter(item => item && item.trim() !== '');
    if (validItems.length === 0) return fallback;
    return validItems.map(item => `- ${item}`).join('\n');
  };

  const problem = inputs.problem && inputs.problem.trim() !== '' ? inputs.problem : missingFallback;
  const trigger = inputs.triggerText && inputs.triggerText.trim() !== '' ? inputs.triggerText : missingFallback;
  const source = inputs.sourceText && inputs.sourceText.trim() !== '' ? inputs.sourceText : missingFallback;
  const workflowText = inputs.workflowText && inputs.workflowText.trim() !== '' ? inputs.workflowText : missingFallback;

  const platforms = formatArray(inputs.platforms, missingFallback);
  const preferences = formatArray(inputs.generalPreferences, missingFallback);
  const strictRules = formatArray(inputs.strictRules, missingFallback);

  return `
AURA-ASSIST ENGINEERING BRIEF: SOCIAL MEDIA MANAGER BLUEPRINT

CLIENT DETAILS
Name: ${clientName || missingFallback}
Business: ${businessName || missingFallback}
Assistant Name: ${assistantName || missingFallback}

PROCESS BOTTLENECK
${problem}

SOURCING & TRIGGER
Trigger: ${trigger}
Source: ${source}

PUBLISHING DESTINATIONS
Platforms:
${platforms}

GENERAL PREFERENCES & STRATEGY
${preferences}

WORKFLOW LOGIC
${workflowText}

NON-NEGOTIABLE STRICT RULES
${strictRules}

APPROVAL PROTOCOL
All requests requiring your sign-off are managed exclusively through your Aura-Assist Workspace. You will be notified by email immediately upon the creation of any new request.
`.trim();
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    // 1. AUTHENTICATION & SESSION EXTRACTION
    const cookieHeader = event.headers.cookie || '';
    const match = cookieHeader.match(/aura_session=([^;]+)/);
    const token = match ? match[1] : null;

    if (!token) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: No session token found.' }) };
    }

    let currentUserId: number;

    try {
      const decoded = jwt.verify(token, jwtSecret) as { userId: number, email: string };
      currentUserId = decoded.userId;
    } catch (error) {
      console.error('JWT Verification Failed:', error);
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized: Invalid or expired session.' }) };
    }

    const [existingUser] = await db.select()
        .from(users)
        .where(eq(users.id, currentUserId))
        .limit(1);

    if (!existingUser || existingUser.status !== 'active' || !existingUser.organisationId) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Account pending verification or missing organisation.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { clientName, businessName, tier, assistantName, customAssistantName, rawInputs, onboardingContext, consents } = body;

    // Payload Validation for Context Persistence
    if (assistantName === 'Social Media Manager') {
      if (!onboardingContext?.target_audience || !onboardingContext?.content_pillars || !onboardingContext?.tone_of_voice || !onboardingContext?.primary_platforms?.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required Social Media Manager context fields (Audience, Pillars, Tone, or Platforms).' }) };
      }
    }

    // 2. QUERY THE MASTER CATALOG
    const [masterPlan] = await db.select()
        .from(masterPlans)
        .where(eq(masterPlans.tierKey, tier?.toLowerCase() || 'employee'))
        .limit(1);

    if (!masterPlan) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid subscription tier selected.' }) };
    }

    // 3. BACKEND RACE CONDITION CHECK (Uniqueness)
    const targetName = (customAssistantName && customAssistantName.trim() !== '')
        ? customAssistantName.trim()
        : 'Digital Assistant';

    // Graceful overwrite if they previously cancelled checkout
    const [existingAssistant] = await db.select().from(aiAssistants)
        .where(and(
            eq(aiAssistants.userId, existingUser.id),
            sql`LOWER(${aiAssistants.name}) = LOWER(${targetName})`
        )).limit(1);

    if (existingAssistant) {
      if (existingAssistant.provisioningStatus === 'pending_payment') {
        // They cancelled before and are trying again. Delete the old unpaid record to recreate it cleanly.
        await db.delete(aiAssistants).where(eq(aiAssistants.id, existingAssistant.id));
      } else {
        return { statusCode: 409, body: JSON.stringify({ error: 'You already have an active Assistant with this name.' }) };
      }
    }

    // 4. THE ACID TRANSACTION (Workspace Provisioning & Payment Link Generation)
    const checkoutUrl = await db.transaction(async (tx) => {

      // Update User Profile Consents (from Registration)
      await tx.update(userProfiles)
          .set({ legalConsents: consents || {} })
          .where(eq(userProfiles.userId, existingUser.id));

      // Update Organisation Name if provided
      if (businessName && businessName.trim() !== '') {
        await tx.update(organisations)
            .set({ name: sanitizeText(businessName.trim()) })
            .where(eq(organisations.id, existingUser.organisationId!));
      }

      // Create Subscription Plan Record
      const [newPlan] = await tx.insert(plans).values({
        organisationId: existingUser.organisationId!,
        userId: existingUser.id,
        masterPlanId: masterPlan.id,
        planName: masterPlan.name,
        planType: 'subscription'
      }).returning();

      // Look up master assistant
      const [assistantRecord] = await tx.select()
          .from(masterAssistants)
          .where(eq(masterAssistants.name, assistantName || 'Social Media Manager'))
          .limit(1);

      // Automated error logging on transformation failure
      let secureSystemPrompt = '';
      try {
        secureSystemPrompt = compileServerSideBrief(clientName, sanitizeText(businessName || ''), targetName, rawInputs);
        if (!secureSystemPrompt) throw new Error("Compilation resulted in empty brief.");
      } catch (compilationError) {
        console.error("CRITICAL: Brief Transformation Failure:", compilationError);
        throw new Error("Failed to generate Assistant Blueprint due to missing or invalid data. Deployment aborted.");
      }

      // Create AI assistant with pending_payment status
      const [newAssistant] = await tx.insert(aiAssistants).values({
        organisationId: existingUser.organisationId!,
        userId: existingUser.id,
        masterAssistantId: assistantRecord?.id || null,
        name: targetName,
        model: 'gpt-4o',
        aiAssistantJobRole: assistantRecord?.name || 'General Assistant',
        systemPrompt: secureSystemPrompt, // Compiled blueprint
        configuration: {
          type: assistantRecord ? assistantRecord.roleKey : 'custom',
          active: true,
          inputs: rawInputs || {}
        },
        onboardingContext: onboardingContext || {}, // Structured UI data
        isActive: false, // Inactive until paid
        provisioningStatus: 'pending_payment' // Blocks async queue until webhook fires
      }).returning();

      // Create Pending Payment Record
      const [newPayment] = await tx.insert(payments).values({
        userId: existingUser.id,
        organisationId: existingUser.organisationId!,
        planId: newPlan.id,
        amount: masterPlan.monthlyPriceGbp,
        currency: 'GBP',
        status: 'pending',
        description: `Aura ${masterPlan.name} Setup`
      }).returning();

      // Generate Stripe Checkout Session
      const baseUrl = process.env.URL || 'http://localhost:8888';
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        customer_email: existingUser.email,
        line_items: [{
          price_data: {
            currency: 'gbp',
            product_data: {
              name: `Aura-Assist: ${targetName}`,
              description: `Monthly subscription for the ${masterPlan.name} plan.`,
            },
            unit_amount: Math.round(Number(masterPlan.monthlyPriceGbp) * 100),
            recurring: { interval: 'month' }
          },
          quantity: 1,
        }],
        mode: 'subscription',
        success_url: `${baseUrl}/dashboard.html?payment=success`,
        cancel_url: `${baseUrl}/onboarding-social-media.html?tier=${tier}`,
        metadata: {
          userId: existingUser.id.toString(),
          assistantId: newAssistant.id.toString(),
          paymentId: newPayment.id.toString()
        }
      });

      return session.url;
    });

    return { statusCode: 200, body: JSON.stringify({ message: 'Success', data: { stripeUrl: checkoutUrl } }) };
  } catch (error: any) {
    console.error('Database Error:', error);

    // Safely return specific compilation errors to the frontend if they caused the rollback
    const errMsg = (error.message && error.message.includes("Blueprint"))
        ? error.message
        : 'Failed to build workspace.';

    return { statusCode: 500, body: JSON.stringify({ error: errMsg }) };
  }
};