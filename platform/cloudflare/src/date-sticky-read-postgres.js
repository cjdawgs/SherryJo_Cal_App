export const DATE_STICKY_LIST_SQL = `
    SELECT id, date, sticky_notes, updated_at
    FROM public.date_sticky_notes
    WHERE owner_id = public.worker_app_user_id()
`;

export const DATE_STICKY_ITEM_SQL = `
    SELECT id, date, sticky_notes, updated_at
    FROM public.date_sticky_notes
    WHERE owner_id = public.worker_app_user_id()
      AND date = $1
    LIMIT 1
`;

function serializeDate(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new TypeError("Date-sticky row contains an invalid timestamp");
    }
    return value.toISOString().replace(".000Z", "+00:00").replace(/Z$/, "+00:00");
}

function serializeDateOnly(value) {
    if (typeof value === "string") return value.slice(0, 10);
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new TypeError("Date-sticky row contains an invalid date");
    }
    return value.toISOString().slice(0, 10);
}

function normalizeStickyNote(value, nowIso) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const content = String(value.content || "").trim();
    if (!content) return null;
    return {
        content,
        color: String(value.color || "#F7E68A").trim(),
        createdAt: value.createdAt || nowIso,
        updatedAt: value.updatedAt || nowIso,
    };
}

export function normalizeStickyNotes(value, now = new Date()) {
    const values = Array.isArray(value) ? value : [value];
    if (value === null || value === undefined) return [];
    const nowIso = now.toISOString().replace("Z", "+00:00");
    return values.map((item) => normalizeStickyNote(item, nowIso)).filter(Boolean);
}

export function serializeDateStickyRow(row, now = new Date()) {
    const stickyNotes = normalizeStickyNotes(row.sticky_notes, now);
    return {
        id: row.id,
        date: serializeDateOnly(row.date),
        sticky_notes: stickyNotes,
        count: stickyNotes.length,
        updated_at: serializeDate(row.updated_at),
    };
}

export async function executeDateStickyListRead(adapter, userId) {
    const result = await adapter.runWithIdentity(
        userId,
        (client) => client.query(DATE_STICKY_LIST_SQL),
    );
    return {
        status: "ok",
        items: result.rows.map((row) => serializeDateStickyRow(row)),
    };
}

export async function executeDateStickyItemRead(adapter, { userId, date }) {
    if (!date) throw new TypeError("date is required");
    const result = await adapter.runWithIdentity(
        userId,
        (client) => client.query(DATE_STICKY_ITEM_SQL, [date]),
    );
    return {
        status: "ok",
        item: result.rows.length
            ? serializeDateStickyRow(result.rows[0])
            : { date, sticky_notes: [], count: 0 },
    };
}