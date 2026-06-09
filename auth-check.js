// auth-check.js
(function() {
    function getCookie(name) {
        const value = `; ${document.cookie}`;
        const parts = value.split(`; ${name}=`);
        if (parts.length === 2) return parts.pop().split(';').shift();
        return null;
    }

    function isSessionValid() {
        const token = getCookie('aura_session');
        if (!token) return false;
        try {
            const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
            return payload.exp && payload.exp * 1000 > Date.now();
        } catch {
            return false;
        }
    }

    if (!isSessionValid()) {
        // Save the destination URL so the login page knows where to send them next
        sessionStorage.setItem('return_url', window.location.href);
        window.location.replace('/login.html');
    }
})();