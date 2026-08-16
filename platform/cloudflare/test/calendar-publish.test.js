import assert from "node:assert/strict";
import test from "node:test";

import { executeCalendarPublish } from "../src/calendar-publish.js";
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
        updateEventLinks: async (...args) => links.push(args), updateAccountToken: async () => {},
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
        updateEventLinks: async () => { throw new Error("must not persist a transaction id"); }, updateAccountToken: async () => {},
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