import { serializeTaskRows } from "./task-read-postgres.js";

const OPERATION = "task_create";

export const TASK_WRITE_LOCK_SQL = `SELECT pg_advisory_xact_lock($1::integer, hashtext($2))`;
export const TASK_RECEIPT_READ_SQL = `
    SELECT operation, request_hash, response_body FROM public.worker_write_receipts
    WHERE owner_id = public.worker_app_user_id() AND idempotency_key = $1
`;
export const TASK_INSERT_SQL = `
    INSERT INTO public.tasks (owner_id, title, description, completed, created_at)
    VALUES (public.worker_app_user_id(), $1, $2, $3, $4::timestamptz)
    RETURNING id, title, description, completed, owner_id, created_at
`;
export const TASK_RECEIPT_INSERT_SQL = `
    INSERT INTO public.worker_write_receipts
        (owner_id, idempotency_key, operation, request_hash, response_body)
    VALUES (public.worker_app_user_id(), $1, $2, $3, $4::jsonb)
    RETURNING response_body
`;

export class TaskWriteConflictError extends Error {
    constructor() {
        super("Idempotency key was already used for a different request");
        this.name = "TaskWriteConflictError";
    }
}

function receiptBody(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

export async function executeTaskWrite(adapter, { userId, data, idempotencyKey, requestHash, now = new Date() }) {
    if (!data || !Object.hasOwn(data, "title")) throw new TypeError("title is required");
    if (!idempotencyKey || !requestHash) throw new TypeError("idempotency metadata is required");
    return adapter.runWithIdentity(userId, async (client) => {
        await client.query(TASK_WRITE_LOCK_SQL, [userId, idempotencyKey]);
        const receipt = await client.query(TASK_RECEIPT_READ_SQL, [idempotencyKey]);
        if (receipt.rows.length) {
            const existing = receipt.rows[0];
            if (existing.operation !== OPERATION || existing.request_hash !== requestHash) throw new TaskWriteConflictError();
            return receiptBody(existing.response_body);
        }
        const result = await client.query(TASK_INSERT_SQL, [
            String(data.title), data.description ?? null, Boolean(data.completed), now.toISOString(),
        ]);
        const response = serializeTaskRows(result.rows)[0];
        const inserted = await client.query(TASK_RECEIPT_INSERT_SQL, [idempotencyKey, OPERATION, requestHash, JSON.stringify(response)]);
        return receiptBody(inserted.rows[0].response_body);
    });
}