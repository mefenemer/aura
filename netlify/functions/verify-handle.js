// netlify/functions/verify-handle.js

exports.handler = async (event) => {
    try {
        const { platform, handle } = JSON.parse(event.body);

        // Normalize handle
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

        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        };

        // Add a 5-second timeout to prevent the Netlify function from hanging
        const controller = new AbortController();
        const timeout = setTimeout(() => { controller.abort(); }, 5000);

        // Use Native Node 18+ Fetch (No require needed)
        const response = await fetch(targetUrl, {
            method: 'GET',
            redirect: 'follow',
            headers: headers,
            signal: controller.signal
        });

        clearTimeout(timeout);

        if (response.status === 404) {
            return { statusCode: 200, body: JSON.stringify({ isLive: false }) };
        }

        const finalUrl = response.url.toLowerCase();
        const hitLoginWall = finalUrl.includes('login') || finalUrl.includes('signup');
        const isLive = response.ok || hitLoginWall;

        return {
            statusCode: 200,
            body: JSON.stringify({ isLive })
        };

    } catch (err) {
        console.error("Backend fetch error: ", err.message);
        // FORGIVENESS PROTOCOL: If the platform blocks us or times out, approve the handle
        // so the user doesn't get stuck during onboarding.
        return {
            statusCode: 200,
            body: JSON.stringify({ isLive: true, warning: "Bypassed due to anti-bot wall." })
        };
    }
};