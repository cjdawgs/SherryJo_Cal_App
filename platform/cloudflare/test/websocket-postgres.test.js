import assert from "node:assert/strict";
import test from "node:test";

import { consumeWebSocketTicket, issueWebSocketTicket } from "../src/websocket-postgres.js";

test("issues a 60-second opaque WebSocket ticket through owner identity", async () => {
    let captured;
    const adapter = { runWithIdentity: async (userId, operation) => { captured = { userId }; await operation({ query: async (sql, params) => { captured.sql = sql; captured.params = await Promise.all(params); } }); } };
    const result = await issueWebSocketTicket(adapter, 9);
    assert.equal(captured.userId, 9);
    assert.match(captured.params[0], /^[0-9a-f]{64}$/);
    assert.equal(result.expires_in_seconds, 60);
    assert.match(result.ticket, /^[A-Za-z0-9_-]{43}$/);
});

test("consumes a ticket only when the database returns a user", async () => {
    const adapter = {
        connectionString: "postgres://test",
        createClient: () => ({ connect: async () => {}, end: async () => {}, query: async () => ({ rows: [{ user_id: 9 }] }) }),
    };
    assert.equal(await consumeWebSocketTicket(adapter, "one-time"), true);
    assert.equal(await consumeWebSocketTicket(adapter, ""), false);
});