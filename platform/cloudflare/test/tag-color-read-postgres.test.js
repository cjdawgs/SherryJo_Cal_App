import assert from "node:assert/strict";
import test from "node:test";

import {
    executeTagColorRead,
    serializeTagColorRows,
    TAG_COLOR_READ_SQL,
} from "../src/tag-color-read-postgres.js";

test("serializes tag-color rows with the FastAPI response fields", () => {
    assert.deepEqual(serializeTagColorRows([
        { tag_key: "family", label: "Family", color: "#ff3344", enabled: true },
        { tag_key: "invalid", label: "Invalid", color: "red", enabled: 0 },
        { tag_key: "", label: "Omitted", color: "#112233", enabled: true },
    ]), {
        settings: {
            family: { label: "Family", color: "#ff3344", enabled: true },
            invalid: { label: "Invalid", color: "#4F8EF7", enabled: false },
        },
    });
});

test("reads tag colors under transaction-local identity", async () => {
    const calls = [];
    const adapter = {
        runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({ query(sql) { calls.push(["query", sql]); return { rows: [] }; } });
        },
    };

    assert.deepEqual(await executeTagColorRead(adapter, 42), { settings: {} });
    assert.deepEqual(calls, [["identity", 42], ["query", TAG_COLOR_READ_SQL]]);
    assert.match(TAG_COLOR_READ_SQL, /owner_id = public\.worker_app_user_id\(\)/);
});