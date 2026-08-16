import assert from "node:assert/strict";
import test from "node:test";

import { materializeDedup, runManualCalendarSync } from "../src/calendar-operations.js";

test("materializes matching provider events into one local canonical", async () => {
    const calls = [];
    const rows = [
        { id: 1, title: "Same", start_time: new Date("2026-08-16T12:00:20Z"), end_time: new Date("2026-08-16T13:00:00Z"), source: "google", account_email: "a@test", external_ids: { "google:a@test": "g1" } },
        { id: 2, title: " same ", start_time: new Date("2026-08-16T12:00:40Z"), end_time: new Date("2026-08-16T13:00:30Z"), source: "microsoft", account_email: "b@test", external_ids: { "microsoft:b@test": "m1" } },
    ];
    const adapter = { runWithIdentity: async (_userId, operation) => operation({ query: async (sql, params) => {
        calls.push([sql, params]);
        if (sql.includes("SELECT id, title")) return { rows };
        return { rows: [], rowCount: sql.includes("UPDATE public.events SET source") ? 0 : 1 };
    } }) };
    assert.equal(await materializeDedup(adapter, 4), 1);
    const canonicalUpdate = calls.find(([sql]) => sql.includes("external_ids=$2"));
    assert.deepEqual(JSON.parse(canonicalUpdate[1][1]), { "google:a@test": "g1", "microsoft:b@test": "m1" });
});

test("manual sync rejects an unknown selected account before provider work", async () => {
    const adapter = { runWithIdentity: async (_userId, operation) => operation({ query: async () => ({ rows: [{ id: 1, provider: "google", account_email: "a@test", sync_range_days: 60 }] }) }) };
    const result = await runManualCalendarSync(adapter, {}, 4, "google:missing@test", true);
    assert.equal(result.status, "error");
    assert.match(result.message, /not found/i);
});