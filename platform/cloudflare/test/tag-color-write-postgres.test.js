import assert from "node:assert/strict";
import test from "node:test";

import {
    executeTagColorWrite,
    normalizeTagColorSettings,
    TAG_COLOR_RECEIPT_INSERT_SQL,
    TAG_COLOR_RECEIPT_READ_SQL,
    TAG_COLOR_RESULT_SQL,
    TAG_COLOR_UPSERT_SQL,
    TAG_COLOR_WRITE_LOCK_SQL,
    TagColorIdempotencyConflictError,
} from "../src/tag-color-write-postgres.js";

function adapterFor(query) {
    return {
        runWithIdentity(userId, operation) {
            assert.equal(userId, 42);
            return operation({ query });
        },
    };
}

test("normalizes tag color settings with FastAPI parity", () => {
    assert.deepEqual(normalizeTagColorSettings({
        "  FAMILY  ": { label: " Family   Time ", color: "#ff3344", enabled: 1 },
        invalid: { color: "red", enabled: 0 },
        omitted: null,
    }), [
        { tagKey: "family time", label: "Family Time", color: "#ff3344", enabled: true },
        { tagKey: "invalid", label: "invalid", color: "#4F8EF7", enabled: false },
    ]);
});

test("upserts settings and stores the authoritative response atomically", async () => {
    const calls = [];
    const stored = { settings: { family: { label: "Family", color: "#ff3344", enabled: true } }, status: "ok" };
    const response = await executeTagColorWrite(adapterFor((sql, parameters) => {
        calls.push([sql, parameters]);
        if (sql === TAG_COLOR_RECEIPT_READ_SQL) return { rows: [] };
        if (sql === TAG_COLOR_RESULT_SQL) {
            return { rows: [{ tag_key: "family", label: "Family", color: "#ff3344", enabled: true }] };
        }
        if (sql === TAG_COLOR_RECEIPT_INSERT_SQL) return { rows: [{ response_body: stored }] };
        return { rows: [] };
    }), {
        userId: 42,
        settings: { family: { label: "Family", color: "#ff3344", enabled: true } },
        idempotencyKey: "write-key",
        requestHash: "request-hash",
        now: new Date("2026-08-04T12:00:00Z"),
    });

    assert.deepEqual(response, stored);
    assert.deepEqual(calls.map(([sql]) => sql), [
        TAG_COLOR_WRITE_LOCK_SQL,
        TAG_COLOR_RECEIPT_READ_SQL,
        TAG_COLOR_UPSERT_SQL,
        TAG_COLOR_RESULT_SQL,
        TAG_COLOR_RECEIPT_INSERT_SQL,
    ]);
});

test("replays a stored response and rejects changed requests", async () => {
    const stored = { status: "ok", settings: {} };
    const replay = await executeTagColorWrite(adapterFor((sql) => {
        if (sql === TAG_COLOR_RECEIPT_READ_SQL) {
            return { rows: [{ operation: "tag_color_put", request_hash: "same", response_body: stored }] };
        }
        return { rows: [] };
    }), { userId: 42, settings: {}, idempotencyKey: "key", requestHash: "same" });
    assert.deepEqual(replay, stored);

    await assert.rejects(executeTagColorWrite(adapterFor((sql) => {
        if (sql === TAG_COLOR_RECEIPT_READ_SQL) {
            return { rows: [{ operation: "tag_color_put", request_hash: "different", response_body: stored }] };
        }
        return { rows: [] };
    }), { userId: 42, settings: {}, idempotencyKey: "key", requestHash: "same" }), TagColorIdempotencyConflictError);
});