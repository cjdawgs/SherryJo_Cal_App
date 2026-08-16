export class AccountNotFoundError extends Error {}

function accountView(row) {
    return {
        id: row.id,
        provider: row.provider,
        account_email: row.account_email,
    };
}

async function requireRow(result) {
    if (!result.rows.length) throw new AccountNotFoundError("Account not found");
    return result.rows[0];
}

export async function executeAccountSettingsUpdate(adapter, { userId, accountId, data }) {
    const frequency = data.sync_frequency_minutes === undefined || data.sync_frequency_minutes === null
        ? null : Math.max(1, Math.min(Number(data.sync_frequency_minutes), 1440));
    const rangeDays = data.sync_range_days === undefined || data.sync_range_days === null
        ? null : Math.max(1, Math.min(Number(data.sync_range_days), 3650));
    const enabled = data.sync_enabled === undefined || data.sync_enabled === null ? null : Boolean(data.sync_enabled);
    if ((frequency !== null && !Number.isInteger(frequency)) || (rangeDays !== null && !Number.isInteger(rangeDays))) {
        throw new TypeError("Sync settings must be integers");
    }
    const result = await adapter.runWithIdentity(userId, (client) => client.query(`
        UPDATE public.oauth_accounts
        SET sync_frequency_minutes = CASE
                WHEN $2::integer IS NULL THEN sync_frequency_minutes
                WHEN lower(provider) = 'apple' THEN GREATEST($2, 240)
                ELSE $2
            END,
            sync_range_days = COALESCE($3::integer, sync_range_days),
            sync_enabled = COALESCE($4::boolean, sync_enabled)
        WHERE id = $1 AND user_id = public.worker_app_user_id()
        RETURNING id, provider, account_email, sync_enabled, sync_frequency_minutes, sync_range_days
    `, [accountId, frequency, rangeDays, enabled]));
    return requireRow(result);
}

export async function executeAccountColorUpdate(adapter, { userId, accountId, color }) {
    const normalized = String(color || "").trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(normalized)) throw new TypeError("Color must be a 6-digit hex value like #34a853");
    const row = await requireRow(await adapter.runWithIdentity(userId, (client) => client.query(`
        UPDATE public.oauth_accounts SET color = $2
        WHERE id = $1 AND user_id = public.worker_app_user_id()
        RETURNING id, provider, account_email, color
    `, [accountId, normalized])));
    return { ...accountView(row), color: row.color };
}

export async function executeAccountPrimaryUpdate(adapter, { userId, accountId }) {
    return adapter.runWithIdentity(userId, async (client) => {
        const target = await requireRow(await client.query(`
            SELECT id, provider, account_email FROM public.oauth_accounts
            WHERE id = $1 AND user_id = public.worker_app_user_id()
            FOR UPDATE
        `, [accountId]));
        await client.query(`
            UPDATE public.oauth_accounts SET is_primary = (id = $1)
            WHERE lower(provider) = lower($2) AND user_id = public.worker_app_user_id()
        `, [accountId, target.provider]);
        return { ...accountView(target), is_primary: true };
    });
}

export async function executeAccountSyncToggle(adapter, { userId, accountId, enabled }) {
    const row = await requireRow(await adapter.runWithIdentity(userId, (client) => client.query(`
        UPDATE public.oauth_accounts SET sync_enabled = $2
        WHERE id = $1 AND user_id = public.worker_app_user_id()
        RETURNING id, provider, account_email, sync_enabled
    `, [accountId, enabled])));
    return { ...accountView(row), sync_enabled: Boolean(row.sync_enabled) };
}

export async function executeAccountDelete(adapter, { userId, accountId }) {
    const row = await requireRow(await adapter.runWithIdentity(userId, (client) => client.query(`
        DELETE FROM public.oauth_accounts
        WHERE id = $1 AND user_id = public.worker_app_user_id()
        RETURNING id, provider, account_email
    `, [accountId])));
    return { message: `Disconnected ${row.provider} account: ${row.account_email}`, deleted_id: row.id };
}