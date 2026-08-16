import ICAL from "ical.js";
import { createDAVClient } from "tsdav";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_CALENDAR_LIST_URL = "https://www.googleapis.com/calendar/v3/users/me/calendarList";
const GOOGLE_EVENTS_BASE_URL = "https://www.googleapis.com/calendar/v3/calendars";
const MICROSOFT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const MAX_PROVIDER_PAGES = 100;

export class ProviderAuthorizationError extends Error {
    constructor(message) {
        super(message);
        this.name = "ProviderAuthorizationError";
    }
}

export class ProviderResponseError extends Error {
    constructor(message, status) {
        super(message);
        this.name = "ProviderResponseError";
        this.status = status;
    }
}

async function responsePayload(response) {
    try {
        return await response.json();
    } catch {
        return {};
    }
}

async function fetchProviderJson(fetchImpl, url, init = {}) {
    const requestInit = { ...init };
    if (!requestInit.signal && typeof AbortSignal?.timeout === "function") {
        requestInit.signal = AbortSignal.timeout(20000);
    }
    const response = await fetchImpl(url, requestInit);
    const payload = await responsePayload(response);
    if (response.status === 401 || response.status === 403) {
        throw new ProviderAuthorizationError(`Provider authorization failed (${response.status})`);
    }
    if (!response.ok) {
        const detail = payload?.error?.message || payload?.error_description || `HTTP ${response.status}`;
        throw new ProviderResponseError(String(detail), response.status);
    }
    return payload;
}

function expiresSoon(expiresAt, now) {
    const expiry = expiresAt ? new Date(expiresAt) : null;
    return !expiry || Number.isNaN(expiry.getTime()) || expiry.getTime() <= now.getTime() + 120000;
}

export async function ensureProviderAccessToken(account, env, fetchImpl = fetch, now = new Date()) {
    if (!expiresSoon(account.token_expires_at, now)) {
        return {
            accessToken: account.access_token,
            refreshToken: account.refresh_token,
            expiresAt: new Date(account.token_expires_at),
            refreshed: false,
        };
    }
    if (!account.refresh_token) throw new ProviderAuthorizationError("Provider refresh token is missing");

    const provider = String(account.provider || "").toLowerCase();
    if (!['google', 'microsoft'].includes(provider)) {
        throw new TypeError(`Unsupported scheduled sync provider: ${provider || "unknown"}`);
    }
    const tokenUrl = provider === "google"
        ? GOOGLE_TOKEN_URL
        : `https://login.microsoftonline.com/${env.MS_TENANT_ID || "common"}/oauth2/v2.0/token`;
    const body = new URLSearchParams({
        client_id: provider === "google" ? env.GOOGLE_CLIENT_ID : env.MS_CLIENT_ID,
        client_secret: provider === "google" ? env.GOOGLE_CLIENT_SECRET : env.MS_CLIENT_SECRET,
        refresh_token: account.refresh_token,
        grant_type: "refresh_token",
    });
    if (provider === "microsoft") body.set("scope", "offline_access Calendars.Read Calendars.ReadWrite");

    const tokenData = await fetchProviderJson(fetchImpl, tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!tokenData.access_token) throw new ProviderAuthorizationError("Provider token refresh returned no access token");

    return {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || account.refresh_token,
        expiresAt: new Date(now.getTime() + Number(tokenData.expires_in || 3600) * 1000),
        refreshed: true,
    };
}

function isSystemGoogleCalendar(calendarId) {
    const value = String(calendarId || "").toLowerCase();
    return value.includes("holiday") || value.includes("@group.v.calendar.google.com") || value.includes("#");
}

function googleEvent(event, accountEmail) {
    const start = event?.start?.dateTime || event?.start?.date;
    const end = event?.end?.dateTime || event?.end?.date || null;
    if (!event?.id || !start) return null;
    return {
        externalId: String(event.id),
        title: String(event.summary || "Untitled Event"),
        start,
        end,
        provider: "google",
        accountEmail,
    };
}

async function listGoogleCalendars(accessToken, fetchImpl) {
    const calendars = [];
    let pageToken = null;
    for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
        const url = new URL(GOOGLE_CALENDAR_LIST_URL);
        url.searchParams.set("maxResults", "250");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const payload = await fetchProviderJson(fetchImpl, url, {
            headers: { authorization: `Bearer ${accessToken}` },
        });
        calendars.push(...(payload.items || []).map((item) => item.id).filter(Boolean));
        pageToken = payload.nextPageToken || null;
        if (!pageToken) return calendars;
    }
    throw new ProviderResponseError("Google calendar pagination limit exceeded", 508);
}

async function fetchGoogleCalendar({ calendarId, accessToken, start, end, syncToken, fetchImpl }) {
    const run = async (incremental) => {
        const events = [];
        const cancelledIds = [];
        let pageToken = null;
        for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
            const url = new URL(`${GOOGLE_EVENTS_BASE_URL}/${encodeURIComponent(calendarId)}/events`);
            url.searchParams.set("singleEvents", "true");
            url.searchParams.set("maxResults", "2500");
            if (incremental) {
                url.searchParams.set("syncToken", syncToken);
            } else {
                url.searchParams.set("orderBy", "startTime");
                url.searchParams.set("timeMin", start.toISOString());
                url.searchParams.set("timeMax", end.toISOString());
            }
            if (pageToken) url.searchParams.set("pageToken", pageToken);
            const payload = await fetchProviderJson(fetchImpl, url, {
                headers: { authorization: `Bearer ${accessToken}` },
            });
            for (const item of payload.items || []) {
                if (item.status === "cancelled") {
                    if (item.id) cancelledIds.push(String(item.id));
                } else {
                    events.push(item);
                }
            }
            pageToken = payload.nextPageToken || null;
            if (!pageToken) {
                return { events, cancelledIds, nextSyncToken: payload.nextSyncToken || null, incremental };
            }
        }
        throw new ProviderResponseError("Google event pagination limit exceeded", 508);
    };

    if (syncToken) {
        try {
            return await run(true);
        } catch (error) {
            if (!(error instanceof ProviderResponseError) || error.status !== 410) throw error;
        }
    }
    return run(false);
}

export async function fetchGoogleChanges({ account, accessToken, start, end, fetchImpl = fetch }) {
    const syncState = { ...(account.sync_token || {}) };
    const nextSyncState = { ...syncState };
    const events = [];
    const cancelledIds = [];
    let usedIncremental = false;
    const calendarIds = await listGoogleCalendars(accessToken, fetchImpl);

    for (const calendarId of calendarIds) {
        if (isSystemGoogleCalendar(calendarId)) continue;
        const result = await fetchGoogleCalendar({
            calendarId,
            accessToken,
            start,
            end,
            syncToken: syncState[calendarId],
            fetchImpl,
        });
        usedIncremental ||= result.incremental;
        for (const item of result.events) {
            const normalized = googleEvent(item, account.account_email);
            if (normalized) events.push(normalized);
        }
        cancelledIds.push(...result.cancelledIds);
        if (result.nextSyncToken) nextSyncState[calendarId] = result.nextSyncToken;
    }
    return { events, cancelledIds, syncToken: nextSyncState, incremental: usedIncremental };
}

function graphDateTime(value) {
    const raw = String(value || "").trim();
    if (!raw) return null;
    const explicitZone = /(?:Z|[+-]\d\d:\d\d)$/i.test(raw) ? raw : `${raw}Z`;
    const parsed = new Date(explicitZone);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function microsoftEvent(event, accountEmail) {
    const start = graphDateTime(event?.start?.dateTime);
    if (!event?.id || !start) return null;
    return {
        externalId: String(event.id),
        title: String(event.subject || "Untitled Event"),
        start,
        end: graphDateTime(event?.end?.dateTime),
        provider: "microsoft",
        accountEmail,
    };
}

export async function fetchMicrosoftChanges({ account, accessToken, start, end, fetchImpl = fetch }) {
    const previousDeltaLink = account.sync_token?.delta_link || null;
    const fullUrl = new URL(`${MICROSOFT_GRAPH_BASE_URL}/me/calendarView/delta`);
    fullUrl.searchParams.set("startDateTime", start.toISOString());
    fullUrl.searchParams.set("endDateTime", end.toISOString());
    let url = previousDeltaLink || fullUrl.toString();
    let retriedFull = false;
    const events = [];
    const cancelledIds = [];

    for (let page = 0; page < MAX_PROVIDER_PAGES; page += 1) {
        let payload;
        try {
            payload = await fetchProviderJson(fetchImpl, url, {
                headers: {
                    authorization: `Bearer ${accessToken}`,
                    prefer: 'outlook.timezone="UTC"',
                },
            });
        } catch (error) {
            if (previousDeltaLink && !retriedFull && error instanceof ProviderResponseError && [400, 410].includes(error.status)) {
                url = fullUrl.toString();
                retriedFull = true;
                events.length = 0;
                cancelledIds.length = 0;
                continue;
            }
            throw error;
        }
        for (const item of payload.value || []) {
            if (item["@removed"]) {
                if (item.id) cancelledIds.push(String(item.id));
            } else {
                const normalized = microsoftEvent(item, account.account_email);
                if (normalized) events.push(normalized);
            }
        }
        if (payload["@odata.nextLink"]) {
            url = payload["@odata.nextLink"];
            continue;
        }
        return {
            events,
            cancelledIds,
            syncToken: payload["@odata.deltaLink"] ? { delta_link: payload["@odata.deltaLink"] } : { ...(account.sync_token || {}) },
            incremental: Boolean(previousDeltaLink && !retriedFull),
        };
    }
    throw new ProviderResponseError("Microsoft event pagination limit exceeded", 508);
}

function calDavTime(value) {
    return value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function icalTimeToIso(value) {
    if (!value) return null;
    const date = value.toJSDate();
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return date.toISOString();
}

export function parseAppleCalendarObject(calendarObject, accountEmail, rangeStart = null, rangeEnd = null) {
    const raw = String(calendarObject?.data || "").trim();
    if (!raw) return [];
    const root = ICAL.Component.fromString(raw);
    const components = root.getAllSubcomponents("vevent");
    const events = [];
    for (const component of components) {
        const event = new ICAL.Event(component);
        if (!event.uid || event.isRecurrenceException()) continue;
        const start = icalTimeToIso(event.startDate);
        if (!start) continue;
        const durationSeconds = Math.max(0, Number(event.duration?.toSeconds?.() || 0));
        const appendOccurrence = (occurrenceStart, occurrenceEnd = null) => {
            const occurrenceIso = icalTimeToIso(occurrenceStart);
            if (!occurrenceIso) return;
            const occurrenceDate = new Date(occurrenceIso);
            if (rangeStart && occurrenceDate < rangeStart) return;
            if (rangeEnd && occurrenceDate > rangeEnd) return;
            const endIso = occurrenceEnd
                ? icalTimeToIso(occurrenceEnd)
                : new Date(new Date(occurrenceIso).getTime() + durationSeconds * 1000).toISOString();
            const occurrenceSuffix = event.isRecurring() ? `:${Math.floor(new Date(occurrenceIso).getTime() / 1000)}` : "";
            events.push({
                externalId: `${event.uid}${occurrenceSuffix}`,
                title: String(event.summary || "Untitled Event"),
                start: occurrenceIso,
                end: endIso,
                provider: "apple",
                accountEmail,
            });
        };

        if (!event.isRecurring()) {
            appendOccurrence(event.startDate, event.endDate);
            continue;
        }
        const iteratorStart = rangeStart ? ICAL.Time.fromJSDate(rangeStart, true) : undefined;
        const iterator = event.iterator(iteratorStart);
        for (let index = 0; index < 5000; index += 1) {
            const occurrence = iterator.next();
            if (!occurrence) break;
            const occurrenceDate = occurrence.toJSDate();
            if (rangeEnd && occurrenceDate > rangeEnd) break;
            appendOccurrence(occurrence);
        }
    }
    return events;
}

export async function fetchAppleChanges({
    account,
    start,
    end,
    fetchImpl = fetch,
    clientFactory = createDAVClient,
}) {
    if (!account.access_token || !account.account_email || !account.refresh_token) {
        throw new ProviderAuthorizationError("Apple CalDAV credentials are incomplete");
    }
    let client;
    try {
        client = await clientFactory({
            serverUrl: account.access_token,
            credentials: {
                username: account.account_email,
                password: account.refresh_token,
            },
            authMethod: "Basic",
            defaultAccountType: "caldav",
            fetch: fetchImpl,
            fetchOptions: typeof AbortSignal?.timeout === "function"
                ? { signal: AbortSignal.timeout(20000) }
                : {},
        });
        const calendars = await client.fetchCalendars();
        if (!Array.isArray(calendars)) throw new ProviderResponseError("Apple CalDAV returned an invalid calendar list", 502);
        if (calendars.length > 100) throw new ProviderResponseError("Apple calendar limit exceeded", 508);
        const events = [];
        for (const calendar of calendars) {
            const objects = await client.fetchCalendarObjects({
                calendar,
                timeRange: { start: calDavTime(start), end: calDavTime(end) },
                expand: true,
            });
            if (!Array.isArray(objects)) throw new ProviderResponseError("Apple CalDAV returned invalid calendar objects", 502);
            if (objects.length > 10000) throw new ProviderResponseError("Apple event limit exceeded", 508);
            for (const object of objects) events.push(...parseAppleCalendarObject(object, account.account_email, start, end));
        }
        return { events, cancelledIds: [], syncToken: {}, incremental: false };
    } catch (error) {
        if (error instanceof ProviderAuthorizationError || error instanceof ProviderResponseError) throw error;
        const message = String(error?.message || error);
        if (/\b(401|403|unauthorized|forbidden|credentials)\b/i.test(message)) {
            throw new ProviderAuthorizationError(`Apple CalDAV authorization failed: ${message}`);
        }
        throw new ProviderResponseError(`Apple CalDAV request failed: ${message}`, 502);
    }
}

export async function validateAppleCredentials({
    email,
    appPassword,
    caldavUrl = "https://caldav.icloud.com",
    fetchImpl = fetch,
    clientFactory = createDAVClient,
}) {
    try {
        const client = await clientFactory({
            serverUrl: caldavUrl,
            credentials: { username: email, password: appPassword },
            authMethod: "Basic",
            defaultAccountType: "caldav",
            fetch: fetchImpl,
            fetchOptions: typeof AbortSignal?.timeout === "function"
                ? { signal: AbortSignal.timeout(20000) }
                : {},
        });
        const calendars = await client.fetchCalendars();
        if (!Array.isArray(calendars)) throw new ProviderResponseError("Apple CalDAV returned an invalid calendar list", 502);
        if (calendars.length > 100) throw new ProviderResponseError("Apple calendar limit exceeded", 508);
        return { success: true, message: "Connection successful" };
    } catch (error) {
        if (error instanceof ProviderResponseError) throw error;
        const message = String(error?.message || error);
        if (/\b(401|403|unauthorized|forbidden|credentials)\b/i.test(message)) {
            throw new ProviderAuthorizationError(`Apple CalDAV authorization failed: ${message}`);
        }
        throw new ProviderResponseError(`Apple CalDAV request failed: ${message}`, 502);
    }
}