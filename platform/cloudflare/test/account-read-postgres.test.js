import assert from "node:assert/strict";
import test from "node:test";

import { ACCOUNT_READ_SQL, executeAccountRead, executeSyncRollupRead } from "../src/account-read-postgres.js";

function adapterFor(rows) {
    return { runWithIdentity: (_userId, operation) => operation({ query: async () => ({ rows }) }) };
}

test("serializes owner-scoped account rows without returning credentials", async () => {
    const accounts = await executeAccountRead(adapterFor([{
        id: 3, provider: "apple", account_email: "apple@example.com", access_token: "app-password",
        refresh_token: null, sync_enabled: true, sync_frequency_minutes: 5, sync_range_days: 30,
        is_primary: false, status: "ok", color: null,
    }]), { userId: 42, tokenEncryptionKey: "unused" });

    assert.equal(accounts[0].sync_frequency_minutes, 240);
    assert.equal(accounts[0].color, "#ef4444");
    assert.equal(accounts[0].status, "ok");
    assert.equal("access_token" in accounts[0], false);
    assert.match(ACCOUNT_READ_SQL, /worker_app_user_id/);
});

test("returns bounded sync rollups and a Monday-based current week", async () => {
    const payload = await executeSyncRollupRead(adapterFor([{
        snapshot_date: "2026-08-10", week_start_date: "2026-08-10", changes: 2,
        no_changes: 3, total_cycles: 5, no_change_ratio: 0.6, google_cache_hit_ratio: 0.5,
    }]), { userId: 42, days: 28, now: new Date("2026-08-16T12:00:00Z") });
    assert.equal(payload.days, 28);
    assert.equal(payload.current_week.week_start_date, "2026-08-10");
    assert.equal(payload.current_week.days_present, 1);
    assert.equal(payload.current_week.avg_no_change_ratio, 0.6);
});