const DAY_MS = 24 * 60 * 60 * 1000;
const VIEWS = new Set(["day", "3-day", "week", "month"]);

function dateOnly(value) {
    const text = String(value || "").slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    const parsed = new Date(`${text}T00:00:00.000Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text ? null : parsed;
}

function dateKey(value) {
    return value.toISOString().slice(0, 10);
}

export function tvViewWindow(selectedDate, currentView) {
    const anchor = dateOnly(selectedDate);
    if (!anchor) throw new TypeError("selectedDate in state is not a valid ISO date");
    const view = VIEWS.has(currentView) ? currentView : "day";
    const base = view === "month"
        ? new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1))
        : anchor;
    const start = new Date(base.getTime() - base.getUTCDay() * DAY_MS);
    const days = view === "month" ? 42 : 7;
    return { start, end: new Date(start.getTime() + (days - 1) * DAY_MS), view };
}

function adaptEvent(event) {
    const source = String(event.source || "local");
    const accountEmail = String(event.account_email || "").trim().toLowerCase() || null;
    const accountKey = event.account_key || (accountEmail ? `${source}:${accountEmail}` : null);
    const sticky = event.sticky_note || (Array.isArray(event.sticky_notes) && event.sticky_notes.length);
    return {
        ...event,
        accountEmail,
        accountKey,
        account_key: accountKey,
        hasSticky: Boolean(sticky),
        extendedProps: {
            backendId: event.id,
            source,
            account: accountEmail,
            accountKey,
            account_key: accountKey,
            external_ids: { ...(event.external_ids || {}) },
            description: event.description || "",
            tags: Array.isArray(event.tags) ? [...event.tags] : [],
            eventColor: event.color,
            eventColorEnabled: Boolean(event.color_enabled),
        },
    };
}

function groupedEvents(events, start, end) {
    const groups = new Map();
    const windowEndExclusive = new Date(end.getTime() + DAY_MS);
    for (const rawEvent of events) {
        const eventStart = new Date(rawEvent.start || rawEvent.start_time);
        if (Number.isNaN(eventStart.getTime())) continue;
        let eventEnd = new Date(rawEvent.end || rawEvent.end_time || eventStart);
        if (Number.isNaN(eventEnd.getTime()) || eventEnd < eventStart) eventEnd = eventStart;
        const midnightExclusive = eventEnd > eventStart
            && eventEnd.getUTCHours() === 0 && eventEnd.getUTCMinutes() === 0 && eventEnd.getUTCSeconds() === 0;
        const inclusiveEnd = new Date(Math.min(
            midnightExclusive ? eventEnd.getTime() - 1 : eventEnd.getTime(),
            windowEndExclusive.getTime() - 1,
        ));
        let cursor = new Date(Math.max(eventStart.getTime(), start.getTime()));
        cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate()));
        const adapted = adaptEvent(rawEvent);
        while (cursor <= inclusiveEnd) {
            const key = dateKey(cursor);
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(adapted);
            cursor = new Date(cursor.getTime() + DAY_MS);
        }
    }
    for (const rows of groups.values()) rows.sort((left, right) => new Date(left.start) - new Date(right.start));
    return groups;
}

export function assembleTvEvents({ selectedDate, currentView, events = [], stickyItems = [], accounts = [], appVersion }) {
    const view = VIEWS.has(currentView) ? currentView : "day";
    if (!selectedDate) return { selectedDate: null, currentView: view, days: [], appVersion };
    const { start, end } = tvViewWindow(selectedDate, view);
    const eventGroups = groupedEvents(events, start, end);
    const stickyMap = new Map(stickyItems.map((item) => [String(item.date).slice(0, 10), item.sticky_notes || []]));
    const days = [];
    for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + DAY_MS)) {
        const key = dateKey(cursor);
        days.push({ date: key, events: eventGroups.get(key) || [], stickyNotes: stickyMap.get(key) || [] });
    }
    const eventCount = days.reduce((total, day) => total + day.events.length, 0);
    const stickyCount = days.reduce((total, day) => total + day.stickyNotes.length, 0);
    return {
        selectedDate, currentView: view, rangeStart: dateKey(start), rangeEnd: dateKey(end), appVersion,
        days, accounts, summary: { eventCount, stickyCount, accountCount: accounts.length }, staleData: false,
    };
}