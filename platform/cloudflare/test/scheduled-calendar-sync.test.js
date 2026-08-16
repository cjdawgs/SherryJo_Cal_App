import assert from "node:assert/strict";
import test from "node:test";

import { runAccountSyncNow, runScheduledCalendarSync } from "../src/scheduled-calendar-sync.js";
import worker from "../src/worker.js";

function account(overrides = {}) {
    return {
        id: 8,
        user_id: 42,
        provider: "google",
        account_email: "agent@example.com",
        access_token: "plain-access",
        refresh_token: "plain-refresh",
        token_expires_at: "2026-08-16T13:00:00Z",
        sync_token: {},
        sync_range_days: 30,
        latest_sync_marker: null,
        ...overrides,
    };
}

test("scheduled sync is fail-closed until explicitly enabled", async () => {
    const result = await runScheduledCalendarSync({}, {
        adapter: { claimDueAccounts() { throw new Error("must not claim"); } },
    });
    assert.deepEqual(result, { status: "disabled", claimed: 0, results: [] });
});

test("manual account sync uses the durable pipeline even when Cron is disabled", async () => {
    const claimed = account();
    const adapter = {
        claimOwnedAccount: async (userId, accountId) => userId === 42 && accountId === 8 ? claimed : null,
        beginAccountSync: async () => ({ id: "operation-1", attempt_count: 1 }),
        decryptClaim: async (value) => value,
        applyAccountSync: async () => ({ created: 1, updated: 0, deleted: 0 }),
    };
    const result = await runAccountSyncNow(
        { SCHEDULED_SYNC_ENABLED: "false", TOKEN_ENCRYPTION_KEY: "unused" },
        42,
        8,
        {
            adapter,
            uuid: () => "operation-1",
            now: new Date("2026-08-16T12:00:00Z"),
            fetchImpl: async (url) => {
                if (String(url).includes("calendarList")) {
                    return new Response(JSON.stringify({ items: [] }), { status: 200 });
                }
                throw new Error(`Unexpected URL ${url}`);
            },
        },
    );

    assert.equal(result.status, "succeeded");
    assert.equal(result.created, 1);
});

test("processes claimed accounts independently and preserves stable operation keys", async () => {
    const calls = [];
    const adapter = {
        async claimDueAccounts(limit, seconds) {
            calls.push(["claim", limit, seconds]);
            return [account(), account({ id: 9, provider: "microsoft" })];
        },
        async runMaintenance(days) {
            calls.push(["maintenance", days]);
            return { deleted_diag_rows: 0, changes: 1, no_changes: 0, total_cycles: 1 };
        },
        async beginAccountSync(value, operationId, key) {
            calls.push(["begin", value.id, operationId, key]);
            return { id: operationId, attempt_count: 1 };
        },
        async decryptClaim(value) { return value; },
        async applyAccountSync(value, providerResult, _token, _key, operationId) {
            calls.push(["apply", value.id, operationId, providerResult.events.length]);
            return { created: providerResult.events.length, updated: 0, deleted: 0 };
        },
        async failAccountSync(value, operationId, error, reauth) {
            calls.push(["fail", value.id, operationId, error.name, reauth]);
        },
    };
    const fetchImpl = async (input) => {
        const url = String(input);
        if (url.includes("calendarList")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
        if (url.includes("calendarView/delta")) return new Response(JSON.stringify({ error: { message: "unavailable" } }), { status: 503 });
        throw new Error(`Unexpected URL ${url}`);
    };

    const result = await runScheduledCalendarSync({
        SCHEDULED_SYNC_ENABLED: "true",
        SCHEDULED_SYNC_BATCH_SIZE: "2",
        SCHEDULED_SYNC_CLAIM_SECONDS: "180",
        TOKEN_ENCRYPTION_KEY: "unused",
    }, {
        adapter,
        fetchImpl,
        now: new Date("2026-08-16T12:00:00Z"),
        uuid: (() => { let value = 0; return () => `operation-${++value}`; })(),
    });

    assert.equal(result.claimed, 2);
    assert.equal(result.succeeded, 1);
    assert.equal(result.failed, 1);
    assert.equal(result.maintenance.total_cycles, 1);
    assert.deepEqual(calls[0], ["claim", 2, 180]);
    assert.deepEqual(calls[1], ["begin", 8, "operation-1", "worker-sync:account:8:anchor:bootstrap"]);
    assert.ok(calls.some((entry) => entry[0] === "apply" && entry[1] === 8));
    assert.ok(calls.some((entry) => entry[0] === "fail" && entry[1] === 9));
});

test("Worker scheduled handler registers the sync promise with waitUntil", async () => {
    let promise;
    worker.scheduled({}, { SCHEDULED_SYNC_ENABLED: "false" }, {
        waitUntil(value) { promise = value; },
    });
    assert.ok(promise instanceof Promise);
    assert.equal((await promise).status, "disabled");
});