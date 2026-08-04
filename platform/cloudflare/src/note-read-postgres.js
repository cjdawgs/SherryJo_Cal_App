export const NOTE_READ_SQL = `
    SELECT
        notes.id,
        notes.date,
        notes.content,
        notes.color,
        notes.x,
        notes.y,
        notes.event_id
    FROM public.notes
    JOIN public.events ON events.id = notes.event_id
    WHERE notes.date = $1
      AND events.owner_id = public.worker_app_user_id()
`;

export function serializeNoteRows(rows) {
    return rows.map((row) => ({
        id: row.id,
        date: row.date,
        content: row.content,
        color: row.color,
        x: row.x,
        y: row.y,
        event_id: row.event_id,
    }));
}

export async function executeNoteRead(adapter, { userId, date }) {
    if (!date) throw new TypeError("date is required");
    const result = await adapter.runWithIdentity(
        userId,
        (client) => client.query(NOTE_READ_SQL, [date]),
    );
    return serializeNoteRows(result.rows);
}