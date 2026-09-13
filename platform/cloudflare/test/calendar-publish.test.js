import assert from "node:assert/strict";
import test from "node:test";

import { executeCalendarPublish, replayPendingCalendarPublishes } from "../src/calendar-publish.js";
import { fernetEncrypt } from "../src/fernet.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

test("publishes selected events to Google with a deterministic create id", async () => {
    const links = [];
    const token = await fernetEncrypt("access", KEY);
    const refresh = await fernetEncrypt("refresh", KEY);
    const adapter = {
        loadPublishData: async () => ({
            events: [{ id: 7, title: "Publish", description: "", start_time: new Date("2026-08-16T12:00:00Z"), end_time: new Date("2026-08-16T13:00:00Z"), external_ids: {} }],
            accounts: [{ id: 2, provider: "google", account_email: "user@example.test", access_token: token, refresh_token: refresh, token_expires_at: new Date(Date.now() + 3600000) }],
        }),
        updateEventLinks: async (...args) => links.push(args), updateAccountToken: async () => { },
    };
    let providerBody;
    const result = await executeCalendarPublish(adapter, {
        userId: 42, env: { TOKEN_ENCRYPTION_KEY: KEY },
        body: { event_ids: [7], publish_targets: { "7": ["google:user@example.test"] } },
        fetchImpl: async (_url, init) => { providerBody = JSON.parse(init.body); return new Response(JSON.stringify({ id: "provider-7" }), { status: 201, headers: { "content-type": "application/json" } }); },
    });
    assert.equal(result.published, 1);
    assert.equal(result.created, 1);
    assert.match(providerBody.id, /^sj[0-9a-v]{24}$/);
    assert.equal(links[0][2]["google:user@example.test"], "provider-7");
});

test("reconciles a deterministic Google create conflict before completing", async () => {
    const token = await fernetEncrypt("access", KEY);
    const methods = [];
    const adapter = {
        loadPublishData: async () => ({
            events: [{ id: 17, title: "Current title", start_time: new Date("2026-08-16T12:00:00Z"), external_ids: {} }],
            accounts: [{ id: 2, provider: "google", account_email: "user@example.test", access_token: token, refresh_token: "", token_expires_at: new Date(Date.now() + 3600000) }],
        }),
        updateEventLinks: async () => { }, updateAccountToken: async () => { },
    };
    const result = await executeCalendarPublish(adapter, {
        userId: 42, env: { TOKEN_ENCRYPTION_KEY: KEY },
        body: { event_ids: [17], publish_targets: { "17": ["google:user@example.test"] } },
        fetchImpl: async (_url, init) => {
            methods.push(init.method);
            return new Response(init.method === "POST" ? "conflict" : null, { status: init.method === "POST" ? 409 : 200 });
        },
    });

    assert.deepEqual(methods, ["POST", "PATCH"]);
    assert.equal(result.published, 1);
    assert.equal(result.failed, 0);
});

test("dead-letters pending publish targets for missing local events", async () => {
    const missing = [];
    const adapter = {
        loadPendingPublishTargets: async () => [{ operation_type: "calendar_publish", event_id: 404 }],
        loadPublishData: async () => ({ events: [], accounts: [] }),
        deadLetterMissingPublishTargets: async (...args) => missing.push(args),
    };
    const result = await replayPendingCalendarPublishes(adapter, {
        userId: 42, targetKey: "google:user@example.test", env: {},
    });

    assert.deepEqual(missing, [[42, [404]]]);
    assert.equal(result.published, 0);
    assert.equal(result.failed, 0);
});

test("treats an explicit empty event list as a no-op", async () => {
    const result = await executeCalendarPublish({}, { userId: 42, body: { event_ids: [], deleted_events: [] }, env: {} });
    assert.equal(result.published, 0);
    assert.match(result.message, /No modified events/);
});

test("does not mistake a Microsoft transaction id for a provider event id", async () => {
    const token = await fernetEncrypt("access", KEY);
    const adapter = {
        loadPublishData: async () => ({
            events: [{ id: 8, title: "Publish", start_time: new Date("2026-08-16T12:00:00Z"), external_ids: {} }],
            accounts: [{ id: 3, provider: "microsoft", account_email: "user@example.test", access_token: token, refresh_token: "", token_expires_at: new Date(Date.now() + 3600000) }],
        }),
        updateEventLinks: async () => { throw new Error("must not persist a transaction id"); }, updateAccountToken: async () => { },
    };
    const result = await executeCalendarPublish(adapter, {
        userId: 42, env: { TOKEN_ENCRYPTION_KEY: KEY },
        body: { event_ids: [8], publish_targets: { "8": ["microsoft:user@example.test"] } },
        fetchImpl: async () => new Response(null, { status: 202 }),
    });
    assert.equal(result.published, 0);
    assert.equal(result.failed, 1);
    assert.match(result.warnings[0], /without an event identifier/);
});

test("reports a reconnectable Microsoft no-token result without calling Graph", async () => {
    const invalidToken = "v1:stored-credential-that-cannot-be-decrypted";
    const queued = [];
    const finished = [];
    const adapter = {
        loadPublishData: async () => ({
            events: [{ id: 9, title: "Publish", start_time: new Date("2026-08-16T12:00:00Z"), external_ids: {} }],
            accounts: [{ id: 4, provider: "microsoft", account_email: "user@example.test", access_token: invalidToken, refresh_token: "", token_expires_at: new Date(Date.now() + 3600000) }],
        }),
        updateEventLinks: async () => { throw new Error("must not persist a failed publish"); },
        updateAccountToken: async () => { },
        queuePublishTarget: async (...args) => queued.push(args),
        finishPublishTarget: async (...args) => finished.push(args),
    };
    let graphCalled = false;
    const result = await executeCalendarPublish(adapter, {
        userId: 42,
        env: { TOKEN_ENCRYPTION_KEY: KEY },
        body: { event_ids: [9], publish_targets: { "9": ["microsoft:user@example.test"] } },
        fetchImpl: async () => {
            graphCalled = true;
            return new Response(null, { status: 500 });
        },
    });

    assert.equal(graphCalled, false);
    assert.equal(result.published, 0);
    assert.equal(result.created, 0);
    assert.equal(result.failed, 1);
    assert.match(result.warnings[0], /No valid token for microsoft:user@example.test/);
    assert.equal(result.account_results[0].status, "no_token");
    assert.deepEqual(queued, [[42, 9, "microsoft:user@example.test"]]);
    assert.equal(finished.length, 1);
    assert.equal(finished[0][3].succeeded, false);
});

test("replays pending publishes only for the reconnected account", async () => {
    const token = await fernetEncrypt("access", KEY);
    const queued = [];
    const finished = [];
    const adapter = {
        loadPendingPublishTargets: async (_userId, targetKey) => {
            assert.equal(targetKey, "microsoft:user@example.test");
            return [
                { operation_type: "calendar_publish", event_id: 21 },
                { operation_type: "calendar_publish", event_id: 21 },
                { operation_type: "calendar_publish", event_id: 22 },
            ];
        },
        loadPublishData: async (_userId, eventIds) => ({
            events: eventIds.map((id) => ({ id, title: `Publish ${id}`, start_time: new Date("2026-08-16T12:00:00Z"), external_ids: {} })),
            accounts: [{ id: 3, provider: "microsoft", account_email: "user@example.test", access_token: token, refresh_token: "", token_expires_at: new Date(Date.now() + 3600000) }],
        }),
        queuePublishTarget: async (...args) => queued.push(args),
        finishPublishTarget: async (...args) => finished.push(args),
        updateEventLinks: async () => { },
        updateAccountToken: async () => { },
    };
    let nextId = 0;
    const result = await replayPendingCalendarPublishes(adapter, {
        userId: 42,
        targetKey: "microsoft:user@example.test",
        env: { TOKEN_ENCRYPTION_KEY: KEY },
        fetchImpl: async () => new Response(JSON.stringify({ id: `provider-${++nextId}` }), { status: 201, headers: { "content-type": "application/json" } }),
    });

    assert.equal(result.replayed, 2);
    assert.equal(result.published, 2);
    assert.equal(result.failed, 0);
    assert.equal(queued.length, 2);
    assert.equal(finished.filter((entry) => entry[3].succeeded).length, 2);
});

test("replays a queued provider delete after reconnect", async () => {
    const token = await fernetEncrypt("access", KEY);
    const completedDeletes = [];
    const adapter = {
        loadPendingPublishTargets: async () => [{
            operation_type: "calendar_publish_delete",
            target_key: "microsoft:user@example.test",
            provider_event_id: "provider-delete-1",
        }],
        loadPublishData: async () => ({
            events: [],
            accounts: [{ id: 3, provider: "microsoft", account_email: "user@example.test", access_token: token, refresh_token: "", token_expires_at: new Date(Date.now() + 3600000) }],
        }),
        queueDeleteTarget: async () => { },
        finishDeleteTarget: async (...args) => completedDeletes.push(args),
        updateAccountToken: async () => { },
    };
    const result = await replayPendingCalendarPublishes(adapter, {
        userId: 42,
        targetKey: "microsoft:user@example.test",
        env: { TOKEN_ENCRYPTION_KEY: KEY },
        fetchImpl: async (_url, init) => new Response(null, { status: init.method === "DELETE" ? 204 : 500 }),
    });

    assert.equal(result.replayed, 1);
    assert.equal(result.deleted, 1);
    assert.equal(result.failed, 0);
    assert.equal(completedDeletes.length, 1);
    assert.equal(completedDeletes[0][3].succeeded, true);
});