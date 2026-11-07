import assert from "node:assert/strict";
import test from "node:test";
import { handleAdminApi } from "../src/admin-api.js";

const route = "https://calendar.test/admin/system/cloudflare/release-control";
const env = { GITHUB_TOKEN: "test-token" };
const adapter = (allowed = true) => ({
    runWithIdentity: async (_userId, operation) => operation({
        query: async () => ({ rows: [{ allowed }] }),
    }),
});

function request(paused) {
    return paused === undefined
        ? new Request(route)
        : new Request(route, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ paused }) });
}

async function withGithub(handler, operation) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try {
        return await operation();
    } finally {
        globalThis.fetch = original;
    }
}

function json(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

test("release control requires an Admin and reports a missing secret", async () => {
    await withGithub(() => { throw new Error("GitHub must not be called"); }, async () => {
        assert.equal((await handleAdminApi(request(), env, adapter(false), 1)).status, 403);
        assert.equal((await handleAdminApi(request(true), env, adapter(false), 1)).status, 403);
        const unconfigured = await handleAdminApi(request(), {}, adapter(), 1);
        assert.equal(unconfigured.status, 200);
        assert.equal((await unconfigured.json()).configured, false);
        assert.equal((await handleAdminApi(request(true), {}, adapter(), 1)).status, 503);
        assert.equal((await handleAdminApi(request("true"), env, adapter(), 1)).status, 422);
    });
});

test("release control creates, verifies, resumes, and reads the shared variable", async () => {
    let variable = null;
    const writes = [];
    await withGithub(async (url, options) => {
        assert.equal(options.headers.authorization, "Bearer test-token");
        assert.equal(options.redirect, "error");
        const method = options.method;
        if (method === "POST" || method === "PATCH") {
            writes.push(method);
            variable = JSON.parse(options.body).value;
            return new Response(null, { status: method === "POST" ? 201 : 204 });
        }
        if (url.endsWith("?per_page=1")) return json({ variables: [] });
        return variable === null ? json({ message: "Not Found" }, 404) : json({ value: variable, updated_at: "2026-11-07T00:00:00Z" });
    }, async () => {
        assert.deepEqual(await (await handleAdminApi(request(), env, adapter(), 1)).json(), {
            configured: true, paused: false, updated_at: null, repository: "cjdawgs/SherryJo_Cal_App",
        });
        const paused = await (await handleAdminApi(request(true), env, adapter(), 1)).json();
        assert.equal(paused.paused, true);
        assert.equal(paused.changed, true);
        assert.equal((await (await handleAdminApi(request(true), env, adapter(), 1)).json()).changed, false);
        const resumed = await (await handleAdminApi(request(false), env, adapter(), 1)).json();
        assert.equal(resumed.paused, false);
        assert.equal(resumed.changed, true);
        assert.deepEqual(writes, ["POST", "PATCH"]);
    });
});

test("inaccessible repository and denied writes are reported, not treated as active", async () => {
    await withGithub(async (url, options) => {
        if (url.endsWith("?per_page=1")) return json({ message: "Not Found" }, 404);
        if (options.method === "GET") return json({ message: "Not Found" }, 404);
        throw new Error("Unexpected request");
    }, async () => {
        const result = await handleAdminApi(request(), env, adapter(), 1);
        assert.equal(result.status, 502);
        assert.match((await result.json()).detail, /GitHub denied access/);
    });
    await withGithub(async (_url, options) => options.method === "PATCH"
        ? json({ message: "Forbidden" }, 403)
        : json({ value: "false" }), async () => {
        const result = await handleAdminApi(request(true), env, adapter(), 1);
        assert.equal(result.status, 502);
        assert.match((await result.json()).detail, /read\/write/);
    });
});

test("unconfirmed or malformed GitHub state never reports a successful pause", async () => {
    await withGithub(async (_url, options) => options.method === "PATCH"
        ? new Response(null, { status: 204 })
        : json({ value: "false" }), async () => {
        const result = await handleAdminApi(request(true), env, adapter(), 1);
        assert.equal(result.status, 502);
        assert.match((await result.json()).detail, /did not confirm/);
    });
    await withGithub(async () => json({ value: "unexpected" }), async () => {
        const result = await handleAdminApi(request(), env, adapter(), 1);
        assert.equal(result.status, 502);
        assert.match((await result.json()).detail, /invalid Worker release pause value/);
    });
});

test("GitHub network failures are surfaced without exposing the token", async () => {
    const originalError = console.error;
    console.error = () => {};
    try {
        await withGithub(async () => { throw new Error("test-token"); }, async () => {
            const result = await handleAdminApi(request(), env, adapter(), 1);
            assert.equal(result.status, 502);
            const body = await result.text();
            assert.match(body, /Could not reach GitHub/);
            assert.doesNotMatch(body, /test-token/);
        });
    } finally {
        console.error = originalError;
    }
});
