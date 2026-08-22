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