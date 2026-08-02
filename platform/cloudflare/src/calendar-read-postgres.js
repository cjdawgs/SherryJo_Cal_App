import { assembleCalendarRead } from "./calendar-read.js";

export const EVENT_READ_SQL = `
    SELECT
        id,
        "externalId" AS external_id,
        external_ids,
        title,
        start_time,
        end_time,
        description,
        color,
        color_enabled,
        tags,
        sticky_note,
        sticky_notes,
        created_at,
        updated_at,
        source,
        account_email
    FROM public.events
    WHERE owner_id = public.worker_app_user_id()
      AND start_time >= $1::timestamptz
      AND start_time <= $2::timestamptz
`;

export const ACCOUNT_STATUS_READ_SQL = `
    SELECT account_key, account_status
    FROM public.worker_calendar_account_status
`;

function normalizeProvider(provider) {
    const value = String(provider || "").trim().toLowerCase();
    if (["outlook", "office365", "ms", "msft", "microsoft"].includes(value)) return "microsoft";
    if (["gmail", "google"].includes(value)) return "google";
    if (["icloud", "caldav", "apple"].includes(value)) return "apple";
    if (["local", "internal"].includes(value)) return "local";
    return value || "other";
}

function asDate(value) {
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
    return null;
}

function isAllDaySpan(startValue, endValue) {
    const start = asDate(startValue);
    const end = asDate(endValue);
    if (!start || !end) return false;

    return start.getUTCHours() === 0
        && start.getUTCMinutes() === 0
        && start.getUTCSeconds() === 0
        && end.getUTCHours() === 0
        && end.getUTCMinutes() === 0
        && end.getUTCSeconds() === 0
        && end >= start
        && end.getTime() - start.getTime() <= 24 * 60 * 60 * 1000;
}

function serializeDate(value, allDay = false) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;

    const date = asDate(value);
    if (!date) throw new TypeError("Calendar event contains an invalid date");
    const iso = date.toISOString().replace(".000Z", "Z");
    return allDay ? iso.replace(/Z$/, "") : iso.replace(/Z$/, "+00:00");
}

function eventView(row, providerOverride, accountEmailOverride) {
    const source = normalizeProvider(providerOverride || row.source || "local");
    const accountEmail = String(accountEmailOverride || row.account_email || "local").trim().toLowerCase();
    const allDay = isAllDaySpan(row.start_time, row.end_time);

    return {
        id: row.id,
        external_id: row.external_id,
        external_ids: { ...(row.external_ids || {}) },
        title: row.title,
        start: serializeDate(row.start_time, allDay),
        end: serializeDate(row.end_time, allDay),
        description: row.description || "",
        color: row.color,
        color_enabled: Boolean(row.color_enabled),
        tags: Array.isArray(row.tags) ? [...row.tags] : [],
        sticky_note: row.sticky_note,
        sticky_notes: Array.isArray(row.sticky_notes) ? [...row.sticky_notes] : [],
        created_at: serializeDate(row.created_at),
        updated_at: serializeDate(row.updated_at),
        source,
        account_email: accountEmail,
        account_key: `${source}:${accountEmail}`,
    };
}

export function serializeCalendarEventRows(rows, dedupEnabled = true) {
    const events = [];
    for (const row of rows) {
        const externalIds = row.external_ids && typeof row.external_ids === "object"
            ? row.external_ids
            : {};

        if (!dedupEnabled) {
            const emittedKeys = new Set();
            for (const accountKey of Object.keys(externalIds)) {
                if (!accountKey.includes(":")) continue;
                const separator = accountKey.indexOf(":");
                const provider = normalizeProvider(accountKey.slice(0, separator));
                const email = (accountKey.slice(separator + 1) || "local").trim().toLowerCase();
                const normalizedKey = `${provider}:${email}`;
                if (emittedKeys.has(normalizedKey)) continue;
                events.push(eventView(row, provider, email));
                emittedKeys.add(normalizedKey);
            }
            if (emittedKeys.size) continue;
        }

        events.push(eventView(row));
    }
    return events;
}

export class PostgresCalendarReadAdapter {
    constructor({ createClient, connectionString, accountStatusProvider = null }) {
        if (typeof createClient !== "function") throw new TypeError("createClient is required");
        if (!connectionString) throw new TypeError("Hyperdrive connection string is required");
        this.createClient = createClient;
        this.connectionString = connectionString;
        this.accountStatusProvider = accountStatusProvider;
    }

    async runWithIdentity(userId, operation) {
        if (!Number.isInteger(userId) || userId <= 0) throw new TypeError("userId must be a positive integer");

        const client = this.createClient({ connectionString: this.connectionString });
        let transactionStarted = false;
        let connected = false;
        try {
            await client.connect();
            connected = true;
            await client.query("BEGIN");
            transactionStarted = true;
            await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
            const result = await operation(client);
            await client.query("COMMIT");
            transactionStarted = false;
            return result;
        } catch (error) {
            if (transactionStarted) {
                try {
                    await client.query("ROLLBACK");
                } catch {
                    // Preserve the original database error.
                }
            }
            throw error;
        } finally {
            if (connected) await client.end();
        }
    }

    async listEvents({ userId, start, end, dedupEnabled = true }) {
        if (!asDate(start) || !asDate(end)) throw new TypeError("start and end must be valid dates");
        const result = await this.runWithIdentity(
            userId,
            (client) => client.query(EVENT_READ_SQL, [start.toISOString(), end.toISOString()]),
        );
        return serializeCalendarEventRows(result.rows, dedupEnabled);
    }

    async listAccountStatuses(userId) {
        if (this.accountStatusProvider) return this.accountStatusProvider(userId);

        const result = await this.runWithIdentity(
            userId,
            (client) => client.query(ACCOUNT_STATUS_READ_SQL),
        );
        return Object.fromEntries(
            result.rows.map((row) => [row.account_key, row.account_status]),
        );
    }
}

export async function executeCalendarRead(adapter, query) {
    let events = [];
    let accountStatus = {};
    try {
        events = await adapter.listEvents(query);
    } catch {
        events = [];
    }
    try {
        accountStatus = await adapter.listAccountStatuses(query.userId);
    } catch {
        accountStatus = {};
    }
    return assembleCalendarRead(events, accountStatus);
}