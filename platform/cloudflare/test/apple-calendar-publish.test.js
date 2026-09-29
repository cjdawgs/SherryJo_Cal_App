import assert from "node:assert/strict";
import test from "node:test";
import ICAL from "ical.js";

import { deleteAppleCalendarEvent, publishAppleCalendarEvent } from "../src/apple-calendar-publish.js";
import { ProviderAuthorizationError } from "../src/provider-calendar-sync.js";

const account = {
    access_token: "https://caldav.example.test",
    account_email: "user@example.test",
    refresh_token: "app-password",
};
const event = {
    title: "Review, final",
    description: "Bring notes; and a laptop",
    start_time: new Date("2026-09-29T15:00:00Z"),
    end_time: new Date("2026-09-29T16:00:00Z"),
};

function makeClient({ objects = [], createResponse = new Response(null, { status: 201 }) } = {}) {
    const calls = [];
    const client = {
        fetchCalendars: async () => [{ url: "https://caldav.example.test/calendars/default/", components: ["VEVENT"] }],
        fetchCalendarObjects: async (params) => { calls.push(["find", params]); return objects; },
        createCalendarObject: async (params) => { calls.push(["create", params]); return createResponse; },
        updateCalendarObject: async (params) => { calls.push(["update", params]); return new Response(null, { status: 204 }); },
        deleteCalendarObject: async (params) => { calls.push(["delete", params]); return new Response(null, { status: 204 }); },
    };
    return { client, calls, clientFactory: async () => client };
}

test("creates an Apple VEVENT with stable UID and escaped content", async () => {
    const mock = makeClient();
    const result = await publishAppleCalendarEvent({
        account, event, uid: "sj-publish@example.test", clientFactory: mock.clientFactory,
    });

    assert.deepEqual(result, { action: "created", uid: "sj-publish@example.test" });
    const [, request] = mock.calls.find(([action]) => action === "create");
    const component = ICAL.Component.fromString(request.iCalString);
    const vevent = new ICAL.Event(component.getFirstSubcomponent("vevent"));
    assert.equal(vevent.uid, "sj-publish@example.test");
    assert.equal(vevent.summary, event.title);
    assert.equal(vevent.description, event.description);
    assert.equal(vevent.startDate.toJSDate().toISOString(), event.start_time.toISOString());
    assert.equal(vevent.endDate.toJSDate().toISOString(), event.end_time.toISOString());
});

test("updates an existing Apple UID while preserving recurrence rules", async () => {
    const existingData = [
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:series@example.test",
        "SUMMARY:Old title", "DTSTART:20260901T150000Z", "DTEND:20260901T160000Z",
        "RRULE:FREQ=WEEKLY;COUNT=4", "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n");
    const mock = makeClient({ objects: [{ url: "https://caldav.example.test/calendars/default/series.ics", etag: "v1", data: existingData }] });
    const result = await publishAppleCalendarEvent({
        account, event, uid: "series@example.test", lookupExisting: true, clientFactory: mock.clientFactory,
    });

    assert.equal(result.action, "updated");
    const [, request] = mock.calls.find(([action]) => action === "update");
    const updated = ICAL.Component.fromString(request.calendarObject.data);
    const vevent = updated.getFirstSubcomponent("vevent");
    assert.equal(vevent.getFirstPropertyValue("summary"), event.title);
    assert.equal(vevent.getFirstPropertyValue("rrule").toString(), "FREQ=WEEKLY;COUNT=4");
    assert.equal(request.calendarObject.etag, "v1");
});

test("deletes an existing Apple UID and treats a missing UID as already deleted", async () => {
    const data = ["BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:remove@example.test", "END:VEVENT", "END:VCALENDAR"].join("\r\n");
    const mock = makeClient({ objects: [{ url: "https://caldav.example.test/calendars/default/remove.ics", data }] });

    assert.equal(await deleteAppleCalendarEvent({ account, uid: "remove@example.test", clientFactory: mock.clientFactory }), true);
    assert.equal(mock.calls.some(([action]) => action === "delete"), true);
    assert.equal(await deleteAppleCalendarEvent({
        account, uid: "missing@example.test", clientFactory: async () => ({
            fetchCalendars: async () => [{ url: "https://caldav.example.test/calendars/default/", components: ["VEVENT"] }],
            fetchCalendarObjects: async () => [],
        })
    }), false);
});

test("classifies Apple credential rejection as a reconnectable authorization error", async () => {
    await assert.rejects(
        () => publishAppleCalendarEvent({ account, event, uid: "auth@example.test", clientFactory: async () => { throw new Error("401 Unauthorized"); } }),
        (error) => error instanceof ProviderAuthorizationError && /authorization failed/i.test(error.message),
    );
});