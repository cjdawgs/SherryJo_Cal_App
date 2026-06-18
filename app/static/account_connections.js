/**
 * ==========================================================
 * ✅ ACCOUNT CONNECTION ROUTER (SINGLE SOURCE OF TRUTH)
 * ==========================================================
 * PURPOSE:
 * Centralize ALL provider connection logic
 *
 * RULES:
 * - NO duplicate logic anywhere else
 * - Apple NEVER uses OAuth
 * - Google/Microsoft remain OAuth
 *
 * RESULT:
 * Prevents drift + guarantees consistency
 * ==========================================================
 */

/**
 * ✅ GOOGLE OAUTH
 * Uses backend OAuth flow
 */
export function connectGoogle() {
    const token = localStorage.getItem("token");

    console.log("🟢 Redirecting to Google OAuth flow");

    window.location.href = "/auth/google/login?token=" + token;
}

/**
 * ✅ MICROSOFT OAUTH
 */
export function connectMicrosoft() {
    const token = localStorage.getItem("token");

    console.log("🔵 Redirecting to Microsoft OAuth flow");

    window.location.href = "/ms/login?token=" + token;
}

/**
 * ✅ APPLE (CRITICAL FIX)
 * NO OAUTH — manual CalDAV via Accounts UI
 */
export function connectApple() {
    console.log("🍎 Apple uses manual CalDAV flow. Redirecting to /accounts/ui");

    window.location.href = "/accounts/ui";
}
