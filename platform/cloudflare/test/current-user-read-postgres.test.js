import assert from "node:assert/strict";
import test from "node:test";

import {
    CURRENT_USER_READ_SQL,
    executeCurrentUserRead,
} from "../src/current-user-read-postgres.js";

test("reads only the current user's public identity fields", async () => {
    const calls = [];
    const adapter = {
        runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({
                query(sql) {
                    calls.push(["query", sql]);
                    return { rows: [{ id: 42, email: "staff@example.com", role: "staff" }] };
                },
            });
        },
    };

    assert.deepEqual(await executeCurrentUserRead(adapter, 42), {
        id: 42,
        email: "staff@example.com",
        role: "staff",
    });
    assert.deepEqual(calls, [["identity", 42], ["query", CURRENT_USER_READ_SQL]]);
    assert.match(CURRENT_USER_READ_SQL, /id = public\.worker_app_user_id\(\)/);
    assert.doesNotMatch(CURRENT_USER_READ_SQL, /password|token/i);
});

test("rejects a verified identity that no longer exists", async () => {
    const adapter = {
        runWithIdentity(_userId, operation) {
            return operation({ query() { return { rows: [] }; } });
        },
    };

    await assert.rejects(executeCurrentUserRead(adapter, 42), /user does not exist/);
});