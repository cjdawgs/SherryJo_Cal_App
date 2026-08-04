import assert from "node:assert/strict";
import test from "node:test";

import {
    DATE_STICKY_UPSERT_SQL,
    IdempotencyConflictError,
    WRITE_RECEIPT_INSERT_SQL,
    WRITE_RECEIPT_LOCK_SQL,
    WRITE_RECEIPT_READ_SQL,
    executeDateStickyWrite,
} from "../src/date-sticky-write-postgres.js";

function adapterFor(query) {
    return {
        runWithIdentity(userId, operation) {
            assert.equal(userId, 42);
            return operation({ query });
        },
    };
}

test("writes a date sticky and stores its exact response receipt atomically", async () => {
    const calls = [];
    const now = new Date("2026-08-04T12:00:00Z");
    const storedResponse = { item: { date: "2026-08-04", id: 7 }, status: "ok" };
    const response = await executeDateStickyWrite(adapterFor((sql, parameters) => {
        calls.push([sql, parameters]);
        if (sql === WRITE_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === DATE_STICKY_UPSERT_SQL) {
            return {
                rows: [{
                    id: 7,
                    date: "2026-08-04",
                    sticky_notes: [{ content: "Keep", color: "#F7E68A", createdAt: "created", updatedAt: "updated" }],
                    updated_at: now,
                }],
            };
        }
        if (sql === WRITE_RECEIPT_INSERT_SQL) return { rows: [{ response_body: storedResponse }] };
        return { rows: [] };
    }), {
        userId: 42,
        date: "2026-08-04",
        stickyNotes: [{ content: " Keep ", createdAt: "created", updatedAt: "updated" }],
        idempotencyKey: "write-key",
        requestHash: "request-hash",
        now,
    });

    assert.deepEqual(response, storedResponse);
    assert.deepEqual(calls.map(([sql]) => sql), [
        WRITE_RECEIPT_LOCK_SQL,
        WRITE_RECEIPT_READ_SQL,
        DATE_STICKY_UPSERT_SQL,
        WRITE_RECEIPT_INSERT_SQL,
    ]);
    assert.equal(JSON.parse(calls[3][1][3]).item.id, 7);
});

test("returns the stored response without repeating a same-key write", async () => {
    const stored = { status: "ok", item: { id: 7, date: "2026-08-04" } };
    const calls = [];
    const response = await executeDateStickyWrite(adapterFor((sql) => {
        calls.push(sql);
        if (sql === WRITE_RECEIPT_READ_SQL) {
            return { rows: [{ operation: "date_sticky_put", request_hash: "request-hash", response_body: stored }] };
        }
        return { rows: [] };
    }), {
        userId: 42,
        date: "2026-08-04",
        stickyNotes: [{ content: "Keep" }],
        idempotencyKey: "write-key",
        requestHash: "request-hash",
    });

    assert.deepEqual(response, stored);
    assert.deepEqual(calls, [WRITE_RECEIPT_LOCK_SQL, WRITE_RECEIPT_READ_SQL]);
});

test("rejects reuse of an idempotency key for a different request", async () => {
    await assert.rejects(
        executeDateStickyWrite(adapterFor((sql) => {
            if (sql === WRITE_RECEIPT_READ_SQL) {
                return { rows: [{ operation: "date_sticky_put", request_hash: "different", response_body: {} }] };
            }
            return { rows: [] };
        }), {
            userId: 42,
            date: "2026-08-04",
            stickyNotes: [],
            idempotencyKey: "write-key",
            requestHash: "request-hash",
        }),
        IdempotencyConflictError,
    );
});