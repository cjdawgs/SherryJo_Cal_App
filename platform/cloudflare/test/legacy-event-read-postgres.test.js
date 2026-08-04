import assert from "node:assert/strict";
import test from "node:test";

import {
    executeLegacyEventRead,
    LEGACY_EVENT_NOTE_READ_SQL,
    LEGACY_EVENT_READ_SQL,
    serializeLegacyEventRows,
} from "../src/legacy-event-read-postgres.js";

test("serializes the FastAPI legacy event and embedded-note contract", () => {
    const result = serializeLegacyEventRows([
        {
            id: 7,
            title: "Planning",
            start_time: new Date("2026-08-04T09:00:00Z"),
            end_time: null,
            description: null,
            status: "pending",
            source: "local",
        },
    ], [
        { id: "note-1", event_id: 7, content: "Bring notes", color: "yellow", x: 120, y: 140 },
    ]);

    assert.deepEqual(result, [{
        id: "7",
        title: "Planning",
        start: "2026-08-04T09:00:00+00:00",
        end: null,
        hasNote: true,
        notes: [{ id: "note-1", content: "Bring notes", color: "yellow", x: 120, y: 140 }],
        extendedProps: { description: null, status: "pending", source: "local" },
    }]);
});

test("reads events and notes under one transaction-local owner identity", async () => {
    const queries = [];
    const adapter = {
        async runWithIdentity(userId, operation) {
            assert.equal(userId, 42);
            return operation({
                async query(sql) {
                    queries.push(sql);
                    return { rows: [] };
                },
            });
        },
    };

    assert.deepEqual(await executeLegacyEventRead(adapter, 42), []);
    assert.deepEqual(queries, [LEGACY_EVENT_READ_SQL, LEGACY_EVENT_NOTE_READ_SQL]);
    assert.match(LEGACY_EVENT_READ_SQL, /owner_id = public\.worker_app_user_id\(\)/);
    assert.match(LEGACY_EVENT_NOTE_READ_SQL, /events\.owner_id = public\.worker_app_user_id\(\)/);
});