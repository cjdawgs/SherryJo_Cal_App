import assert from "node:assert/strict";
import test from "node:test";

import {
    ACCOUNT_SYNC_LOCK_SQL,
    BEGIN_SYNC_OPERATION_SQL,
    CLAIM_DUE_ACCOUNTS_SQL,
    CLAIM_OWNED_ACCOUNT_SQL,
    COMPLETE_ACCOUNT_SYNC_SQL,
    FIND_STALE_SYNC_EVENT_IDS_SQL,
    FINISH_SYNC_OPERATION_SQL,
    INSERT_SYNC_EVENT_SQL,
    RUN_SCHEDULED_MAINTENANCE_SQL,
    ScheduledSyncPostgresAdapter,
    FAIL_ACCOUNT_SYNC_SQL,
} from "../src/scheduled-sync-postgres.js";

function mockClient(handler) {
    const calls = [];
    return {
        calls,
        async connect() { calls.push(["connect"]); },
        async query(sql, params) {
            calls.push([sql, params]);
            return handler?.(sql, params) || { rows: [] };
        },
        async end() { calls.push(["end"]); },
    };
}

test("claims due accounts without assigning a user identity", async () => {
    const client = mockClient((sql) => sql === CLAIM_DUE_ACCOUNTS_SQL
        ? { rows: [{ id: 8, user_id: 42, provider: "google" }] }
        : { rows: [] });
    const adapter = new ScheduledSyncPostgresAdapter({
        createClient: () => client,
        connectionString: "postgres://hyperdrive",
    });

    const rows = await adapter.claimDueAccounts(5, 180);

    assert.equal(rows[0].id, 8);
    assert.deepEqual(client.calls, [
        ["connect"],
        ["BEGIN", undefined],
        [CLAIM_DUE_ACCOUNTS_SQL, [5, 180]],
        ["COMMIT", undefined],
        ["end"],
    ]);
});

test("claims one immediate account under the authenticated owner identity", async () => {
    const client = mockClient((sql) => sql === CLAIM_OWNED_ACCOUNT_SQL
        ? { rows: [{ id: 9, user_id: 42 }] }
        : { rows: [] });
    const adapter = new ScheduledSyncPostgresAdapter({
        createClient: () => client,
        connectionString: "postgres://hyperdrive",
    });

    assert.deepEqual(await adapter.claimOwnedAccount(42, 9, 240), { id: 9, user_id: 42 });
    assert.ok(client.calls.some(([sql, params]) => sql.includes("set_config") && params[0] === "42"));
    assert.ok(client.calls.some(([sql, params]) => sql === CLAIM_OWNED_ACCOUNT_SQL && params[0] === 9));
});

test("runs global maintenance only through the restricted database function", async () => {
    const client = mockClient((sql) => sql === RUN_SCHEDULED_MAINTENANCE_SQL
        ? { rows: [{ deleted_diag_rows: 3, changes: 4, no_changes: 5, total_cycles: 9 }] }
        : { rows: [] });
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });

    const result = await adapter.runMaintenance(14);

    assert.equal(result.deleted_diag_rows, 3);
    assert.ok(client.calls.some(([sql, params]) => sql === RUN_SCHEDULED_MAINTENANCE_SQL && params[0] === 14));
    assert.ok(!client.calls.some(([sql]) => /DELETE FROM public\.tv_diag_log/i.test(sql)));
});

test("does not resume succeeded or dead-letter account operations", async () => {
    assert.match(BEGIN_SYNC_OPERATION_SQL, /status NOT IN \('succeeded', 'dead_letter'\)/);
    const client = mockClient((sql) => sql === BEGIN_SYNC_OPERATION_SQL ? { rows: [] } : { rows: [] });
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });

    const operation = await adapter.beginAccountSync(
        { id: 8, user_id: 42, provider: "google" },
        "operation-id",
        "worker-sync:account:8:anchor:bootstrap",
        new Date("2026-08-16T12:00:00Z"),
    );

    assert.equal(operation, null);
    assert.ok(client.calls.some(([sql]) => sql === ACCOUNT_SYNC_LOCK_SQL));
    assert.ok(client.calls.some(([sql]) => sql === BEGIN_SYNC_OPERATION_SQL));
});

test("failed attempts preserve the sync marker so retries keep one operation key", () => {
    assert.doesNotMatch(FAIL_ACCOUNT_SYNC_SQL, /\blast_sync\s*=/);
    assert.match(FAIL_ACCOUNT_SYNC_SQL, /last_sync_failure\s*=/);
});

test("persists a full account sync and its ledger result in one user transaction", async () => {
    const client = mockClient((sql) => {
        if (sql.includes("SELECT id, source, external_ids")) return { rows: [] };
        if (sql === FIND_STALE_SYNC_EVENT_IDS_SQL) return { rows: [] };
        return { rows: [] };
    });
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });
    const account = { id: 8, user_id: 42, provider: "google", account_email: "agent@example.com" };

    const result = await adapter.applyAccountSync(account, {
        events: [{ externalId: "g-1", title: "Showing", start: "2026-08-17T14:00:00Z", end: "2026-08-17T15:00:00Z" }],
        cancelledIds: [],
        syncToken: { primary: "next" },
        incremental: false,
    }, {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date("2026-08-16T13:00:00Z"),
    }, "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "operation-id", new Date("2026-08-16T12:00:00Z"));

    assert.deepEqual(result, { created: 1, updated: 0, deleted: 0 });
    assert.ok(client.calls.some(([sql]) => sql === INSERT_SYNC_EVENT_SQL));
    assert.ok(client.calls.some(([sql]) => sql === COMPLETE_ACCOUNT_SYNC_SQL));
    const finish = client.calls.find(([sql]) => sql === FINISH_SYNC_OPERATION_SQL);
    assert.equal(finish[1][1], "succeeded");
    assert.deepEqual(client.calls.slice(-2), [["COMMIT", undefined], ["end"]]);
});