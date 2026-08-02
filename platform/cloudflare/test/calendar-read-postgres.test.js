import assert from "node:assert/strict";
import test from "node:test";

import {
    ACCOUNT_STATUS_READ_SQL,
    EVENT_READ_SQL,
    PostgresCalendarReadAdapter,
    executeCalendarRead,
    serializeCalendarEventRows,
} from "../src/calendar-read-postgres.js";
import {
    CALENDAR_READ_HYPERDRIVE_BINDING,
    createHyperdriveCalendarReadAdapter,
} from "../src/calendar-read-hyperdrive.js";

const query = {
    userId: 42,
    start: new Date("2026-08-01T00:00:00Z"),
    end: new Date("2026-08-08T00:00:00Z"),
    dedupEnabled: true,
};

function eventRow(overrides = {}) {
    return {
        id: 101,
        external_id: "external-101",
        external_ids: {},
        title: "Listing appointment",
        start_time: new Date("2026-08-01T14:00:00Z"),
        end_time: new Date("2026-08-01T15:00:00Z"),
        description: null,
        color: null,
        color_enabled: false,
        tags: null,
        sticky_note: null,
        sticky_notes: null,
        created_at: new Date("2026-07-30T12:00:00Z"),
        updated_at: null,
        source: "gmail",
        account_email: " Agent@Example.com ",
        ...overrides,
    };
}

function mockClient({ rows = [eventRow()], failOnEventRead = false } = {}) {
    const calls = [];
    return {
        calls,
        async connect() {
            calls.push(["connect"]);
        },
        async query(sql, parameters) {
            calls.push([sql, parameters]);
            if (sql === EVENT_READ_SQL) {
                if (failOnEventRead) throw new Error("database unavailable");
                return { rows };
            }
            return { rows: [] };
        },
        async end() {
            calls.push(["end"]);
        },
    };
}

test("reads bounded events with transaction-local identity and closes the client", async () => {
    const client = mockClient();
    const adapter = new PostgresCalendarReadAdapter({
        createClient: (options) => {
            assert.deepEqual(options, { connectionString: "postgres://hyperdrive" });
            return client;
        },
        connectionString: "postgres://hyperdrive",
    });

    const events = await adapter.listEvents(query);

    assert.equal(events[0].account_key, "google:agent@example.com");
    assert.equal(events[0].start, "2026-08-01T14:00:00+00:00");
    assert.deepEqual(client.calls, [
        ["connect"],
        ["BEGIN", undefined],
        ["SELECT set_config('app.user_id', $1, true)", ["42"]],
        [EVENT_READ_SQL, ["2026-08-01T00:00:00.000Z", "2026-08-08T00:00:00.000Z"]],
        ["COMMIT", undefined],
        ["end"],
    ]);
    assert.match(EVENT_READ_SQL, /owner_id = public\.worker_app_user_id\(\)/);
});

test("rolls back and closes the client when the event query fails", async () => {
    const client = mockClient({ failOnEventRead: true });
    const adapter = new PostgresCalendarReadAdapter({
        createClient: () => client,
        connectionString: "postgres://hyperdrive",
    });

    await assert.rejects(adapter.listEvents(query), /database unavailable/);
    assert.deepEqual(client.calls.slice(-2), [["ROLLBACK", undefined], ["end"]]);
});

test("reads only projected account status fields with transaction-local identity", async () => {
    const client = mockClient({ rows: [] });
    client.query = async function queryStatus(sql, parameters) {
        this.calls.push([sql, parameters]);
        if (sql === ACCOUNT_STATUS_READ_SQL) {
            return {
                rows: [
                    { account_key: "google:agent@example.com", account_status: "ok" },
                    { account_key: "microsoft:agent@example.com", account_status: "error" },
                ],
            };
        }
        return { rows: [] };
    };
    const adapter = new PostgresCalendarReadAdapter({
        createClient: () => client,
        connectionString: "postgres://hyperdrive",
    });

    const statuses = await adapter.listAccountStatuses(42);

    assert.deepEqual(statuses, {
        "google:agent@example.com": "ok",
        "microsoft:agent@example.com": "error",
    });
    assert.deepEqual(client.calls, [
        ["connect"],
        ["BEGIN", undefined],
        ["SELECT set_config('app.user_id', $1, true)", ["42"]],
        [ACCOUNT_STATUS_READ_SQL, undefined],
        ["COMMIT", undefined],
        ["end"],
    ]);
    assert.doesNotMatch(ACCOUNT_STATUS_READ_SQL, /token|oauth_accounts/i);
});

test("preserves all-day timestamps and expands linked accounts when dedup is disabled", () => {
    const rows = [eventRow({
        start_time: new Date("2026-08-02T00:00:00Z"),
        end_time: new Date("2026-08-03T00:00:00Z"),
        external_ids: {
            "gmail:Agent@Example.com": "g-1",
            "outlook:Agent@Example.com": "m-1",
        },
    })];

    const events = serializeCalendarEventRows(rows, false);

    assert.deepEqual(events.map((event) => event.account_key), [
        "google:agent@example.com",
        "microsoft:agent@example.com",
    ]);
    assert.equal(events[0].start, "2026-08-02T00:00:00");
    assert.equal(events[0].end, "2026-08-03T00:00:00");
});

test("fails soft independently for events and credential-free account status", async () => {
    const result = await executeCalendarRead({
        async listEvents() {
            throw new Error("database unavailable");
        },
        async listAccountStatuses() {
            return { "google:agent@example.com": "connected" };
        },
    }, query);

    assert.deepEqual(result, {
        events: [],
        account_status: { "google:agent@example.com": "connected" },
        account_event_totals: {},
    });
});

test("creates request-scoped pg clients from the cache-disabled Hyperdrive binding", async () => {
    const constructedWith = [];
    class TestClient {
        constructor(options) {
            constructedWith.push(options);
        }
    }

    const adapter = createHyperdriveCalendarReadAdapter({
        [CALENDAR_READ_HYPERDRIVE_BINDING]: {
            connectionString: "postgres://hyperdrive-runtime",
        },
    }, { ClientClass: TestClient });

    adapter.createClient({ connectionString: adapter.connectionString });
    assert.deepEqual(constructedWith, [{ connectionString: "postgres://hyperdrive-runtime" }]);
    assert.throws(
        () => createHyperdriveCalendarReadAdapter({}),
        /HYPERDRIVE_RLS_NO_CACHE is not configured/,
    );
});