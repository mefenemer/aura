import { Handler } from '@netlify/functions';
import { getDb } from '../../db/client'; // Adjust this path to point to your DB client file
import { helpArticles } from '../../db/schema'; // Adjust this path to point to your DB schema file

export const handler: Handler = async (event) => {
    // Only allow GET requests to fetch data
    if (event.httpMethod !== 'GET') {
        return {
            statusCode: 405,
            body: 'Method Not Allowed'
        };
    }

    try {
        // Initialize your database connection instance
        const db = getDb();

        // Query the database to retrieve all articles, ordered by creation date
        const articles = await db
            .select()
            .from(helpArticles)
            .orderBy(helpArticles.createdAt);

        // Return a successful response along with the data rows
        return {
            statusCode: 200,
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*' // Allows smooth testing in cross-origin environments
            },
            body: JSON.stringify(articles)
        };
    } catch (error) {
        console.error('Error executing get-help-articles serverless function:', error);
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Failed to stream help articles from the database layer.' })
        };
    }
};