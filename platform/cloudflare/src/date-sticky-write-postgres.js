import {
    normalizeStickyNotes,
    serializeDateStickyRow,
} from "./date-sticky-read-postgres.js";

const OPERATION = "date_sticky_put";

export const WRITE_RECEIPT_LOCK_SQL = `
    SELECT pg_advisory_xact_lock($1::integer, hashtext($2))
`;

export const WRITE_RECEIPT_READ_SQL = `
    SELECT operation, request_hash, response_body
    FROM public.worker_write_receipts
    WHERE owner_id = public.worker_app_user_id()
      AND idempotency_key = $1
`;

export const DATE_STICKY_UPSERT_SQL = `
    INSERT INTO public.date_sticky_notes (owner_id, date, sticky_notes, updated_at)
    VALUES (public.worker_app_user_id(), $1, $2::jsonb, $3::timestamptz)
    ON CONFLICT (owner_id, date) DO UPDATE
    SET sticky_notes = EXCLUDED.sticky_notes,
        updated_at = EXCLUDED.updated_at
    RETURNING id, date, sticky_notes, updated_at
`;

export const DATE_STICKY_DELETE_SQL = `
    DELETE FROM public.date_sticky_notes
    WHERE owner_id = public.worker_app_user_id()
      AND date = $1
`;

export const WRITE_RECEIPT_INSERT_SQL = `
    INSERT INTO public.worker_write_receipts
        (owner_id, idempotency_key, operation, request_hash, response_body)
    VALUES
        (public.worker_app_user_id(), $1, $2, $3, $4::jsonb)
    RETURNING response_body
`;

export class IdempotencyConflictError extends Error {
    constructor() {
        super("Idempotency key was already used for a different request");
        this.name = "IdempotencyConflictError";
    }
}

function receiptBody(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

export async function executeDateStickyWrite(adapter, {
    userId,
    date,
    stickyNotes,
    idempotencyKey,
    requestHash,
    now = new Date(),
}) {
    if (!date) throw new TypeError("date is required");
    if (!idempotencyKey) throw new TypeError("idempotencyKey is required");
    if (!requestHash) throw new TypeError("requestHash is required");

    return adapter.runWithIdentity(userId, async (client) => {
        await client.query(WRITE_RECEIPT_LOCK_SQL, [userId, idempotencyKey]);
        const receipt = await client.query(WRITE_RECEIPT_READ_SQL, [idempotencyKey]);
        if (receipt.rows.length) {
            const existing = receipt.rows[0];
            if (existing.operation !== OPERATION || existing.request_hash !== requestHash) {
                throw new IdempotencyConflictError();
            }
            return receiptBody(existing.response_body);
        }

        const normalized = normalizeStickyNotes(stickyNotes, now);
        let response;
        if (!normalized.length) {
            await client.query(DATE_STICKY_DELETE_SQL, [date]);
            response = {
                status: "ok",
                item: { date, sticky_notes: [], count: 0 },
            };
        } else {
            const result = await client.query(DATE_STICKY_UPSERT_SQL, [
                date,
                JSON.stringify(normalized),
                now.toISOString(),
            ]);
            response = {
                status: "ok",
                item: serializeDateStickyRow(result.rows[0], now),
            };
        }

        const insertedReceipt = await client.query(WRITE_RECEIPT_INSERT_SQL, [
            idempotencyKey,
            OPERATION,
            requestHash,
            JSON.stringify(response),
        ]);
        return receiptBody(insertedReceipt.rows[0].response_body);
    });
}