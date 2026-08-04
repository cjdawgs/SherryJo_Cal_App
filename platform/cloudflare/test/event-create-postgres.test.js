import assert from "node:assert/strict";
import test from "node:test";
import {
    EVENT_CREATE_LOCK_SQL, EVENT_CREATE_RECEIPT_INSERT_SQL, EVENT_CREATE_RECEIPT_READ_SQL,
    EVENT_CREATE_SQL, EventCreateIdempotencyConflictError, executeEventCreate,
} from "../src/event-create-postgres.js";

function adapterFor(query) {
    return { runWithIdentity(userId, operation) { assert.equal(userId, 42); return operation({ query }); } };
}

test("creates a normalized event and returns the stored receipt", async () => {
    const calls = []; const now = new Date("2026-08-04T12:00:00Z");
    const stored = { status: "ok", event: { id: 9, title: "Visit" } };
    const response = await executeEventCreate(adapterFor((sql, parameters) => {
        calls.push([sql, parameters]);
        if (sql === EVENT_CREATE_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === EVENT_CREATE_SQL) return { rows: [{ id: 9, title: "Visit", description: "", start_time: now, end_time: null, recurrence: null, color: null, color_enabled: false, tags: [], sticky_notes: [], created_at: now, updated_at: now, source: "local", account_email: "local", external_ids: {} }] };
        if (sql === EVENT_CREATE_RECEIPT_INSERT_SQL) return { rows: [{ response_body: stored }] };
        return { rows: [] };
    }), { userId: 42, data: { title: " Visit ", start_time: now.toISOString() }, idempotencyKey: "key", requestHash: "hash", now });
    assert.deepEqual(response, stored);
    assert.deepEqual(calls.map(([sql]) => sql), [EVENT_CREATE_LOCK_SQL, EVENT_CREATE_RECEIPT_READ_SQL, EVENT_CREATE_SQL, EVENT_CREATE_RECEIPT_INSERT_SQL]);
    assert.equal(calls[2][1][0], "Visit");
});

test("replays creates and rejects changed requests", async () => {
    const stored = { status: "ok", event: { id: 9 } };
    const base = { userId: 42, data: { title: "Visit", start_time: "2026-08-04T12:00:00Z" }, idempotencyKey: "key", requestHash: "hash" };
    const query = (sql) => sql === EVENT_CREATE_RECEIPT_READ_SQL ? { rows: [{ operation: "event_create", request_hash: "hash", response_body: stored }] } : { rows: [] };
    assert.deepEqual(await executeEventCreate(adapterFor(query), base), stored);
    await assert.rejects(executeEventCreate(adapterFor((sql) => sql === EVENT_CREATE_RECEIPT_READ_SQL ? { rows: [{ operation: "event_create", request_hash: "other", response_body: stored }] } : { rows: [] }), base), EventCreateIdempotencyConflictError);
});