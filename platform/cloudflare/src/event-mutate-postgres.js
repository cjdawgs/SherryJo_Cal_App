import { normalizeStickyNotes } from "./date-sticky-read-postgres.js";
import { serializeCreatedEvent } from "./event-create-postgres.js";

export const EVENT_MUTATION_LOCK_SQL = `SELECT pg_advisory_xact_lock($1::integer, hashtext($2))`;
export const EVENT_MUTATION_RECEIPT_READ_SQL = `
    SELECT operation, request_hash, response_body FROM public.worker_write_receipts
    WHERE owner_id = public.worker_app_user_id() AND idempotency_key = $1
`;
export const EVENT_UPDATE_READ_SQL = `
    SELECT id, "externalId" AS external_id, external_ids, title, description,
        start_time, end_time, recurrence, color, color_enabled, tags, sticky_note,
        sticky_notes, created_at, updated_at, source, account_email
    FROM public.events
    WHERE id = $1 AND owner_id = public.worker_app_user_id()
    FOR UPDATE
`;
export const EVENT_UPDATE_SQL = `
    UPDATE public.events SET
        title = $2, description = $3, start_time = $4::timestamptz,
        end_time = $5::timestamptz, recurrence = $6::jsonb, color = $7,
        color_enabled = $8, tags = $9::jsonb, sticky_note = $10::jsonb,
        sticky_notes = $11::jsonb, updated_at = $12::timestamptz
    WHERE id = $1 AND owner_id = public.worker_app_user_id()
    RETURNING id, "externalId" AS external_id, external_ids, title, description,
        start_time, end_time, recurrence, color, color_enabled, tags, sticky_note,
        sticky_notes, created_at, updated_at, source, account_email
`;
export const EVENT_NOTE_DELETE_SQL = `
    DELETE FROM public.notes
    WHERE event_id = $1
      AND EXISTS (
          SELECT 1 FROM public.events
          WHERE events.id = notes.event_id
            AND events.owner_id = public.worker_app_user_id()
      )
`;
export const EVENT_DELETE_SQL = `
    DELETE FROM public.events
    WHERE id = $1 AND owner_id = public.worker_app_user_id()
    RETURNING id
`;
export const EVENT_MUTATION_RECEIPT_INSERT_SQL = `
    INSERT INTO public.worker_write_receipts
        (owner_id, idempotency_key, operation, request_hash, response_body)
    VALUES (public.worker_app_user_id(), $1, $2, $3, $4::jsonb)
    RETURNING response_body
`;

export class EventMutationIdempotencyConflictError extends Error {
    constructor() {
        super("Idempotency key was already used for a different request");
        this.name = "EventMutationIdempotencyConflictError";
    }
}

export class EventNotFoundError extends Error {
    constructor() {
        super("Event not found");
        this.name = "EventNotFoundError";
    }
}

export class EventUpdateConflictError extends Error {
    constructor(serverUpdatedAt) {
        super("Event was updated by another process. Reload and try again.");
        this.name = "EventUpdateConflictError";
        this.serverUpdatedAt = serverUpdatedAt;
    }
}

function receiptBody(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

function parseDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeTags(value) {
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    if (typeof value === "string") return value.split(",").map((item) => item.trim()).filter(Boolean);
    return [];
}

function pythonOr(first, second) {
    if (Array.isArray(first)) return first.length ? first : second;
    return first || second;
}

async function beginMutation(client, { userId, idempotencyKey, requestHash, operation }) {
    if (!idempotencyKey || !requestHash) throw new TypeError("idempotency metadata is required");
    await client.query(EVENT_MUTATION_LOCK_SQL, [userId, idempotencyKey]);
    const receipt = await client.query(EVENT_MUTATION_RECEIPT_READ_SQL, [idempotencyKey]);
    if (!receipt.rows.length) return null;
    const existing = receipt.rows[0];
    if (existing.operation !== operation || existing.request_hash !== requestHash) {
        throw new EventMutationIdempotencyConflictError();
    }
    return receiptBody(existing.response_body);
}

async function finishMutation(client, { idempotencyKey, requestHash, operation, response }) {
    const inserted = await client.query(EVENT_MUTATION_RECEIPT_INSERT_SQL, [
        idempotencyKey, operation, requestHash, JSON.stringify(response),
    ]);
    return receiptBody(inserted.rows[0].response_body);
}

export async function executeEventUpdate(adapter, {
    userId, eventId, data, idempotencyKey, requestHash, now = new Date(),
}) {
    return adapter.runWithIdentity(userId, async (client) => {
        const replay = await beginMutation(client, {
            userId, idempotencyKey, requestHash, operation: "event_update",
        });
        if (replay) return replay;

        const selected = await client.query(EVENT_UPDATE_READ_SQL, [eventId]);
        if (!selected.rows.length) throw new EventNotFoundError();
        const row = selected.rows[0];
        const clientUpdatedAt = parseDate(data?.client_updated_at);
        const serverUpdatedAt = parseDate(row.updated_at);
        if (clientUpdatedAt && serverUpdatedAt && clientUpdatedAt < serverUpdatedAt) {
            throw new EventUpdateConflictError(serverUpdatedAt.toISOString().replace("Z", "+00:00"));
        }

        if (Object.hasOwn(data, "title")) {
            row.title = String(data.title || "").trim();
            if (!row.title) throw new TypeError("title cannot be empty");
        }
        if (Object.hasOwn(data, "description")) row.description = String(data.description || "").trim();
        if (Object.hasOwn(data, "start_time")) {
            row.start_time = parseDate(data.start_time);
            if (!row.start_time) throw new TypeError("start_time is invalid");
        }
        if (Object.hasOwn(data, "end_time")) row.end_time = parseDate(data.end_time);
        if (Object.hasOwn(data, "recurrence")) row.recurrence = data.recurrence;
        if (Object.hasOwn(data, "color")) row.color = data.color;
        if (Object.hasOwn(data, "color_enabled")) row.color_enabled = Boolean(data.color_enabled);
        if (Object.hasOwn(data, "tags")) row.tags = normalizeTags(data.tags);

        const hasSticky = ["sticky_notes", "stickyNotes", "sticky_note", "stickyNote"]
            .some((key) => Object.hasOwn(data, key));
        if (hasSticky) {
            let stickyNotes = normalizeStickyNotes(pythonOr(data.sticky_notes, data.stickyNotes), now);
            if (!stickyNotes.length && (Object.hasOwn(data, "sticky_note") || Object.hasOwn(data, "stickyNote"))) {
                stickyNotes = normalizeStickyNotes(pythonOr(data.sticky_note, data.stickyNote), now);
            }
            row.sticky_notes = stickyNotes;
            row.sticky_note = stickyNotes[0] || null;
        }

        const updated = await client.query(EVENT_UPDATE_SQL, [
            eventId, row.title, row.description || "", new Date(row.start_time).toISOString(),
            row.end_time ? new Date(row.end_time).toISOString() : null,
            JSON.stringify(row.recurrence ?? null), row.color ?? null, Boolean(row.color_enabled),
            JSON.stringify(row.tags || []), JSON.stringify(row.sticky_note || null),
            JSON.stringify(row.sticky_notes || []), now.toISOString(),
        ]);
        const response = { status: "ok", event: serializeCreatedEvent(updated.rows[0]) };
        return finishMutation(client, {
            idempotencyKey, requestHash, operation: "event_update", response,
        });
    });
}

export async function executeEventDelete(adapter, { userId, eventId, idempotencyKey, requestHash }) {
    return adapter.runWithIdentity(userId, async (client) => {
        const replay = await beginMutation(client, {
            userId, idempotencyKey, requestHash, operation: "event_delete",
        });
        if (replay) return replay;
        const selected = await client.query(EVENT_UPDATE_READ_SQL, [eventId]);
        if (!selected.rows.length) throw new EventNotFoundError();
        await client.query(EVENT_NOTE_DELETE_SQL, [eventId]);
        const deleted = await client.query(EVENT_DELETE_SQL, [eventId]);
        if (!deleted.rows.length) throw new EventNotFoundError();
        const response = { status: "ok", deleted: eventId };
        return finishMutation(client, {
            idempotencyKey, requestHash, operation: "event_delete", response,
        });
    });
}