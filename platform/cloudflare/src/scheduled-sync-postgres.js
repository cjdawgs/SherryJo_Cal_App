import { fernetDecrypt, fernetEncrypt } from "./fernet.js";

export const CLAIM_DUE_ACCOUNTS_SQL = "SELECT * FROM public.worker_claim_due_sync_accounts($1, $2)";
export const CLAIM_OWNED_ACCOUNT_SQL = `
        UPDATE public.oauth_accounts
        SET sync_claimed_until = pg_catalog.now() + pg_catalog.make_interval(secs => $2)
        WHERE id = $1
            AND user_id = public.worker_app_user_id()
            AND sync_enabled IS TRUE
            AND lower(provider) IN ('google', 'microsoft', 'apple')
            AND (sync_claimed_until IS NULL OR sync_claimed_until < pg_catalog.now())
        RETURNING id, user_id, provider, account_email, access_token, refresh_token,
                            token_expires_at, sync_token, sync_range_days, sync_frequency_minutes,
                            GREATEST(last_sync, last_sync_success, last_manual_refresh_at) AS latest_sync_marker
`;
export const RUN_SCHEDULED_MAINTENANCE_SQL = "SELECT * FROM public.worker_run_scheduled_maintenance($1)";
export const ACCOUNT_SYNC_LOCK_SQL = "SELECT pg_advisory_xact_lock($1::integer, $2::integer)";
export const BEGIN_SYNC_OPERATION_SQL = `
    INSERT INTO public.sync_operation_ledger
        (id, operation_key, operation_type, owner_user_id, status, attempt_count,
         request_payload, started_at, created_at, updated_at)
    VALUES ($1, $2, 'worker_scheduled_sync', public.worker_app_user_id(), 'running', 1,
            $3::jsonb, $4::timestamptz, $4::timestamptz, $4::timestamptz)
    ON CONFLICT (operation_key) DO UPDATE SET
        status = 'running',
        attempt_count = sync_operation_ledger.attempt_count + 1,
        request_payload = EXCLUDED.request_payload,
        started_at = EXCLUDED.started_at,
        finished_at = NULL,
        error_type = NULL,
        error_message = NULL,
        updated_at = EXCLUDED.updated_at
    WHERE sync_operation_ledger.status NOT IN ('succeeded', 'dead_letter')
    RETURNING id, attempt_count
`;
export const FIND_SYNC_EVENT_SQL = `
    SELECT id, source, external_ids
    FROM public.events
    WHERE owner_id = public.worker_app_user_id() AND "externalId" = $1
    FOR UPDATE
`;
export const INSERT_SYNC_EVENT_SQL = `
    INSERT INTO public.events
        (owner_id, title, start_time, end_time, source, "externalId", account_email,
         color, color_enabled, external_ids, status, created_at, updated_at)
    VALUES (public.worker_app_user_id(), $1, $2::timestamptz, $3::timestamptz, $4, $5,
            $6, $7, false, $8::jsonb, 'synced', $9::timestamptz, $9::timestamptz)
`;
export const UPDATE_SYNC_EVENT_SQL = `
    UPDATE public.events
    SET start_time = $2::timestamptz,
        end_time = $3::timestamptz,
        external_ids = COALESCE(external_ids, '{}'::jsonb) || $4::jsonb,
        updated_at = $5::timestamptz
    WHERE id = $1
`;
export const DELETE_SYNC_EVENT_NOTES_SQL = `
    DELETE FROM public.notes
    WHERE event_id IN (
        SELECT id FROM public.events
        WHERE owner_id = public.worker_app_user_id()
          AND "externalId" = ANY($1::text[])
          AND source <> 'local'
    )
`;
export const DELETE_SYNC_EVENTS_SQL = `
    DELETE FROM public.events
    WHERE owner_id = public.worker_app_user_id()
      AND "externalId" = ANY($1::text[])
      AND source <> 'local'
`;
export const FIND_STALE_SYNC_EVENT_IDS_SQL = `
    SELECT "externalId" AS external_id
    FROM public.events
    WHERE owner_id = public.worker_app_user_id()
      AND lower(account_email) = lower($1)
      AND lower(source) = ANY($2::text[])
      AND source <> 'local'
      AND NOT ("externalId" = ANY($3::text[]))
`;
export const COMPLETE_ACCOUNT_SYNC_SQL = `
    UPDATE public.oauth_accounts
    SET access_token = $2,
        refresh_token = COALESCE($3, refresh_token),
        token_expires_at = $4::timestamptz,
        sync_token = $5::jsonb,
        last_sync = $6::timestamptz,
        last_sync_success = $6::timestamptz,
        last_sync_failure = NULL,
        last_error = NULL,
        status = 'ok',
        sync_claimed_until = NULL,
        updated_at = $6::timestamptz
    WHERE id = $1 AND user_id = public.worker_app_user_id()
`;
export const FAIL_ACCOUNT_SYNC_SQL = `
    UPDATE public.oauth_accounts
    SET access_token = CASE WHEN $2::boolean THEN '__REAUTH_REQUIRED__' ELSE access_token END,
        last_sync_failure = $3::timestamptz,
        last_error = $4,
        status = 'error',
        sync_claimed_until = NULL,
        updated_at = $3::timestamptz
    WHERE id = $1 AND user_id = public.worker_app_user_id()
`;
export const RELEASE_ACCOUNT_CLAIM_SQL = `
    UPDATE public.oauth_accounts
    SET sync_claimed_until = NULL, updated_at = $2::timestamptz
    WHERE id = $1 AND user_id = public.worker_app_user_id()
`;
export const FINISH_SYNC_OPERATION_SQL = `
    UPDATE public.sync_operation_ledger
    SET status = $2,
        result_payload = $3::jsonb,
        error_type = $4,
        error_message = $5,
        finished_at = $6::timestamptz,
        updated_at = $6::timestamptz
    WHERE id = $1 AND owner_user_id = public.worker_app_user_id()
`;

const PROVIDER_COLORS = { google: "#1f9d55", microsoft: "#1d4ed8", apple: "#ef4444" };

function providerAliases(provider) {
    if (provider === "microsoft") return ["microsoft", "outlook", "office365", "ms", "msft"];
    if (provider === "apple") return ["apple", "icloud", "caldav"];
    return ["google", "gmail"];
}

function externalId(account, rawId) {
    return `${account.provider}:${String(account.account_email || "").trim().toLowerCase()}:${rawId}`;
}

export class ScheduledSyncPostgresAdapter {
    constructor({ createClient, connectionString }) {
        if (typeof createClient !== "function") throw new TypeError("createClient is required");
        if (!connectionString) throw new TypeError("Hyperdrive connection string is required");
        this.createClient = createClient;
        this.connectionString = connectionString;
    }

    async runTransaction(operation, userId = null) {
        const client = this.createClient({ connectionString: this.connectionString });
        let started = false;
        try {
            await client.connect();
            await client.query("BEGIN");
            started = true;
            if (userId !== null) await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
            const result = await operation(client);
            await client.query("COMMIT");
            started = false;
            return result;
        } catch (error) {
            if (started) {
                try { await client.query("ROLLBACK"); } catch { /* Preserve the original error. */ }
            }
            throw error;
        } finally {
            await client.end();
        }
    }

    async claimDueAccounts(limit = 10, claimSeconds = 240) {
        return this.runTransaction(async (client) => {
            const result = await client.query(CLAIM_DUE_ACCOUNTS_SQL, [limit, claimSeconds]);
            return result.rows;
        });
    }

    async claimOwnedAccount(userId, accountId, claimSeconds = 240) {
        return this.runTransaction(async (client) => {
            const result = await client.query(CLAIM_OWNED_ACCOUNT_SQL, [accountId, Math.min(Math.max(claimSeconds, 30), 900)]);
            return result.rows[0] || null;
        }, userId);
    }

    async runMaintenance(retentionDays = 14) {
        return this.runTransaction(async (client) => {
            const result = await client.query(RUN_SCHEDULED_MAINTENANCE_SQL, [retentionDays]);
            return result.rows[0] || { deleted_diag_rows: 0, changes: 0, no_changes: 0, total_cycles: 0 };
        });
    }

    async decryptClaim(account, tokenEncryptionKey) {
        return {
            ...account,
            access_token: await fernetDecrypt(account.access_token, tokenEncryptionKey),
            refresh_token: await fernetDecrypt(account.refresh_token, tokenEncryptionKey),
        };
    }

    async beginAccountSync(account, operationId, operationKey, now = new Date()) {
        return this.runTransaction(async (client) => {
            await client.query(ACCOUNT_SYNC_LOCK_SQL, [account.user_id, account.id]);
            const result = await client.query(BEGIN_SYNC_OPERATION_SQL, [
                operationId,
                operationKey,
                JSON.stringify({ account_id: account.id, provider: account.provider }),
                now.toISOString(),
            ]);
            return result.rows[0] || null;
        }, account.user_id);
    }

    async applyAccountSync(account, providerResult, tokenResult, tokenEncryptionKey, operationId, now = new Date()) {
        return this.runTransaction(async (client) => {
            await client.query(ACCOUNT_SYNC_LOCK_SQL, [account.user_id, account.id]);
            let created = 0;
            let updated = 0;
            const incomingIds = [];
            for (const event of providerResult.events) {
                const canonicalExternalId = externalId(account, event.externalId);
                incomingIds.push(canonicalExternalId);
                const accountKey = `${account.provider}:${String(account.account_email).trim().toLowerCase()}`;
                const linkedIds = JSON.stringify({ [accountKey]: event.externalId });
                const existing = await client.query(FIND_SYNC_EVENT_SQL, [canonicalExternalId]);
                if (existing.rows.length) {
                    await client.query(UPDATE_SYNC_EVENT_SQL, [
                        existing.rows[0].id, event.start, event.end, linkedIds, now.toISOString(),
                    ]);
                    updated += 1;
                } else {
                    await client.query(INSERT_SYNC_EVENT_SQL, [
                        event.title, event.start, event.end, account.provider, canonicalExternalId,
                        account.account_email, PROVIDER_COLORS[account.provider] || null, linkedIds, now.toISOString(),
                    ]);
                    created += 1;
                }
            }

            let deletedIds = providerResult.cancelledIds.map((id) => externalId(account, id));
            if (!providerResult.incremental) {
                const stale = await client.query(FIND_STALE_SYNC_EVENT_IDS_SQL, [
                    account.account_email,
                    providerAliases(account.provider),
                    incomingIds,
                ]);
                deletedIds = [...new Set([...deletedIds, ...stale.rows.map((row) => row.external_id)])];
            }
            if (deletedIds.length) {
                await client.query(DELETE_SYNC_EVENT_NOTES_SQL, [deletedIds]);
                await client.query(DELETE_SYNC_EVENTS_SQL, [deletedIds]);
            }

            const encryptedAccess = await fernetEncrypt(tokenResult.accessToken, tokenEncryptionKey);
            const encryptedRefresh = tokenResult.refreshToken
                ? await fernetEncrypt(tokenResult.refreshToken, tokenEncryptionKey)
                : null;
            await client.query(COMPLETE_ACCOUNT_SYNC_SQL, [
                account.id,
                encryptedAccess,
                encryptedRefresh,
                tokenResult.expiresAt.toISOString(),
                JSON.stringify(providerResult.syncToken || {}),
                now.toISOString(),
            ]);
            const resultPayload = { created, updated, deleted: deletedIds.length };
            await client.query(FINISH_SYNC_OPERATION_SQL, [
                operationId, "succeeded", JSON.stringify(resultPayload), null, null, now.toISOString(),
            ]);
            return resultPayload;
        }, account.user_id);
    }

    async failAccountSync(account, operationId, error, reauthRequired, attemptCount, now = new Date()) {
        return this.runTransaction(async (client) => {
            await client.query(FAIL_ACCOUNT_SYNC_SQL, [
                account.id, reauthRequired, now.toISOString(), String(error?.message || error).slice(0, 1000),
            ]);
            await client.query(FINISH_SYNC_OPERATION_SQL, [
                operationId,
                Number(attemptCount || 1) >= 3 ? "dead_letter" : "retry_pending",
                null,
                error?.name || "Error",
                String(error?.message || error).slice(0, 1000),
                now.toISOString(),
            ]);
        }, account.user_id);
    }

    async releaseAccountClaim(account, now = new Date()) {
        return this.runTransaction(
            (client) => client.query(RELEASE_ACCOUNT_CLAIM_SQL, [account.id, now.toISOString()]),
            account.user_id,
        );
    }
}