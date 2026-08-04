import { serializeTagColorRows } from "./tag-color-read-postgres.js";

const OPERATION = "tag_color_put";
const DEFAULT_EVENT_COLOR = "#4F8EF7";

export const TAG_COLOR_WRITE_LOCK_SQL = `
    SELECT pg_advisory_xact_lock($1::integer, hashtext($2))
`;

export const TAG_COLOR_RECEIPT_READ_SQL = `
    SELECT operation, request_hash, response_body
    FROM public.worker_write_receipts
    WHERE owner_id = public.worker_app_user_id()
      AND idempotency_key = $1
`;

export const TAG_COLOR_UPSERT_SQL = `
    INSERT INTO public.event_tag_color_settings
        (owner_id, tag_key, label, color, enabled, updated_at)
    VALUES
        (public.worker_app_user_id(), $1, $2, $3, $4, $5::timestamptz)
    ON CONFLICT (owner_id, tag_key) DO UPDATE
    SET label = EXCLUDED.label,
        color = EXCLUDED.color,
        enabled = EXCLUDED.enabled,
        updated_at = EXCLUDED.updated_at
`;

export const TAG_COLOR_RESULT_SQL = `
    SELECT tag_key, label, color, enabled
    FROM public.event_tag_color_settings
    WHERE owner_id = public.worker_app_user_id()
`;

export const TAG_COLOR_RECEIPT_INSERT_SQL = `
    INSERT INTO public.worker_write_receipts
        (owner_id, idempotency_key, operation, request_hash, response_body)
    VALUES
        (public.worker_app_user_id(), $1, $2, $3, $4::jsonb)
    RETURNING response_body
`;

export class TagColorIdempotencyConflictError extends Error {
    constructor() {
        super("Idempotency key was already used for a different request");
        this.name = "TagColorIdempotencyConflictError";
    }
}

function receiptBody(value) {
    return typeof value === "string" ? JSON.parse(value) : value;
}

function normalizeLabel(value) {
    return String(value || "").trim().split(/\s+/).filter(Boolean).join(" ");
}

function normalizeColor(value) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_EVENT_COLOR;
}

export function normalizeTagColorSettings(settings) {
    const normalized = [];
    for (const [rawKey, rawEntry] of Object.entries(settings)) {
        if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
        const label = normalizeLabel(rawEntry.label || rawKey);
        const tagKey = normalizeLabel(label || rawKey).toLowerCase();
        if (!tagKey) continue;
        normalized.push({
            tagKey,
            label,
            color: normalizeColor(rawEntry.color),
            enabled: Boolean(rawEntry.enabled),
        });
    }
    return normalized;
}

export async function executeTagColorWrite(adapter, {
    userId,
    settings,
    idempotencyKey,
    requestHash,
    now = new Date(),
}) {
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
        throw new TypeError("settings object is required");
    }
    if (!idempotencyKey) throw new TypeError("idempotencyKey is required");
    if (!requestHash) throw new TypeError("requestHash is required");

    return adapter.runWithIdentity(userId, async (client) => {
        await client.query(TAG_COLOR_WRITE_LOCK_SQL, [userId, idempotencyKey]);
        const receipt = await client.query(TAG_COLOR_RECEIPT_READ_SQL, [idempotencyKey]);
        if (receipt.rows.length) {
            const existing = receipt.rows[0];
            if (existing.operation !== OPERATION || existing.request_hash !== requestHash) {
                throw new TagColorIdempotencyConflictError();
            }
            return receiptBody(existing.response_body);
        }

        for (const setting of normalizeTagColorSettings(settings)) {
            await client.query(TAG_COLOR_UPSERT_SQL, [
                setting.tagKey,
                setting.label,
                setting.color,
                setting.enabled,
                now.toISOString(),
            ]);
        }

        const result = await client.query(TAG_COLOR_RESULT_SQL);
        const response = { status: "ok", ...serializeTagColorRows(result.rows) };
        const insertedReceipt = await client.query(TAG_COLOR_RECEIPT_INSERT_SQL, [
            idempotencyKey,
            OPERATION,
            requestHash,
            JSON.stringify(response),
        ]);
        return receiptBody(insertedReceipt.rows[0].response_body);
    });
}