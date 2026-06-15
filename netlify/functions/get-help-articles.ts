import { Handler, HandlerResponse } from '@netlify/functions';
import { getDb } from '../../db/client'; // Adjust path if necessary
import { helpArticles } from '../../db/schema'; // Adjust path if necessary

export const handler: Handler = async (event) => {
    // 1. Explicitly type a base headers object to prevent index-signature widening bugs
    const standardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    };

    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            headers: standardHeaders,
            body: 'Method Not Allowed'
        };
    }

    try {
        const db = getDb();

        const articles = await db
            .select()
            .from(helpArticles)
            .orderBy(helpArticles.createdAt);

        return {
            statusCode: 200,
            headers: standardHeaders,
            body: JSON.stringify(articles)
        };
    } catch (error) {
        console.error('Error executing get-help-articles serverless function:', error);
        return {
            statusCode: 500,
            headers: standardHeaders,
            body: JSON.stringify({ error: 'Failed to stream help articles from the database layer.' })
        };
    }
};