import assert from "node:assert/strict";
import test from "node:test";

import {
    executeTaskRead,
    serializeTaskRows,
    TASK_READ_SQL,
} from "../src/task-read-postgres.js";


test("serializes task rows with the FastAPI response fields", () => {
    const rows = serializeTaskRows([{
        id: 7,
        title: "Call closing attorney",
        description: null,
        completed: false,
        owner_id: 42,
        created_at: new Date("2026-08-04T12:30:00Z"),
    }]);

    assert.deepEqual(rows, [{
        title: "Call closing attorney",
        description: null,
        completed: false,
        owner_id: 42,
        id: 7,
        created_at: "2026-08-04T12:30:00+00:00",
    }]);
});


test("executes the task query under transaction-local Worker identity", async () => {
    const calls = [];
    const adapter = {
        async runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({
                async query(sql) {
                    calls.push(["query", sql]);
                    return { rows: [] };
                },
            });
        },
    };

    assert.deepEqual(await executeTaskRead(adapter, 42), []);
    assert.deepEqual(calls, [
        ["identity", 42],
        ["query", TASK_READ_SQL],
    ]);
    assert.match(TASK_READ_SQL, /owner_id = public\.worker_app_user_id\(\)/);
});