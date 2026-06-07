// netlify/functions/generate-names.ts
import { HandlerEvent } from '@netlify/functions';
import jwt from 'jsonwebtoken';

const jwtSecret = process.env.JWT_SECRET;
const openAiKey = process.env.OPENAI_API_KEY;

export const handler = async (event: HandlerEvent) => {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
    if (!jwtSecret || !openAiKey) return { statusCode: 500, body: JSON.stringify({ error: 'Server misconfigured.' }) };

    // 1. Authenticate Session
    const rawCookieHeader = event.headers.cookie || '';
    const cookies = Object.fromEntries(
        rawCookieHeader.split(';').map(c => {
            const [key, ...v] = c.trim().split('=');
            return [key, decodeURIComponent(v.join('='))];
        }).filter(([key]) => key !== '')
    );

    const sessionToken = cookies['aura_session'];
    if (!sessionToken) return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized.' }) };

    try {
        jwt.verify(sessionToken, jwtSecret);
    } catch (err) {
        return { statusCode: 401, body: JSON.stringify({ error: 'Invalid session.' }) };
    }

    const { theme, role } = JSON.parse(event.body || '{}');
    if (!theme || !role) return { statusCode: 400, body: JSON.stringify({ error: 'Theme and Role are required.' }) };

    try {
        // 2. Prompt the LLM
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openAiKey}`
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [{
                    role: 'system',
                    content: `You are a creative naming assistant for an AI software platform. The user wants to name their new AI Assistant. The assistant's role is "${role}" and the creative theme is "${theme}". Return EXACTLY 3 to 5 unique, catchy, and professional name suggestions. Return ONLY a valid JSON array of strings (e.g. ["Name 1", "Name 2", "Name 3"]). Do not include markdown formatting, explanations, or extra text.`
                }],
                temperature: 0.8
            })
        });

        if (!response.ok) throw new Error('LLM failed to respond.');

        const data = await response.json();
        const names = JSON.parse(data.choices[0].message.content);

        // 3. Return clean array
        return { statusCode: 200, body: JSON.stringify({ names }) };

    } catch (error) {
        console.error('Name Generation Error:', error);
        return { statusCode: 500, body: JSON.stringify({ error: 'Our creative gears are jammed right now. Please type a name manually!' }) };
    }
};