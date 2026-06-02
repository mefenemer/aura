import { config } from 'dotenv';
import * as path from 'path';

// Try to load .env from the root of the project
config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq } from 'drizzle-orm';
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
  masterAssistants
} from '../../db/schema';

const connectionString = process.env.NETLIFY_DATABASE_URL;

if (!connectionString) {
  throw new Error("CRITICAL: NETLIFY_DATABASE_URL is missing from the environment.");
}

const sql = postgres(connectionString);
const db = drizzle({ client: sql });

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    // ----------------------------------------------------------------------
    // 1. AUTHENTICATION & SESSION EXTRACTION
    // ----------------------------------------------------------------------
    const cookieHeader = event.headers.cookie || '';
    const sessionMatch = cookieHeader.match(/aura_session=simulated_jwt_for_user_(\d+)/);

    if (!sessionMatch) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized. Please log in or verify your account.' }) };
    }

    const currentUserId = parseInt(sessionMatch[1], 10);

    const [existingUser] = await db.select()
        .from(users)
        .where(eq(users.id, currentUserId))
        .limit(1);

    if (!existingUser || existingUser.status !== 'active') {
      return { statusCode: 403, body: JSON.stringify({ error: 'Account pending verification or does not exist.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { companyName, tier, blueprint, assistantName, customAssistantName, algorithmConfig, consents } = body;

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
    // 3. THE ACID TRANSACTION (Workspace Provisioning)
    // ----------------------------------------------------------------------
    const newWorkspace = await db.transaction(async (tx) => {

      // Insert User Profile
      await tx.insert(userProfiles).values({
        userId: existingUser.id,
        displayName: `${existingUser.firstName || ''} ${existingUser.lastName || ''}`.trim() || 'Aura User',
        preferences: { theme: 'light', onboardingComplete: true },
        legalConsents: consents || {}
      });

      // Handle organisation naming (Solopreneur vs Business)
      const finalCompanyName = (companyName && companyName.trim() !== '')
          ? companyName.trim()
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

      // Create plan (FIX: Included planType and userId explicitly to satisfy TypeScript types)
      const [newPlan] = await tx.insert(plans).values({
        organisationId: newOrg.id,
        userId: existingUser.id,
        masterPlanId: masterPlan.id,
        planName: masterPlan.name,
        planType: 'subscription'
      }).returning();

      // Look up assistant (Using TX for atomicity)
      const [assistantRecord] = await tx.select()
          .from(masterAssistants)
          .where(eq(masterAssistants.name, assistantName || 'Social Media Manager'))
          .limit(1);

      // Create AI assistant
      await tx.insert(aiAssistants).values({
        organisationId: newOrg.id,
        userId: existingUser.id,
        masterAssistantId: assistantRecord?.id || null,
        name: (customAssistantName && customAssistantName.trim() !== '') ? customAssistantName.trim() : 'Digital Assistant',
        model: 'gpt-4o',
        aiAssistantJobRole: assistantRecord?.name || 'General Assistant',
        systemPrompt: blueprint || 'No system prompt provided.',
        configuration: {
          type: assistantRecord ? assistantRecord.roleKey : 'custom',
          active: true,
          algorithm: algorithmConfig || {}
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
        metadata: { organisationId: newOrg.id }
      });

      return { userId: existingUser.id, organisationId: newOrg.id };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Workspace provisioned successfully.',
        data: newWorkspace
      }),
    };
  } catch (error) {
    console.error('Database Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Failed to build workspace. Transaction rolled back.' }),
    };
  }
};