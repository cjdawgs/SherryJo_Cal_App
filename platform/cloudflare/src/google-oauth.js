// Handles Google OAuth login redirect and authorization-code callback.
// Mirrors app/routers/google_auth.py: same scopes, same redirect target, same error paths.

import { encodeOAuthState, decodeOAuthState } from "./oauth-state.js";
import { executeOAuthAccountUpsert } from "./oauth-account-postgres.js";
import { issueUserToken } from "./auth-token-issue.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";

const GOOGLE_SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "openid",
    "email",
    "profile",
];

function googleRedirectUri(request) {
    return `${new URL(request.url).origin}/auth/google/callback`;
}

function errorRedirect(base, errorCode, token) {
    const params = new URLSearchParams({ error: errorCode });
    if (token) params.set("token", token);
    return Response.redirect(`${base}/accounts/ui?${params}`, 302);
}

export async function handleGoogleLogin(request, env, adapter) {
    const url = new URL(request.url);
    const rawToken = url.searchParams.get("token") || "";
    const reconnect = url.searchParams.get("reconnect") || "";

    // Verify the user's existing JWT to extract their userId.
    const { authenticateWorkerRequest, JwtVerificationError } = await import("./jwt.js");
    let claims;
    try {
        const syntheticReq = new Request(request.url, {
            headers: { authorization: `Bearer ${rawToken}` },
        });
        claims = await authenticateWorkerRequest(syntheticReq, env);
    } catch (e) {
        if (e instanceof JwtVerificationError) return new Response("Unauthorized", { status: 401 });
        throw e;
    }

    const state = await encodeOAuthState(claims.user_id, reconnect, env.EDGE_PROXY_SECRET);
    const params = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID,
        redirect_uri: googleRedirectUri(request),
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
    });
    if (reconnect) params.set("login_hint", reconnect);
    return Response.redirect(`${GOOGLE_AUTH_URL}?${params}`, 302);
}

export async function handleGoogleCallback(request, env, adapter) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const base = `${url.origin}`;

    if (!code || !stateParam) return errorRedirect(base, "google_oauth_failed", null);

    let userId, reconnectEmail;
    try {
        ({ userId, reconnectEmail } = await decodeOAuthState(stateParam, env.EDGE_PROXY_SECRET));
    } catch {
        return errorRedirect(base, "google_invalid_state", null);
    }

    // Exchange authorization code for tokens.
    let tokenData;
    try {
        const resp = await fetch(GOOGLE_TOKEN_URL, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: env.GOOGLE_CLIENT_ID,
                client_secret: env.GOOGLE_CLIENT_SECRET,
                redirect_uri: googleRedirectUri(request),
                grant_type: "authorization_code",
                code,
            }),
        });
        tokenData = await resp.json();
    } catch {
        return errorRedirect(base, "google_oauth_failed", null);
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    if (!accessToken) return errorRedirect(base, "google_token_missing", null);

    // Fetch the user's email from Google.
    let accountEmail = reconnectEmail;
    let providerId = null;
    try {
        const infoResp = await fetch(GOOGLE_USERINFO_URL, {
            headers: { authorization: `Bearer ${accessToken}` },
        });
        const info = await infoResp.json();
        accountEmail = ((info.email || "").trim().toLowerCase()) || reconnectEmail;
        providerId = info.sub || null;
    } catch {
        if (!accountEmail) return errorRedirect(base, "google_email_missing", null);
    }

    if (!accountEmail) return errorRedirect(base, "google_email_missing", null);
    if (reconnectEmail && accountEmail !== reconnectEmail) {
        return errorRedirect(base, "google_reconnect_mismatch", null);
    }

    const tokenExpiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 3600);

    try {
        await executeOAuthAccountUpsert(adapter, {
            userId, provider: "google", accountEmail,
            accessToken, refreshToken, tokenExpiresAt,
            displayName: accountEmail, providerId,
            tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
    } catch {
        return errorRedirect(base, "google_account_save_failed", null);
    }

    let newToken;
    try { newToken = await issueUserToken(userId, env); } catch { newToken = null; }

    const params = new URLSearchParams({ connected: "google", account: accountEmail });
    if (newToken) params.set("token", newToken);
    return Response.redirect(`${base}/accounts/ui?${params}`, 302);
}
