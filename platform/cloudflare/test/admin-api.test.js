import assert from "node:assert/strict";
import test from "node:test";

import { handleAdminApi } from "../src/admin-api.js";

test("rejects a signed-in non-admin before executing an admin route", async () => {
    const adapter = { runWithIdentity: async (userId, operation) => operation({ query: async () => ({ rows: [{ allowed: false }] }) }) };
    const result = await handleAdminApi(new Request("https://calendar.test/admin/users"), {}, adapter, 4);
    assert.equal(result.status, 403);
    assert.deepEqual(await result.json(), { detail: "Admin only" });
});

test("redacts credentials from the managed table browser", async () => {
    let calls = 0;
    const adapter = { runWithIdentity: async (_userId, operation) => operation({ query: async () => {
        calls += 1;
        if (calls === 1) return { rows: [{ allowed: true }] };
        return { rows: [{ id: 1, access_token: "secret", account_email: "a@example.test" }], fields: [{ name: "id" }, { name: "access_token" }, { name: "account_email" }], rowCount: 1 };
    } }) };
    const result = await handleAdminApi(new Request("https://calendar.test/admin/system/table/oauth_accounts/rows"), {}, adapter, 1);
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal(body.rows[0].access_token, "***");
    assert.deepEqual(body.redacted_columns, ["access_token"]);
});