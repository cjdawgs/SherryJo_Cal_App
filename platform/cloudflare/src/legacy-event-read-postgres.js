export const LEGACY_EVENT_READ_SQL = `
    SELECT id, title, start_time, end_time, description, status, source
    FROM public.events
    WHERE owner_id = public.worker_app_user_id()
`;

export const LEGACY_EVENT_NOTE_READ_SQL = `
    SELECT notes.id, notes.event_id, notes.content, notes.color, notes.x, notes.y
    FROM public.notes
    JOIN public.events ON events.id = notes.event_id
    WHERE events.owner_id = public.worker_app_user_id()
`;

function serializeDate(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new TypeError("Legacy event contains an invalid date");
    }
    return value.toISOString().replace(".000Z", "+00:00").replace(/Z$/, "+00:00");
}

export function serializeLegacyEventRows(eventRows, noteRows) {
    const notesByEvent = new Map();
    for (const row of noteRows) {
        const notes = notesByEvent.get(row.event_id) || [];
        notes.push({
            id: row.id,
            content: row.content,
            color: row.color,
            x: row.x,
            y: row.y,
        });
        notesByEvent.set(row.event_id, notes);
    }

    return eventRows.map((row) => {
        const notes = notesByEvent.get(row.id) || [];
        return {
            id: String(row.id),
            title: row.title,
            start: serializeDate(row.start_time),
            end: serializeDate(row.end_time),
            hasNote: notes.length > 0,
            notes,
            extendedProps: {
                description: row.description,
                status: row.status,
                source: row.source,
            },
        };
    });
}

export async function executeLegacyEventRead(adapter, userId) {
    return adapter.runWithIdentity(userId, async (client) => {
        const [events, notes] = await Promise.all([
            client.query(LEGACY_EVENT_READ_SQL),
            client.query(LEGACY_EVENT_NOTE_READ_SQL),
        ]);
        return serializeLegacyEventRows(events.rows, notes.rows);
    });
}