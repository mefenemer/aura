// auth-check.js
(function() {
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    const sessionToken = getCookie('aura_session');

    if (!sessionToken) {
        // Save the destination URL so the login page knows where to send them next
        sessionStorage.setItem('return_url', window.location.href);
        window.location.replace('/login.html');
    }
})();