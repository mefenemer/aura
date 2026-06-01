// netlify/functions/verify-handle.js
const fetch = require('node-fetch');

exports.handler = async (event) => {
    try {
        const { platform, handle } = JSON.parse(event.body);
        const cleanHandle = handle.replace('@', '').replace('https://', '').replace('http://', '').replace('www.', '').replace('facebook.com/', '').replace('linkedin.com/in/', '');

        const patterns = {
            fb: `https://facebook.com/${cleanHandle}`,
            ig: `https://instagram.com/${cleanHandle}`,
            li: `https://linkedin.com/in/${cleanHandle}`,
            x: `https://twitter.com/${cleanHandle}`
        };

        const targetUrl = patterns[platform];
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
        };

        // HEAD request is lightweight and fast
        const response = await fetch(targetUrl, {
            method: 'HEAD',
            redirect: 'follow',
            headers: headers
        });

        // If the final redirected URL still contains the handle, it's valid
        const isLive = response.url.toLowerCase().includes(cleanHandle.toLowerCase());

        return {
            statusCode: 200,
            body: JSON.stringify({ isLive })
        };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: "Verification failed" }) };
    }
};