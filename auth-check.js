// auth-check.js
(function() {
    // Helper to read a specific cookie
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    // Check for the aura_session cookie
    const sessionToken = getCookie('aura_session');

    // If it doesn't exist, immediately redirect to login
    if (!sessionToken) {
        window.location.replace('/login.html');
    }
})();