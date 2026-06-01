const fetch = require('node-fetch');

exports.handler = async (event) => {
    const { platform, handle } = JSON.parse(event.body);
    const cleanHandle = handle.replace('@', '').replace('https://', '').replace('http://', '');

    const patterns = {
        fb: `https://facebook.com/${cleanHandle}`,
        ig: `https://instagram.com/${cleanHandle}`,
        li: `https://linkedin.com/in/${cleanHandle}`,
        x: `https://twitter.com/${cleanHandle}`
    };

    const targetUrl = patterns[platform];

    // Define a browser-like User-Agent
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
    };

    try {
        // Adding headers to the request
        const response = await fetch(targetUrl, {
            method: 'HEAD',
            redirect: 'follow',
            headers: headers
        });

        // Check if the URL contains the handle (prevents redirect false-positives)
        const isLive = response.url.toLowerCase().includes(cleanHandle.toLowerCase());

        return {
            statusCode: 200,
            body: JSON.stringify({ isLive })
        };
    } catch (err) {
        return { statusCode: 500, body: JSON.stringify({ error: "Service unreachable" }) };
    }
};