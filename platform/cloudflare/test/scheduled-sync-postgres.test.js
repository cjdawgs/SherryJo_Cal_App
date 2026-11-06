import assert from "node:assert/strict";
import test from "node:test";

import {
    ACCOUNT_SYNC_LOCK_SQL,
    BEGIN_SYNC_OPERATION_SQL,
    CLAIM_DUE_ACCOUNTS_SQL,
    CLAIM_OWNED_ACCOUNT_SQL,
    COMPLETE_ACCOUNT_SYNC_SQL,
    DELETE_SYNC_EVENTS_SQL,
    FIND_STALE_SYNC_EVENT_IDS_SQL,
    FINISH_SYNC_OPERATION_SQL,
    FIND_SYNC_EVENT_SQL,
    FIND_SYNC_EVENTS_SQL,
    INSERT_SYNC_EVENT_SQL,
    INSERT_SYNC_EVENTS_SQL,
    UPDATE_SYNC_EVENTS_SQL,
    UPDATE_SYNC_EVENT_SQL,
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
    assert.ok(client.calls.some(([sql]) => sql === INSERT_SYNC_EVENTS_SQL));
    assert.ok(client.calls.some(([sql]) => sql === COMPLETE_ACCOUNT_SYNC_SQL));
    const finish = client.calls.find(([sql]) => sql === FINISH_SYNC_OPERATION_SQL);
    assert.equal(finish[1][1], "succeeded");
    assert.deepEqual(client.calls.slice(-2), [["COMMIT", undefined], ["end"]]);
});

test("syncing hundreds of existing events uses a bounded number of database statements", async () => {
    const events = Array.from({ length: 618 }, (_, index) => ({
        externalId: `g-${index}`,
        title: `Event ${index}`,
        start: "2026-08-17T14:00:00Z",
        end: "2026-08-17T15:00:00Z",
    }));
    const client = mockClient((sql) => {
        if (sql.includes("FROM public.events") && sql.includes("FOR UPDATE")) {
            return { rows: events.map((event, index) => ({
                id: index + 1,
                external_id: `google:agent@example.com:${event.externalId}`,
            })) };
        }
        return { rows: [] };
    });
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });

    const result = await adapter.applyAccountSync(
        { id: 8, user_id: 42, provider: "google", account_email: "agent@example.com" },
        { events, cancelledIds: [], syncToken: { primary: "next" }, incremental: true },
        { accessToken: "access", refreshToken: null, expiresAt: new Date("2026-08-16T13:00:00Z") },
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "operation-id", new Date("2026-08-16T12:00:00Z"),
    );

    assert.deepEqual(result, { created: 0, updated: 618, deleted: 0 });
    assert.ok(client.calls.filter(([sql]) => typeof sql === "string" && sql !== "connect" && sql !== "end").length <= 10);
    assert.equal(client.calls.filter(([sql]) => sql === FIND_SYNC_EVENTS_SQL).length, 1);
    assert.equal(client.calls.filter(([sql]) => sql === UPDATE_SYNC_EVENTS_SQL).length, 1);
});

test("batches mixed inserts and updates while preserving linked identifiers", async () => {
    const client = mockClient((sql) => sql === FIND_SYNC_EVENTS_SQL
        ? { rows: [{ id: 7, external_id: "google:agent@example.com:existing" }] }
        : { rows: [] });
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });
    const makeEvent = (externalId) => ({
        externalId, title: externalId, start: "2026-08-17T14:00:00Z", end: "2026-08-17T15:00:00Z",
    });
    const result = await adapter.applyAccountSync(
        { id: 8, user_id: 42, provider: "google", account_email: "Agent@example.com" },
        { events: [makeEvent("existing"), makeEvent("new")], cancelledIds: [], syncToken: {}, incremental: true },
        { accessToken: "access", refreshToken: null, expiresAt: new Date("2026-08-16T13:00:00Z") },
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "operation-id", new Date("2026-08-16T12:00:00Z"),
    );
    assert.deepEqual(result, { created: 1, updated: 1, deleted: 0 });
    const updates = JSON.parse(client.calls.find(([sql]) => sql === UPDATE_SYNC_EVENTS_SQL)[1][0]);
    const inserts = JSON.parse(client.calls.find(([sql]) => sql === INSERT_SYNC_EVENTS_SQL)[1][0]);
    assert.equal(updates[0].id, 7);
    assert.deepEqual(updates[0].external_ids, { "google:agent@example.com": "existing" });
    assert.equal(inserts[0].external_id, "google:agent@example.com:new");
    assert.equal(inserts[0].title, "new");
});

test("duplicate incoming event identifiers retain sequential insert then update behavior", async () => {
    let found = false;
    const client = mockClient((sql) => {
        if (sql === FIND_SYNC_EVENT_SQL) return { rows: found ? [{ id: 7 }] : [] };
        if (sql === INSERT_SYNC_EVENT_SQL) found = true;
        return { rows: [] };
    });
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });
    const event = { externalId: "same", title: "Event", start: "2026-08-17T14:00:00Z", end: "2026-08-17T15:00:00Z" };
    const result = await adapter.applyAccountSync(
        { id: 8, user_id: 42, provider: "google", account_email: "agent@example.com" },
        { events: [event, event], cancelledIds: [], syncToken: {}, incremental: true },
        { accessToken: "access", refreshToken: null, expiresAt: new Date("2026-08-16T13:00:00Z") },
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "operation-id", new Date("2026-08-16T12:00:00Z"),
    );
    assert.deepEqual(result, { created: 1, updated: 1, deleted: 0 });
    assert.equal(client.calls.filter(([sql]) => sql === INSERT_SYNC_EVENT_SQL).length, 1);
    assert.equal(client.calls.filter(([sql]) => sql === UPDATE_SYNC_EVENT_SQL).length, 1);
    assert.equal(client.calls.filter(([sql]) => sql === FIND_SYNC_EVENTS_SQL).length, 0);
});

test("full-window reconciliation only considers events in the fetched window", async () => {
    const client = mockClient(() => ({ rows: [] }));
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });
    const start = "2026-08-01T00:00:00.000Z";
    const end = "2026-09-01T00:00:00.000Z";
    await adapter.applyAccountSync(
        { id: 8, user_id: 42, provider: "google", account_email: "agent@example.com" },
        { events: [], cancelledIds: [], syncToken: {}, incremental: false, reconciliationWindow: { start, end } },
        { accessToken: "access", refreshToken: null, expiresAt: new Date("2026-08-16T13:00:00Z") },
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "operation-id", new Date("2026-08-16T12:00:00Z"),
    );
    const stale = client.calls.find(([sql]) => sql === FIND_STALE_SYNC_EVENT_IDS_SQL);
    assert.deepEqual(stale[1].slice(3), [start, end]);
    assert.match(stale[0], /start_time\s*<\s*\$5::timestamptz/);
    assert.match(stale[0], /COALESCE\(end_time,\s*start_time\)\s*>\s*\$4::timestamptz/);
});

test("unsafe full snapshots skip stale reconciliation but still apply cancellations", async () => {
    const client = mockClient(() => ({ rows: [] }));
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });
    await adapter.applyAccountSync(
        { id: 8, user_id: 42, provider: "google", account_email: "agent@example.com" },
        {
            events: [], cancelledIds: ["cancelled"], syncToken: {}, incremental: false,
            reconcileFullSnapshot: false,
            reconciliationWindow: { start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z" },
        },
        { accessToken: "access", refreshToken: null, expiresAt: new Date("2026-08-16T13:00:00Z") },
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "operation-id", new Date("2026-08-16T12:00:00Z"),
    );
    assert.equal(client.calls.some(([sql]) => sql === FIND_STALE_SYNC_EVENT_IDS_SQL), false);
    assert.ok(client.calls.some(([sql, params]) =>
        sql === DELETE_SYNC_EVENTS_SQL && params[0][0] === "google:agent@example.com:cancelled"));
});

test("sync completion retains a cursor only if the range generation still matches", async () => {
    const client = mockClient(() => ({ rows: [] }));
    const adapter = new ScheduledSyncPostgresAdapter({ createClient: () => client, connectionString: "postgres://hyperdrive" });
    await adapter.applyAccountSync(
        { id: 8, user_id: 42, provider: "google", account_email: "agent@example.com", sync_token: { _range_generation: "old" } },
        { events: [], cancelledIds: [], syncToken: { primary: "cursor" }, incremental: true },
        { accessToken: "access", refreshToken: null, expiresAt: new Date("2026-08-16T13:00:00Z") },
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", "operation-id", new Date("2026-08-16T12:00:00Z"),
    );
    const [sql, params] = client.calls.find(([query]) => query === COMPLETE_ACCOUNT_SYNC_SQL);
    assert.match(sql, /_range_generation/);
    assert.equal(params[6], "old");
    assert.equal(JSON.parse(params[4])._range_generation, "old");
});