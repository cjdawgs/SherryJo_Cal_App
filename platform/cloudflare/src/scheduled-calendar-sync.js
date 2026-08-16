import { Client } from "pg";

import {
    ensureProviderAccessToken,
    fetchAppleChanges,
    fetchGoogleChanges,
    fetchMicrosoftChanges,
    ProviderAuthorizationError,
} from "./provider-calendar-sync.js";
import { ScheduledSyncPostgresAdapter } from "./scheduled-sync-postgres.js";

const HYPERDRIVE_BINDING = "HYPERDRIVE_RLS_NO_CACHE";

function positiveInteger(value, fallback, maximum) {
    const parsed = Number.parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(parsed, maximum);
}

function schedulerEnabled(env) {
    return String(env.SCHEDULED_SYNC_ENABLED || "false").trim().toLowerCase() === "true";
}

function operationKey(account) {
    const marker = account.latest_sync_marker ? new Date(account.latest_sync_marker) : null;
    const anchor = marker && !Number.isNaN(marker.getTime())
        ? Math.floor(marker.getTime() / 1000)
        : "bootstrap";
    return `worker-sync:account:${account.id}:anchor:${anchor}`;
}

export function createScheduledSyncAdapter(env, ClientClass = Client) {
    const hyperdrive = env?.[HYPERDRIVE_BINDING];
    if (!hyperdrive?.connectionString) throw new Error(`${HYPERDRIVE_BINDING} is not configured`);
    return new ScheduledSyncPostgresAdapter({
        createClient: (options) => new ClientClass(options),
        connectionString: hyperdrive.connectionString,
    });
}

export async function syncClaimedAccount(account, env, dependencies, now) {
    const { adapter, fetchImpl, uuid } = dependencies;
    const operationId = uuid();
    const ledger = await adapter.beginAccountSync(account, operationId, operationKey(account), now);
    if (!ledger) {
        await adapter.releaseAccountClaim(account, now);
        return { accountId: account.id, status: "skipped_terminal" };
    }

    try {
        const decrypted = await adapter.decryptClaim(account, env.TOKEN_ENCRYPTION_KEY);
        const tokenResult = account.provider === "apple"
            ? {
                accessToken: decrypted.access_token,
                refreshToken: decrypted.refresh_token,
                expiresAt: decrypted.token_expires_at ? new Date(decrypted.token_expires_at) : new Date("2100-01-01T00:00:00Z"),
                refreshed: false,
            }
            : await ensureProviderAccessToken(decrypted, env, fetchImpl, now);
        const rangeDays = positiveInteger(account.sync_range_days, 30, 365);
        const start = new Date(now.getTime() - rangeDays * 86400000);
        const end = new Date(now.getTime() + rangeDays * 86400000);
        let providerResult;
        if (account.provider === "google") {
            providerResult = await fetchGoogleChanges({ account: decrypted, accessToken: tokenResult.accessToken, start, end, fetchImpl });
        } else if (account.provider === "microsoft") {
            providerResult = await fetchMicrosoftChanges({ account: decrypted, accessToken: tokenResult.accessToken, start, end, fetchImpl });
        } else if (account.provider === "apple") {
            providerResult = await fetchAppleChanges({ account: decrypted, start, end, fetchImpl });
        } else {
            throw new TypeError(`Unsupported scheduled sync provider: ${account.provider}`);
        }
        const result = await adapter.applyAccountSync(
            account,
            providerResult,
            tokenResult,
            env.TOKEN_ENCRYPTION_KEY,
            ledger.id,
            now,
        );
        return { accountId: account.id, provider: account.provider, status: "succeeded", ...result };
    } catch (error) {
        const reauthRequired = error instanceof ProviderAuthorizationError;
        await adapter.failAccountSync(account, ledger.id, error, reauthRequired, ledger.attempt_count, now);
        return {
            accountId: account.id,
            provider: account.provider,
            status: reauthRequired ? "reauth_required" : "failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
        };
    }
}

export async function runAccountSyncNow(env, userId, accountId, overrides = {}) {
    const now = overrides.now || new Date();
    const dependencies = {
        adapter: overrides.adapter || createScheduledSyncAdapter(env),
        fetchImpl: overrides.fetchImpl || fetch,
        uuid: overrides.uuid || (() => crypto.randomUUID()),
    };
    const claimSeconds = positiveInteger(env.SCHEDULED_SYNC_CLAIM_SECONDS, 240, 900);
    const account = await dependencies.adapter.claimOwnedAccount(userId, accountId, claimSeconds);
    if (!account) return { accountId, status: "not_available" };
    return syncClaimedAccount(account, env, dependencies, now);
}

export async function runScheduledCalendarSync(env, overrides = {}) {
    if (!schedulerEnabled(env)) return { status: "disabled", claimed: 0, results: [] };

    const now = overrides.now || new Date();
    const dependencies = {
        adapter: overrides.adapter || createScheduledSyncAdapter(env),
        fetchImpl: overrides.fetchImpl || fetch,
        uuid: overrides.uuid || (() => crypto.randomUUID()),
    };
    const batchSize = positiveInteger(env.SCHEDULED_SYNC_BATCH_SIZE, 10, 50);
    const claimSeconds = positiveInteger(env.SCHEDULED_SYNC_CLAIM_SECONDS, 240, 900);
    const accounts = await dependencies.adapter.claimDueAccounts(batchSize, claimSeconds);
    const results = [];
    for (const account of accounts) {
        results.push(await syncClaimedAccount(account, env, dependencies, now));
    }
    const maintenance = await dependencies.adapter.runMaintenance(
        positiveInteger(env.TV_DIAG_RETENTION_DAYS, 14, 365),
    );
    const summary = {
        status: "completed",
        claimed: accounts.length,
        succeeded: results.filter((result) => result.status === "succeeded").length,
        failed: results.filter((result) => ["failed", "reauth_required"].includes(result.status)).length,
        maintenance,
        results,
    };
    console.log(JSON.stringify({ event: "scheduled_calendar_sync", ...summary }));
    return summary;
}