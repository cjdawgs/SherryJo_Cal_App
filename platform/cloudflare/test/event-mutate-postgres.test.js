import assert from "node:assert/strict";
import test from "node:test";
import {
    EVENT_DELETE_SQL, EVENT_MUTATION_LOCK_SQL, EVENT_MUTATION_RECEIPT_INSERT_SQL,
    EVENT_MUTATION_RECEIPT_READ_SQL, EVENT_NOTE_DELETE_SQL, EVENT_UPDATE_READ_SQL,
    EVENT_UPDATE_SQL, EventNotFoundError, EventUpdateConflictError,
    executeEventDelete, executeEventUpdate,
} from "../src/event-mutate-postgres.js";

const now = new Date("2026-08-04T12:00:00Z");
const row = { id: 7, title: "Before", description: "Old", start_time: new Date("2026-08-04T09:00:00Z"), end_time: null, recurrence: null, color: null, color_enabled: false, tags: [], sticky_note: null, sticky_notes: [], created_at: now, updated_at: now, source: "local", account_email: "local", external_ids: {} };
function adapterFor(query) { return { runWithIdentity(userId, operation) { assert.equal(userId, 42); return operation({ query }); } }; }

test("partially updates an event and stores the authoritative response", async () => {
    const calls = []; const stored = { status: "ok", event: { id: 7, title: "After" } };
    const response = await executeEventUpdate(adapterFor((sql, parameters) => {
        calls.push([sql, parameters]);
        if (sql === EVENT_MUTATION_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === EVENT_UPDATE_READ_SQL) return { rows: [{ ...row }] };
        if (sql === EVENT_UPDATE_SQL) return { rows: [{ ...row, title: parameters[1], updated_at: now }] };
        if (sql === EVENT_MUTATION_RECEIPT_INSERT_SQL) return { rows: [{ response_body: stored }] };
        return { rows: [] };
    }), { userId: 42, eventId: 7, data: { title: " After " }, idempotencyKey: "key", requestHash: "hash", now });
    assert.deepEqual(response, stored);
    assert.deepEqual(calls.map(([sql]) => sql), [EVENT_MUTATION_LOCK_SQL, EVENT_MUTATION_RECEIPT_READ_SQL, EVENT_UPDATE_READ_SQL, EVENT_UPDATE_SQL, EVENT_MUTATION_RECEIPT_INSERT_SQL]);
    assert.equal(calls[3][1][2], "Old");
});

test("rejects stale event updates", async () => {
    await assert.rejects(executeEventUpdate(adapterFor((sql) => {
        if (sql === EVENT_MUTATION_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === EVENT_UPDATE_READ_SQL) return { rows: [{ ...row, updated_at: new Date("2026-08-04T12:00:00Z") }] };
        return { rows: [] };
    }), { userId: 42, eventId: 7, data: { client_updated_at: "2026-08-04T11:00:00Z" }, idempotencyKey: "key", requestHash: "hash", now }), EventUpdateConflictError);
});

test("deletes child notes before the owned event and records replay", async () => {
    const calls = []; const stored = { status: "ok", deleted: 7 };
    const response = await executeEventDelete(adapterFor((sql) => {
        calls.push(sql);
        if (sql === EVENT_MUTATION_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === EVENT_UPDATE_READ_SQL) return { rows: [row] };
        if (sql === EVENT_DELETE_SQL) return { rows: [{ id: 7 }] };
        if (sql === EVENT_MUTATION_RECEIPT_INSERT_SQL) return { rows: [{ response_body: stored }] };
        return { rows: [] };
    }), { userId: 42, eventId: 7, idempotencyKey: "key", requestHash: "hash" });
    assert.deepEqual(response, stored);
    assert.deepEqual(calls, [EVENT_MUTATION_LOCK_SQL, EVENT_MUTATION_RECEIPT_READ_SQL, EVENT_UPDATE_READ_SQL, EVENT_NOTE_DELETE_SQL, EVENT_DELETE_SQL, EVENT_MUTATION_RECEIPT_INSERT_SQL]);
});

test("returns not found for an unowned event", async () => {
    await assert.rejects(executeEventDelete(adapterFor((sql) => sql === EVENT_MUTATION_RECEIPT_READ_SQL ? { rows: [] } : { rows: [] }), { userId: 42, eventId: 99, idempotencyKey: "key", requestHash: "hash" }), EventNotFoundError);
});