import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assembleCalendarRead } from "../src/calendar-read.js";

const fixturePath = new URL("../../../app/tests/fixtures/calendar_read_contract.json", import.meta.url);
const fixture = JSON.parse(readFileSync(fixturePath, "utf-8"));

test("matches the shared bounded calendar read fixture", () => {
    assert.deepEqual(
        assembleCalendarRead(fixture.events, fixture.account_status),
        fixture.expected,
    );
});

test("ignores empty account keys without mutating source events", () => {
    const events = [{ id: 1, account_key: "" }, { id: 2 }, { id: 3, account_key: "local:local" }];
    const result = assembleCalendarRead(events, {});

    assert.deepEqual(result.account_event_totals, { "local:local": 1 });
    assert.deepEqual(events, [{ id: 1, account_key: "" }, { id: 2 }, { id: 3, account_key: "local:local" }]);
});

test("rejects malformed adapter output", () => {
    assert.throws(() => assembleCalendarRead(null, {}), /events must be an array/);
    assert.throws(() => assembleCalendarRead([], []), /status must be an object/);
});