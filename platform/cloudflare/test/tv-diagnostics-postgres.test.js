import assert from "node:assert/strict";
import test from "node:test";

import { executeTvDiagnosticsRead, executeTvDiagnosticsWrite, TvDiagnosticsForbiddenError } from "../src/tv-diagnostics-postgres.js";

function adapter(handler) {
    return { runWithIdentity: (userId, operation) => operation({ query: (sql, params) => handler(userId, sql, params) }) };
}

test("normalizes and batches diagnostic writes", async () => {
    let captured;
    const result = await executeTvDiagnosticsWrite(adapter(async (userId, sql, params) => {
        captured = { userId, sql, entries: JSON.parse(params[0]) };
        return { rows: [] };
    }), { userId: 42, body: { entries: [{ event: " heartbeat ", details: "ok" }] }, userAgent: "Silk/1" });
    assert.deepEqual(result, { ok: true, accepted: 1 });
    assert.equal(captured.userId, 42);
    assert.match(captured.sql, /worker_record_tv_diagnostics/);
    assert.equal(captured.entries[0].event, "heartbeat");
    assert.equal(captured.entries[0].device_ua, "Silk/1");
});

test("bounds diagnostic reads and maps database rows", async () => {
    const result = await executeTvDiagnosticsRead(adapter(async (_userId, _sql, params) => ({
        rows: [{ ts_server: new Date("2026-08-16T12:00:00Z"), event: "session_start", device_id: null }], params,
    })), { userId: 42, scope: "own", hours: "900", eventGroup: "all" });
    assert.equal(result.filters.hours, 720);
    assert.equal(result.entries[0].device_id, "");
    assert.equal(result.entries[0].ts_server, "2026-08-16T12:00:00.000Z");
});

test("maps fleet authorization failures to a dedicated error", async () => {
    await assert.rejects(
        executeTvDiagnosticsRead(adapter(async () => { const error = new Error("admin only"); error.code = "42501"; throw error; }), {
            userId: 42, scope: "all", eventGroup: "all",
        }),
        TvDiagnosticsForbiddenError,
    );
});