// netlify/functions/verify-handle.js
const fetch = require('node-fetch');

exports.handler = async (event) => {
    try {
        const { platform, handle } = JSON.parse(event.body);

        // 1. Ensure we strip out any accidental full URLs the frontend might have missed
        const cleanHandle = handle
            .replace(/^https?:\/\/(www\.)?facebook\.com\//i, '')
            .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
            .replace(/^https?:\/\/(www\.)?linkedin\.com\/(in|company)\//i, '')
            .replace(/^https?:\/\/(www\.)?twitter\.com\//i, '')
            .replace(/^https?:\/\/(www\.)?x\.com\//i, '')
            .replace('@', '')
            .replace(/\/$/, '');

        const patterns = {
            fb: `https://facebook.com/${cleanHandle}`,
            ig: `https://instagram.com/${cleanHandle}`,
            li: `https://linkedin.com/in/${cleanHandle}`,
            x: `https://twitter.com/${cleanHandle}`
        };

        const targetUrl = patterns[platform];

        // 2. Use broader headers to look more like a standard web browser
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        };

        // 3. Switch to GET. Many platforms block HEAD requests automatically to stop simple ping scripts.
        const response = await fetch(targetUrl, {
            method: 'GET',
            redirect: 'follow',
            headers: headers
        });

        // 4. If the platform explicitly tells us the page doesn't exist, fail the validation.
        if (response.status === 404) {
            return { statusCode: 200, body: JSON.stringify({ isLive: false }) };
        }

        // 5. Check if the bot was redirected to a login or signup page.
        const finalUrl = response.url.toLowerCase();
        const hitLoginWall = finalUrl.includes('login') || finalUrl.includes('signup');

        // 6. Pass the user if it's a valid 200 response OR if we hit a login wall (giving the user the benefit of the doubt)
        const isLive = response.ok || hitLoginWall;

        return {
            statusCode: 200,
            body: JSON.stringify({ isLive })
        };

    } catch (err) {
        console.error("Fetch error: ", err);
        return { statusCode: 500, body: JSON.stringify({ error: "Verification failed" }) };
    }
};