import assert from "node:assert/strict";
import test from "node:test";

import {
    AccountNotFoundError,
    executeAccountColorUpdate,
    executeAccountSettingsUpdate,
} from "../src/account-mutate-postgres.js";

function capturingAdapter(rows) {
    const calls = [];
    return {
        calls,
        runWithIdentity(userId, operation) {
            calls.push(["identity", userId]);
            return operation({ query: async (sql, params) => { calls.push([sql, params]); return { rows }; } });
        },
    };
}

test("clamps settings and preserves the Apple cadence in SQL", async () => {
    const adapter = capturingAdapter([{
        id: 4, provider: "apple", account_email: "a@example.com",
        sync_enabled: true, sync_frequency_minutes: 240, sync_range_days: 3650,
    }]);
    const result = await executeAccountSettingsUpdate(adapter, {
        userId: 42, accountId: 4,
        data: { sync_frequency_minutes: 2, sync_range_days: 9999 },
    });
    assert.equal(result.sync_frequency_minutes, 240);
    assert.deepEqual(adapter.calls[1][1], [4, 2, 3650, null]);
    assert.match(adapter.calls[1][0], /GREATEST\(\$2, 240\)/);
});

test("normalizes valid colors and rejects missing owned accounts", async () => {
    const adapter = capturingAdapter([{ id: 4, provider: "google", account_email: "g@example.com", color: "#34a853" }]);
    assert.equal((await executeAccountColorUpdate(adapter, { userId: 42, accountId: 4, color: "#34A853" })).color, "#34a853");
    await assert.rejects(
        executeAccountColorUpdate(capturingAdapter([]), { userId: 42, accountId: 99, color: "#34a853" }),
        AccountNotFoundError,
    );
});