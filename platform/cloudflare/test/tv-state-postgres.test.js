import assert from "node:assert/strict";
import test from "node:test";

import { executeTvStateRead, executeTvStateWrite } from "../src/tv-state-postgres.js";

function adapterWith(rowsByCall) {
    const calls = [];
    return {
        calls,
        runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({ query: async (sql, params) => ({ rows: rowsByCall.shift(), sql, params }) }).then((result) => {
                calls.push([result.sql, result.params]);
                return result;
            });
        },
    };
}

test("returns empty state without injecting today's date", async () => {
    const adapter = adapterWith([[{
        selected_date: null, current_view: "day", focused_event_id: null,
        email: "tv@example.com", role: "staff", sleep_guard_enabled: true,
        sleep_guard_timeout_minutes: 0,
    }]]);
    assert.deepEqual(await executeTvStateRead(adapter, 42), {
        selectedDate: null, currentView: "day", focusedEventId: null,
        currentUserEmail: "tv@example.com", currentUserRole: "staff",
        sleepGuardEnabled: true, sleepGuardTimeoutMinutes: 0,
    });
});

test("writes only supplied state fields and enforces never-timeout by default", async () => {
    const state = {
        selected_date: "2026-08-16", current_view: "week", focused_event_id: null,
        sleep_guard_enabled: true, sleep_guard_timeout_minutes: 0,
    };
    const adapter = adapterWith([[state], [{ ...state, email: "tv@example.com", role: "staff" }]]);
    const result = await executeTvStateWrite(adapter, {
        userId: 42,
        body: { selectedDate: "2026-08-16", currentView: "week", sleepGuardTimeoutMinutes: 90 },
    });
    assert.equal(result.selectedDate, "2026-08-16");
    assert.equal(result.sleepGuardTimeoutMinutes, 0);
    assert.deepEqual(adapter.calls[1][1].slice(5), [true, true, false, false, true]);
});

test("rejects invalid dates and focused event identifiers", async () => {
    const adapter = adapterWith([]);
    await assert.rejects(executeTvStateWrite(adapter, { userId: 42, body: { selectedDate: "today" } }), /YYYY-MM-DD/);
    await assert.rejects(executeTvStateWrite(adapter, { userId: 42, body: { focusedEventId: -1 } }), /focusedEventId/);
});