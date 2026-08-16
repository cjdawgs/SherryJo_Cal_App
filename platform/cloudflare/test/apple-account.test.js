import assert from "node:assert/strict";
import test from "node:test";

import { handleAppleAccountRequest } from "../src/apple-account.js";

function request(path, body) {
    return new Request(`https://calendar.example.com${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
}

test("tests Apple credentials without writing an account", async () => {
    let writes = 0;
    const response = await handleAppleAccountRequest(
        request("/accounts/apple/test", { email: "APPLE@example.com", app_password: "app-pass" }),
        { userId: 42, TOKEN_ENCRYPTION_KEY: "unused" },
        { runWithIdentity: async () => { writes += 1; } },
        { validate: async ({ email }) => assert.equal(email, "apple@example.com") },
    );
    assert.equal(response.status, 200);
    assert.equal(writes, 0);
});

test("connects Apple only after validation and writes through user identity", async () => {
    const calls = [];
    const response = await handleAppleAccountRequest(
        request("/accounts/apple/connect", {
            email: "apple@example.com", app_password: "app-pass", caldav_url: "https://caldav.icloud.com/",
        }),
        { userId: 42, TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" },
        {
            runWithIdentity(userId, operation) {
                calls.push(["identity", userId]);
                return operation({ query: async (_sql, params) => { calls.push(params.slice(0, 3)); return { rows: [{ id: 8 }] }; } });
            },
        },
        { validate: async () => ({ success: true }) },
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).account_id, 8);
    assert.deepEqual(calls[0], ["identity", 42]);
    assert.deepEqual(calls[1].slice(0, 3), [42, "apple", "apple@example.com"]);
});