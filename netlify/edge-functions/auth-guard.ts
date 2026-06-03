import { Context } from "@netlify/edge-functions";

export default async (request: Request, context: Context) => {
    const url = new URL(request.url);

    // Define the exact paths that require an active session
    const protectedPaths = [
        '/onboarding.html',
        '/dashboard.html',
        '/billing.html'
    ];

    // If the user is trying to access a protected page
    if (protectedPaths.includes(url.pathname)) {
        const sessionCookie = context.cookies.get("aura_session");

        // If the cookie is missing or empty, boot them to login
        if (!sessionCookie) {
            console.log(`Blocked unauthorized access to ${url.pathname}`);
            return Response.redirect(new URL('/login.html', request.url));
        }
    }

    // Otherwise, let the request proceed normally
    return context.next();
};