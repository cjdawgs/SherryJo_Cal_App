async function deleteOperationKey(userId, targetKey, providerEventId) {
    const value = `${userId}:${targetKey}:${providerEventId}`;
    const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
    const digest = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
    return `calendar-publish-delete:${digest}`;
}

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

    async queuePublishTarget(userId, eventId, targetKey) {
        const operationKey = `calendar-publish:user:${userId}:event:${eventId}:target:${targetKey}`;
        await this.baseAdapter.runWithIdentity(userId, (client) => client.query(`
            INSERT INTO public.sync_operation_ledger
                (id, operation_key, operation_type, owner_user_id, status, attempt_count,
                 request_payload, created_at, updated_at)
            VALUES ($1, $2, 'calendar_publish', public.worker_app_user_id(), 'pending', 0,
                    $3::jsonb, now(), now())
            ON CONFLICT (operation_key) DO UPDATE SET
                status = 'pending',
                request_payload = EXCLUDED.request_payload,
                result_payload = NULL,
                error_type = NULL,
                error_message = NULL,
                finished_at = NULL,
                updated_at = now()
        `, [crypto.randomUUID(), operationKey, JSON.stringify({ event_id: eventId, target_key: targetKey })]));
    }

    async loadPendingPublishTargets(userId, targetKey) {
        return this.baseAdapter.runWithIdentity(userId, async (client) => {
            const result = await client.query(`
                SELECT operation_type, request_payload
                FROM public.sync_operation_ledger
                WHERE owner_user_id = public.worker_app_user_id()
                  AND operation_type IN ('calendar_publish', 'calendar_publish_delete')
                  AND status IN ('pending', 'retry_pending')
                  AND request_payload->>'target_key' = $1
                ORDER BY created_at, operation_key
            `, [targetKey]);
            return result.rows.map((row) => ({ operation_type: row.operation_type, ...(row.request_payload || {}) }));
        });
    }

    async queueDeleteTarget(userId, targetKey, providerEventId) {
        const operationKey = await deleteOperationKey(userId, targetKey, providerEventId);
        await this.baseAdapter.runWithIdentity(userId, (client) => client.query(`
            INSERT INTO public.sync_operation_ledger
                (id, operation_key, operation_type, owner_user_id, status, attempt_count,
                 request_payload, created_at, updated_at)
            VALUES ($1, $2, 'calendar_publish_delete', public.worker_app_user_id(), 'pending', 0,
                    $3::jsonb, now(), now())
            ON CONFLICT (operation_key) DO UPDATE SET
                status = 'pending', result_payload = NULL, error_type = NULL,
                error_message = NULL, finished_at = NULL, updated_at = now()
        `, [crypto.randomUUID(), operationKey, JSON.stringify({ target_key: targetKey, provider_event_id: providerEventId })]));
    }

    async finishDeleteTarget(userId, targetKey, providerEventId, { succeeded, error = null }) {
        const operationKey = await deleteOperationKey(userId, targetKey, providerEventId);
        await this.baseAdapter.runWithIdentity(userId, (client) => client.query(`
            UPDATE public.sync_operation_ledger
            SET status = $2, attempt_count = attempt_count + 1,
                result_payload = CASE WHEN $2 = 'succeeded' THEN '{"deleted":true}'::jsonb ELSE NULL END,
                error_type = CASE WHEN $2 = 'succeeded' THEN NULL ELSE 'ProviderDeleteError' END,
                error_message = $3, started_at = COALESCE(started_at, now()),
                finished_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE NULL END,
                updated_at = now()
                        WHERE operation_key = $1 AND owner_user_id = public.worker_app_user_id()
                            AND ($2 = 'succeeded' OR status != 'succeeded')
        `, [operationKey, succeeded ? "succeeded" : "retry_pending", succeeded ? null : String(error || "Delete failed").slice(0, 1000)]));
    }

    async finishPublishTarget(userId, eventId, targetKey, { succeeded, result = null, error = null }) {
        const operationKey = `calendar-publish:user:${userId}:event:${eventId}:target:${targetKey}`;
        await this.baseAdapter.runWithIdentity(userId, (client) => client.query(`
            UPDATE public.sync_operation_ledger
            SET status = $2,
                attempt_count = attempt_count + 1,
                result_payload = $3::jsonb,
                error_type = $4,
                error_message = $5,
                started_at = COALESCE(started_at, now()),
                finished_at = CASE WHEN $2 = 'succeeded' THEN now() ELSE NULL END,
                updated_at = now()
            WHERE operation_key = $1
              AND owner_user_id = public.worker_app_user_id()
                            AND ($2 = 'succeeded' OR status != 'succeeded')
        `, [
            operationKey,
            succeeded ? "succeeded" : "retry_pending",
            result ? JSON.stringify(result) : null,
            succeeded ? null : "ProviderPublishError",
            succeeded ? null : String(error || "Publish failed").slice(0, 1000),
        ]));
    }

    async deadLetterMissingPublishTargets(userId, eventIds) {
        if (!eventIds.length) return;
        await this.baseAdapter.runWithIdentity(userId, (client) => client.query(`
            UPDATE public.sync_operation_ledger
            SET status = 'dead_letter', error_type = 'EventNotFound',
                error_message = 'Local event no longer exists', finished_at = now(), updated_at = now()
            WHERE owner_user_id = public.worker_app_user_id()
              AND operation_type = 'calendar_publish'
              AND status IN ('pending', 'retry_pending')
              AND request_payload->>'event_id' = ANY($1::text[])
        `, [eventIds.map(String)]));
    }
}