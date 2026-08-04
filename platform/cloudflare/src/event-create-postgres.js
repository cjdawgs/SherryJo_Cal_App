import { normalizeStickyNotes } from "./date-sticky-read-postgres.js";

const OPERATION = "event_create";

export const EVENT_CREATE_SQL = `
    INSERT INTO public.events (
        owner_id, title, description, start_time, end_time, recurrence,
        source, account_email, color, color_enabled, tags, sticky_note,
        sticky_notes, status, created_at, updated_at
    ) VALUES (
        public.worker_app_user_id(), $1, $2, $3::timestamptz, $4::timestamptz,
        $5::jsonb, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb,
        'pending', $13::timestamptz, $13::timestamptz
    )
    RETURNING id, "externalId" AS external_id, external_ids, title, description,
        start_time, end_time, recurrence, color, color_enabled, tags, sticky_note,
        sticky_notes, created_at, updated_at, source, account_email
`;

export const EVENT_CREATE_LOCK_SQL = `SELECT pg_advisory_xact_lock($1::integer, hashtext($2))`;
export const EVENT_CREATE_RECEIPT_READ_SQL = `
    SELECT operation, request_hash, response_body FROM public.worker_write_receipts
    WHERE owner_id = public.worker_app_user_id() AND idempotency_key = $1
`;
export const EVENT_CREATE_RECEIPT_INSERT_SQL = `
    INSERT INTO public.worker_write_receipts
        (owner_id, idempotency_key, operation, request_hash, response_body)
    VALUES (public.worker_app_user_id(), $1, $2, $3, $4::jsonb)
    RETURNING response_body
`;

export class EventCreateIdempotencyConflictError extends Error {
    constructor() {
        super("Idempotency key was already used for a different request");
        this.name = "EventCreateIdempotencyConflictError";
    }
}

function receiptBody(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

function parseDate(value, required = false) {
    if (value === null || value === undefined || value === "") {
        if (required) throw new TypeError("start_time is required");
        return null;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("invalid event timestamp");
    return date;
}

function normalizeProvider(value) {
    const provider = String(value || "").trim().toLowerCase();
    if (["outlook", "office365", "ms", "msft", "microsoft"].includes(provider)) return "microsoft";
    if (["gmail", "google"].includes(provider)) return "google";
    if (["icloud", "caldav", "apple"].includes(provider)) return "apple";
    if (["local", "internal"].includes(provider)) return "local";
    return provider || "other";
}

function iso(value, allDay = false) {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError("invalid event timestamp");
    const serialized = date.toISOString().replace(".000Z", "+00:00").replace(/Z$/, "+00:00");
    return allDay ? serialized.replace("+00:00", "") : serialized;
}

function isAllDay(start, end) {
    if (!start || !end) return false;
    return start.getUTCHours() === 0 && start.getUTCMinutes() === 0 && start.getUTCSeconds() === 0
        && end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0
        && end >= start && end.getTime() - start.getTime() <= 86400000;
}

export function serializeCreatedEvent(row) {
    const start = row.start_time instanceof Date ? row.start_time : new Date(row.start_time);
    const end = row.end_time ? (row.end_time instanceof Date ? row.end_time : new Date(row.end_time)) : null;
    const allDay = isAllDay(start, end);
    const source = String(row.source || "local");
    const accountEmail = String(row.account_email || "local");
    const provider = normalizeProvider(source);
    const accountKey = `${provider}:${accountEmail.toLowerCase().trim()}`;
    const stickyNotes = Array.isArray(row.sticky_notes) ? row.sticky_notes : [];
    const createdAt = iso(row.created_at);
    const updatedAt = iso(row.updated_at);
    const event = {
        id: row.id, external_id: row.external_id, external_ids: row.external_ids || {},
        title: row.title, description: row.description || "", start: iso(start, allDay), end: iso(end, allDay),
        start_time: iso(start, allDay), end_time: iso(end, allDay), recurrence: row.recurrence || null,
        color: row.color, color_enabled: Boolean(row.color_enabled), tags: row.tags || [],
        sticky_note: stickyNotes[0] || null, sticky_notes: stickyNotes,
        created_at: createdAt, updated_at: updatedAt, source, account_email: accountEmail, account_key: accountKey,
    };
    event.extendedProps = {
        backendId: row.id, source: provider, account: accountEmail, account_key: accountKey,
        external_ids: event.external_ids, description: event.description, tags: event.tags,
        eventColor: row.color, eventColorEnabled: event.color_enabled,
        stickyNote: event.sticky_note, stickyNotes, createdAt, updatedAt, recurrence: event.recurrence,
    };
    return event;
}

export async function executeEventCreate(adapter, { userId, data, idempotencyKey, requestHash, now = new Date() }) {
    const title = String(data?.title || "").trim();
    if (!title) throw new TypeError("title is required");
    const start = parseDate(data.start_time, true);
    const end = parseDate(data.end_time);
    let stickyNotes = normalizeStickyNotes(data.sticky_notes ?? data.stickyNotes, now);
    if (!stickyNotes.length) stickyNotes = normalizeStickyNotes(data.sticky_note ?? data.stickyNote, now);
    const tags = Array.isArray(data.tags) ? data.tags.map(String).map((value) => value.trim()).filter(Boolean)
        : typeof data.tags === "string" ? data.tags.split(",").map((value) => value.trim()).filter(Boolean) : [];
    if (!idempotencyKey || !requestHash) throw new TypeError("idempotency metadata is required");

    return adapter.runWithIdentity(userId, async (client) => {
        await client.query(EVENT_CREATE_LOCK_SQL, [userId, idempotencyKey]);
        const receipt = await client.query(EVENT_CREATE_RECEIPT_READ_SQL, [idempotencyKey]);
        if (receipt.rows.length) {
            const existing = receipt.rows[0];
            if (existing.operation !== OPERATION || existing.request_hash !== requestHash) throw new EventCreateIdempotencyConflictError();
            return receiptBody(existing.response_body);
        }
        const created = await client.query(EVENT_CREATE_SQL, [
            title, String(data.description || "").trim(), start.toISOString(), end?.toISOString() || null,
            JSON.stringify(data.recurrence ?? null), data.source || "local", data.account_email || "local",
            data.color ?? null, Boolean(data.color_enabled), JSON.stringify(tags),
            JSON.stringify(stickyNotes[0] || null), JSON.stringify(stickyNotes), now.toISOString(),
        ]);
        const response = { status: "ok", event: serializeCreatedEvent(created.rows[0]) };
        const inserted = await client.query(EVENT_CREATE_RECEIPT_INSERT_SQL, [idempotencyKey, OPERATION, requestHash, JSON.stringify(response)]);
        return receiptBody(inserted.rows[0].response_body);
    });
}