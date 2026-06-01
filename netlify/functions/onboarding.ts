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
    const body = JSON.parse(event.body || '{}');

    const { firstName, lastName, email, companyName, tier, blueprint, assistantName, customAssistantName, algorithmConfig, consents } = body;

    const fullName = `${firstName || ''} ${lastName || ''}`.trim();
    const planKey = tier?.toLowerCase() || 'employee';
    const targetAssistantName = assistantName || 'Social Media Manager';

    // ----------------------------------------------------------------------
    // Random Name Generator for when the user selects "Let AI Decide"
    // ----------------------------------------------------------------------
    const auraNames = ['Chloe', 'Atlas', 'Nova', 'Echo', 'Orion', 'Lyra', 'Sage', 'Finn', 'Maya', 'Theo'];
    const randomName = auraNames[Math.floor(Math.random() * auraNames.length)];

    // If the user provided a custom name, use it. Otherwise, assign the random name.
    const finalAssistantName = customAssistantName && customAssistantName.trim() !== ''
        ? customAssistantName.trim()
        : randomName;

    // 1. QUERY THE MASTER CATALOG
    const [masterPlan] = await db.select()
        .from(masterPlans)
        .where(eq(masterPlans.tierKey, planKey))
        .limit(1);

    const [masterAssistant] = await db.select()
        .from(masterAssistants)
        .where(eq(masterAssistants.name, targetAssistantName))
        .limit(1);

    if (!masterPlan) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Invalid subscription tier selected.' }) };
    }

    const planAmount = masterPlan.monthlyPriceGbp;
    const formalPlanName = masterPlan.name;

    // 2. THE ACID TRANSACTION
    const newWorkspace = await db.transaction(async (tx) => {

      // --- UPDATED: Insert firstName and lastName into the core users table ---
      const [newUser] = await tx.insert(users).values({
        email,
        firstName: firstName || null,
        lastName: lastName || null
      }).returning();

      // --- UPDATED: Map the consents payload directly to the legalConsents column ---
      await tx.insert(userProfiles).values({
        userId: newUser.id,
        displayName: fullName,
        preferences: { theme: 'light', onboardingComplete: true },
        legalConsents: consents || {}
      });

      let orgId: number | null = null;

      // Note: This logic naturally handles independent users by safely bypassing
      // the organisation creation if companyName is left empty.
      if (companyName && companyName.trim() !== '') {
        const companySlug = companyName.toLowerCase().replace(/[^a-z0-9]+/g, '-') + `-${Date.now()}`;

        const [newOrg] = await tx.insert(organisations).values({
          name: companyName.trim(),
          slug: companySlug,
        }).returning();

        orgId = newOrg.id;

        await tx.insert(userOrganisations).values({
          userId: newUser.id,
          organisationId: orgId,
          role: 'owner'
        });
      }

      const [newPlan] = await tx.insert(plans).values({
        userId: newUser.id,
        masterPlanId: masterPlan.id,
        planName: formalPlanName,
        planType: 'subscription'
      }).returning();

      // ----------------------------------------------------------------------
      // AI Assistant Insertion
      // ----------------------------------------------------------------------
      await tx.insert(aiAssistants).values({
        userId: newUser.id,
        organisationId: orgId,
        masterAssistantId: masterAssistant?.id,
        name: finalAssistantName,
        aiAssistantJobRole: masterAssistant?.name || targetAssistantName, // --- UPDATED: Assigned to dedicated column ---
        model: 'gpt-4o',
        systemPrompt: blueprint || 'No blueprint provided.',
        configuration: {
          type: masterAssistant?.roleKey || 'custom',
          active: true,
          algorithm: algorithmConfig || {}
        }
      });

      await tx.insert(payments).values({
        userId: newUser.id,
        organisationId: orgId,
        planId: newPlan.id,
        amount: planAmount,
        currency: 'GBP',
        status: 'pending',
        description: `Aura ${formalPlanName} Setup`
      });

      await tx.insert(notifications).values({
        userId: newUser.id,
        type: 'onboarding_complete',
        title: 'Workspace Provisioned',
        message: 'Your Aura setup is complete. We are awaiting final payment confirmation to activate your services.',
        metadata: orgId ? { organisationId: orgId } : {}
      });

      return { userId: newUser.id, organisationId: orgId, paymentAmount: planAmount };
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