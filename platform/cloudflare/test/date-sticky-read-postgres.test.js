import assert from "node:assert/strict";
import test from "node:test";

import {
    DATE_STICKY_ITEM_SQL,
    DATE_STICKY_LIST_SQL,
    executeDateStickyItemRead,
    executeDateStickyListRead,
    serializeDateStickyRow,
} from "../src/date-sticky-read-postgres.js";

test("serializes date-sticky rows with the FastAPI response fields", () => {
    assert.deepEqual(serializeDateStickyRow({
        id: 7,
        date: new Date("2026-08-04T00:00:00Z"),
        sticky_notes: [
            { content: " Keep this ", color: "#F7E68A", createdAt: "created", updatedAt: "updated" },
            { content: "" },
        ],
        updated_at: new Date("2026-08-04T12:00:00Z"),
    }), {
        id: 7,
        date: "2026-08-04",
        sticky_notes: [{ content: "Keep this", color: "#F7E68A", createdAt: "created", updatedAt: "updated" }],
        count: 1,
        updated_at: "2026-08-04T12:00:00+00:00",
    });
});

test("lists date-sticky rows under transaction-local identity", async () => {
    const calls = [];
    const adapter = {
        runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({ query(sql) { calls.push(["query", sql]); return { rows: [] }; } });
        },
    };

    assert.deepEqual(await executeDateStickyListRead(adapter, 42), { status: "ok", items: [] });
    assert.deepEqual(calls, [["identity", 42], ["query", DATE_STICKY_LIST_SQL]]);
    assert.match(DATE_STICKY_LIST_SQL, /owner_id = public\.worker_app_user_id\(\)/);
});

test("reads one date-sticky row and preserves FastAPI's empty response", async () => {
    const calls = [];
    const adapter = {
        runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({ query(sql, parameters) { calls.push(["query", sql, parameters]); return { rows: [] }; } });
        },
    };

    assert.deepEqual(await executeDateStickyItemRead(adapter, { userId: 42, date: "2026-08-04" }), {
        status: "ok",
        item: { date: "2026-08-04", sticky_notes: [], count: 0 },
    });
    assert.deepEqual(calls, [
        ["identity", 42],
        ["query", DATE_STICKY_ITEM_SQL, ["2026-08-04"]],
    ]);
    assert.match(DATE_STICKY_ITEM_SQL, /owner_id = public\.worker_app_user_id\(\)/);
});

test("rejects a missing date before opening a database transaction", async () => {
    await assert.rejects(
        executeDateStickyItemRead({ runWithIdentity() { } }, { userId: 42, date: "" }),
        /date is required/,
    );
});