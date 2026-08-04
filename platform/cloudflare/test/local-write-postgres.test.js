import assert from "node:assert/strict";
import test from "node:test";
import {
    executeNoteWrite, NOTE_DOMAIN_LOCK_SQL, NOTE_EVENT_READ_SQL, NOTE_EXISTING_READ_SQL,
    NOTE_INSERT_SQL, NOTE_RECEIPT_INSERT_SQL, NOTE_RECEIPT_READ_SQL, NOTE_WRITE_LOCK_SQL,
} from "../src/note-write-postgres.js";
import {
    executeTaskWrite, TASK_INSERT_SQL, TASK_RECEIPT_INSERT_SQL, TASK_RECEIPT_READ_SQL, TASK_WRITE_LOCK_SQL,
} from "../src/task-write-postgres.js";

function adapterFor(query) {
    return { runWithIdentity(userId, operation) { assert.equal(userId, 42); return operation({ query }); } };
}

test("creates an event-owned note under domain and receipt locks", async () => {
    const calls = []; const stored = { id: "note-id", date: "2026-08-04", content: "Keep", color: "yellow", x: 120, y: 120, event_id: 7 };
    const response = await executeNoteWrite(adapterFor((sql) => {
        calls.push(sql);
        if (sql === NOTE_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === NOTE_EVENT_READ_SQL) return { rows: [{ id: 7 }] };
        if (sql === NOTE_EXISTING_READ_SQL) return { rows: [] };
        if (sql === NOTE_INSERT_SQL) return { rows: [stored] };
        if (sql === NOTE_RECEIPT_INSERT_SQL) return { rows: [{ response_body: stored }] };
        return { rows: [] };
    }), { userId: 42, data: { event_id: 7, date: "2026-08-04", content: "Keep" }, idempotencyKey: "key", requestHash: "hash" });
    assert.deepEqual(response, stored);
    assert.deepEqual(calls, [NOTE_WRITE_LOCK_SQL, NOTE_RECEIPT_READ_SQL, NOTE_DOMAIN_LOCK_SQL, NOTE_EVENT_READ_SQL, NOTE_EXISTING_READ_SQL, NOTE_INSERT_SQL, NOTE_RECEIPT_INSERT_SQL]);
});

test("creates a task and returns the stored receipt", async () => {
    const calls = []; const now = new Date("2026-08-04T12:00:00Z");
    const stored = { id: 5, title: "Call", description: null, completed: false, owner_id: 42, created_at: "2026-08-04T12:00:00+00:00" };
    const response = await executeTaskWrite(adapterFor((sql) => {
        calls.push(sql);
        if (sql === TASK_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === TASK_INSERT_SQL) return { rows: [{ ...stored, created_at: now }] };
        if (sql === TASK_RECEIPT_INSERT_SQL) return { rows: [{ response_body: stored }] };
        return { rows: [] };
    }), { userId: 42, data: { title: "Call" }, idempotencyKey: "key", requestHash: "hash", now });
    assert.deepEqual(response, stored);
    assert.deepEqual(calls, [TASK_WRITE_LOCK_SQL, TASK_RECEIPT_READ_SQL, TASK_INSERT_SQL, TASK_RECEIPT_INSERT_SQL]);
});