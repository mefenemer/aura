import { config } from 'dotenv';
import * as path from 'path';
import jwt from 'jsonwebtoken';
// Try to load .env from the root of the project
config({ path: path.resolve(process.cwd(), '.env') });
import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, sql } from 'drizzle-orm'; // Use this 'sql' for queries
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

const pgClient = postgres(connectionString);
const db = drizzle({ client: pgClient });

// SCENARIO 2: Secure Server-Side Prompt Compilation
function compileServerSideBrief(clientName: string, businessName: string, assistantName: string, inputs: any) {
  const missingFallback = "[MISSING - PLEASE UPDATE]";
  return `
AURA-ASSIST ENGINEERING BRIEF: SOCIAL MEDIA MANAGER BLUEPRINT
CLIENT DETAILS
Name: ${clientName || 'New User'}
Business: ${businessName || 'Business'}
Assistant Name: ${assistantName || 'Digital Assistant'}
PROCESS BOTTLENECK
${inputs?.problem || missingFallback}
SOURCING & TRIGGER
Trigger: ${inputs?.triggerText || missingFallback}
Source: ${inputs?.sourceText || missingFallback}
PUBLISHING DESTINATIONS
Platforms: ${inputs?.platforms?.length > 0 ? inputs.platforms.join(', ') : missingFallback}
GENERAL PREFERENCES & STRATEGY
${inputs?.generalPreferences?.length > 0 ? inputs.generalPreferences.join('\n') : '- No general preferences configured.'}
WORKFLOW LOGIC
${inputs?.workflowText || missingFallback}
NON-NEGOTIABLE STRICT RULES
${inputs?.strictRules?.length > 0 ? inputs.strictRules.join('\n') : '- No strict rules configured.'}
APPROVAL PROTOCOL
All requests requiring your sign-off are managed exclusively through your Aura-Assist Workspace. You will be notified by email immediately upon the creation of any new request.
`;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  try {
    // ----------------------------------------------------------------------
    // 1. AUTHENTICATION & SESSION EXTRACTION
    // ----------------------------------------------------------------------
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

    if (!existingUser || existingUser.status !== 'active') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Account pending verification or does not exist.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { clientName, businessName, tier, assistantName, customAssistantName, rawInputs, consents } = body;

    // ----------------------------------------------------------------------
    // 2. QUERY THE MASTER CATALOG
    // ----------------------------------------------------------------------
    const [masterPlan] = await db.select()
        .from(masterPlans)
        .where(eq(masterPlans.tierKey, tier?.toLowerCase() || 'employee'))
        .limit(1);

    if (!masterPlan) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid subscription tier selected.' }) };
    }

    // ----------------------------------------------------------------------
    // 3. BACKEND RACE CONDITION CHECK (Uniqueness Scenario 3)
    // ----------------------------------------------------------------------
    const targetName = (customAssistantName && customAssistantName.trim() !== '')
        ? customAssistantName.trim()
        : 'Digital Assistant';

    const existingAssistant = await db.select().from(aiAssistants)
        .where(and(
            eq(aiAssistants.userId, existingUser.id),
            sql`LOWER(${aiAssistants.name}) = LOWER(${targetName})`
        )).limit(1);

    if (existingAssistant.length > 0) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: 'You already have an Assistant with this name.' })
      };
    }

    // ----------------------------------------------------------------------
    // 4. THE ACID TRANSACTION (Workspace Provisioning)
    // ----------------------------------------------------------------------
    const newWorkspace = await db.transaction(async (tx) => {
      // Insert User Profile
      await tx.insert(userProfiles).values({
        userId: existingUser.id,
        displayName: `${existingUser.firstName || ''} ${existingUser.lastName || ''}`.trim() || 'Aura User',
        preferences: { theme: 'light', onboardingComplete: true },
        legalConsents: consents || {}
      });

      // Handle organisation naming
      const finalCompanyName = (businessName && businessName.trim() !== '')
          ? businessName.trim()
          : `${existingUser.firstName}'s Workspace`;

      const companySlug = finalCompanyName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + `-${Date.now()}`;

      // Create organisation
      const [newOrg] = await tx.insert(organisations).values({
        name: finalCompanyName,
        slug: companySlug,
      }).returning();

      // Link user to organisation
      await tx.insert(userOrganisations).values({
        userId: existingUser.id,
        organisationId: newOrg.id,
        role: 'owner'
      });

      // Create plan
      const [newPlan] = await tx.insert(plans).values({
        organisationId: newOrg.id,
        userId: existingUser.id,
        masterPlanId: masterPlan.id,
        planName: masterPlan.name,
        planType: 'subscription'
      }).returning();

      // Look up assistant
      const [assistantRecord] = await tx.select()
          .from(masterAssistants)
          .where(eq(masterAssistants.name, assistantName || 'Social Media Manager'))
          .limit(1);

      // Generate the secure brief server-side
      const secureSystemPrompt = compileServerSideBrief(clientName, businessName, customAssistantName, rawInputs);

      // Create AI assistant
      await tx.insert(aiAssistants).values({
        organisationId: newOrg.id,
        userId: existingUser.id,
        masterAssistantId: assistantRecord?.id || null,
        name: (customAssistantName && customAssistantName.trim() !== '') ? customAssistantName.trim() : 'Digital Assistant',
        model: 'gpt-4o',
        aiAssistantJobRole: assistantRecord?.name || 'General Assistant',
        systemPrompt: secureSystemPrompt,
        configuration: {
          type: assistantRecord ? assistantRecord.roleKey : 'custom',
          active: true,
          inputs: rawInputs || {}
        },
        isActive: true
      });

      // Record payment
      await tx.insert(payments).values({
        userId: existingUser.id,
        organisationId: newOrg.id,
        planId: newPlan.id,
        amount: masterPlan.monthlyPriceGbp,
        currency: 'GBP',
        status: 'pending',
        description: `Aura ${masterPlan.name} Setup`
      });

      // Notify user
      await tx.insert(notifications).values({
        userId: existingUser.id,
        type: 'onboarding_complete',
        title: 'Workspace Provisioned',
        message: 'Your Aura setup is complete.',
        isRead: false
      });

      await tx.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, existingUser.id));

      return { userId: existingUser.id, organisationId: newOrg.id };
    });

    return { statusCode: 200, body: JSON.stringify({ message: 'Success', data: newWorkspace }) };
  } catch (error) {
    console.error('Database Error:', error);
    return { statusCode: 500, body: JSON.stringify({ error: 'Failed to build workspace.' }) };
  }
};