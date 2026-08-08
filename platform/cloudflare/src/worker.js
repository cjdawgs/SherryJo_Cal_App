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
import { authenticateWorkerRequest, JwtVerificationError } from "./jwt.js";
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
const CALENDAR_READ_MODES = new Set(["proxy", "shadow", "canary", "native"]);
const WRITE_MODES = new Set(["proxy", "canary", "native"]);

function jsonResponse(payload, status = 200) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
        },
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
    async fetch(request, env) {
        const incomingUrl = new URL(request.url);
        if (incomingUrl.pathname === EDGE_HEALTH_PATH) {
            return jsonResponse({
                status: "ok",
                platform: "cloudflare",
                mode: "render-origin-proxy",
            });
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
            if (error instanceof EventNotFoundError || error instanceof NoteEventNotFoundError) {
                return jsonResponse({ detail: error.message }, 404);
            }
            if (error instanceof IdempotencyConflictError || error instanceof TagColorIdempotencyConflictError || error instanceof EventCreateIdempotencyConflictError || error instanceof EventMutationIdempotencyConflictError || error instanceof NoteWriteConflictError || error instanceof TaskWriteConflictError) {
                return jsonResponse({ error: error.message }, 409);
            }
            if (error instanceof TypeError) {
                return jsonResponse({ error: "Invalid Worker request" }, 400);
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