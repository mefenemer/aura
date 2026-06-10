import { config } from 'dotenv';
import * as path from 'path';
import jwt from 'jsonwebtoken';

config({ path: path.resolve(process.cwd(), '.env') });

import { Handler } from '@netlify/functions';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { eq, and, sql } from 'drizzle-orm';
import {
  users,
  organisations,
  userProfiles,
  aiAssistants,
  notifications,
  masterAssistants,
  onboardingDrafts,
} from '../../db/schema';
import { AURA_SAFE_CONTENT_BENCHMARK } from '../../src/constants/safety-benchmark';

const connectionString = process.env.NETLIFY_DATABASE_URL;
if (!connectionString) throw new Error('CRITICAL: NETLIFY_DATABASE_URL is missing.');
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) throw new Error('CRITICAL: JWT_SECRET is missing.');

const pgClient = postgres(connectionString);
const db = drizzle({ client: pgClient });

function sanitizeText(str: string): string {
  return str.replace(/[<>]/g, '');
}

function compileServerSideBrief(clientName: string, businessName: string, assistantName: string, inputs: any): string {
  if (!inputs) throw new Error('Transformation Failure: Missing inputs payload.');
  const missing = 'Not specified/Provided';
  const fmt = (arr: any[], fallback: string) => {
    if (!Array.isArray(arr) || arr.length === 0) return fallback;
    const valid = arr.filter(i => i && i.trim() !== '');
    return valid.length === 0 ? fallback : valid.map(i => `- ${i}`).join('\n');
  };
  return `
AURA-ASSIST ENGINEERING BRIEF: SOCIAL MEDIA MANAGER BLUEPRINT

CLIENT DETAILS
Name: ${clientName || missing}
Business: ${businessName || missing}
Assistant Name: ${assistantName || missing}

PROCESS BOTTLENECK
${inputs.problem?.trim() || missing}

SOURCING & TRIGGER
Trigger: ${inputs.triggerText?.trim() || missing}
Source: ${inputs.sourceText?.trim() || missing}

PUBLISHING DESTINATIONS
Platforms:
${fmt(inputs.platforms, missing)}

GENERAL PREFERENCES & STRATEGY
${fmt(inputs.generalPreferences, missing)}

WORKFLOW LOGIC
${inputs.workflowText?.trim() || missing}

NON-NEGOTIABLE STRICT RULES
${fmt(inputs.strictRules, missing)}

APPROVAL PROTOCOL
All requests requiring your sign-off are managed exclusively through your Aura-Assist Workspace. You will be notified by email immediately upon the creation of any new request.

${AURA_SAFE_CONTENT_BENCHMARK}
`.trim();
}

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

    const [existingUser] = await db.select().from(users).where(eq(users.id, currentUserId)).limit(1);
    if (!existingUser || existingUser.status !== 'active' || !existingUser.organisationId) {
      return { statusCode: 403, body: JSON.stringify({ error: 'Account pending verification or missing organisation.' }) };
    }

    const body = JSON.parse(event.body || '{}');
    const { clientName, businessName, assistantName, customAssistantName, rawInputs, onboardingContext, consents } = body;

    if (assistantName === 'Social Media Manager') {
      if (!onboardingContext?.target_audience || !onboardingContext?.content_pillars || !onboardingContext?.tone_of_voice || !onboardingContext?.primary_platforms?.length) {
        return { statusCode: 400, body: JSON.stringify({ error: 'Missing required Social Media Manager context fields (Audience, Pillars, Tone, or Platforms).' }) };
      }
    }

    const targetName = customAssistantName?.trim() || 'Digital Assistant';

    // 2. DEDUP CHECK — allow retry if previously incomplete
    const [existingAssistant] = await db.select().from(aiAssistants).where(and(
      eq(aiAssistants.userId, existingUser.id),
      sql`LOWER(${aiAssistants.name}) = LOWER(${targetName})`
    )).limit(1);

    if (existingAssistant) {
      if (['pending_payment', 'pending'].includes(existingAssistant.provisioningStatus || '')) {
        await db.delete(aiAssistants).where(eq(aiAssistants.id, existingAssistant.id));
      } else {
        return { statusCode: 409, body: JSON.stringify({ error: 'You already have an active Assistant with this name.' }) };
      }
    }

    // 3. UPDATE PROFILE CONSENTS & ORG NAME
    await db.update(userProfiles).set({ legalConsents: consents || {} }).where(eq(userProfiles.userId, existingUser.id));

    if (businessName?.trim()) {
      await db.update(organisations).set({ name: sanitizeText(businessName.trim()) })
        .where(eq(organisations.id, existingUser.organisationId!));
    }

    // 4. COMPILE SYSTEM PROMPT
    let secureSystemPrompt: string;
    try {
      secureSystemPrompt = compileServerSideBrief(clientName, sanitizeText(businessName || ''), targetName, rawInputs);
      if (!secureSystemPrompt) throw new Error('Empty brief.');
    } catch (e) {
      console.error('Brief compilation failed:', e);
      throw new Error('Failed to generate Assistant Blueprint due to missing or invalid data.');
    }

    // 5. LOOK UP MASTER ASSISTANT
    const [assistantRecord] = await db.select().from(masterAssistants)
      .where(eq(masterAssistants.name, assistantName || 'Social Media Manager'))
      .limit(1);

    // 6. CREATE AI ASSISTANT (subscription already paid — activate immediately)
    // The DB has a unique constraint on (userId, name) to prevent duplicate provisioning
    // from race conditions. We catch PostgreSQL error 23505 (unique_violation) and return 409.
    let newAssistant: typeof aiAssistants.$inferSelect;
    try {
      const [inserted] = await db.insert(aiAssistants).values({
        organisationId: existingUser.organisationId!,
        userId: existingUser.id,
        masterAssistantId: assistantRecord?.id || null,
        name: targetName,
        model: 'gpt-4o',
        aiAssistantJobRole: assistantRecord?.name || 'General Assistant',
        systemPrompt: secureSystemPrompt,
        configuration: {
          type: assistantRecord ? assistantRecord.roleKey : 'custom',
          active: true,
          inputs: rawInputs || {},
        },
        onboardingContext: onboardingContext || {},
        isActive: true,
        provisioningStatus: 'pending', // Ready for async provisioning
      }).returning();
      newAssistant = inserted;
    } catch (insertErr: any) {
      // PostgreSQL unique_violation error code 23505 = duplicate (userId, name)
      if (insertErr?.code === '23505' || insertErr?.message?.includes('ai_assistants_user_name_unique')) {
        console.warn('[onboarding] Duplicate assistant creation prevented by DB constraint:', targetName);
        return {
          statusCode: 409,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'An assistant with this name already exists for your account.' }),
        };
      }
      throw insertErr; // Re-throw unexpected errors
    }

    // 7. CLEAR DRAFT & NOTIFY
    await db.delete(onboardingDrafts).where(eq(onboardingDrafts.userId, existingUser.id));

    await db.insert(notifications).values({
      userId: existingUser.id,
      type: 'system',
      title: 'Assistant Setup Received',
      message: `${targetName} is being built. We'll notify you when it's ready.`,
      isRead: false,
    });

    // 8. TRIGGER ASYNC PROVISIONING
    const baseUrl = process.env.URL || 'http://localhost:8888';
    fetch(`${baseUrl}/.netlify/functions/provision-assistant-async`, {
      method: 'POST',
      body: JSON.stringify({ assistantId: newAssistant.id }),
    }).catch(err => console.error('Async provisioning trigger failed:', err));

    return {
      statusCode: 200,
      body: JSON.stringify({ message: 'Assistant setup complete.', assistantId: newAssistant.id }),
    };
  } catch (error: any) {
    console.error('onboarding error:', error);
    const errMsg = error.message?.includes('Blueprint') || error.message?.includes('Assistant')
      ? error.message
      : 'Failed to set up assistant.';
    return { statusCode: 500, body: JSON.stringify({ error: errMsg }) };
  }
};
