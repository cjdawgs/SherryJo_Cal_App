import assert from "node:assert/strict";
import test from "node:test";

import { handleAdminApi } from "../src/admin-api.js";

test("rejects a signed-in non-admin before executing an admin route", async () => {
    const adapter = { runWithIdentity: async (userId, operation) => operation({ query: async () => ({ rows: [{ allowed: false }] }) }) };
    const result = await handleAdminApi(new Request("https://calendar.test/admin/users"), {}, adapter, 4);
    assert.equal(result.status, 403);
    assert.deepEqual(await result.json(), { detail: "Admin only" });
});

test("redacts credentials from the managed table browser", async () => {
    let calls = 0;
    const adapter = {
        runWithIdentity: async (_userId, operation) => operation({
            query: async () => {
                calls += 1;
                if (calls === 1) return { rows: [{ allowed: true }] };
                return { rows: [{ id: 1, access_token: "secret", account_email: "a@example.test" }], fields: [{ name: "id" }, { name: "access_token" }, { name: "account_email" }], rowCount: 1 };
            }
        })
    };
    const result = await handleAdminApi(new Request("https://calendar.test/admin/system/table/oauth_accounts/rows"), {}, adapter, 1);
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.rows[0].access_token, "***");
    assert.deepEqual(body.redacted_columns, ["access_token"]);
});

test("reports inferred TV connection gaps and delivered failure evidence", async () => {
    let calls = 0;
    const adapter = {
        runWithIdentity: async (_userId, operation) => operation({
            query: async (sql) => {
                calls += 1;
                if (calls === 1) return { rows: [{ allowed: true }] };
                assert.match(sql, /tv_diag_log/);
                return {
                    rows: [
                        { user_id: 7, user_email: "owner@example.test", device_id: "firetv-1", device_ua: "Silk", event: "heartbeat", ts_server: new Date(Date.now() - 6 * 60 * 60 * 1000), visibility: "visible" },
                        { user_id: 7, user_email: "owner@example.test", device_id: "firetv-1", device_ua: "Silk", event: "device_presence", ts_server: new Date(Date.now() - 4 * 60 * 60 * 1000), visibility: "visible" },
                        { user_id: 7, user_email: "owner@example.test", device_id: "firetv-1", device_ua: "Silk", event: "tv_fetch_timeout", details: "GET /tv/events timed out", ts_server: new Date(Date.now() - 3 * 60 * 60 * 1000), visibility: "visible" },
                        { user_id: 7, user_email: "owner@example.test", device_id: "firetv-1", device_ua: "Silk", event: "device_presence", ts_server: new Date(Date.now() - 60 * 60 * 1000), visibility: "visible" },
                    ]
                };
            },
        }),
    };
    const result = await handleAdminApi(
        new Request("https://calendar.test/admin/system/tv-connection-gaps-summary?hours=168"),
        {},
        adapter,
        7,
    );
    assert.equal(result.status, 200);
    const body = await result.json();
    const gap = body.recent_rows.find((row) => row.status === "recovered");
    assert.equal(gap.user_email, "owner@example.test");
    assert.equal(gap.gap_minutes, 180);
    assert.match(gap.evidence, /tv_fetch_timeout/);
    assert.equal(gap.checkin_source, "device_presence");
});

test("overview reports synced when the deployed Worker commit matches GitHub's latest", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ sha: "9cfb04d26497c55fc6933e634c91e5965d8171d8" }), { status: 200 });
    try {
        const adapter = { runWithIdentity: async (_userId, operation) => operation({ query: async () => ({ rows: [{ allowed: true }] }) }) };
        const env = { WORKER_GIT_COMMIT: "9cfb04d26497c55fc6933e634c91e5965d8171d8" };
        const result = await handleAdminApi(new Request("https://calendar.test/admin/system/overview"), env, adapter, 1);
        const body = await result.json();
        assert.equal(body.deployment.status, "synced");
        assert.equal(body.deployment.github_latest_commit, "9cfb04d26497c55fc6933e634c91e5965d8171d8");
        assert.match(body.deployment.message, /matches the latest GitHub commit/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("overview reports out_of_sync when the deployed Worker commit trails GitHub", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), { status: 200 });
    try {
        const adapter = { runWithIdentity: async (_userId, operation) => operation({ query: async () => ({ rows: [{ allowed: true }] }) }) };
        const env = { WORKER_GIT_COMMIT: "9cfb04d26497c55fc6933e634c91e5965d8171d8" };
        const result = await handleAdminApi(new Request("https://calendar.test/admin/system/overview"), env, adapter, 1);
        const body = await result.json();
        assert.equal(body.deployment.status, "out_of_sync");
        assert.match(body.deployment.message, /not on the latest GitHub commit/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("overview surfaces a specific GitHub error instead of a generic comparison-unavailable message", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({ message: "rate limited" }), { status: 403 });
    try {
        const adapter = { runWithIdentity: async (_userId, operation) => operation({ query: async () => ({ rows: [{ allowed: true }] }) }) };
        const env = { WORKER_GIT_COMMIT: "9cfb04d26497c55fc6933e634c91e5965d8171d8" };
        const result = await handleAdminApi(new Request("https://calendar.test/admin/system/overview"), env, adapter, 1);
        const body = await result.json();
        assert.equal(body.deployment.status, "unknown");
        assert.equal(body.deployment.github_error_code, "rate_limited");
        assert.match(body.deployment.message, /GitHub could not be verified/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test("reports the Worker database reconnect steps instead of returning 404", async () => {
    const adapter = {
        runWithIdentity: async (_userId, operation) => operation({
            query: async () => ({ rows: [{ allowed: true }] }),
        })
    };
    const result = await handleAdminApi(
        new Request("https://calendar.test/admin/system/database-config/test", {
            method: "POST",
            body: JSON.stringify({ database_mode: "postgres", database_url: "postgresql://example" }),
            headers: { "Content-Type": "application/json" },
        }),
        {},
        adapter,
        1,
    );
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.ok, false);
    assert.match(body.message, /HYPERDRIVE_RLS_NO_CACHE/);
    assert.equal(body.next_steps.length, 3);
});

test("rejects database saves in the single-binding Worker runtime", async () => {
    const adapter = {
        runWithIdentity: async (_userId, operation) => operation({
            query: async () => ({ rows: [{ allowed: true }] }),
        })
    };
    const result = await handleAdminApi(
        new Request("https://calendar.test/admin/system/database-config", {
            method: "POST",
            body: JSON.stringify({ provider_title: "Neon - Postgres" }),
            headers: { "Content-Type": "application/json" },
        }),
        {},
        adapter,
        1,
    );
    assert.equal(result.status, 409);
    const body = await result.json();
    assert.match(body.detail, /cannot be changed/);
    assert.equal(body.next_steps.length, 3);
});

test("reports an inactive Hyperdrive binding with setup instructions", async () => {
    const adapter = {
        runWithIdentity: async (_userId, operation) => operation({
            query: async () => ({ rows: [{ allowed: true }] }),
        })
    };
    const result = await handleAdminApi(
        new Request("https://calendar.test/admin/system/database-config"),
        {},
        adapter,
        1,
    );
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.live_database_confirmed, false);
    assert.equal(body.hyperdrive_configured, false);
    assert.match(body.message, /not configured/);
    assert.match(body.next_steps.join(" "), /npm run deploy/);
});

test("explains the required Cloudflare credentials for Hyperdrive editing", async () => {
    const adapter = {
        runWithIdentity: async (_userId, operation) => operation({
            query: async () => ({ rows: [{ allowed: true }] }),
        })
    };
    const result = await handleAdminApi(
        new Request("https://calendar.test/admin/system/database-config/update", {
            method: "PUT",
            body: JSON.stringify({ database_host: "db.example.test", database_name: "app", database_user: "user", database_password: "secret" }),
            headers: { "Content-Type": "application/json" },
        }),
        {},
        adapter,
        1,
    );
    assert.equal(result.status, 501);
    const body = await result.json();
    assert.match(body.detail, /not configured/);
    assert.doesNotMatch(JSON.stringify(body), /db\.example\.test|user/);
});

test("uses request-scoped Cloudflare credentials without echoing secrets", async () => {
    const adapter = {
        runWithIdentity: async (_userId, operation) => operation({
            query: async () => ({ rows: [{ allowed: true }] }),
        })
    };
    const originalFetch = globalThis.fetch;
    let captured = null;
    globalThis.fetch = async (url, init) => {
        captured = { url, init, body: JSON.parse(init.body) };
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    try {
        const result = await handleAdminApi(
            new Request("https://calendar.test/admin/system/database-config/update", {
                method: "PUT",
                body: JSON.stringify({ cloudflare_account_id: "acct", cloudflare_api_token: "cf-token", database_url: "postgresql://neon-user:db-pass@ep-example.neon.tech/neondb", provider_title: "Neon - Postgres" }),
                headers: { "Content-Type": "application/json" },
            }),
            {},
            adapter,
            1,
        );
        assert.equal(result.status, 200);
        assert.match(captured.url, /accounts\/acct\/hyperdrive\/configs/);
        assert.equal(captured.init.headers.Authorization, "Bearer cf-token");
        assert.equal(captured.body.origin.host, "ep-example.neon.tech");
        const responseBody = await result.json();
        assert.equal(responseBody.cloudflare_token_accepted, true);
        assert.doesNotMatch(JSON.stringify(responseBody), /cf-token|db-pass/);
    } finally {
        globalThis.fetch = originalFetch;
    }
});