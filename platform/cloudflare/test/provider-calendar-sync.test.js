import assert from "node:assert/strict";
import test from "node:test";

import {
    ensureProviderAccessToken,
    fetchAppleChanges,
    fetchGoogleChanges,
    fetchMicrosoftChanges,
    parseAppleCalendarObject,
} from "../src/provider-calendar-sync.js";

function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
    });
}

test("refreshes a rotating Microsoft token before provider polling", async () => {
    let request;
    const result = await ensureProviderAccessToken({
        provider: "microsoft",
        access_token: "old-access",
        refresh_token: "old-refresh",
        token_expires_at: "2026-08-16T10:00:00Z",
    }, {
        MS_CLIENT_ID: "client",
        MS_CLIENT_SECRET: "secret",
        MS_TENANT_ID: "common",
    }, async (url, init) => {
        request = { url: String(url), init };
        return jsonResponse({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 });
    }, new Date("2026-08-16T12:00:00Z"));

    assert.equal(result.accessToken, "new-access");
    assert.equal(result.refreshToken, "new-refresh");
    assert.equal(result.expiresAt.toISOString(), "2026-08-16T13:00:00.000Z");
    assert.match(request.url, /common\/oauth2\/v2\.0\/token$/);
    assert.equal(request.init.body.get("grant_type"), "refresh_token");
});

test("fetches Google calendars, skips system calendars, and records cancellations", async () => {
    const urls = [];
    const fetchImpl = async (input) => {
        const url = new URL(input);
        urls.push(url);
        if (url.pathname.endsWith("/calendarList")) {
            return jsonResponse({ items: [{ id: "primary" }, { id: "en.usa#holiday@group.v.calendar.google.com" }] });
        }
        return jsonResponse({
            items: [
                { id: "g-1", summary: "Showing", start: { dateTime: "2026-08-17T14:00:00Z" }, end: { dateTime: "2026-08-17T15:00:00Z" } },
                { id: "g-2", status: "cancelled" },
            ],
            nextSyncToken: "google-next",
        });
    };

    const result = await fetchGoogleChanges({
        account: { account_email: "agent@example.com", sync_token: {} },
        accessToken: "token",
        start: new Date("2026-08-01T00:00:00Z"),
        end: new Date("2026-09-01T00:00:00Z"),
        fetchImpl,
    });

    assert.equal(urls.length, 2);
    assert.equal(result.events[0].externalId, "g-1");
    assert.equal(result.events[0].provider, "google");
    assert.deepEqual(result.cancelledIds, ["g-2"]);
    assert.equal(result.syncToken.primary, "google-next");
});

test("falls back from an expired Microsoft delta link and returns a new cursor", async () => {
    const urls = [];
    const fetchImpl = async (input) => {
        const url = String(input);
        urls.push(url);
        if (url === "https://graph.microsoft.com/expired") return jsonResponse({ error: { message: "expired" } }, 410);
        return jsonResponse({
            value: [
                { id: "m-1", subject: "Closing", start: { dateTime: "2026-08-18T10:00:00" }, end: { dateTime: "2026-08-18T11:00:00" } },
                { id: "m-2", "@removed": { reason: "deleted" } },
            ],
            "@odata.deltaLink": "https://graph.microsoft.com/new-delta",
        });
    };

    const result = await fetchMicrosoftChanges({
        account: { account_email: "agent@example.com", sync_token: { delta_link: "https://graph.microsoft.com/expired" } },
        accessToken: "token",
        start: new Date("2026-08-01T00:00:00Z"),
        end: new Date("2026-09-01T00:00:00Z"),
        fetchImpl,
    });

    assert.equal(urls.length, 2);
    assert.match(urls[1], /calendarView\/delta/);
    assert.equal(result.incremental, false);
    assert.equal(result.events[0].start, "2026-08-18T10:00:00.000Z");
    assert.deepEqual(result.cancelledIds, ["m-2"]);
    assert.equal(result.syncToken.delta_link, "https://graph.microsoft.com/new-delta");
});

test("parses Apple events and gives recurring occurrences stable unique IDs", () => {
    const events = parseAppleCalendarObject({
        data: [
            "BEGIN:VCALENDAR",
            "VERSION:2.0",
            "BEGIN:VEVENT",
            "UID:apple-series",
            "SUMMARY:Open House",
            "DTSTART:20260817T140000Z",
            "DTEND:20260817T150000Z",
            "RRULE:FREQ=DAILY;COUNT=2",
            "END:VEVENT",
            "END:VCALENDAR",
        ].join("\r\n")
    }, "agent@icloud.com");

    assert.equal(events.length, 2);
    assert.equal(events[0].externalId, "apple-series:1786975200");
    assert.equal(events[1].externalId, "apple-series:1787061600");
    assert.equal(events[0].provider, "apple");
});

test("bounds an old Apple recurrence series to the requested window", () => {
    const events = parseAppleCalendarObject({
        data: [
            "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:old-series",
            "SUMMARY:Weekly Review", "DTSTART:20200106T140000Z", "DTEND:20200106T150000Z",
            "RRULE:FREQ=WEEKLY", "END:VEVENT", "END:VCALENDAR",
        ].join("\r\n")
    }, "agent@icloud.com", new Date("2026-08-01T00:00:00Z"), new Date("2026-08-31T23:59:59Z"));

    assert.ok(events.length >= 4 && events.length <= 5);
    assert.ok(events.every((event) => new Date(event.start) >= new Date("2026-08-01T00:00:00Z")));
    assert.ok(events.every((event) => new Date(event.start) <= new Date("2026-08-31T23:59:59Z")));
});

test("fetches Apple calendars in a bounded range and never converts failures to empty success", async () => {
    const calls = [];
    const clientFactory = async (options) => {
        calls.push(["client", options.serverUrl, options.credentials.username]);
        return {
            async fetchCalendars() { return [{ url: "https://caldav.icloud.com/calendars/home/" }]; },
            async fetchCalendarObjects(options) {
                calls.push(["objects", options.timeRange, options.expand]);
                return [{
                    data: [
                        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:apple-1",
                        "SUMMARY:Inspection", "DTSTART:20260818T100000Z", "DTEND:20260818T110000Z",
                        "END:VEVENT", "END:VCALENDAR",
                    ].join("\r\n")
                }];
            },
        };
    };
    const account = {
        access_token: "https://caldav.icloud.com",
        refresh_token: "app-password",
        account_email: "agent@icloud.com",
    };
    const result = await fetchAppleChanges({
        account,
        start: new Date("2026-08-01T00:00:00Z"),
        end: new Date("2026-09-01T00:00:00Z"),
        clientFactory,
    });

    assert.equal(result.events[0].externalId, "apple-1");
    assert.deepEqual(calls[1], ["objects", { start: "20260801T000000Z", end: "20260901T000000Z" }, true]);

    await assert.rejects(fetchAppleChanges({
        account,
        start: new Date("2026-08-01T00:00:00Z"),
        end: new Date("2026-09-01T00:00:00Z"),
        clientFactory: async () => { throw new Error("401 Unauthorized"); },
    }), /authorization failed/i);
});