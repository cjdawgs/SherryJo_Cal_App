const EDGE_HEALTH_PATH = "/__edge/health";
const PLATFORM_STATUS_PATH = "/api/platform/status";

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

function buildOriginRequest(request, origin) {
    const incomingUrl = new URL(request.url);
    if (incomingUrl.hostname === origin.hostname) {
        throw new Error("ORIGIN_BASE_URL must not point to this Worker hostname");
    }

    const targetUrl = new URL(`${incomingUrl.pathname}${incomingUrl.search}`, origin);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", incomingUrl.host);
    headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
    headers.set("x-sherryjo-edge", "cloudflare");

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
            });
        }

        let origin;
        try {
            origin = resolveOrigin(env);
            const originRequest = buildOriginRequest(request, origin);
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
        } catch (error) {
            console.error("Cloudflare edge origin request failed", error);
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