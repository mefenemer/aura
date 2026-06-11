/**
 * src/utils/ai-usage.ts
 *
 * US-ADM-3.1.1: AI Token Usage Logging & COGS Dashboard
 *
 * Fire-and-forget utility to log one AI call to ai_usage_log.
 * costUsd is calculated server-side from aiModelPricing rates; if no pricing row
 * exists for the model the cost is stored as 0 (admin can add rates later).
 */

import { getDb } from '../../db/client';
import { aiUsageLog, aiModelPricing } from '../../db/schema';
import { eq } from 'drizzle-orm';

export interface AiUsageParams {
    workspaceId?: number | null;
    userId?: number | null;
    assistantId?: number | null;
    model: string;               // must match aiModelPricing.modelKey, e.g. 'gpt-4o-mini'
    inputTokens: number;
    outputTokens: number;
    taskRunId?: number | null;
    sessionId?: string | null;
}

/**
 * Write one row to ai_usage_log.
 * Non-blocking — call with `void logAiUsage(...)` or wrap in setImmediate.
 * Never throws; errors are logged to console only.
 */
export async function logAiUsage(params: AiUsageParams): Promise<void> {
    try {
        const db = getDb();

        // Look up per-token pricing for this model
        let costUsd = '0';
        const [pricing] = await db
            .select({
                inputCostPer1kTokens:  aiModelPricing.inputCostPer1kTokens,
                outputCostPer1kTokens: aiModelPricing.outputCostPer1kTokens,
            })
            .from(aiModelPricing)
            .where(eq(aiModelPricing.modelKey, params.model))
            .limit(1);

        if (pricing) {
            const inputCost  = (params.inputTokens  / 1000) * parseFloat(pricing.inputCostPer1kTokens);
            const outputCost = (params.outputTokens / 1000) * parseFloat(pricing.outputCostPer1kTokens);
            costUsd = (inputCost + outputCost).toFixed(6);
        }

        await db.insert(aiUsageLog).values({
            workspaceId:  params.workspaceId  ?? null,
            userId:       params.userId       ?? null,
            assistantId:  params.assistantId  ?? null,
            model:        params.model,
            inputTokens:  params.inputTokens,
            outputTokens: params.outputTokens,
            costUsd,
            taskRunId:    params.taskRunId    ?? null,
            sessionId:    params.sessionId    ?? null,
        });
    } catch (err) {
        console.error('[ai-usage] Failed to write usage log row:', err);
        // Never re-throw — logging failure must not block the AI response
    }
}
