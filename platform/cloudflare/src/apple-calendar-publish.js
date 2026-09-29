import ICAL from "ical.js";
import { createDAVClient } from "tsdav";
import { ProviderAuthorizationError, ProviderResponseError } from "./provider-calendar-sync.js";

function normalizeUid(value) {
    const uid = String(value || "").trim();
    return uid.replace(/:\d{9,}$/, "");
}

function uidFilter(uid) {
    return [{
        "comp-filter": {
            _attributes: { name: "VCALENDAR" },
            "comp-filter": {
                _attributes: { name: "VEVENT" },
                "prop-filter": {
                    _attributes: { name: "UID" },
                    "text-match": { _text: uid },
                },
            },
        }
    }];
}

function asDate(value, field) {
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new TypeError(`Apple publish requires a valid ${field}`);
    return parsed;
}

function updateVeventData(data, event) {
    const root = ICAL.Component.fromString(String(data || ""));
    const component = root.getFirstSubcomponent("vevent");
    if (!component) throw new ProviderResponseError("Apple event object has no VEVENT", 502);

    const start = ICAL.Time.fromJSDate(asDate(event.start_time, "start time"), true);
    const end = event.end_time ? ICAL.Time.fromJSDate(asDate(event.end_time, "end time"), true) : null;
    const current = new ICAL.Event(component);
    component.updatePropertyWithValue("summary", String(event.title || "Untitled Event"));
    component.updatePropertyWithValue("description", String(event.description || ""));
    component.updatePropertyWithValue("dtstart", start);
    if (end) component.updatePropertyWithValue("dtend", end);
    else component.removeAllProperties("dtend");
    component.removeAllProperties("duration");
    component.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));
    component.updatePropertyWithValue("sequence", Number(current.sequence || 0) + 1);
    return root.toString();
}

function createVcalendarData(uid, event) {
    const component = new ICAL.Component("vevent");
    const vevent = new ICAL.Event(component);
    vevent.uid = uid;
    vevent.summary = String(event.title || "Untitled Event");
    vevent.description = String(event.description || "");
    vevent.startDate = ICAL.Time.fromJSDate(asDate(event.start_time, "start time"), true);
    if (event.end_time) vevent.endDate = ICAL.Time.fromJSDate(asDate(event.end_time, "end time"), true);
    component.updatePropertyWithValue("dtstamp", ICAL.Time.fromJSDate(new Date(), true));

    const calendar = new ICAL.Component("vcalendar");
    calendar.addPropertyWithValue("prodid", "-//SherryJo Cal App//Apple Publish//EN");
    calendar.addPropertyWithValue("version", "2.0");
    calendar.addPropertyWithValue("calscale", "GREGORIAN");
    calendar.addSubcomponent(component);
    return calendar.toString();
}

function eventUid(object) {
    try {
        const root = ICAL.Component.fromString(String(object?.data || ""));
        return String(root.getFirstSubcomponent("vevent")?.getFirstPropertyValue("uid") || "");
    } catch {
        return "";
    }
}

function appleFailure(error) {
    if (error instanceof ProviderAuthorizationError || error instanceof ProviderResponseError) return error;
    const message = String(error?.message || error);
    if (/\b(401|403|unauthorized|forbidden|invalid credentials)\b/i.test(message)) {
        return new ProviderAuthorizationError(`Apple CalDAV authorization failed: ${message}`);
    }
    return new ProviderResponseError(`Apple CalDAV publish failed: ${message}`, 502);
}

async function openAppleAccount(account, fetchImpl, clientFactory) {
    if (!account.access_token || !account.account_email || !account.refresh_token) {
        throw new ProviderAuthorizationError("Apple CalDAV credentials are incomplete");
    }
    const client = await clientFactory({
        serverUrl: account.access_token,
        credentials: { username: account.account_email, password: account.refresh_token },
        authMethod: "Basic",
        defaultAccountType: "caldav",
        fetch: fetchImpl,
        fetchOptions: typeof AbortSignal?.timeout === "function" ? { signal: AbortSignal.timeout(20000) } : {},
    });
    const calendars = await client.fetchCalendars();
    if (!Array.isArray(calendars) || !calendars.length) {
        throw new ProviderResponseError("Apple returned no calendars that can receive events", 502);
    }
    return { client, calendars };
}

async function findAppleEvent(client, calendars, uid) {
    for (const calendar of calendars) {
        const objects = await client.fetchCalendarObjects({
            calendar,
            filters: uidFilter(uid),
            expand: false,
        });
        const match = (objects || []).find((object) => eventUid(object) === uid);
        if (match) return { calendar, object: match };
    }
    return null;
}

function writableCalendars(calendars) {
    return calendars.filter((calendar) => !Array.isArray(calendar.components) || calendar.components.includes("VEVENT"));
}

function calendarDestination(calendar) {
    const url = String(calendar?.url || "").trim();
    const name = typeof calendar?.displayName === "string" ? calendar.displayName.trim() : "";
    return { name: name || url || "Apple calendar", url };
}

export async function publishAppleCalendarEvent({
    account,
    event,
    uid: rawUid,
    lookupExisting = false,
    fetchImpl = fetch,
    clientFactory = createDAVClient,
}) {
    const uid = normalizeUid(rawUid);
    if (!uid) throw new TypeError("Apple publish requires an event UID");
    try {
        const { client, calendars } = await openAppleAccount(account, fetchImpl, clientFactory);
        const existing = lookupExisting ? await findAppleEvent(client, calendars, uid) : null;
        if (existing) {
            const calendarObject = { ...existing.object, data: updateVeventData(existing.object.data, event) };
            const response = await client.updateCalendarObject({ calendarObject });
            if (!response?.ok) throw new Error(`CalDAV update returned status ${response?.status || "unknown"}`);
            return { action: "updated", uid, destinationCalendar: calendarDestination(existing.calendar) };
        }

        const calendar = writableCalendars(calendars)[0];
        if (!calendar) throw new ProviderResponseError("Apple has no calendar that supports events", 502);
        const response = await client.createCalendarObject({
            calendar,
            filename: `${encodeURIComponent(uid)}.ics`,
            iCalString: createVcalendarData(uid, event),
        });
        if (!response?.ok) throw new Error(`CalDAV create returned status ${response?.status || "unknown"}`);
        return { action: "created", uid, destinationCalendar: calendarDestination(calendar) };
    } catch (error) {
        throw appleFailure(error);
    }
}

export async function deleteAppleCalendarEvent({
    account,
    uid: rawUid,
    fetchImpl = fetch,
    clientFactory = createDAVClient,
}) {
    const uid = normalizeUid(rawUid);
    if (!uid) return false;
    try {
        const { client, calendars } = await openAppleAccount(account, fetchImpl, clientFactory);
        const existing = await findAppleEvent(client, calendars, uid);
        if (!existing) return false;
        const response = await client.deleteCalendarObject({ calendarObject: existing.object });
        if (!response?.ok && ![404, 410].includes(response?.status)) {
            throw new Error(`CalDAV delete returned status ${response?.status || "unknown"}`);
        }
        return true;
    } catch (error) {
        throw appleFailure(error);
    }
}