declare namespace Deno {
    const env: {
        get(key: string): string | undefined;
    };
}

// Deno edge functions import dependencies from remote URLs (e.g. jose from deno.land).
// Netlify's Deno bundler resolves these at build time; this ambient declaration just
// stops node-flavored TS tooling from reporting TS2307 on the URL specifiers.
declare module 'https://*';
