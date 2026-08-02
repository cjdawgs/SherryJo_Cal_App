import { executeCalendarRead } from "./calendar-read-postgres.js";
import { createHyperdriveCalendarReadAdapter } from "./calendar-read-hyperdrive.js";
import { authenticateWorkerRequest, JwtVerificationError } from "./jwt.js";

const EDGE_HEALTH_PATH = "/__edge/health";
const PLATFORM_STATUS_PATH = "/api/platform/status";
const CALENDAR_READ_PATH = "/calendar/unified";
const CALENDAR_READ_MODES = new Set(["proxy", "shadow", "canary", "native"]);

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
                calendarReadMode: calendarReadMode(env),
                edgeProxyAuthConfigured: Boolean(String(env.EDGE_PROXY_SECRET || "")),
            });
        }

        try {
            const mode = calendarReadMode(env);
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

            const response = await proxyRequest(request, incomingUrl, env);
            if (request.method === "GET" && incomingUrl.pathname === CALENDAR_READ_PATH && mode === "shadow") {
                await shadowCalendarRead(request, incomingUrl, env, response);
            }
            return response;
        } catch (error) {
            if (error instanceof JwtVerificationError) {
                return jsonResponse({ error: "Authentication required" }, 401);
            }
            if (error instanceof TypeError) {
                return jsonResponse({ error: "Invalid calendar read request" }, 400);
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