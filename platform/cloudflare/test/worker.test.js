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
            {
                EDGE_PROXY_SECRET: "configured-secret",
                WORKER_GIT_COMMIT: "9CFB04D26497C55FC6933E634C91E5965D8171D8",
            },
        );

        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(await response.json(), {
            status: "ok",
            platform: "cloudflare-worker",
            mode: "worker-native",
            deploymentCommit: "9cfb04d26497c55fc6933e634c91e5965d8171d8",
            calendarReadMode: "proxy",
            currentUserReadMode: "proxy",
            dateStickyReadMode: "proxy",
            dateStickyWriteMode: "proxy",
            eventWriteMode: "proxy",
            legacyEventReadMode: "proxy",
            noteReadMode: "proxy",
            noteWriteMode: "proxy",
            tagColorReadMode: "proxy",
            tagColorWriteMode: "proxy",
            taskReadMode: "proxy",
            taskWriteMode: "proxy",
            tvVersionReadMode: "proxy",
            googleAuthMode: "proxy",
            msAuthMode: "proxy",
            edgeProxyAuthConfigured: true,
        });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native date-sticky write mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        for (const path of ["/calendar/date-sticky/2026-08-04", "/tv/date-sticky/2026-08-04"]) {
            const response = await worker.fetch(
                new Request(`https://calendar.example.com${path}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json", "Idempotency-Key": "test-key" },
                    body: JSON.stringify({ sticky_notes: [] }),
                }),
                { DATE_STICKY_WRITE_MODE: "native" },
            );

            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), { error: "Authentication required" });
        }
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native event create mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => { originContacted = true; throw new Error("Native mode must not contact Render"); };
    try {
        const response = await worker.fetch(new Request("https://calendar.example.com/calendar/event", {
            method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": "test-key" },
            body: JSON.stringify({ title: "Test", start_time: "2026-08-04T12:00:00Z" }),
        }), { EVENT_WRITE_MODE: "native" });
        assert.equal(response.status, 401);
        assert.equal(originContacted, false);
    } finally { globalThis.fetch = originalFetch; }
});

test("native event update and delete modes fail closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => { originContacted = true; throw new Error("Native mode must not contact Render"); };
    try {
        for (const method of ["PUT", "DELETE"]) {
            const response = await worker.fetch(new Request("https://calendar.example.com/calendar/event/7", {
                method, headers: { "Content-Type": "application/json", "Idempotency-Key": "test-key" },
                body: method === "PUT" ? JSON.stringify({ title: "Test" }) : undefined,
            }), { EVENT_WRITE_MODE: "native" });
            assert.equal(response.status, 401);
        }
        assert.equal(originContacted, false);
    } finally { globalThis.fetch = originalFetch; }
});

test("native tag-color write mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/calendar/tag-colors", {
                method: "PUT",
                headers: { "Content-Type": "application/json", "Idempotency-Key": "test-key" },
                body: JSON.stringify({ settings: {} }),
            }),
            { TAG_COLOR_WRITE_MODE: "native" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native note and task write modes fail closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => { originContacted = true; throw new Error("Native mode must not contact Render"); };
    try {
        for (const [path, binding, body] of [
            ["/notes/", "NOTE_WRITE_MODE", { event_id: 7, date: "2026-08-04", content: "Note" }],
            ["/tasks/", "TASK_WRITE_MODE", { title: "Task" }],
        ]) {
            const response = await worker.fetch(new Request(`https://calendar.example.com${path}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Idempotency-Key": "test-key" },
                body: JSON.stringify(body),
            }), { [binding]: "native" });
            assert.equal(response.status, 401);
        }
        assert.equal(originContacted, false);
    } finally { globalThis.fetch = originalFetch; }
});

test("native TV version mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/tv/version"),
            { TV_VERSION_READ_MODE: "native", TV_APP_VERSION: "test-version" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native legacy event mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/events/"),
            { LEGACY_EVENT_READ_MODE: "native" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native date-sticky mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        for (const path of ["/calendar/date-sticky", "/calendar/date-sticky/2026-08-04"]) {
            const response = await worker.fetch(
                new Request(`https://calendar.example.com${path}`),
                { DATE_STICKY_READ_MODE: "native" },
            );

            assert.equal(response.status, 401);
            assert.deepEqual(await response.json(), { error: "Authentication required" });
        }
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native tag-color mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/calendar/tag-colors"),
            { TAG_COLOR_READ_MODE: "native" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native current-user mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/users/me"),
            { CURRENT_USER_READ_MODE: "native" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native note mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/notes/?date=2026-08-04"),
            { NOTE_READ_MODE: "native" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
        assert.equal(originContacted, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("native task mode fails closed without Worker authentication", async () => {
    const originalFetch = globalThis.fetch;
    let originContacted = false;
    globalThis.fetch = async () => {
        originContacted = true;
        throw new Error("Native mode must not contact Render");
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/tasks/"),
            { TASK_READ_MODE: "native" },
        );

        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { error: "Authentication required" });
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

test("admin overview uses the Cloudflare deployment commit as the sync signal", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
        deployment: {
            current_commit: "9424fafa8ff89dc0e0cea8013d942706e74f6079",
            current_commit_source: "RENDER_GIT_COMMIT",
            github_latest_commit: "9cfb04d26497c55fc6933e634c91e5965d8171d8",
            repository_url: "https://github.com/cjdawgs/SherryJo_Cal_App",
            compare_base_url: "https://github.com/cjdawgs/SherryJo_Cal_App/compare",
            platforms: [
                { id: "render", role: "Application origin" },
                { id: "cloudflare", role: "Public edge proxy", manual_deploy_available: false },
            ],
        },
    }), { headers: { "content-type": "application/json" } });

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/admin/system/overview"),
            {
                ORIGIN_BASE_URL: "https://sherryjo-cal-app.onrender.com",
                WORKER_GIT_COMMIT: "9cfb04d26497c55fc6933e634c91e5965d8171d8",
            },
        );
        const deployment = (await response.json()).deployment;

        assert.equal(deployment.status, "synced");
        assert.equal(deployment.active_platform, "cloudflare");
        assert.equal(deployment.current_commit, "9cfb04d26497c55fc6933e634c91e5965d8171d8");
        assert.equal(deployment.current_commit_source, "Cloudflare Worker build");
        assert.equal(deployment.origin_commit, "9424fafa8ff89dc0e0cea8013d942706e74f6079");
        assert.equal(deployment.origin_commit_source, "RENDER_GIT_COMMIT");
        assert.equal(deployment.worker_status_applied, true);
        assert.equal(deployment.platforms[0].role, "Proxied admin and legacy origin");
        assert.equal(deployment.platforms[1].role, "Primary application runtime");
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

test("proxy returns WebSocket upgrades without reconstructing the response", async () => {
    const originalFetch = globalThis.fetch;
    const upgradeResponse = { status: 101, webSocket: {}, headers: new Headers() };
    let capturedRequest;
    globalThis.fetch = async (request) => {
        capturedRequest = request;
        return upgradeResponse;
    };

    try {
        const response = await worker.fetch(
            new Request("https://calendar.example.com/ws?ticket=one-use", {
                headers: { connection: "Upgrade", upgrade: "websocket" },
            }),
            {
                ORIGIN_BASE_URL: "https://sherryjo-cal-app.onrender.com",
                EDGE_PROXY_SECRET: "trusted-edge-secret",
            },
        );

        assert.equal(response, upgradeResponse);
        assert.equal(capturedRequest.headers.get("upgrade"), "websocket");
        assert.equal(capturedRequest.headers.get("x-sherryjo-edge-auth"), "trusted-edge-secret");
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