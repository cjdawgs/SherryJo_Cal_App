import { executeCalendarRead } from "./calendar-read-postgres.js";
import {
    EventCreateIdempotencyConflictError,
    executeEventCreate,
} from "./event-create-postgres.js";
import {
    EventMutationIdempotencyConflictError,
    EventNotFoundError,
    EventUpdateConflictError,
    executeEventDelete,
    executeEventUpdate,
} from "./event-mutate-postgres.js";
import { createHyperdriveCalendarReadAdapter } from "./calendar-read-hyperdrive.js";
import {
    executeDateStickyItemRead,
    executeDateStickyListRead,
} from "./date-sticky-read-postgres.js";
import {
    IdempotencyConflictError,
    executeDateStickyWrite,
} from "./date-sticky-write-postgres.js";
import {
    CurrentUserNotFoundError,
    executeCurrentUserRead,
} from "./current-user-read-postgres.js";
import { authenticateTvRequest, authenticateWorkerRequest, JwtVerificationError } from "./jwt.js";
import { issueTvToken } from "./auth-token-issue.js";
import { executeLegacyEventRead } from "./legacy-event-read-postgres.js";
import { executeNoteRead } from "./note-read-postgres.js";
import {
    executeNoteWrite,
    NoteEventNotFoundError,
    NoteWriteConflictError,
} from "./note-write-postgres.js";
import { executeTagColorRead } from "./tag-color-read-postgres.js";
import {
    executeTagColorWrite,
    TagColorIdempotencyConflictError,
} from "./tag-color-write-postgres.js";
import { executeTaskRead } from "./task-read-postgres.js";
import { executeTaskWrite, TaskWriteConflictError } from "./task-write-postgres.js";
import { handleGoogleLogin, handleGoogleCallback } from "./google-oauth.js";
import { handleMsLogin, handleMsCallback } from "./ms-oauth.js";
import { runAccountSyncNow, runScheduledCalendarSync } from "./scheduled-calendar-sync.js";
import { createNativeAuthPostgresAdapter } from "./native-auth-postgres.js";
import { handleNativeLogin, handleNativeRegistration } from "./native-auth.js";
import { executeAccountRead, executeSyncRollupRead } from "./account-read-postgres.js";
import { handleAppleAccountRequest } from "./apple-account.js";
import {
    AccountNotFoundError,
    executeAccountColorUpdate,
    executeAccountDelete,
    executeAccountPrimaryUpdate,
    executeAccountSettingsUpdate,
    executeAccountSyncToggle,
} from "./account-mutate-postgres.js";
import {
    InvalidPairingCodeError,
    autoRedeemTvPairingCode,
    createTvPairingCode,
    createTvPairingPostgresAdapter,
    pairingClientFingerprint,
    redeemTvPairingCode,
} from "./tv-pairing-postgres.js";
import { executeTvStateRead, executeTvStateWrite, TvStateUserNotFoundError } from "./tv-state-postgres.js";
import { assembleTvEvents, tvViewWindow } from "./tv-events.js";
import { executeTvAccountLegendRead } from "./tv-events-postgres.js";
import { executeTvDiagnosticsRead, executeTvDiagnosticsWrite, TvDiagnosticsForbiddenError } from "./tv-diagnostics-postgres.js";
import { CalendarImportError, handleCalendarImport } from "./calendar-import.js";
import { executeCalendarPublish } from "./calendar-publish.js";
import { CalendarPublishPostgresAdapter } from "./calendar-publish-postgres.js";
import { issueWebSocketTicket, openNativeWebSocket } from "./websocket-postgres.js";
import { handleAdminApi } from "./admin-api.js";
import { materializeDedup, runManualCalendarSync, upsertLegacyEventNote } from "./calendar-operations.js";

const EDGE_HEALTH_PATH = "/__edge/health";
const PLATFORM_STATUS_PATH = "/api/platform/status";
const ADMIN_SYSTEM_OVERVIEW_PATH = "/admin/system/overview";
const CALENDAR_READ_PATH = "/calendar/unified";
const EVENT_WRITE_PATH = "/calendar/event";
const DATE_STICKY_READ_PATH = "/calendar/date-sticky";
const TV_DATE_STICKY_WRITE_PATH = "/tv/date-sticky";
const TAG_COLOR_READ_PATH = "/calendar/tag-colors";
const CURRENT_USER_READ_PATH = "/users/me";
const LEGACY_EVENT_READ_PATH = "/events/";
const NOTE_READ_PATH = "/notes/";
const TASK_READ_PATH = "/tasks/";
const TV_VERSION_READ_PATH = "/tv/version";
const GOOGLE_LOGIN_PATH = "/auth/google/login";
const GOOGLE_CALLBACK_PATH = "/auth/google/callback";
const MS_LOGIN_PATH = "/ms/login";
const MS_CALLBACK_PATH = "/ms/callback";
const AUTH_LOGIN_PATH = "/auth/login";
const AUTH_REGISTER_PATH = "/auth/register";
const ACCOUNT_LIST_PATH = "/accounts";
const ACCOUNT_SYNC_STATUS_PATH = "/accounts/sync-status";
const ACCOUNT_SYNC_ROLLUPS_PATH = "/accounts/sync-rollups";
const APPLE_TEST_PATH = "/accounts/apple/test";
const APPLE_CONNECT_PATH = "/accounts/apple/connect";
const TV_GENERATE_CODE_PATH = "/tv/generate-code";
const TV_PAIR_PATH = "/tv/pair";
const TV_AUTO_PAIR_PATH = "/tv/auto-pair";
const TV_STATE_PATH = "/tv/state";
const TV_EVENTS_PATH = "/tv/events";
const NATIVE_PAGE_ASSETS = new Map([
    ["/", "/index.html"],
    ["/calendar-ui", "/index.html"],
    ["/login", "/login.html"],
    ["/accounts/ui", "/accounts.html"],
    ["/admin", "/admin.html"],
    ["/admin/ui", "/admin.html"],
]);
const CALENDAR_READ_MODES = new Set(["proxy", "shadow", "canary", "native"]);
const WRITE_MODES = new Set(["proxy", "canary", "native"]);
const ORIGIN_FALLBACK_MODES = new Set(["proxy", "severed"]);

function originFallbackMode(env) {
    const mode = String(env.ORIGIN_FALLBACK_MODE || "proxy").trim().toLowerCase();
    return ORIGIN_FALLBACK_MODES.has(mode) ? mode : "severed";
}

function authMode(env) {
    return String(env.AUTH_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function accountReadMode(env) {
    return String(env.ACCOUNT_READ_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function accountWriteMode(env) {
    return String(env.ACCOUNT_WRITE_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function tvPairingMode(env) {
    return String(env.TV_PAIRING_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function tvStateMode(env) {
    return String(env.TV_STATE_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function tvEventsMode(env) {
    return String(env.TV_EVENTS_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function tvDiagnosticsMode(env) {
    return String(env.TV_DIAGNOSTICS_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function calendarImportMode(env) {
    return String(env.CALENDAR_IMPORT_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function calendarPublishMode(env) {
    return String(env.CALENDAR_PUBLISH_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function webSocketMode(env) {
    return String(env.WEBSOCKET_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function adminApiMode(env) {
    return String(env.ADMIN_API_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

function calendarSyncMode(env) {
    return String(env.CALENDAR_SYNC_MODE || "proxy").trim().toLowerCase() === "native" ? "native" : "proxy";
}

async function nativeTvDiagnostics(request, incomingUrl, env) {
    const claims = await authenticateTvRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    if (request.method === "POST") {
        return jsonResponse(await executeTvDiagnosticsWrite(adapter, {
            userId: claims.user_id,
            body: await request.json(),
            userAgent: request.headers.get("user-agent"),
        }));
    }
    return jsonResponse(await executeTvDiagnosticsRead(adapter, {
        userId: claims.user_id,
        scope: incomingUrl.searchParams.get("scope"),
        hours: incomingUrl.searchParams.get("hours"),
        eventGroup: incomingUrl.searchParams.get("event_group"),
    }));
}

async function nativeTvEvents(request, incomingUrl, env) {
    const claims = await authenticateTvRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    const state = await executeTvStateRead(adapter, claims.user_id);
    const selectedDate = String(incomingUrl.searchParams.get("selectedDate") || state.selectedDate || "").trim() || null;
    const requestedView = String(incomingUrl.searchParams.get("currentView") || "").trim().toLowerCase();
    const currentView = ["day", "3-day", "week", "month"].includes(requestedView) ? requestedView : state.currentView;
    const appVersion = String(env.TV_APP_VERSION || env.WORKER_GIT_COMMIT || "worker").trim();
    if (!selectedDate) return jsonResponse(assembleTvEvents({ selectedDate, currentView, appVersion }));
    const window = tvViewWindow(selectedDate, currentView);
    const [events, stickyResult, accounts] = await Promise.all([
        adapter.listEvents({ userId: claims.user_id, start: window.start, end: new Date(window.end.getTime() + 24 * 60 * 60 * 1000 - 1), dedupEnabled: incomingUrl.searchParams.get("dedup") !== "false" }),
        executeDateStickyListRead(adapter, claims.user_id),
        executeTvAccountLegendRead(adapter, claims.user_id),
    ]);
    return jsonResponse(assembleTvEvents({
        selectedDate, currentView, events, stickyItems: stickyResult.items, accounts, appVersion,
    }));
}

async function nativeTvState(request, env) {
    const claims = await authenticateTvRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    if (request.method === "GET") return jsonResponse(await executeTvStateRead(adapter, claims.user_id));
    const allowSleepTimeout = String(env.TV_SLEEP_GUARD_ALLOW_TIMEOUT || "0").trim().toLowerCase() === "1";
    return jsonResponse(await executeTvStateWrite(adapter, {
        userId: claims.user_id,
        body: await request.json(),
        allowSleepTimeout,
    }));
}

async function nativeTvGenerateCode(request, env) {
    const claims = await authenticateWorkerRequest(request, env);
    return jsonResponse(await createTvPairingCode(createTvPairingPostgresAdapter(env), {
        userId: claims.user_id,
        clientFingerprint: pairingClientFingerprint(request),
    }));
}

async function pairedTvResponse(env, pairing) {
    return jsonResponse({
        token: await issueTvToken(pairing.userId, env),
        selectedDate: null,
        currentView: "day",
    });
}

async function nativeTvPair(request, env) {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("Pairing request must be an object");
    const pairing = await redeemTvPairingCode(createTvPairingPostgresAdapter(env), body.pairingCode);
    return pairedTvResponse(env, pairing);
}

async function nativeTvAutoPair(request, env) {
    const pairing = await autoRedeemTvPairingCode(
        createTvPairingPostgresAdapter(env),
        pairingClientFingerprint(request),
    );
    return pairedTvResponse(env, pairing);
}

function accountMutation(incomingUrl) {
    const match = incomingUrl.pathname.match(/^\/accounts\/(\d+)(?:\/(sync-settings|color|set-primary|sync\/(true|false)))?$/);
    if (!match) return null;
    return { accountId: Number(match[1]), action: match[2] || "delete", enabled: match[3] === "true" };
}

function accountSyncRequestId(incomingUrl) {
    const match = incomingUrl.pathname.match(/^\/accounts\/(\d+)\/(?:retry|refresh-sync)$/);
    return match ? Number(match[1]) : null;
}

async function nativeAccountSyncNow(request, incomingUrl, env) {
    const claims = await authenticateWorkerRequest(request, env);
    const accountId = accountSyncRequestId(incomingUrl);
    if (!accountId) throw new TypeError("Invalid account sync request");
    const result = await runAccountSyncNow(env, claims.user_id, accountId);
    if (result.status === "not_available") {
        return jsonResponse({ success: false, message: "Account is unavailable or already syncing" }, 409);
    }
    if (result.status !== "succeeded") {
        return jsonResponse({ success: false, message: "Sync failed", error: result.errorType || result.status }, 502);
    }
    const account = await createHyperdriveCalendarReadAdapter(env).runWithIdentity(claims.user_id, async (client) => (
        await client.query("SELECT provider, account_email FROM public.oauth_accounts WHERE id=$1 AND user_id=public.worker_app_user_id()", [accountId])
    ).rows[0] || null);
    return jsonResponse({
        success: true, message: "Sync successful", account_id: accountId,
        sync_result: result, account, checked_at: new Date().toISOString(),
    });
}

async function nativeAccountMutation(request, incomingUrl, env) {
    const claims = await authenticateWorkerRequest(request, env);
    const mutation = accountMutation(incomingUrl);
    if (!mutation) throw new TypeError("Invalid account mutation path");
    const adapter = createHyperdriveCalendarReadAdapter(env);
    const input = { userId: claims.user_id, accountId: mutation.accountId };
    if (request.method === "DELETE" && mutation.action === "delete") return jsonResponse(await executeAccountDelete(adapter, input));
    if (request.method !== "PUT") throw new TypeError("Invalid account mutation method");
    if (mutation.action === "sync-settings") return jsonResponse(await executeAccountSettingsUpdate(adapter, { ...input, data: await request.json() }));
    if (mutation.action === "color") return jsonResponse(await executeAccountColorUpdate(adapter, { ...input, color: (await request.json()).color }));
    if (mutation.action === "set-primary") return jsonResponse(await executeAccountPrimaryUpdate(adapter, input));
    if (mutation.action.startsWith("sync/")) return jsonResponse(await executeAccountSyncToggle(adapter, { ...input, enabled: mutation.enabled }));
    throw new TypeError("Invalid account mutation");
}

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
        },
    });
}

async function nativeAssetResponse(request, incomingUrl, env) {
    const pageAsset = NATIVE_PAGE_ASSETS.get(incomingUrl.pathname);
    if (!pageAsset && !incomingUrl.pathname.startsWith("/static/")) {
        return null;
    }
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
        return jsonResponse({
            error: "Worker assets binding is not configured",
            code: "worker_assets_unavailable",
        }, 503);
    }

    const assetUrl = new URL(pageAsset || `${incomingUrl.pathname}${incomingUrl.search}`, incomingUrl.origin);
    const assetRequest = new Request(assetUrl, request);
    return env.ASSETS.fetch(assetRequest);
}

function tvAppVersion(env) {
    return String(env.TV_APP_VERSION || env.WORKER_GIT_COMMIT || "worker").trim();
}

async function tvHtmlAsset(request, incomingUrl, env, assetPath, replacements = {}) {
    if (!env.ASSETS || typeof env.ASSETS.fetch !== "function") {
        return jsonResponse({ error: "Worker assets binding is not configured", code: "worker_assets_unavailable" }, 503);
    }
    const assetResponse = await env.ASSETS.fetch(new Request(new URL(assetPath, incomingUrl.origin), request));
    if (!assetResponse.ok) return assetResponse;
    let html = await assetResponse.text();
    html = html.replaceAll("__TV_APP_VERSION__", tvAppVersion(env));
    for (const [placeholder, value] of Object.entries(replacements)) html = html.replaceAll(placeholder, value);
    const headers = new Headers(assetResponse.headers);
    headers.set("cache-control", "no-store, max-age=0, must-revalidate");
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("pragma", "no-cache");
    return new Response(html, { status: assetResponse.status, headers });
}

async function nativeTvDashboard(request, incomingUrl, env) {
    return tvHtmlAsset(request, incomingUrl, env, "/tv.html");
}

async function nativeTvKiosk(request, incomingUrl, env) {
    const token = String(incomingUrl.searchParams.get("token") || "").trim();
    if (!token) return jsonResponse({ detail: "Invalid or expired kiosk token. Generate a new one from Admin." }, 401);
    try {
        await authenticateTvRequest(new Request(incomingUrl, { headers: { authorization: `Bearer ${token}` } }), env);
    } catch (error) {
        if (error instanceof JwtVerificationError) {
            return jsonResponse({ detail: "Invalid or expired kiosk token. Generate a new one from Admin." }, 401);
        }
        throw error;
    }
    return tvHtmlAsset(request, incomingUrl, env, "/tv-kiosk.html", {
        __KIOSK_TOKEN__: JSON.stringify(token).slice(1, -1),
    });
}

async function nativeTvKioskToken(request, incomingUrl, env) {
    const claims = await authenticateWorkerRequest(request, env);
    const token = await issueTvToken(claims.user_id, env);
    return jsonResponse({
        token,
        kiosk_url: `${incomingUrl.origin}/tv/kiosk?token=${encodeURIComponent(token)}`,
        expires_in: "persistent",
        note: "Paste kiosk_url into your signage platform (Kitcast, etc.). No pairing or interaction needed.",
    });
}

function resolveOrigin(env) {
    const configuredOrigin = String(env.ORIGIN_BASE_URL || "").trim();
    if (!configuredOrigin) {
        throw new Error("ORIGIN_BASE_URL is not configured");
    }

    const origin = new URL(configuredOrigin);
    if (origin.protocol !== "https:") {
        throw new Error("ORIGIN_BASE_URL must use HTTPS");
    }
    return origin;
}

function buildOriginRequest(request, origin, env) {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.hostname === origin.hostname) {
        throw new Error("ORIGIN_BASE_URL must not point to this Worker hostname");
    }

    const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", incomingUrl.host);
    headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
    headers.set("x-sherryjo-edge", "cloudflare");
    headers.delete("x-sherryjo-edge-auth");
    const edgeProxySecret = String(env.EDGE_PROXY_SECRET || "");
    if (edgeProxySecret) {
        headers.set("x-sherryjo-edge-auth", edgeProxySecret);
    }

    return new Request(targetUrl, {
        method: request.method,
        headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
        redirect: "manual",
    });
}

function rewriteOriginRedirect(response, origin, publicOrigin) {
    const location = response.headers.get("location");
    if (!location) {
        return response;
    }

    const redirectUrl = new URL(location, origin);
    if (redirectUrl.origin !== origin.origin) {
        return response;
    }

    redirectUrl.protocol = publicOrigin.protocol;
    redirectUrl.host = publicOrigin.host;
    const headers = new Headers(response.headers);
    headers.set("location", redirectUrl.toString());
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

function calendarReadMode(env) {
    const mode = String(env.CALENDAR_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function taskReadMode(env) {
    const mode = String(env.TASK_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function taskWriteMode(env) {
    const mode = String(env.TASK_WRITE_MODE || "proxy").trim().toLowerCase();
    return WRITE_MODES.has(mode) ? mode : "proxy";
}

function noteReadMode(env) {
    const mode = String(env.NOTE_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function noteWriteMode(env) {
    const mode = String(env.NOTE_WRITE_MODE || "proxy").trim().toLowerCase();
    return WRITE_MODES.has(mode) ? mode : "proxy";
}

function dateStickyReadMode(env) {
    const mode = String(env.DATE_STICKY_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function dateStickyWriteMode(env) {
    const mode = String(env.DATE_STICKY_WRITE_MODE || "proxy").trim().toLowerCase();
    return WRITE_MODES.has(mode) ? mode : "proxy";
}

function eventWriteMode(env) {
    const mode = String(env.EVENT_WRITE_MODE || "proxy").trim().toLowerCase();
    return WRITE_MODES.has(mode) ? mode : "proxy";
}

function tagColorReadMode(env) {
    const mode = String(env.TAG_COLOR_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function tagColorWriteMode(env) {
    const mode = String(env.TAG_COLOR_WRITE_MODE || "proxy").trim().toLowerCase();
    return WRITE_MODES.has(mode) ? mode : "proxy";
}

function currentUserReadMode(env) {
    const mode = String(env.CURRENT_USER_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function tvVersionReadMode(env) {
    const mode = String(env.TV_VERSION_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function googleAuthMode(env) {
    const mode = String(env.GOOGLE_AUTH_MODE || "proxy").trim().toLowerCase();
    return WRITE_MODES.has(mode) ? mode : "proxy";
}

function msAuthMode(env) {
    const mode = String(env.MS_AUTH_MODE || "proxy").trim().toLowerCase();
    return WRITE_MODES.has(mode) ? mode : "proxy";
}

function legacyEventReadMode(env) {
    const mode = String(env.LEGACY_EVENT_READ_MODE || "proxy").trim().toLowerCase();
    return CALENDAR_READ_MODES.has(mode) ? mode : "proxy";
}

function parseIsoUtc(value) {
    const candidate = String(value || "").trim();
    if (!candidate) return null;
    const hasTimezone = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/i.test(candidate);
    const parsed = new Date(hasTimezone ? candidate : `${candidate}Z`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function parseCalendarReadQuery(incomingUrl, userId, now = new Date()) {
    let start = parseIsoUtc(incomingUrl.searchParams.get("start"));
    let end = parseIsoUtc(incomingUrl.searchParams.get("end"));
    if (!start || !end) {
        const rawRangeDays = incomingUrl.searchParams.get("range_days");
        const rangeDays = rawRangeDays === null ? 30 : Number(rawRangeDays);
        if (!Number.isInteger(rangeDays)) {
            throw new TypeError("range_days must be an integer");
        }
        const rangeMilliseconds = rangeDays * 24 * 60 * 60 * 1000;
        start = new Date(now.getTime() - rangeMilliseconds);
        end = new Date(now.getTime() + rangeMilliseconds);
    }
    return {
        userId,
        start,
        end,
        dedupEnabled: incomingUrl.searchParams.get("dedup") !== "false",
    };
}

function canaryUserAllowed(env, userId) {
    return String(env.CALENDAR_READ_CANARY_USER_IDS || "")
        .split(",")
        .map((value) => Number(value.trim()))
        .some((value) => Number.isSafeInteger(value) && value === userId);
}

async function nativeCalendarRead(request, incomingUrl, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const query = parseCalendarReadQuery(incomingUrl, claims.user_id);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeCalendarRead(adapter, query));
}

async function nativeTaskRead(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeTaskRead(adapter, claims.user_id));
}

async function nativeNoteRead(request, incomingUrl, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeNoteRead(adapter, {
        userId: claims.user_id,
        date: incomingUrl.searchParams.get("date"),
    }));
}

function dateStickyKey(incomingUrl) {
    const prefix = `${DATE_STICKY_READ_PATH}/`;
    return incomingUrl.pathname.startsWith(prefix)
        ? decodeURIComponent(incomingUrl.pathname.slice(prefix.length))
        : null;
}

function tvDateStickyKey(incomingUrl) {
    const prefix = `${TV_DATE_STICKY_WRITE_PATH}/`;
    return incomingUrl.pathname.startsWith(prefix)
        ? decodeURIComponent(incomingUrl.pathname.slice(prefix.length))
        : null;
}

function dateStickyWriteKey(incomingUrl) {
    return dateStickyKey(incomingUrl) ?? tvDateStickyKey(incomingUrl);
}

function isDateStickyReadPath(incomingUrl) {
    return incomingUrl.pathname === DATE_STICKY_READ_PATH || dateStickyKey(incomingUrl) !== null;
}

async function nativeDateStickyRead(request, incomingUrl, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    const date = dateStickyKey(incomingUrl);
    return jsonResponse(date === null
        ? await executeDateStickyListRead(adapter, claims.user_id)
        : await executeDateStickyItemRead(adapter, { userId: claims.user_id, date }));
}

function canonicalJson(value) {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

async function sha256Hex(value) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function nativeDateStickyWrite(request, incomingUrl, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const date = dateStickyWriteKey(incomingUrl);
    if (!date) throw new TypeError("date is required");

    const idempotencyKey = String(request.headers.get("idempotency-key") || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
        throw new TypeError("A valid Idempotency-Key is required");
    }

    const data = await request.json();
    const stickyNotes = data?.sticky_notes ?? data?.stickyNotes ?? [];
    const requestHash = await sha256Hex(canonicalJson({ date, sticky_notes: stickyNotes }));
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeDateStickyWrite(adapter, {
        userId: claims.user_id,
        date,
        stickyNotes,
        idempotencyKey,
        requestHash,
    }));
}

async function nativeEventCreate(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const idempotencyKey = String(request.headers.get("idempotency-key") || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new TypeError("A valid Idempotency-Key is required");
    const data = await request.json();
    const requestHash = await sha256Hex(canonicalJson(data));
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeEventCreate(adapter, { userId: claims.user_id, data, idempotencyKey, requestHash }));
}

function eventId(incomingUrl) {
    const prefix = `${EVENT_WRITE_PATH}/`;
    if (!incomingUrl.pathname.startsWith(prefix)) return null;
    const value = Number(incomingUrl.pathname.slice(prefix.length));
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function nativeEventMutation(request, incomingUrl, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const id = eventId(incomingUrl);
    if (!id) throw new TypeError("A valid event ID is required");
    const idempotencyKey = String(request.headers.get("idempotency-key") || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new TypeError("A valid Idempotency-Key is required");
    const data = request.method === "PUT" ? await request.json() : {};
    const requestHash = await sha256Hex(canonicalJson({ eventId: id, method: request.method, data }));
    const adapter = createHyperdriveCalendarReadAdapter(env);
    const input = { userId: claims.user_id, eventId: id, data, idempotencyKey, requestHash };
    return jsonResponse(request.method === "PUT"
        ? await executeEventUpdate(adapter, input)
        : await executeEventDelete(adapter, input));
}

function tvEventId(incomingUrl) {
    const match = incomingUrl.pathname.match(/^\/tv\/events\/(\d+)$/);
    const value = Number(match?.[1]);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function nativeTvEventWrite(request, incomingUrl, env) {
    const claims = await authenticateTvRequest(request, env);
    const source = await request.json();
    const data = { ...source, start_time: source.start_time ?? source.start, end_time: source.end_time ?? source.end };
    const idempotencyKey = `tv-event:${crypto.randomUUID()}`;
    const adapter = createHyperdriveCalendarReadAdapter(env);
    if (request.method === "POST") {
        return jsonResponse(await executeEventCreate(adapter, {
            userId: claims.user_id, data, idempotencyKey, requestHash: await sha256Hex(canonicalJson(data)),
        }));
    }
    const id = tvEventId(incomingUrl);
    if (!id) throw new TypeError("A valid event ID is required");
    return jsonResponse(await executeEventUpdate(adapter, {
        userId: claims.user_id, eventId: id, data, idempotencyKey,
        requestHash: await sha256Hex(canonicalJson({ eventId: id, method: "PUT", data })),
    }));
}

async function nativeTvDateStickyWrite(request, incomingUrl, env) {
    const claims = await authenticateTvRequest(request, env);
    const data = await request.json();
    const forwarded = new Request(request.url, {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": `tv-sticky:${crypto.randomUUID()}` },
        body: JSON.stringify(data),
    });
    return nativeDateStickyWrite(forwarded, incomingUrl, env, claims);
}

async function nativeTvAdminUsers(request, env) {
    const claims = await authenticateTvRequest(request, env);
    const rows = await createHyperdriveCalendarReadAdapter(env).runWithIdentity(claims.user_id, async (client) => {
        const allowed = await client.query("SELECT public.worker_app_is_admin() AS allowed");
        if (!allowed.rows[0]?.allowed) return null;
        return (await client.query("SELECT id,email,role FROM public.users ORDER BY id")).rows;
    });
    return rows ? jsonResponse(rows) : jsonResponse({ detail: "Admin only" }, 403);
}

async function nativeLocalCreate(request, env, execute, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const idempotencyKey = String(request.headers.get("idempotency-key") || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200) throw new TypeError("A valid Idempotency-Key is required");
    const data = await request.json();
    const requestHash = await sha256Hex(canonicalJson(data));
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await execute(adapter, { userId: claims.user_id, data, idempotencyKey, requestHash }));
}

async function nativeTagColorRead(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeTagColorRead(adapter, claims.user_id));
}

async function nativeTagColorWrite(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const idempotencyKey = String(request.headers.get("idempotency-key") || "").trim();
    if (!idempotencyKey || idempotencyKey.length > 200) {
        throw new TypeError("A valid Idempotency-Key is required");
    }

    const data = await request.json();
    if (!data?.settings || typeof data.settings !== "object" || Array.isArray(data.settings)) {
        throw new TypeError("settings object is required");
    }
    const requestHash = await sha256Hex(canonicalJson({ settings: data.settings }));
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeTagColorWrite(adapter, {
        userId: claims.user_id,
        settings: data.settings,
        idempotencyKey,
        requestHash,
    }));
}

async function nativeCurrentUserRead(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeCurrentUserRead(adapter, claims.user_id));
}

async function nativeAccountRead(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeAccountRead(adapter, {
        userId: claims.user_id,
        tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    }));
}

async function nativeAccountSyncStatus(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    const accounts = await executeAccountRead(adapter, {
        userId: claims.user_id,
        tokenEncryptionKey: env.TOKEN_ENCRYPTION_KEY,
    });
    return jsonResponse({
        scheduler: {
            running: String(env.SCHEDULED_SYNC_ENABLED || "false").toLowerCase() === "true",
            owner: "cloudflare", execution_enabled: String(env.SCHEDULED_SYNC_ENABLED || "false").toLowerCase() === "true",
            maintenance_owner: "cloudflare", frequency_minutes: 5, apple_min_frequency_minutes: 240,
            efficiency: { changes: 0, no_changes: 0, total_cycles: 0, change_ratio: null, no_change_ratio: null },
            google_calendar_list_cache: { hits: 0, misses: 0, total_lookups: 0, hit_ratio: null, entries: 0 },
            adaptive_backoff_user: { user_id: claims.user_id, no_change_streak: 0, backoff_active: false, next_due_override_at: null },
        },
        accounts,
    });
}

async function nativeAccountSyncRollups(request, incomingUrl, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeSyncRollupRead(adapter, {
        userId: claims.user_id,
        days: Number(incomingUrl.searchParams.get("days") || 7),
    }));
}

async function nativeLegacyEventRead(request, env, verifiedClaims = null) {
    const claims = verifiedClaims || await authenticateWorkerRequest(request, env);
    const adapter = createHyperdriveCalendarReadAdapter(env);
    return jsonResponse(await executeLegacyEventRead(adapter, claims.user_id));
}

async function nativeTvVersionRead(request, env, verifiedClaims = null) {
    verifiedClaims || await authenticateWorkerRequest(request, env);
    const appVersion = String(env.TV_APP_VERSION || "").trim();
    if (!appVersion) throw new TypeError("TV_APP_VERSION is required for native TV version reads");
    return new Response(JSON.stringify({ appVersion }), {
        status: 200,
        headers: {
            "cache-control": "no-store, max-age=0, must-revalidate",
            "content-type": "application/json; charset=utf-8",
            pragma: "no-cache",
        },
    });
}

async function proxyRequest(request, incomingUrl, env) {
    const origin = resolveOrigin(env);
    const originRequest = buildOriginRequest(request, origin, env);
    const response = await fetch(originRequest);

    if (response.status === 101 || response.webSocket) {
        return response;
    }

    const rewritten = rewriteOriginRedirect(response, origin, incomingUrl);
    const headers = new Headers(rewritten.headers);
    headers.set("x-sherryjo-edge", "cloudflare");
    return new Response(rewritten.body, {
        status: rewritten.status,
        statusText: rewritten.statusText,
        headers,
    });
}

async function applyCloudflareDeploymentStatus(response, env) {
    if (!response.ok) return response;

    const payload = await response.json();
    const deployment = payload?.deployment;
    if (!deployment) return response;

    const workerCommitValue = String(env.WORKER_GIT_COMMIT || "").trim().toLowerCase();
    const workerCommit = /^[0-9a-f]{7,40}$/.test(workerCommitValue) ? workerCommitValue : null;
    const githubCommitValue = String(deployment.github_latest_commit || "").trim().toLowerCase();
    const githubCommit = /^[0-9a-f]{7,40}$/.test(githubCommitValue) ? githubCommitValue : null;

    deployment.origin_commit = deployment.current_commit;
    deployment.origin_commit_source = deployment.current_commit_source;
    deployment.current_commit = workerCommit;
    deployment.current_commit_source = "Cloudflare Worker build";
    deployment.active_platform = "cloudflare";
    deployment.active_platform_label = "Cloudflare Worker";
    deployment.worker_status_applied = true;

    if (workerCommit && githubCommit) {
        deployment.status = workerCommit === githubCommit ? "synced" : "out_of_sync";
        deployment.message = workerCommit === githubCommit
            ? "The active Cloudflare Worker matches the latest GitHub commit."
            : "The active Cloudflare Worker is not on the latest GitHub commit yet.";
    } else {
        deployment.status = "unknown";
        deployment.message = "Cloudflare is active, but its deployed Git commit is unavailable.";
    }

    const platforms = Array.isArray(deployment.platforms) ? deployment.platforms : [];
    for (const platform of platforms) {
        if (platform.id === "cloudflare") platform.role = "Primary application runtime";
        if (platform.id === "render") platform.role = "Proxied admin and legacy origin";
    }
    const cloudflareTarget = platforms.find((platform) => platform.id === "cloudflare") || {};
    deployment.manual_deploy_available = Boolean(cloudflareTarget.manual_deploy_available);
    deployment.manual_deploy_endpoint = cloudflareTarget.manual_deploy_endpoint || null;
    deployment.manual_deploy_hint = deployment.manual_deploy_available
        ? "Trigger the Cloudflare deploy hook from this admin app."
        : "Open the Cloudflare dashboard and deploy the latest GitHub commit.";
    deployment.current_commit_url = workerCommit
        ? `${deployment.repository_url}/commit/${workerCommit}`
        : null;
    deployment.compare_url = workerCommit && githubCommit && workerCommit !== githubCommit
        ? `${deployment.compare_base_url}/${workerCommit}...${githubCommit}`
        : null;

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("cache-control", "no-store");
    return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

async function shadowCalendarRead(request, incomingUrl, env, proxyResponse) {
    try {
        const [nativeResponse, proxyBody] = await Promise.all([
            nativeCalendarRead(request, incomingUrl, env),
            proxyResponse.clone().json(),
        ]);
        const nativeBody = await nativeResponse.json();
        console.log(JSON.stringify({
            event: "calendar_read_shadow_comparison",
            matched: proxyResponse.status === nativeResponse.status
                && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
            proxyStatus: proxyResponse.status,
            nativeStatus: nativeResponse.status,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "calendar_read_shadow_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        }));
    }
}

async function shadowTaskRead(request, env, proxyResponse) {
    try {
        const [nativeResponse, proxyBody] = await Promise.all([
            nativeTaskRead(request, env),
            proxyResponse.clone().json(),
        ]);
        const nativeBody = await nativeResponse.json();
        console.log(JSON.stringify({
            event: "task_read_shadow_comparison",
            matched: proxyResponse.status === nativeResponse.status
                && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
            proxyStatus: proxyResponse.status,
            nativeStatus: nativeResponse.status,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "task_read_shadow_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        }));
    }
}

async function shadowNoteRead(request, incomingUrl, env, proxyResponse) {
    try {
        const [nativeResponse, proxyBody] = await Promise.all([
            nativeNoteRead(request, incomingUrl, env),
            proxyResponse.clone().json(),
        ]);
        const nativeBody = await nativeResponse.json();
        console.log(JSON.stringify({
            event: "note_read_shadow_comparison",
            matched: proxyResponse.status === nativeResponse.status
                && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
            proxyStatus: proxyResponse.status,
            nativeStatus: nativeResponse.status,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "note_read_shadow_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        }));
    }
}

async function shadowDateStickyRead(request, incomingUrl, env, proxyResponse) {
    try {
        const [nativeResponse, proxyBody] = await Promise.all([
            nativeDateStickyRead(request, incomingUrl, env),
            proxyResponse.clone().json(),
        ]);
        const nativeBody = await nativeResponse.json();
        console.log(JSON.stringify({
            event: "date_sticky_read_shadow_comparison",
            matched: proxyResponse.status === nativeResponse.status
                && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
            proxyStatus: proxyResponse.status,
            nativeStatus: nativeResponse.status,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "date_sticky_read_shadow_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        }));
    }
}

async function shadowTagColorRead(request, env, proxyResponse) {
    try {
        const [nativeResponse, proxyBody] = await Promise.all([
            nativeTagColorRead(request, env),
            proxyResponse.clone().json(),
        ]);
        const nativeBody = await nativeResponse.json();
        console.log(JSON.stringify({
            event: "tag_color_read_shadow_comparison",
            matched: proxyResponse.status === nativeResponse.status
                && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
            proxyStatus: proxyResponse.status,
            nativeStatus: nativeResponse.status,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "tag_color_read_shadow_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        }));
    }
}

async function shadowCurrentUserRead(request, env, proxyResponse) {
    try {
        const [nativeResponse, proxyBody] = await Promise.all([
            nativeCurrentUserRead(request, env),
            proxyResponse.clone().json(),
        ]);
        const nativeBody = await nativeResponse.json();
        console.log(JSON.stringify({
            event: "current_user_read_shadow_comparison",
            matched: proxyResponse.status === nativeResponse.status
                && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
            proxyStatus: proxyResponse.status,
            nativeStatus: nativeResponse.status,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "current_user_read_shadow_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        }));
    }
}

async function shadowLegacyEventRead(request, env, proxyResponse) {
    try {
        const [nativeResponse, proxyBody] = await Promise.all([
            nativeLegacyEventRead(request, env),
            proxyResponse.clone().json(),
        ]);
        const nativeBody = await nativeResponse.json();
        console.log(JSON.stringify({
            event: "legacy_event_read_shadow_comparison",
            matched: proxyResponse.status === nativeResponse.status
                && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
            proxyStatus: proxyResponse.status,
            nativeStatus: nativeResponse.status,
        }));
    } catch (error) {
        console.error(JSON.stringify({
            event: "legacy_event_read_shadow_failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        }));
    }
}

export default {
    scheduled(_controller, env, ctx) {
        ctx.waitUntil(runScheduledCalendarSync(env));
    },

    async fetch(request, env) {
        const incomingUrl = new URL(request.url);
        if (request.method === "GET" || request.method === "HEAD") {
            const assetResponse = await nativeAssetResponse(request, incomingUrl, env);
            if (assetResponse) return assetResponse;
        }
        if (incomingUrl.pathname === "/favicon.ico") {
            return new Response(null, { status: 204 });
        }
        if (incomingUrl.pathname === EDGE_HEALTH_PATH) {
            return jsonResponse({
                status: "ok",
                platform: "cloudflare",
                mode: originFallbackMode(env) === "severed" ? "worker-only" : "render-origin-proxy",
            });
        }
        if (incomingUrl.pathname === "/health") {
            return request.method === "HEAD" ? new Response(null, { status: 200 }) : jsonResponse({ status: "ok", platform: "cloudflare-worker" });
        }
        if (incomingUrl.pathname === "/health/schema") {
            return jsonResponse({ status: "ok", database: "postgresql", connectivity: "unchecked", runtime: "cloudflare-worker" });
        }
        if (incomingUrl.pathname === "/openapi.json") {
            return jsonResponse({ openapi: "3.1.0", info: { title: "SherryJo Calendar Worker", version: "1.0" }, paths: {} });
        }

        if (incomingUrl.pathname === PLATFORM_STATUS_PATH) {
            return jsonResponse({
                status: "ok",
                platform: "cloudflare-worker",
                mode: "worker-native",
                deploymentCommit: /^[0-9a-f]{7,40}$/i.test(String(env.WORKER_GIT_COMMIT || "").trim())
                    ? String(env.WORKER_GIT_COMMIT).trim().toLowerCase()
                    : null,
                calendarReadMode: calendarReadMode(env),
                currentUserReadMode: currentUserReadMode(env),
                dateStickyReadMode: dateStickyReadMode(env),
                dateStickyWriteMode: dateStickyWriteMode(env),
                eventWriteMode: eventWriteMode(env),
                legacyEventReadMode: legacyEventReadMode(env),
                noteReadMode: noteReadMode(env),
                noteWriteMode: noteWriteMode(env),
                tagColorReadMode: tagColorReadMode(env),
                tagColorWriteMode: tagColorWriteMode(env),
                taskReadMode: taskReadMode(env),
                taskWriteMode: taskWriteMode(env),
                tvVersionReadMode: tvVersionReadMode(env),
                googleAuthMode: googleAuthMode(env),
                msAuthMode: msAuthMode(env),
                authMode: authMode(env),
                accountReadMode: accountReadMode(env),
                accountWriteMode: accountWriteMode(env),
                tvPairingMode: tvPairingMode(env),
                tvStateMode: tvStateMode(env),
                tvEventsMode: tvEventsMode(env),
                tvDiagnosticsMode: tvDiagnosticsMode(env),
                calendarImportMode: calendarImportMode(env),
                calendarPublishMode: calendarPublishMode(env),
                webSocketMode: webSocketMode(env),
                adminApiMode: adminApiMode(env),
                calendarSyncMode: calendarSyncMode(env),
                scheduledSyncEnabled: String(env.SCHEDULED_SYNC_ENABLED || "false").trim().toLowerCase() === "true",
                originFallbackMode: originFallbackMode(env),
                renderDependencySevered: originFallbackMode(env) === "severed",
                edgeProxyAuthConfigured: Boolean(String(env.EDGE_PROXY_SECRET || "")),
            });
        }

        try {
            const mode = calendarReadMode(env);
            const currentUserMode = currentUserReadMode(env);
            const dateStickyMode = dateStickyReadMode(env);
            const dateStickyWritesMode = dateStickyWriteMode(env);
            const eventsWriteMode = eventWriteMode(env);
            const legacyEventsMode = legacyEventReadMode(env);
            const notesMode = noteReadMode(env);
            const notesWriteMode = noteWriteMode(env);
            const tagColorsMode = tagColorReadMode(env);
            const tagColorWritesMode = tagColorWriteMode(env);
            const tasksMode = taskReadMode(env);
            const tasksWriteMode = taskWriteMode(env);
            const tvVersionMode = tvVersionReadMode(env);
            const googleMode = googleAuthMode(env);
            const msMode = msAuthMode(env);
            const authenticationMode = authMode(env);
            const accountsReadMode = accountReadMode(env);
            const accountsWriteMode = accountWriteMode(env);
            const pairingMode = tvPairingMode(env);
                        if (pairingMode === "native" && request.method === "GET" && incomingUrl.pathname === "/tv/dashboard") {
                            return await nativeTvDashboard(request, incomingUrl, env);
                        }
                        if (pairingMode === "native" && request.method === "GET" && incomingUrl.pathname === "/tv/kiosk") {
                            return await nativeTvKiosk(request, incomingUrl, env);
                        }
                        if (pairingMode === "native" && request.method === "POST" && incomingUrl.pathname === "/tv/generate-kiosk-token") {
                            return await nativeTvKioskToken(request, incomingUrl, env);
                        }
            const stateMode = tvStateMode(env);
            const eventsMode = tvEventsMode(env);
            const diagnosticsMode = tvDiagnosticsMode(env);
            const importMode = calendarImportMode(env);
            const publishMode = calendarPublishMode(env);
            const socketMode = webSocketMode(env);
            const adminMode = adminApiMode(env);
            const syncMode = calendarSyncMode(env);

            if (adminMode === "native" && incomingUrl.pathname.startsWith("/admin/") && incomingUrl.pathname !== "/admin/ui") {
                const claims = await authenticateWorkerRequest(request, env);
                return await handleAdminApi(request, env, createHyperdriveCalendarReadAdapter(env), claims.user_id);
            }
            if (syncMode === "native" && request.method === "POST" && incomingUrl.pathname === "/calendar/sync") {
                const claims = await authenticateWorkerRequest(request, env);
                return jsonResponse(await runManualCalendarSync(
                    createHyperdriveCalendarReadAdapter(env), env, claims.user_id,
                    incomingUrl.searchParams.get("account"), incomingUrl.searchParams.get("dedup") !== "false",
                ));
            }
            if (syncMode === "native" && request.method === "POST" && incomingUrl.pathname === "/calendar/dedup-materialize") {
                const claims = await authenticateWorkerRequest(request, env);
                return jsonResponse({ status: "success", changed: await materializeDedup(createHyperdriveCalendarReadAdapter(env), claims.user_id) });
            }
            if (eventsMode === "native" && request.method === "POST" && incomingUrl.pathname === "/tv/events") {
                return await nativeTvEventWrite(request, incomingUrl, env);
            }
            if (eventsMode === "native" && request.method === "PUT" && tvEventId(incomingUrl)) {
                return await nativeTvEventWrite(request, incomingUrl, env);
            }
            if (dateStickyWritesMode === "native" && request.method === "PUT" && tvDateStickyKey(incomingUrl) !== null) {
                return await nativeTvDateStickyWrite(request, incomingUrl, env);
            }
            if (notesWriteMode === "native" && request.method === "POST" && incomingUrl.pathname === "/events/note") {
                const claims = await authenticateWorkerRequest(request, env);
                const result = await upsertLegacyEventNote(createHyperdriveCalendarReadAdapter(env), claims.user_id, await request.json());
                return result ? jsonResponse(result) : jsonResponse({ detail: "Note or event not found" }, 404);
            }
            if (adminMode === "native" && request.method === "GET" && ["/users", "/users/"].includes(incomingUrl.pathname)) {
                return await nativeTvAdminUsers(request, env);
            }

            if (socketMode === "native" && request.method === "POST" && incomingUrl.pathname === "/ws/ticket") {
                const claims = await authenticateWorkerRequest(request, env);
                return jsonResponse(await issueWebSocketTicket(createHyperdriveCalendarReadAdapter(env), claims.user_id));
            }
            if (socketMode === "native" && request.method === "GET" && incomingUrl.pathname === "/ws") {
                return await openNativeWebSocket(request, createHyperdriveCalendarReadAdapter(env));
            }

            if (pairingMode === "native" && request.method === "POST" && incomingUrl.pathname === TV_GENERATE_CODE_PATH) {
                return await nativeTvGenerateCode(request, env);
            }
            if (pairingMode === "native" && request.method === "POST" && incomingUrl.pathname === TV_PAIR_PATH) {
                return await nativeTvPair(request, env);
            }
            if (pairingMode === "native" && request.method === "POST" && incomingUrl.pathname === TV_AUTO_PAIR_PATH) {
                return await nativeTvAutoPair(request, env);
            }
            if (stateMode === "native" && ["GET", "PATCH"].includes(request.method) && incomingUrl.pathname === TV_STATE_PATH) {
                return await nativeTvState(request, env);
            }
            if (eventsMode === "native" && request.method === "GET" && incomingUrl.pathname === TV_EVENTS_PATH) {
                return await nativeTvEvents(request, incomingUrl, env);
            }
            if (diagnosticsMode === "native" && ["GET", "POST"].includes(request.method) && incomingUrl.pathname === "/tv/diag") {
                return await nativeTvDiagnostics(request, incomingUrl, env);
            }
            if (importMode === "native" && request.method === "POST" && incomingUrl.pathname === "/calendar/import-events") {
                const claims = await authenticateWorkerRequest(request, env);
                return await handleCalendarImport(request, env, createHyperdriveCalendarReadAdapter(env), claims.user_id);
            }
            if (publishMode === "native" && request.method === "POST" && incomingUrl.pathname === "/calendar/publish") {
                const claims = await authenticateWorkerRequest(request, env);
                const body = await request.json();
                const adapter = new CalendarPublishPostgresAdapter(createHyperdriveCalendarReadAdapter(env));
                return jsonResponse(await executeCalendarPublish(adapter, { userId: claims.user_id, body, env }));
            }

            if (request.method === "POST" && incomingUrl.pathname === AUTH_LOGIN_PATH && authenticationMode === "native") {
                return await handleNativeLogin(request, env, createNativeAuthPostgresAdapter(env));
            }
            if (request.method === "POST" && incomingUrl.pathname === AUTH_REGISTER_PATH && authenticationMode === "native") {
                return await handleNativeRegistration(request, env, createNativeAuthPostgresAdapter(env));
            }
            if (request.method === "GET" && accountsReadMode === "native") {
                if (incomingUrl.pathname === ACCOUNT_LIST_PATH) return await nativeAccountRead(request, env);
                if (incomingUrl.pathname === ACCOUNT_SYNC_STATUS_PATH) return await nativeAccountSyncStatus(request, env);
                if (incomingUrl.pathname === ACCOUNT_SYNC_ROLLUPS_PATH) return await nativeAccountSyncRollups(request, incomingUrl, env);
            }
            if (accountsWriteMode === "native" && accountMutation(incomingUrl)
                && ["PUT", "DELETE"].includes(request.method)) {
                return await nativeAccountMutation(request, incomingUrl, env);
            }
            if (accountsWriteMode === "native" && request.method === "POST"
                && [APPLE_TEST_PATH, APPLE_CONNECT_PATH].includes(incomingUrl.pathname)) {
                const claims = await authenticateWorkerRequest(request, env);
                return await handleAppleAccountRequest(
                    request,
                    { ...env, userId: claims.user_id },
                    createHyperdriveCalendarReadAdapter(env),
                );
            }
            if (accountsWriteMode === "native" && request.method === "POST" && accountSyncRequestId(incomingUrl)) {
                return await nativeAccountSyncNow(request, incomingUrl, env);
            }

            // OAuth routes: mode "native" lets the Worker handle the full flow.
            if (incomingUrl.pathname === GOOGLE_LOGIN_PATH && googleMode === "native") {
                return await handleGoogleLogin(request, env, createHyperdriveCalendarReadAdapter(env));
            }
            if (incomingUrl.pathname === GOOGLE_CALLBACK_PATH && googleMode === "native") {
                return await handleGoogleCallback(request, env, createHyperdriveCalendarReadAdapter(env));
            }
            if (incomingUrl.pathname === MS_LOGIN_PATH && msMode === "native") {
                return await handleMsLogin(request, env, createHyperdriveCalendarReadAdapter(env));
            }
            if (incomingUrl.pathname === MS_CALLBACK_PATH && msMode === "native") {
                return await handleMsCallback(request, env, createHyperdriveCalendarReadAdapter(env));
            }

            if (request.method === "POST" && incomingUrl.pathname === NOTE_READ_PATH && notesWriteMode !== "proxy") {
                if (notesWriteMode === "native") return await nativeLocalCreate(request, env, executeNoteWrite);
                if (notesWriteMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) return await nativeLocalCreate(request, env, executeNoteWrite, claims);
                }
            }
            if (request.method === "POST" && incomingUrl.pathname === TASK_READ_PATH && tasksWriteMode !== "proxy") {
                if (tasksWriteMode === "native") return await nativeLocalCreate(request, env, executeTaskWrite);
                if (tasksWriteMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) return await nativeLocalCreate(request, env, executeTaskWrite, claims);
                }
            }
            if (request.method === "POST" && incomingUrl.pathname === EVENT_WRITE_PATH && eventsWriteMode !== "proxy") {
                if (eventsWriteMode === "native") return await nativeEventCreate(request, env);
                if (eventsWriteMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) return await nativeEventCreate(request, env, claims);
                }
            }
            if (["PUT", "DELETE"].includes(request.method) && eventId(incomingUrl) !== null && eventsWriteMode !== "proxy") {
                if (eventsWriteMode === "native") return await nativeEventMutation(request, incomingUrl, env);
                if (eventsWriteMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) return await nativeEventMutation(request, incomingUrl, env, claims);
                }
            }
            if (request.method === "PUT" && dateStickyWriteKey(incomingUrl) !== null && dateStickyWritesMode !== "proxy") {
                if (dateStickyWritesMode === "native") {
                    return await nativeDateStickyWrite(request, incomingUrl, env);
                }
                if (dateStickyWritesMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeDateStickyWrite(request, incomingUrl, env, claims);
                    }
                }
            }
            if (request.method === "PUT" && incomingUrl.pathname === TAG_COLOR_READ_PATH && tagColorWritesMode !== "proxy") {
                if (tagColorWritesMode === "native") {
                    return await nativeTagColorWrite(request, env);
                }
                if (tagColorWritesMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeTagColorWrite(request, env, claims);
                    }
                }
            }
            if (request.method === "GET" && incomingUrl.pathname === CALENDAR_READ_PATH && mode !== "proxy") {
                if (mode === "native") {
                    return await nativeCalendarRead(request, incomingUrl, env);
                }
                if (mode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeCalendarRead(request, incomingUrl, env, claims);
                    }
                }
            }

            if (request.method === "GET" && incomingUrl.pathname === TASK_READ_PATH && tasksMode !== "proxy") {
                if (tasksMode === "native") {
                    return await nativeTaskRead(request, env);
                }
                if (tasksMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeTaskRead(request, env, claims);
                    }
                }
            }

            if (request.method === "GET" && incomingUrl.pathname === LEGACY_EVENT_READ_PATH && legacyEventsMode !== "proxy") {
                if (legacyEventsMode === "native") {
                    return await nativeLegacyEventRead(request, env);
                }
                if (legacyEventsMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeLegacyEventRead(request, env, claims);
                    }
                }
            }

            if (request.method === "GET" && incomingUrl.pathname === NOTE_READ_PATH && notesMode !== "proxy") {
                if (notesMode === "native") {
                    return await nativeNoteRead(request, incomingUrl, env);
                }
                if (notesMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeNoteRead(request, incomingUrl, env, claims);
                    }
                }
            }

            if (request.method === "GET" && isDateStickyReadPath(incomingUrl) && dateStickyMode !== "proxy") {
                if (dateStickyMode === "native") {
                    return await nativeDateStickyRead(request, incomingUrl, env);
                }
                if (dateStickyMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeDateStickyRead(request, incomingUrl, env, claims);
                    }
                }
            }

            if (request.method === "GET" && incomingUrl.pathname === TAG_COLOR_READ_PATH && tagColorsMode !== "proxy") {
                if (tagColorsMode === "native") {
                    return await nativeTagColorRead(request, env);
                }
                if (tagColorsMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeTagColorRead(request, env, claims);
                    }
                }
            }

            if (request.method === "GET" && incomingUrl.pathname === CURRENT_USER_READ_PATH && currentUserMode !== "proxy") {
                if (currentUserMode === "native") {
                    return await nativeCurrentUserRead(request, env);
                }
                if (currentUserMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeCurrentUserRead(request, env, claims);
                    }
                }
            }

            if (request.method === "GET" && incomingUrl.pathname === TV_VERSION_READ_PATH && tvVersionMode !== "proxy") {
                if (tvVersionMode === "native") {
                    return await nativeTvVersionRead(request, env);
                }
                if (tvVersionMode === "canary") {
                    const claims = await authenticateWorkerRequest(request, env);
                    if (canaryUserAllowed(env, claims.user_id)) {
                        return await nativeTvVersionRead(request, env, claims);
                    }
                }
            }

            if (originFallbackMode(env) === "severed") {
                return jsonResponse({
                    error: "Route is not available in Worker-only mode",
                    code: "worker_route_not_migrated",
                    path: incomingUrl.pathname,
                }, 503);
            }

            const response = await proxyRequest(request, incomingUrl, env);
            if (request.method === "GET" && incomingUrl.pathname === ADMIN_SYSTEM_OVERVIEW_PATH) {
                return await applyCloudflareDeploymentStatus(response, env);
            }
            if (request.method === "GET" && incomingUrl.pathname === CALENDAR_READ_PATH && mode === "shadow") {
                await shadowCalendarRead(request, incomingUrl, env, response);
            }
            if (request.method === "GET" && incomingUrl.pathname === TASK_READ_PATH && tasksMode === "shadow") {
                await shadowTaskRead(request, env, response);
            }
            if (request.method === "GET" && incomingUrl.pathname === LEGACY_EVENT_READ_PATH && legacyEventsMode === "shadow") {
                await shadowLegacyEventRead(request, env, response);
            }
            if (request.method === "GET" && incomingUrl.pathname === NOTE_READ_PATH && notesMode === "shadow") {
                await shadowNoteRead(request, incomingUrl, env, response);
            }
            if (request.method === "GET" && isDateStickyReadPath(incomingUrl) && dateStickyMode === "shadow") {
                await shadowDateStickyRead(request, incomingUrl, env, response);
            }
            if (request.method === "GET" && incomingUrl.pathname === TAG_COLOR_READ_PATH && tagColorsMode === "shadow") {
                await shadowTagColorRead(request, env, response);
            }
            if (request.method === "GET" && incomingUrl.pathname === CURRENT_USER_READ_PATH && currentUserMode === "shadow") {
                await shadowCurrentUserRead(request, env, response);
            }
            if (request.method === "GET" && incomingUrl.pathname === TV_VERSION_READ_PATH && tvVersionMode === "shadow") {
                try {
                    const nativeResponse = await nativeTvVersionRead(request, env);
                    const [nativeBody, proxyBody] = await Promise.all([nativeResponse.json(), response.clone().json()]);
                    console.log(JSON.stringify({
                        event: "tv_version_read_shadow_comparison",
                        matched: response.status === nativeResponse.status
                            && JSON.stringify(proxyBody) === JSON.stringify(nativeBody),
                        proxyStatus: response.status,
                        nativeStatus: nativeResponse.status,
                    }));
                } catch (error) {
                    console.error(JSON.stringify({
                        event: "tv_version_read_shadow_failed",
                        errorType: error instanceof Error ? error.name : "UnknownError",
                    }));
                }
            }
            return response;
        } catch (error) {
            if (error instanceof JwtVerificationError || error instanceof CurrentUserNotFoundError) {
                return jsonResponse({ error: "Authentication required" }, 401);
            }
            if (error instanceof EventUpdateConflictError) {
                return jsonResponse({ detail: { conflict: true, message: error.message, server_updated_at: error.serverUpdatedAt } }, 409);
            }
            if (error instanceof EventNotFoundError || error instanceof NoteEventNotFoundError || error instanceof AccountNotFoundError || error instanceof TvStateUserNotFoundError) {
                return jsonResponse({ detail: error.message }, 404);
            }
            if (error instanceof IdempotencyConflictError || error instanceof TagColorIdempotencyConflictError || error instanceof EventCreateIdempotencyConflictError || error instanceof EventMutationIdempotencyConflictError || error instanceof NoteWriteConflictError || error instanceof TaskWriteConflictError) {
                return jsonResponse({ error: error.message }, 409);
            }
            if (error instanceof TypeError) {
                return jsonResponse({ error: "Invalid Worker request" }, 400);
            }
            if (error instanceof CalendarImportError) {
                const status = /empty|missing file/i.test(error.message) ? 400 : 422;
                return jsonResponse({ detail: error.message }, status);
            }
            if (error instanceof TvDiagnosticsForbiddenError) {
                return jsonResponse({ detail: error.message }, 403);
            }
            if (error instanceof InvalidPairingCodeError) {
                const autoPair = new URL(request.url).pathname === TV_AUTO_PAIR_PATH;
                return jsonResponse({ detail: error.message }, autoPair ? 404 : 400);
            }
            console.error(JSON.stringify({
                event: "origin_request_failed",
                method: request.method,
                path: incomingUrl.pathname,
                errorType: error instanceof Error ? error.name : "UnknownError",
            }));
            return jsonResponse(
                {
                    status: "unavailable",
                    platform: "cloudflare",
                    error: "Origin request failed",
                },
                502,
            );
        }
    },
};