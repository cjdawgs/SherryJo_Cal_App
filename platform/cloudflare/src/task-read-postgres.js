export const TASK_READ_SQL = `
    SELECT
        id,
        title,
        description,
        completed,
        owner_id,
        created_at
    FROM public.tasks
    WHERE owner_id = public.worker_app_user_id()
`;

function serializeDate(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === "string") return value;
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        throw new TypeError("Task contains an invalid created_at value");
    }
    return value.toISOString().replace(".000Z", "+00:00");
}

export function serializeTaskRows(rows) {
    return rows.map((row) => ({
        title: row.title,
        description: row.description,
        completed: Boolean(row.completed),
        owner_id: row.owner_id,
        id: row.id,
        created_at: serializeDate(row.created_at),
    }));
}

export async function executeTaskRead(adapter, userId) {
    const result = await adapter.runWithIdentity(
        userId,
        (client) => client.query(TASK_READ_SQL),
    );
    return serializeTaskRows(result.rows);
}