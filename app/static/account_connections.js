/**
 * ==========================================================
 * ACCOUNT CONNECTION ROUTER (SINGLE SOURCE OF TRUTH)
 * ==========================================================
 * PURPOSE:
 * Centralize provider connection logic used by the main calendar UI.
 *
 * RULES:
 * - Apple never uses OAuth.
 * - Google/Microsoft use OAuth login endpoints.
 * ==========================================================
 */

/**
 * Google OAuth via backend route.
 */
export function connectGoogle() {
    const token = localStorage.getItem("token");

    console.log("Redirecting to Google OAuth flow");

    window.location.href = "/auth/google/login?token=" + token;
}

/**
 * Microsoft OAuth via backend route.
 */
export function connectMicrosoft() {
    const token = localStorage.getItem("token");

    console.log("Redirecting to Microsoft OAuth flow");

    window.location.href = "/ms/login?token=" + token;
}

/**
 * Apple uses manual CalDAV flow in Accounts UI.
 */
export function connectApple() {
    console.log("Apple uses manual CalDAV flow. Redirecting to /accounts/ui");

    window.location.href = "/accounts/ui";
}