import assert from "node:assert/strict";
import test from "node:test";

import { assembleTvEvents, tvViewWindow } from "../src/tv-events.js";

test("uses a Sunday-start week for day, three-day, and week views", () => {
    for (const view of ["day", "3-day", "week"]) {
        const window = tvViewWindow("2026-10-20", view);
        assert.equal(window.start.toISOString().slice(0, 10), "2026-10-18");
        assert.equal(window.end.toISOString().slice(0, 10), "2026-10-24");
    }
});

test("uses a stable six-week Sunday-start month grid", () => {
    const window = tvViewWindow("2026-10-20", "month");
    assert.equal(window.start.toISOString().slice(0, 10), "2026-09-27");
    assert.equal(window.end.toISOString().slice(0, 10), "2026-11-07");
});

test("does not inject today when selectedDate is absent", () => {
    assert.deepEqual(assembleTvEvents({ selectedDate: null, currentView: "day", appVersion: "test" }), {
        selectedDate: null, currentView: "day", days: [], appVersion: "test",
    });
});

test("places multi-day events on every overlapping day and preserves sticky notes", () => {
    const payload = assembleTvEvents({
        selectedDate: "2026-10-20", currentView: "day", appVersion: "test",
        events: [{ id: 7, title: "Trip", start: "2026-10-20T09:00:00Z", end: "2026-10-22T00:00:00Z", source: "google", account_email: "a@real.test" }],
        stickyItems: [{ date: "2026-10-21", sticky_notes: [{ content: "Note" }] }],
        accounts: [{ provider: "google" }],
    });
    assert.equal(payload.days.find((day) => day.date === "2026-10-20").events.length, 1);
    assert.equal(payload.days.find((day) => day.date === "2026-10-21").events.length, 1);
    assert.equal(payload.days.find((day) => day.date === "2026-10-22").events.length, 0);
    assert.equal(payload.days.find((day) => day.date === "2026-10-21").stickyNotes.length, 1);
    assert.deepEqual(payload.summary, { eventCount: 2, stickyCount: 1, accountCount: 1 });
});