import assert from "node:assert/strict";
import test from "node:test";

import {
    executeNoteRead,
    NOTE_READ_SQL,
    serializeNoteRows,
} from "../src/note-read-postgres.js";


test("serializes note rows with the FastAPI response fields", () => {
    assert.deepEqual(serializeNoteRows([{
        id: "note-1",
        date: "2026-08-04",
        content: "Confirm inspection",
        color: "yellow",
        x: 120,
        y: 120,
        event_id: 7,
    }]), [{
        id: "note-1",
        date: "2026-08-04",
        content: "Confirm inspection",
        color: "yellow",
        x: 120,
        y: 120,
        event_id: 7,
    }]);
});


test("reads notes by date under transaction-local identity", async () => {
    const calls = [];
    const adapter = {
        async runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({
                async query(sql, parameters) {
                    calls.push(["query", sql, parameters]);
                    return { rows: [] };
                },
            });
        },
    };

    assert.deepEqual(await executeNoteRead(adapter, { userId: 42, date: "2026-08-04" }), []);
    assert.deepEqual(calls, [
        ["identity", 42],
        ["query", NOTE_READ_SQL, ["2026-08-04"]],
    ]);
    assert.match(NOTE_READ_SQL, /events\.owner_id = public\.worker_app_user_id\(\)/);
});


test("rejects a missing note date before opening a database transaction", async () => {
    await assert.rejects(
        executeNoteRead({ runWithIdentity() { } }, { userId: 42, date: null }),
        /date is required/,
    );
});