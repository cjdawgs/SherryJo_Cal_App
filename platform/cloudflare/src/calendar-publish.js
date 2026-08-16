import { fernetDecrypt, fernetEncrypt } from "./fernet.js";
import { ensureProviderAccessToken } from "./provider-calendar-sync.js";

const GOOGLE_EVENTS = "https://www.googleapis.com/calendar/v3/calendars";
const GRAPH_EVENTS = "https://graph.microsoft.com/v1.0/me/events";

function normalizeProvider(value) {
    const provider = String(value || "").trim().toLowerCase();
    if (["gmail", "google"].includes(provider)) return "google";
    if (["outlook", "office365", "ms", "msft", "microsoft"].includes(provider)) return "microsoft";
    return provider;
}

async function deterministicBytes(value) {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function googleCreateId(userId, eventId, targetKey) {
    const bytes = await deterministicBytes(`${userId}:${eventId}:${targetKey}`);
    const alphabet = "0123456789abcdefghijklmnopqrstuv";
    return `sj${[...bytes].map((byte) => alphabet[byte & 31]).join("").slice(0, 24)}`;
}

async function microsoftTransactionId(userId, eventId, targetKey) {
    const bytes = await deterministicBytes(`${userId}:${eventId}:${targetKey}`);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function eventPayload(event, provider, createIdentity = null) {
    if (provider === "google") {
        return {
            ...(createIdentity ? { id: createIdentity } : {}),
            summary: event.title || "Untitled Event", description: event.description || "",
            start: { dateTime: new Date(event.start_time).toISOString() },
            ...(event.end_time ? { end: { dateTime: new Date(event.end_time).toISOString() } } : {}),
        };
    }
    return {
        subject: event.title || "Untitled Event",
        body: { contentType: "HTML", content: event.description || "" },
        start: { dateTime: new Date(event.start_time).toISOString(), timeZone: "UTC" },
        ...(event.end_time ? { end: { dateTime: new Date(event.end_time).toISOString(), timeZone: "UTC" } } : {}),
        ...(createIdentity ? { transactionId: createIdentity } : {}),
    };
}

async function providerRequest(url, token, method, body, fetchImpl) {
    const response = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        ...(typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(20000) } : {}),
    });
    let payload = {};
    try { payload = await response.json(); } catch { /* Empty provider response. */ }
    return { response, payload };
}

function providerCreatedId(result, provider) {
    const payloadId = String(result.payload?.id || "").trim();
    if (payloadId) return payloadId;
    if (provider !== "microsoft") return null;
    for (const name of ["OData-EntityId", "Location", "Content-Location"]) {
        const value = String(result.response.headers.get(name) || "").trim();
        const match = value.match(/(?:events\/|events\(['"]?)([^/'"?)]+)(?:['"]?\))?\/?$/i);
        if (match?.[1]) return decodeURIComponent(match[1]);
    }
    return null;
}

async function publishTarget({ userId, event, account, targetKey, rawId, env, fetchImpl }) {
    const tokenResult = await ensureProviderAccessToken(account, env, fetchImpl);
    const provider = normalizeProvider(account.provider);
    const calendarId = encodeURIComponent(account.account_email || "primary");
    const base = provider === "google" ? `${GOOGLE_EVENTS}/${calendarId}/events` : GRAPH_EVENTS;
    if (rawId) {
        const update = await providerRequest(`${base}/${encodeURIComponent(rawId)}`, tokenResult.accessToken, "PATCH", eventPayload(event, provider), fetchImpl);
        if (update.response.ok) return { action: "updated", rawId, tokenResult };
        if (![404, 410].includes(update.response.status)) throw new Error(`${provider} update failed (${update.response.status})`);
    }
    const identity = provider === "google"
        ? await googleCreateId(userId, event.id, targetKey)
        : await microsoftTransactionId(userId, event.id, targetKey);
    const created = await providerRequest(base, tokenResult.accessToken, "POST", eventPayload(event, provider, identity), fetchImpl);
    if (!created.response.ok && !(provider === "google" && created.response.status === 409)) {
        throw new Error(`${provider} create failed (${created.response.status})`);
    }
    const createdId = providerCreatedId(created, provider) || (provider === "google" ? identity : null);
    if (!createdId) throw new Error(`${provider} create succeeded without an event identifier`);
    return { action: "created", rawId: createdId, tokenResult };
}

async function deleteTarget({ account, rawId, env, fetchImpl }) {
    const tokenResult = await ensureProviderAccessToken(account, env, fetchImpl);
    const provider = normalizeProvider(account.provider);
    const calendarId = encodeURIComponent(account.account_email || "primary");
    const url = provider === "google"
        ? `${GOOGLE_EVENTS}/${calendarId}/events/${encodeURIComponent(rawId)}`
        : `${GRAPH_EVENTS}/${encodeURIComponent(rawId)}`;
    const result = await providerRequest(url, tokenResult.accessToken, "DELETE", null, fetchImpl);
    if (!result.response.ok && ![404, 410].includes(result.response.status)) throw new Error(`${provider} delete failed (${result.response.status})`);
    return tokenResult;
}

function targetParts(key) {
    if (typeof key !== "string" || !key.includes(":")) return null;
    const [providerPart, ...emailParts] = key.split(":");
    const provider = normalizeProvider(providerPart);
    const email = emailParts.join(":").trim().toLowerCase();
    return ["google", "microsoft"].includes(provider) && email ? { provider, email, key: `${provider}:${email}` } : null;
}

export async function executeCalendarPublish(adapter, { userId, body, env, fetchImpl = fetch }) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Publish request must be an object");
    const requestedIds = body.event_ids === undefined ? null : Array.isArray(body.event_ids) ? body.event_ids.map(Number).filter(Number.isSafeInteger) : [];
    const deletedEntries = Array.isArray(body.deleted_events) ? body.deleted_events : [];
    if (requestedIds?.length === 0 && !deletedEntries.length) {
        return { status: "success", published: 0, failed: 0, message: "No modified events to publish — make edits first" };
    }
    const data = await adapter.loadPublishData(userId, requestedIds);
    const accounts = new Map();
    for (const row of data.accounts) {
        const provider = normalizeProvider(row.provider);
        const key = `${provider}:${String(row.account_email || "").trim().toLowerCase()}`;
        try {
            accounts.set(key, {
                ...row, provider,
                access_token: await fernetDecrypt(row.access_token || "", env.TOKEN_ENCRYPTION_KEY || ""),
                refresh_token: await fernetDecrypt(row.refresh_token || "", env.TOKEN_ENCRYPTION_KEY || ""),
            });
        } catch { /* Invalid credentials become a no-token warning. */ }
    }
    let published = 0; let created = 0; let deleted = 0; let failed = 0;
    const affected = new Set(); const warnings = []; const accountResults = [];
    const persistToken = async (account, tokenResult) => {
        if (!tokenResult.refreshed) return;
        await adapter.updateAccountToken(userId, account.id, {
            accessToken: await fernetEncrypt(tokenResult.accessToken, env.TOKEN_ENCRYPTION_KEY || ""),
            refreshToken: await fernetEncrypt(tokenResult.refreshToken, env.TOKEN_ENCRYPTION_KEY || ""),
            expiresAt: tokenResult.expiresAt,
        });
    };
    for (const deletedEntry of deletedEntries) {
        for (const [key, rawId] of Object.entries(deletedEntry?.external_ids || {})) {
            const target = targetParts(key); const account = target && accounts.get(target.key);
            if (!target || !account || !rawId) continue;
            try { const token = await deleteTarget({ account, rawId, env, fetchImpl }); await persistToken(account, token); deleted += 1; affected.add(target.key); }
            catch (error) { failed += 1; warnings.push(`Delete failed for ${target.key}: ${error.message}`); }
        }
    }
    for (const event of data.events) {
        const externalIds = { ...(event.external_ids || {}) };
        const selected = body.publish_targets?.[String(event.id)];
        const keys = body.publish_all_accounts
            ? [...accounts.keys()]
            : Array.isArray(selected) && selected.length ? selected : Object.keys(externalIds);
        let eventSucceeded = false;
        for (const key of keys) {
            const target = targetParts(key); const account = target && accounts.get(target.key);
            const resultRow = { target_key: target?.key || key, provider: target?.provider, account_email: target?.email, linked: Boolean(externalIds[key]), action: externalIds[key] ? "update" : "create", ok: false, status: "pending", message: "" };
            if (!target || !account) { resultRow.status = "no_token"; resultRow.message = `No valid token for ${key}`; warnings.push(resultRow.message); accountResults.push(resultRow); continue; }
            try {
                const result = await publishTarget({ userId, event, account, targetKey: target.key, rawId: externalIds[target.key], env, fetchImpl });
                await persistToken(account, result.tokenResult);
                externalIds[target.key] = result.rawId;
                resultRow.ok = true; resultRow.status = result.action; resultRow.message = `${result.action === "created" ? "Created" : "Updated"} ${target.key}`;
                created += result.action === "created" ? 1 : 0; eventSucceeded = true; affected.add(target.key);
            } catch (error) { failed += 1; resultRow.status = "failed"; resultRow.message = `Publish failed for ${target.key}: ${error.message}`; warnings.push(resultRow.message); }
            accountResults.push(resultRow);
        }
        if (eventSucceeded) { published += 1; await adapter.updateEventLinks(userId, event.id, externalIds); }
    }
    const starts = data.events.map((event) => event.start_time).filter(Boolean).sort();
    return { status: "success", published, created, deleted, failed, total_events: data.events.length, affected_accounts: [...affected].sort(), range_start: starts[0]?.toISOString?.().slice(0, 10) || String(starts[0] || "").slice(0, 10) || null, range_end: starts.at(-1)?.toISOString?.().slice(0, 10) || String(starts.at(-1) || "").slice(0, 10) || null, warnings, account_results: accountResults };
}