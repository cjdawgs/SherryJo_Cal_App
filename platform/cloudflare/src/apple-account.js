import { executeOAuthAccountUpsert } from "./oauth-account-postgres.js";
import {
    ProviderAuthorizationError,
    ProviderResponseError,
    validateAppleCredentials,
} from "./provider-calendar-sync.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    });
}

async function parseRequest(request) {
    if (!(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) {
        throw new TypeError("application/json is required");
    }
    const body = await request.json();
    const email = String(body?.email || "").trim().toLowerCase();
    const appPassword = String(body?.app_password || "").trim();
    const caldavUrl = String(body?.caldav_url || "https://caldav.icloud.com").trim();
    let parsedUrl;
    try { parsedUrl = new URL(caldavUrl); } catch { throw new TypeError("A valid CalDAV URL is required"); }
    if (!EMAIL_PATTERN.test(email) || email.length > 320 || !appPassword || appPassword.length > 256
        || parsedUrl.protocol !== "https:") {
        throw new TypeError("Valid Apple email, app password, and HTTPS CalDAV URL are required");
    }
    return { email, appPassword, caldavUrl: parsedUrl.toString().replace(/\/$/, "") };
}

export async function handleAppleAccountRequest(request, env, adapter, { validate = validateAppleCredentials } = {}) {
    let values;
    try {
        values = await parseRequest(request);
    } catch (error) {
        return json({ success: false, message: error.message }, 422);
    }

    try {
        await validate(values);
        if (new URL(request.url).pathname.endsWith("/test")) {
            return json({ success: true, message: "Connection successful" });
        }
        const accountId = await executeOAuthAccountUpsert(adapter, {
            userId: env.userId,
            provider: "apple",
            accountEmail: values.email,
            accessToken: values.caldavUrl,
            refreshToken: values.appPassword,
            tokenExpiresAt: null,
            displayName: values.email,
            providerId: null,
            tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
        });
        return json({ success: true, message: "Apple connected", account_id: accountId || null });
    } catch (error) {
        if (error instanceof ProviderAuthorizationError) {
            return json({ success: false, message: "Apple credentials were not accepted" }, 401);
        }
        if (error instanceof ProviderResponseError) {
            return json({ success: false, message: "Apple Calendar is temporarily unavailable" }, error.status || 502);
        }
        throw error;
    }
}