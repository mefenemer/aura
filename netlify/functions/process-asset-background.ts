// netlify/functions/process-asset-background.ts
import { HandlerEvent } from '@netlify/functions';
import { eq } from 'drizzle-orm';
import * as cheerio from 'cheerio';
import pdfParse from 'pdf-parse';
import { getDb } from '../../db/client';
import { workspaceAssets } from '../../db/schema';
import { logAuditEvent } from '../../src/utils/audit';

export const handler = async (event: HandlerEvent) => {
    try {
        const body = JSON.parse(event.body || '{}');
        const assetId = body.assetId;

        if (!assetId) return { statusCode: 400, body: 'Missing assetId' };

        const db = getDb();

        // 1. Fetch the processing asset from the database
        const [asset] = await db.select().from(workspaceAssets).where(eq(workspaceAssets.id, assetId));
        if (!asset) return { statusCode: 404, body: 'Asset not found' };

        let extractedText = '';

        try {
            // ---------------------------------------------------------
            // EXTRACTION LOGIC A: WEBSITES & URLS
            // ---------------------------------------------------------
            if (asset.assetType === 'url' && asset.externalUrl) {
                const response = await fetch(asset.externalUrl, {
                    headers: { 'User-Agent': 'Aura-Assist RAG Bot (Mozilla/5.0)' }
                });

                if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

                const html = await response.text();
                const $ = cheerio.load(html);

                // Strip out code, styling, and navigation junk
                $('script, style, noscript, iframe, img, svg, nav, footer').remove();

                // Extract clean text and normalize whitespace
                extractedText = $('body').text().replace(/\s+/g, ' ').trim();
            }
                // ---------------------------------------------------------
                // EXTRACTION LOGIC B: PHYSICAL FILES (PDF, TXT, CSV)
            // ---------------------------------------------------------
            else if (asset.assetType === 'file' && asset.storageUrl) {

                // NOTE: While using your mock URL from earlier, we will simulate the extraction.
                // When your real S3 bucket is connected, uncomment the fetch block below:

                /*
                const response = await fetch(asset.storageUrl);
                const arrayBuffer = await response.arrayBuffer();
                const buffer = Buffer.from(arrayBuffer);

                if (asset.name.toLowerCase().endsWith('.pdf')) {
                    const pdfData = await pdfParse(buffer);
                    extractedText = pdfData.text.replace(/\s+/g, ' ').trim();
                } else if (asset.name.toLowerCase().endsWith('.txt') || asset.name.toLowerCase().endsWith('.csv')) {
                    extractedText = buffer.toString('utf-8').trim();
                } else {
                    throw new Error('Unsupported file format for text extraction.');
                }
                */

                // Simulated extraction for current mock storage
                extractedText = `[Simulated Document Content for: ${asset.name}]. This text represents the brand guidelines that the AI will use to maintain consistency.`;
            }

            // 2. Cap the token length for safety (e.g., 100,000 characters)
            const safeText = extractedText.substring(0, 100000);

            // 3. Update the Database to 'Ready'
            await db.update(workspaceAssets)
                .set({
                    extractedText: safeText,
                    status: 'ready',
                    updatedAt: new Date()
                })
                .where(eq(workspaceAssets.id, assetId));

            // Log Success
            logAuditEvent({
                actionType: 'UPDATE',
                resourceType: 'workspace_assets',
                resourceId: assetId,
                newState: { status: 'ready', textLength: safeText.length }
            });

            return { statusCode: 200, body: 'Asset processed successfully.' };

        } catch (extractionError: any) {
            console.error(`Extraction failed for Asset ${assetId}:`, extractionError);

            // Handle failures gracefully by updating the UI state
            await db.update(workspaceAssets)
                .set({ status: 'failed', updatedAt: new Date() })
                .where(eq(workspaceAssets.id, assetId));

            return { statusCode: 500, body: 'Failed to extract text.' };
        }

    } catch (error) {
        console.error('Background Worker Critical Error:', error);
        return { statusCode: 500, body: 'Internal Server Error' };
    }
};