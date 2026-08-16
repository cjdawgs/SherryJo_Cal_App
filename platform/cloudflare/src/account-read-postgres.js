import { fernetDecrypt } from "./fernet.js";

export const ACCOUNT_READ_SQL = `
    SELECT id, provider, account_email, access_token, refresh_token, token_expires_at,
           display_name, provider_id, is_primary, sync_enabled, color,
           sync_frequency_minutes, sync_range_days, last_manual_refresh_at,
           last_sync, last_sync_success, last_sync_failure, last_error, status,
           created_at, updated_at
    FROM public.oauth_accounts
    WHERE user_id = public.worker_app_user_id()
    ORDER BY provider, account_email, id
`;

export const SYNC_ROLLUP_READ_SQL = `
    SELECT snapshot_date, week_start_date, changes, no_changes, total_cycles,
           change_ratio, no_change_ratio, google_cache_hits, google_cache_misses,
           google_cache_total_lookups, google_cache_hit_ratio, google_cache_entries, updated_at
    FROM public.sync_efficiency_daily_rollups
    WHERE snapshot_date >= $1::date
    ORDER BY snapshot_date ASC
`;

const PROVIDER_COLORS = {
    google: "#34a853", microsoft: "#2563eb", apple: "#ef4444",
    local: "#7ca3af", other: "#999999",
};

function iso(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    return String(value);
}

function provider(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (["gmail", "google"].includes(normalized)) return "google";
    if (["outlook", "office365", "ms", "msft", "microsoft"].includes(normalized)) return "microsoft";
    if (["icloud", "caldav", "apple"].includes(normalized)) return "apple";
    return normalized || "other";
}

function issue(code, message, action = "none", label = "", extra = {}) {
    return {
        code, message, requires_admin: false, user_remediable: true,
        recommended_action: action, recommended_label: label, ...extra,
    };
}

function tokenIssue(row, accessToken, decryptError) {
    if (decryptError) {
        return {
            ...issue("app_key_error", "Saved credentials cannot be read because of an app encryption-key issue.", "open_accounts", "Open Accounts"),
            requires_admin: true, user_remediable: false,
        };
    }
    if (accessToken === "__REAUTH_REQUIRED__") {
        return issue("token_expired_or_invalid", "Connection expired or token is invalid. Reconnect this account.", "reconnect", "Reconnect");
    }
    if (!accessToken && !row.refresh_token) {
        return issue("token_never_connected", "No credential has been saved for this account yet. Connect this account to create one.", "open_accounts", "Open Accounts");
    }
    if (row.token_expires_at && new Date(row.token_expires_at).getTime() < Date.now()) {
        return issue("token_expired_or_invalid", "Token is expired. Reconnect this account.", "reconnect", "Reconnect");
    }
    const lastError = String(row.last_error || "").toLowerCase();
    if (row.status === "error") {
        if (["expired", "invalid", "revoked", "invalid_grant", "reauth", "no valid token"].some((flag) => lastError.includes(flag))) {
            return issue("token_expired_or_invalid", "Connection expired or token is invalid. Reconnect this account.", "reconnect", "Reconnect");
        }
        return issue("sync_error", "Sync failed for this account. Retry sync from Account Manager.", "retry_sync", "Retry Sync");
    }
    return issue("none", "");
}

async function serializeAccount(row, tokenEncryptionKey) {
    let accessToken = row.access_token || "";
    let decryptError = false;
    try {
        accessToken = await fernetDecrypt(accessToken, tokenEncryptionKey || "");
    } catch {
        decryptError = true;
        accessToken = "";
    }
    const normalizedProvider = provider(row.provider);
    const status = decryptError || accessToken === "__REAUTH_REQUIRED__" || row.last_sync_failure || row.status === "error"
        ? "error" : "ok";
    const frequency = Math.max(1, Number(row.sync_frequency_minutes || 5));
    return {
        id: row.id, provider: row.provider, account_email: row.account_email,
        sync_enabled: Boolean(row.sync_enabled), status,
        last_sync: iso(row.last_sync), last_sync_success: iso(row.last_sync_success),
        last_sync_failure: iso(row.last_sync_failure), last_error: row.last_error || null,
        sync_frequency_minutes: normalizedProvider === "apple" ? Math.max(240, frequency) : frequency,
        sync_range_days: Number(row.sync_range_days || 30),
        last_manual_refresh_at: iso(row.last_manual_refresh_at),
        credential_state: {
            encrypted_at_rest: String(row.access_token || "").startsWith("v1:"),
            decrypt_error: decryptError,
            warning: decryptError ? { code: "token_decrypt_failed", message: "Saved credentials could not be decrypted." } : null,
        },
        token_issue: tokenIssue(row, accessToken, decryptError),
        display_name: row.display_name || null, provider_id: row.provider_id || null,
        is_primary: Boolean(row.is_primary), color: row.color || PROVIDER_COLORS[normalizedProvider] || PROVIDER_COLORS.other,
        created_at: iso(row.created_at), updated_at: iso(row.updated_at),
    };
}

export async function executeAccountRead(adapter, { userId, tokenEncryptionKey }) {
    const result = await adapter.runWithIdentity(userId, (client) => client.query(ACCOUNT_READ_SQL));
    return Promise.all(result.rows.map((row) => serializeAccount(row, tokenEncryptionKey)));
}

export async function executeSyncRollupRead(adapter, { userId, days, now = new Date() }) {
    const safeDays = Number(days) === 28 ? 28 : 7;
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const start = new Date(today); start.setUTCDate(start.getUTCDate() - safeDays + 1);
    const result = await adapter.runWithIdentity(userId, (client) => client.query(SYNC_ROLLUP_READ_SQL, [start.toISOString().slice(0, 10)]));
    const rows = result.rows.map((row) => ({
        ...row,
        snapshot_date: iso(row.snapshot_date)?.slice(0, 10), week_start_date: iso(row.week_start_date)?.slice(0, 10),
        changes: Number(row.changes || 0), no_changes: Number(row.no_changes || 0), total_cycles: Number(row.total_cycles || 0),
        google_cache_hits: Number(row.google_cache_hits || 0), google_cache_misses: Number(row.google_cache_misses || 0),
        google_cache_total_lookups: Number(row.google_cache_total_lookups || 0), google_cache_entries: Number(row.google_cache_entries || 0),
        updated_at: iso(row.updated_at),
    }));
    const day = today.getUTCDay();
    const weekStart = new Date(today); weekStart.setUTCDate(today.getUTCDate() - (day === 0 ? 6 : day - 1));
    const weekStartText = weekStart.toISOString().slice(0, 10);
    const currentRows = rows.filter((row) => row.week_start_date === weekStartText);
    const average = (key) => {
        const values = currentRows.map((row) => row[key]).filter((value) => typeof value === "number");
        return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    };
    return {
        days: safeDays, start_date: start.toISOString().slice(0, 10), end_date: today.toISOString().slice(0, 10), rows,
        current_week: {
            week_start_date: weekStartText, days_present: currentRows.length,
            avg_no_change_ratio: average("no_change_ratio"),
            avg_google_cache_hit_ratio: average("google_cache_hit_ratio"), rows: currentRows,
        },
    };
}