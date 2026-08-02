import assert from "node:assert/strict";
import test from "node:test";

import worker, { parseCalendarReadQuery } from "../src/worker.js";

test("edge health does not contact the Render origin", async () => {
    const response = await worker.fetch(
        new Request("https://calendar.example.com/__edge/health"),
        {},
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
        status: "ok",
        platform: "cloudflare",
        mode: "render-origin-proxy",
    });
});

test("platform status is Worker-native and does not contact Render", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Worker-native routes must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/api/platform/status"),
            { EDGE_PROXY_SECRET: "configured-secret" },
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
            status: "ok",
            platform: "cloudflare-worker",
            mode: "worker-native",
            calendarReadMode: "proxy",
            edgeProxyAuthConfigured: true,
        });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("proxy preserves path, query, authorization, and public host", async () => {
    const originalFetch = globalThis.fetch;
    let capturedRequest;
    globalThis.fetch = async (request) => {
        capturedRequest = request;
        return new Response(JSON.stringify({ status: "ok" }), {
            headers: { "content-type": "application/json" },
        });
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/events?date=2026-08-01", {
                headers: {
                    authorization: "Bearer test-token",
                    "x-sherryjo-edge-auth": "attacker-supplied",
                },
            }),
            {
                ORIGIN_BASE_URL: "https://sherryjo-cal-app.onrender.com",
                EDGE_PROXY_SECRET: "trusted-edge-secret",
            },
        );

        assert.equal(
            capturedRequest.url,
            "https://sherryjo-cal-app.onrender.com/events?date=2026-08-01",
        );
        assert.equal(capturedRequest.headers.get("authorization"), "Bearer test-token");
        assert.equal(capturedRequest.headers.get("x-forwarded-host"), "calendar.example.com");
        assert.equal(capturedRequest.headers.get("x-forwarded-proto"), "https");
        assert.equal(capturedRequest.headers.get("x-sherryjo-edge-auth"), "trusted-edge-secret");
        assert.equal(response.headers.get("x-sherryjo-edge"), "cloudflare");
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("proxy rewrites same-origin Render redirects to the public hostname", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, {
        status: 302,
        headers: { location: "https://sherryjo-cal-app.onrender.com/login?next=%2Fcalendar" },
    });

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/calendar"),
            { ORIGIN_BASE_URL: "https://sherryjo-cal-app.onrender.com" },
        );

        assert.equal(
            response.headers.get("location"),
            "https://calendar.example.com/login?next=%2Fcalendar",
        );
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("proxy fails closed when the origin points back to the Worker", async () => {
    const originalConsoleError = console.error;
    let errorLog;
    console.error = (message) => {
        errorLog = JSON.parse(message);
    };

    let response;
    try {
        response = await worker.fetch(
            new Request("https://calendar.example.com/health?token=must-not-be-logged"),
            { ORIGIN_BASE_URL: "https://calendar.example.com" },
        );
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "Origin request failed");
    assert.deepEqual(errorLog, {
        event: "origin_request_failed",
        method: "GET",
        path: "/health",
        errorType: "Error",
    });
});

test("invalid calendar ownership configuration fails closed to proxy", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        return new Response(JSON.stringify({ events: [] }), {
            headers: { "content-type": "application/json" },
        });
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/calendar/unified?start=2026-08-01&end=2026-08-02"),
            {
                ORIGIN_BASE_URL: "https://sherryjo-cal-app.onrender.com",
                CALENDAR_READ_MODE: "unexpected",
            },
        );

        assert.equal(response.status, 200);
        assert.equal(originContacted, true);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native calendar mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/calendar/unified?start=2026-08-01&end=2026-08-02"),
            { CALENDAR_READ_MODE: "native" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("calendar query matches FastAPI UTC parsing and invalid-bound fallback", () => {
    const explicit = parseCalendarReadQuery(
        new URL("https://calendar.example.com/calendar/unified?start=2026-08-01T10:00:00&end=2026-08-01T12:00:00%2B02:00&dedup=false"),
        42,
    );
    assert.equal(explicit.start.toISOString(), "2026-08-01T10:00:00.000Z");
    assert.equal(explicit.end.toISOString(), "2026-08-01T10:00:00.000Z");
    assert.equal(explicit.dedupEnabled, false);

    const fallback = parseCalendarReadQuery(
        new URL("https://calendar.example.com/calendar/unified?start=invalid&end=2026-08-02&range_days=2"),
        42,
        new Date("2026-08-10T00:00:00Z"),
    );
    assert.equal(fallback.start.toISOString(), "2026-08-08T00:00:00.000Z");
    assert.equal(fallback.end.toISOString(), "2026-08-12T00:00:00.000Z");
    assert.throws(
        () => parseCalendarReadQuery(
            new URL("https://calendar.example.com/calendar/unified?range_days=two"),
            42,
        ),
        /range_days must be an integer/,
    );
});