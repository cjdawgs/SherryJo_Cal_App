export const CURRENT_USER_READ_SQL = `
    SELECT id, email, role
    FROM public.users
    WHERE id = public.worker_app_user_id()
    LIMIT 1
`;

export class CurrentUserNotFoundError extends Error {}

export async function executeCurrentUserRead(adapter, userId) {
    const result = await adapter.runWithIdentity(
        userId,
        (client) => client.query(CURRENT_USER_READ_SQL),
    );
    if (!result.rows.length) throw new CurrentUserNotFoundError("authenticated user does not exist");
    const row = result.rows[0];
    return { id: row.id, email: row.email, role: row.role };
}