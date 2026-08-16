export class CalendarPublishPostgresAdapter {
    constructor(baseAdapter) { this.baseAdapter = baseAdapter; }

    async loadPublishData(userId, eventIds) {
        return this.baseAdapter.runWithIdentity(userId, async (client) => {
            const events = await client.query(`
                SELECT id, title, description, start_time, end_time, external_ids
                FROM public.events
                WHERE owner_id = public.worker_app_user_id()
                  AND ($1::integer[] IS NULL OR id = ANY($1::integer[]))
                  AND ($1::integer[] IS NOT NULL OR external_ids IS NOT NULL)
                ORDER BY id
            `, [eventIds]);
            const accounts = await client.query(`
                SELECT id, provider, account_email, access_token, refresh_token, token_expires_at
                FROM public.oauth_accounts
                WHERE user_id = public.worker_app_user_id() AND sync_enabled IS TRUE
            `);
            return { events: events.rows, accounts: accounts.rows };
        });
    }

    async updateEventLinks(userId, eventId, externalIds) {
        await this.baseAdapter.runWithIdentity(userId, (client) => client.query(`
            UPDATE public.events SET external_ids = $2::jsonb, updated_at = now()
            WHERE id = $1 AND owner_id = public.worker_app_user_id()
        `, [eventId, JSON.stringify(externalIds)]));
    }

    async updateAccountToken(userId, accountId, token) {
        await this.baseAdapter.runWithIdentity(userId, (client) => client.query(`
            UPDATE public.oauth_accounts
            SET access_token = $2, refresh_token = $3, token_expires_at = $4, updated_at = now()
            WHERE id = $1 AND user_id = public.worker_app_user_id()
        `, [accountId, token.accessToken, token.refreshToken, token.expiresAt]));
    }
}