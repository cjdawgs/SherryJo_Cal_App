import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "pg";

import { executeAccountSettingsUpdate } from "../src/account-mutate-postgres.js";
import { BEGIN_SYNC_OPERATION_SQL, COMPLETE_ACCOUNT_SYNC_SQL } from "../src/scheduled-sync-postgres.js";

const connectionString = process.env.TEST_SYNC_POSTGRES_URL;

test("sync completion and range changes work with json and jsonb cursor columns", { skip: !connectionString }, async () => {
    const client = new Client({ connectionString });
    await client.connect();
    try {
        await client.query("BEGIN");
        await client.query("CREATE FUNCTION public.worker_app_user_id() RETURNS integer LANGUAGE sql AS 'SELECT 42'");
        for (const type of ["json", "jsonb"]) {
            await client.query(`CREATE TABLE public.oauth_accounts (
                id integer PRIMARY KEY, user_id integer, provider text, account_email text,
                access_token text, refresh_token text, token_expires_at timestamptz,
                sync_token ${type}, sync_frequency_minutes integer, sync_range_days integer,
                sync_enabled boolean, last_sync timestamptz, last_sync_success timestamptz,
                last_sync_failure timestamptz, last_error text, status text,
                sync_claimed_until timestamptz, updated_at timestamptz
            )`);
            await client.query(`INSERT INTO public.oauth_accounts
                (id, user_id, provider, account_email, sync_token, sync_frequency_minutes, sync_range_days,
                 sync_enabled, status, last_error, last_sync_failure)
                VALUES (1, 42, 'google', 'test@example.com', '{"_range_generation":"old","cursor":"old"}',
                        240, 30, true, 'error', 'sync failure', now())`);
            const params = [1, "access", null, "2026-01-01T00:00:00Z",
                '{"_range_generation":"old","cursor":"new"}', "2026-01-01T00:00:00Z", "old"];
            await client.query(COMPLETE_ACCOUNT_SYNC_SQL, params);
            let row = (await client.query("SELECT sync_token, status, last_error, last_sync_failure FROM public.oauth_accounts WHERE id=1")).rows[0];
            assert.equal(row.sync_token.cursor, "new", type);
            assert.equal(row.status, "ok", type);
            assert.equal(row.last_error, null, type);
            assert.equal(row.last_sync_failure, null, type);

            const adapter = { runWithIdentity: (_userId, operation) => operation(client) };
            await executeAccountSettingsUpdate(adapter, { userId: 42, accountId: 1, data: { sync_enabled: true } });
            row = (await client.query("SELECT sync_token FROM public.oauth_accounts WHERE id=1")).rows[0];
            assert.equal(row.sync_token.cursor, "new", type);
            await executeAccountSettingsUpdate(adapter, { userId: 42, accountId: 1, data: { sync_range_days: 60 } });
            row = (await client.query("SELECT sync_token, sync_range_days FROM public.oauth_accounts WHERE id=1")).rows[0];
            assert.equal(row.sync_range_days, 60, type);
            assert.ok(row.sync_token._range_generation, type);
            assert.equal(row.sync_token.cursor, undefined, type);

            await client.query(COMPLETE_ACCOUNT_SYNC_SQL, params);
            const afterStaleSync = (await client.query("SELECT sync_token FROM public.oauth_accounts WHERE id=1")).rows[0];
            assert.deepEqual(afterStaleSync.sync_token, row.sync_token, type);
            await client.query("DROP TABLE public.oauth_accounts");
        }
        await client.query(`CREATE TABLE public.sync_operation_ledger (
            id text PRIMARY KEY, operation_key text UNIQUE, operation_type text, owner_user_id integer,
            status text, attempt_count integer, request_payload jsonb, started_at timestamptz,
            finished_at timestamptz, created_at timestamptz, updated_at timestamptz,
            error_type text, error_message text
        )`);
        await client.query(`INSERT INTO public.sync_operation_ledger (id, operation_key, status)
            VALUES ('old-operation', 'worker-sync:account:1:anchor:bootstrap', 'dead_letter')`);
        const now = "2026-01-01T00:00:00Z";
        const blocked = await client.query(BEGIN_SYNC_OPERATION_SQL,
            ["scheduled-operation", "worker-sync:account:1:anchor:bootstrap", "{}", now]);
        assert.equal(blocked.rows.length, 0);
        const retry = await client.query(BEGIN_SYNC_OPERATION_SQL,
            ["manual-operation", "worker-sync:manual:account:1:manual-operation", "{}", now]);
        assert.equal(retry.rows[0].attempt_count, 1);
    } finally {
        await client.query("ROLLBACK");
        await client.end();
    }
});
