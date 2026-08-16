import assert from "node:assert/strict";
import test from "node:test";

import { CalendarImportError, executeCalendarImport, parseCalendarImport } from "../src/calendar-import.js";

const bytes = (value) => new TextEncoder().encode(value);

test("parses JSON and CSV imports with warnings for invalid rows", () => {
    const json = parseCalendarImport("events.json", bytes(JSON.stringify({ events: [
        { title: "JSON", start: "2026-08-16T12:00:00Z", stickyNotes: ["Remember"] },
        { title: "Broken" },
    ] })));
    assert.equal(json.events.length, 1);
    assert.equal(json.events[0].sticky_notes[0].content, "Remember");
    assert.equal(json.warnings.length, 1);

    const csv = parseCalendarImport("events.csv", bytes("title,start,end\nCSV,2026-08-17T10:00:00Z,2026-08-17T11:00:00Z\n"));
    assert.equal(csv.events[0].title, "CSV");
});

test("parses ICS events with ical.js", () => {
    const parsed = parseCalendarImport("events.ics", bytes([
        "BEGIN:VCALENDAR", "VERSION:2.0", "BEGIN:VEVENT", "UID:test-1",
        "DTSTART:20260818T140000Z", "DTEND:20260818T150000Z", "SUMMARY:ICS Event",
        "END:VEVENT", "END:VCALENDAR",
    ].join("\r\n")));
    assert.equal(parsed.events.length, 1);
    assert.equal(parsed.events[0].title, "ICS Event");
});

test("rejects unsupported and empty imports", () => {
    assert.throws(() => parseCalendarImport("events.txt", bytes("data")), CalendarImportError);
    assert.throws(() => parseCalendarImport("events.json", new Uint8Array()), /empty/);
});

test("bulk inserts imported events under transaction-local identity", async () => {
    const calls = [];
    const adapter = { runWithIdentity: (userId, operation) => operation({ query: async (sql, params) => {
        calls.push({ userId, sql, rows: JSON.parse(params[0]) });
        return { rows: [{ id: 1 }] };
    } }) };
    const imported = await executeCalendarImport(adapter, {
        userId: 42,
        events: [{ title: "Import", description: "", start_time: "2026-08-16T12:00:00Z", end_time: null, sticky_notes: [{ content: "Note" }] }],
    });
    assert.equal(imported, 1);
    assert.equal(calls[0].userId, 42);
    assert.match(calls[0].sql, /public\.worker_app_user_id\(\)/);
    assert.match(calls[0].rows[0].description, /Sticky Notes/);
});

test("can return inserted ids for the import-and-publish workflow", async () => {
    const adapter = { runWithIdentity: (_userId, operation) => operation({ query: async () => ({ rows: [{ id: 4 }, { id: 5 }] }) }) };
    const importedIds = await executeCalendarImport(adapter, {
        userId: 42,
        events: [
            { title: "One", description: "", start_time: "2026-08-16T12:00:00Z", end_time: null, sticky_notes: [] },
            { title: "Two", description: "", start_time: "2026-08-17T12:00:00Z", end_time: null, sticky_notes: [] },
        ],
        returnIds: true,
    });
    assert.deepEqual(importedIds, [4, 5]);
});