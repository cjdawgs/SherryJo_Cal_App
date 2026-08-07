// Handles Microsoft OAuth login redirect and authorization-code callback.
// Mirrors app/routers/oauth.py: same scopes, same redirect target, same error paths.

import { encodeOAuthState, decodeOAuthState } from "./oauth-state.js";
import { executeOAuthAccountUpsert } from "./oauth-account-postgres.js";
import { issueUserToken } from "./auth-token-issue.js";

const MS_SCOPES = [
    "User.Read",
    "Calendars.Read",
    "Calendars.ReadWrite",
    "Tasks.Read",
    "offline_access",
];

function msAuthority(tenantId) {
    return `https://login.microsoftonline.com/${tenantId}`;
}

function msRedirectUri(request) {
    return `${new URL(request.url).origin}/ms/callback`;
}

function errorRedirect(base, errorCode, token) {
    const params = new URLSearchParams({ error: errorCode });
    if (token) params.set("token", token);
    return Response.redirect(`${base}/accounts/ui?${params}`, 302);
}

export async function handleMsLogin(request, env, adapter) {
    const url = new URL(request.url);
    const rawToken = url.searchParams.get("token") || "";
    const reconnect = url.searchParams.get("reconnect") || "";

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
    const authority = msAuthority(env.MS_TENANT_ID);
    const params = new URLSearchParams({
        client_id: env.MS_CLIENT_ID,
        response_type: "code",
        redirect_uri: msRedirectUri(request),
        response_mode: "query",
        scope: MS_SCOPES.join(" "),
        state,
        prompt: reconnect ? "consent" : "select_account",
    });
    if (reconnect) params.set("login_hint", reconnect);
    return Response.redirect(`${authority}/oauth2/v2.0/authorize?${params}`, 302);
}

export async function handleMsCallback(request, env, adapter) {
    const url = new URL(request.url);
    const code = url.searchParams.get("code");
    const stateParam = url.searchParams.get("state");
    const msError = url.searchParams.get("error");
    const base = `${url.origin}`;

    if (msError) return errorRedirect(base, "microsoft_login_failed", null);
    if (!code || !stateParam) return errorRedirect(base, "microsoft_oauth_failed", null);

    let userId;
    try {
        ({ userId } = await decodeOAuthState(stateParam, env.EDGE_PROXY_SECRET));
    } catch {
        return errorRedirect(base, "microsoft_invalid_state", null);
    }

    // Exchange authorization code for tokens.
    const authority = msAuthority(env.MS_TENANT_ID);
    let tokenData;
    try {
        const resp = await fetch(`${authority}/oauth2/v2.0/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                client_id: env.MS_CLIENT_ID,
                client_secret: env.MS_CLIENT_SECRET,
                code,
                redirect_uri: msRedirectUri(request),
                grant_type: "authorization_code",
            }),
        });
        tokenData = await resp.json();
    } catch {
        return errorRedirect(base, "microsoft_oauth_failed", null);
    }

    const accessToken = tokenData.access_token;
    const refreshToken = tokenData.refresh_token || null;
    if (!accessToken) return errorRedirect(base, "microsoft_token_missing", null);

    const grantedScope = String(tokenData.scope || "");
    if (!grantedScope.includes("Calendars.ReadWrite")) {
        return errorRedirect(base, "microsoft_scope_missing_write", null);
    }

    // Fetch the user's profile from Microsoft Graph.
    let accountEmail = "";
    let providerId = null;
    try {
        const profileResp = await fetch("https://graph.microsoft.com/v1.0/me", {
            headers: { authorization: `Bearer ${accessToken}` },
        });
        const profile = await profileResp.json();
        if (profile.error) return errorRedirect(base, "microsoft_profile_failed", null);
        accountEmail = ((profile.mail || profile.userPrincipalName || "").trim().toLowerCase());
        providerId = profile.id || null;
    } catch {
        return errorRedirect(base, "microsoft_profile_failed", null);
    }

    if (!accountEmail) return errorRedirect(base, "microsoft_email_missing", null);

    const tokenExpiresAt = Math.floor(Date.now() / 1000) + Number(tokenData.expires_in || 3600);

    try {
        await executeOAuthAccountUpsert(adapter, {
            userId, provider: "microsoft", accountEmail,
            accessToken, refreshToken, tokenExpiresAt,
            displayName: accountEmail, providerId,
            tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
    } catch (err) {
        console.error("[handleMsCallback] Account upsert failed:", err.message || String(err));
        return errorRedirect(base, "microsoft_account_save_failed", null);
    }

    let newToken;
    try {
        newToken = await issueUserToken(userId, env);
    } catch (err) {
        console.error("[handleMsCallback] Native token issue failed:", err?.message || String(err));
        return errorRedirect(base, "microsoft_token_issue_failed", null);
    }

    const params = new URLSearchParams({ connected: "microsoft", account: accountEmail });
    params.set("token", newToken);
    return Response.redirect(`${base}/accounts/ui?${params}`, 302);
}
