import { serializeNoteRows } from "./note-read-postgres.js";

const OPERATION = "note_upsert";

export const NOTE_WRITE_LOCK_SQL = `SELECT pg_advisory_xact_lock($1::integer, hashtext($2))`;
export const NOTE_DOMAIN_LOCK_SQL = `SELECT pg_advisory_xact_lock($1::integer, hashtext($2))`;
export const NOTE_RECEIPT_READ_SQL = `
    SELECT operation, request_hash, response_body FROM public.worker_write_receipts
    WHERE owner_id = public.worker_app_user_id() AND idempotency_key = $1
`;
export const NOTE_EVENT_READ_SQL = `
    SELECT id FROM public.events
    WHERE id = $1 AND owner_id = public.worker_app_user_id()
`;
export const NOTE_EXISTING_READ_SQL = `
    SELECT id FROM public.notes WHERE event_id = $1 AND date = $2
    ORDER BY id LIMIT 1 FOR UPDATE
`;
export const NOTE_UPDATE_SQL = `
    UPDATE public.notes SET content = $2 WHERE id = $1
    RETURNING id, date, content, color, x, y, event_id
`;
export const NOTE_INSERT_SQL = `
    INSERT INTO public.notes (id, date, content, color, x, y, event_id)
    VALUES ($1, $2, $3, 'yellow', 120, 120, $4)
    RETURNING id, date, content, color, x, y, event_id
`;
export const NOTE_RECEIPT_INSERT_SQL = `
    INSERT INTO public.worker_write_receipts
        (owner_id, idempotency_key, operation, request_hash, response_body)
    VALUES (public.worker_app_user_id(), $1, $2, $3, $4::jsonb)
    RETURNING response_body
`;

export class NoteWriteConflictError extends Error {
    constructor() {
        super("Idempotency key was already used for a different request");
        this.name = "NoteWriteConflictError";
    }
}

export class NoteEventNotFoundError extends Error {
    constructor() {
        super("Event not found");
        this.name = "NoteEventNotFoundError";
    }
}

function receiptBody(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

export async function executeNoteWrite(adapter, { userId, data, idempotencyKey, requestHash }) {
    const eventId = Number(data?.event_id);
    const date = String(data?.date || "").trim();
    if (!Number.isSafeInteger(eventId) || eventId <= 0) throw new TypeError("event_id is required");
    if (!date) throw new TypeError("date is required");
    if (!Object.hasOwn(data, "content")) throw new TypeError("content is required");
    if (!idempotencyKey || !requestHash) throw new TypeError("idempotency metadata is required");

    return adapter.runWithIdentity(userId, async (client) => {
        await client.query(NOTE_WRITE_LOCK_SQL, [userId, idempotencyKey]);
        const receipt = await client.query(NOTE_RECEIPT_READ_SQL, [idempotencyKey]);
        if (receipt.rows.length) {
            const existing = receipt.rows[0];
            if (existing.operation !== OPERATION || existing.request_hash !== requestHash) throw new NoteWriteConflictError();
            return receiptBody(existing.response_body);
        }

        await client.query(NOTE_DOMAIN_LOCK_SQL, [userId, `note:${eventId}:${date}`]);
        const event = await client.query(NOTE_EVENT_READ_SQL, [eventId]);
        if (!event.rows.length) throw new NoteEventNotFoundError();
        const existing = await client.query(NOTE_EXISTING_READ_SQL, [eventId, date]);
        const content = String(data.content);
        const result = existing.rows.length
            ? await client.query(NOTE_UPDATE_SQL, [existing.rows[0].id, content])
            : await client.query(NOTE_INSERT_SQL, [crypto.randomUUID(), date, content, eventId]);
        const response = serializeNoteRows(result.rows)[0];
        const inserted = await client.query(NOTE_RECEIPT_INSERT_SQL, [idempotencyKey, OPERATION, requestHash, JSON.stringify(response)]);
        return receiptBody(inserted.rows[0].response_body);
    });
}