import assert from "node:assert/strict";
import test from "node:test";

import worker from "../src/worker.js";

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
            {},
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
            status: "ok",
            platform: "cloudflare-worker",
            mode: "worker-native",
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
                headers: { authorization: "Bearer test-token" },
            }),
            { ORIGIN_BASE_URL: "https://sherryjo-cal-app.onrender.com" },
        );

        assert.equal(
            capturedRequest.url,
            "https://sherryjo-cal-app.onrender.com/events?date=2026-08-01",
        );
        assert.equal(capturedRequest.headers.get("authorization"), "Bearer test-token");
        assert.equal(capturedRequest.headers.get("x-forwarded-host"), "calendar.example.com");
        assert.equal(capturedRequest.headers.get("x-forwarded-proto"), "https");
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
    console.error = () => { };

    let response;
    try {
        response = await worker.fetch(
            new Request("https://calendar.example.com/health"),
            { ORIGIN_BASE_URL: "https://calendar.example.com" },
        );
    } finally {
        console.error = originalConsoleError;
    }

    assert.equal(response.status, 502);
    assert.equal((await response.json()).error, "Origin request failed");
});