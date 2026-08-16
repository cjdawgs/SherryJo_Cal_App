import { hashPassword } from "./native-auth.js";

const MANAGED_TABLES = new Set(["users", "oauth_accounts", "events", "notes", "tasks", "date_sticky_notes", "tv_diag_log"]);
const REDACTED = new Set(["access_token", "refresh_token", "hashed_password", "password", "sync_token", "google_access_token", "google_refresh_token", "ms_access_token", "ms_refresh_token"]);

function response(body, status = 200) {
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

function iso(value) { return value instanceof Date ? value.toISOString() : value || null; }
function integer(value) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null; }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }
function validColor(value) { return value == null || value === "" || /^#[0-9a-f]{6}$/i.test(value); }

function serializeUser(row) {
    return { id: row.id, email: row.email, username: row.username, role: row.role, created_at: iso(row.created_at) };
}

function serializeProvider(row) {
    return {
        id: row.id, provider_name: row.display_name || row.provider, contact_email: row.account_email,
        status: row.sync_enabled ? "active" : "inactive", created_at: iso(row.created_at),
        metadata: { provider: row.provider, provider_id: row.provider_id, display_name: row.display_name, sync_enabled: row.sync_enabled, is_primary: row.is_primary, health_status: row.status || "ok", last_error: row.last_error, color: row.color, user_id: row.user_id, owner_email: row.owner_email, is_service_provider: Boolean(row.is_service_provider), updated_at: iso(row.updated_at) },
    };
}

async function related(client, kind, id) {
    if (kind === "users") {
        const result = await client.query(`SELECT
            (SELECT count(*)::int FROM oauth_accounts WHERE user_id=$1) providers,
            (SELECT count(*)::int FROM events WHERE owner_id=$1) events,
            (SELECT count(*)::int FROM notes n JOIN events e ON e.id=n.event_id WHERE e.owner_id=$1) notes,
            (SELECT count(*)::int FROM tasks WHERE owner_id=$1) tasks,
            (SELECT count(*)::int FROM date_sticky_notes WHERE owner_id=$1) date_sticky_notes`, [id]);
        return result.rows[0];
    }
    const provider = (await client.query("SELECT provider, account_email FROM oauth_accounts WHERE id=$1", [id])).rows[0];
    if (!provider) return null;
    const aliases = provider.provider === "google" ? ["google", "gmail"] : provider.provider === "microsoft" ? ["microsoft", "outlook", "office365", "ms", "msft"] : [provider.provider];
    return (await client.query(`SELECT count(*)::int events,
        (SELECT count(*)::int FROM notes n JOIN events e ON e.id=n.event_id WHERE lower(e.account_email)=lower($1) AND e.source=ANY($2)) notes
        FROM events WHERE lower(account_email)=lower($1) AND source=ANY($2)`, [provider.account_email, aliases])).rows[0];
}

async function purgeRelated(client, kind, id) {
    if (kind === "users") {
        const notes = await client.query("DELETE FROM notes USING events WHERE notes.event_id=events.id AND events.owner_id=$1", [id]);
        const events = await client.query("DELETE FROM events WHERE owner_id=$1", [id]);
        const tasks = await client.query("DELETE FROM tasks WHERE owner_id=$1", [id]);
        const sticky = await client.query("DELETE FROM date_sticky_notes WHERE owner_id=$1", [id]);
        return { notes: notes.rowCount, events: events.rowCount, tasks: tasks.rowCount, date_sticky_notes: sticky.rowCount };
    }
    const provider = (await client.query("SELECT provider, account_email FROM oauth_accounts WHERE id=$1", [id])).rows[0];
    if (!provider) return null;
    const aliases = provider.provider === "google" ? ["google", "gmail"] : provider.provider === "microsoft" ? ["microsoft", "outlook", "office365", "ms", "msft"] : [provider.provider];
    const notes = await client.query("DELETE FROM notes USING events WHERE notes.event_id=events.id AND lower(events.account_email)=lower($1) AND events.source=ANY($2)", [provider.account_email, aliases]);
    const events = await client.query("DELETE FROM events WHERE lower(account_email)=lower($1) AND source=ANY($2)", [provider.account_email, aliases]);
    return { notes: notes.rowCount, events: events.rowCount };
}

async function usersRoute(client, request, parts, body) {
    const id = integer(parts[2]); const action = parts[3];
    if (request.method === "GET" && !id) return (await client.query("SELECT id,email,username,role,created_at FROM users ORDER BY id")).rows.map(serializeUser);
    if (request.method === "POST" && parts[2] === "bulk-delete") {
        const ids = Array.isArray(body.ids) ? body.ids.map(integer).filter(Boolean) : [];
        if (!ids.length) return { error: "Select at least one user", status: 422 };
        const skipped = [];
        if (!body.delete_related) for (const userId of ids) { const counts = await related(client, "users", userId); if (Object.values(counts).some(Number)) skipped.push(userId); }
        const deletable = ids.filter((value) => !skipped.includes(value));
        if (body.delete_related) for (const userId of deletable) { await purgeRelated(client, "users", userId); await client.query("DELETE FROM oauth_accounts WHERE user_id=$1", [userId]); }
        const result = deletable.length ? await client.query("DELETE FROM users WHERE id=ANY($1::integer[])", [deletable]) : { rowCount: 0 };
        return { deleted_users: result.rowCount, skipped };
    }
    if (request.method === "POST" && !id) {
        if (!validEmail(body.email) || !body.username || !["admin", "staff"].includes(body.role) || String(body.password || "").length < 8) return { error: "Invalid user fields", status: 422 };
        const result = await client.query("INSERT INTO users(email,username,role,hashed_password,created_at) VALUES(lower($1),$2,$3,$4,now()) RETURNING id,email,username,role,created_at", [body.email.trim(), body.username.trim(), body.role, await hashPassword(body.password)]);
        return serializeUser(result.rows[0]);
    }
    if (!id) return { error: "User not found", status: 404 };
    if (request.method === "GET" && action === "related-data") { const value = await related(client, "users", id); return { id, related: value, total: Object.values(value).reduce((sum, count) => sum + Number(count), 0) }; }
    if (request.method === "POST" && action === "purge-related") return { id, deleted: await purgeRelated(client, "users", id) };
    if (request.method === "POST" && action === "reset-password") { if (String(body.new_password || "").length < 8) return { error: "Password must be at least 8 characters", status: 422 }; await client.query("UPDATE users SET hashed_password=$2 WHERE id=$1", [id, await hashPassword(body.new_password)]); return { status: "success" }; }
    if (request.method === "PUT") { if (!validEmail(body.email) || !body.username || !["admin", "staff"].includes(body.role)) return { error: "Invalid user fields", status: 422 }; const result = await client.query("UPDATE users SET email=lower($2),username=$3,role=$4 WHERE id=$1 RETURNING id,email,username,role,created_at", [id, body.email.trim(), body.username.trim(), body.role]); return result.rows[0] ? serializeUser(result.rows[0]) : { error: "User not found", status: 404 }; }
    if (request.method === "DELETE") { const result = await client.query("DELETE FROM users WHERE id=$1", [id]); return result.rowCount ? { deleted: true } : { error: "User not found", status: 404 }; }
    return { error: "Unsupported admin user operation", status: 405 };
}

async function providersRoute(client, request, parts, body) {
    const id = integer(parts[2]); const action = parts[3];
    if (request.method === "GET" && !id) return (await client.query("SELECT a.*,u.email owner_email FROM oauth_accounts a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id")).rows.map(serializeProvider);
    if (request.method === "POST" && parts[2] === "bulk-delete") { const ids = Array.isArray(body.ids) ? body.ids.map(integer).filter(Boolean) : []; if (!ids.length) return { error: "Select at least one provider", status: 422 }; if (body.delete_related) for (const providerId of ids) await purgeRelated(client, "providers", providerId); const result = await client.query("DELETE FROM oauth_accounts WHERE id=ANY($1::integer[])", [ids]); return { deleted_providers: result.rowCount, skipped: [] }; }
    if (request.method === "POST" && !id) {
        if (!integer(body.user_id) || !body.provider || !validEmail(body.contact_email) || !validColor(body.color)) return { error: "Invalid provider fields", status: 422 };
        const result = await client.query(`INSERT INTO oauth_accounts(user_id,provider,account_email,access_token,display_name,provider_id,color,is_primary,sync_enabled,status,created_at,updated_at)
            VALUES($1,lower($2),lower($3),'admin-placeholder-token',$4,$5,$6,$7,$8,'ok',now(),now()) RETURNING *`, [body.user_id, body.provider.trim(), body.contact_email.trim(), body.provider_name || body.provider, body.provider_id || null, body.color || null, Boolean(body.is_primary), body.status === "active"]);
        return serializeProvider(result.rows[0]);
    }
    if (!id) return { error: "Provider not found", status: 404 };
    if (request.method === "GET" && action === "related-data") { const value = await related(client, "providers", id); if (!value) return { error: "Provider not found", status: 404 }; return { id, related: value, total: Object.values(value).reduce((sum, count) => sum + Number(count), 0) }; }
    if (request.method === "POST" && action === "purge-related") { const deleted = await purgeRelated(client, "providers", id); return deleted ? { id, deleted } : { error: "Provider not found", status: 404 }; }
    if (request.method === "POST" && action === "status") { if (!['active','inactive'].includes(body.status)) return { error: "Invalid status", status: 422 }; const result = await client.query("UPDATE oauth_accounts SET sync_enabled=$2,updated_at=now() WHERE id=$1 RETURNING *", [id, body.status === "active"]); return result.rows[0] ? serializeProvider(result.rows[0]) : { error: "Provider not found", status: 404 }; }
    if (request.method === "PUT") { if (!validEmail(body.contact_email) || !validColor(body.color)) return { error: "Invalid provider fields", status: 422 }; const result = await client.query(`UPDATE oauth_accounts SET account_email=lower($2),display_name=$3,provider_id=$4,color=$5,is_primary=$6,sync_enabled=$7,updated_at=now() WHERE id=$1 RETURNING *`, [id, body.contact_email.trim(), body.display_name || body.provider_name || null, body.provider_id || null, body.color || null, Boolean(body.is_primary), body.status === "active"]); return result.rows[0] ? serializeProvider(result.rows[0]) : { error: "Provider not found", status: 404 }; }
    if (request.method === "DELETE") { const result = await client.query("DELETE FROM oauth_accounts WHERE id=$1", [id]); return result.rowCount ? { deleted: true } : { error: "Provider not found", status: 404 }; }
    return { error: "Unsupported admin provider operation", status: 405 };
}

async function systemRoute(client, request, parts, url, env) {
    const action = parts[2];
    if (action === "overview") {
        const tables = [...MANAGED_TABLES].sort();
        return { generated_at: new Date().toISOString(), database: { engine: "postgresql", label: "PostgreSQL", database: "hyperdrive", host: "cloudflare-hyperdrive" }, tables, table_count: tables.length, admin_operations: { users: ["List, create, edit, reset, delete"], providers: ["List, create, edit, activate, delete"] }, security: { token_key_configured: Boolean(env.TOKEN_ENCRYPTION_KEY) }, deployment: { active_platform: "cloudflare", active_platform_label: "Cloudflare Worker", current_commit: env.WORKER_GIT_COMMIT || null, current_commit_source: "Cloudflare Worker build", repository_url: "https://github.com/cjdawgs/SherryJo_Cal_App", compare_base_url: "https://github.com/cjdawgs/SherryJo_Cal_App/compare", github_latest_commit: null, status: "unknown", message: "Cloudflare Worker is the active runtime.", platforms: [{ id: "cloudflare", label: "Cloudflare edge", role: "Primary application runtime", dashboard_url: "https://dash.cloudflare.com/", manual_deploy_available: Boolean(env.CLOUDFLARE_DEPLOY_HOOK_URL), manual_deploy_endpoint: env.CLOUDFLARE_DEPLOY_HOOK_URL ? "/admin/system/cloudflare/redeploy" : null }], repository_controls: { commit_push_endpoint: null, commit_push_hint: "Commit and push is unavailable in the Worker runtime." } } };
    }
    if (action === "cloudflare" && parts[3] === "redeploy" && request.method === "POST") { if (!env.CLOUDFLARE_DEPLOY_HOOK_URL) return { error: "CLOUDFLARE_DEPLOY_HOOK_URL is not configured", status: 400 }; const hook = await fetch(env.CLOUDFLARE_DEPLOY_HOOK_URL, { method: "POST" }); return hook.ok ? { triggered: true, message: "Cloudflare deploy hook triggered." } : { error: `Cloudflare deploy hook failed (${hook.status})`, status: 502 }; }
    if (action === "token-encryption-key") return { error: "Worker secrets cannot be changed by an HTTP request; update TOKEN_ENCRYPTION_KEY through Cloudflare secret management.", status: 409 };
    if (action === "table" && parts[4] === "rows") {
        const table = decodeURIComponent(parts[3] || ""); if (!MANAGED_TABLES.has(table)) return { table, columns: [], rows: [], count: 0, error: "Table not found" };
        const result = await client.query(`SELECT * FROM public.${table} ORDER BY 1 LIMIT 200`); const columns = result.fields.map((field) => field.name);
        return { table, columns, redacted_columns: columns.filter((column) => REDACTED.has(column)), rows: result.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key,value]) => [key, REDACTED.has(key) && value != null ? "***" : value]))), count: result.rowCount, limit: 200, offset: 0 };
    }
    const historical = action === "current-user-failure-history";
    if (action === "current-user-failures-today" || historical) {
        const end = historical ? new Date(`${url.searchParams.get("end_date")}T00:00:00Z`) : new Date(); if (historical) end.setUTCDate(end.getUTCDate() + 1);
        const start = historical ? new Date(`${url.searchParams.get("start_date")}T00:00:00Z`) : new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
        if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start || end - start > 91 * 86400000) return { error: "Invalid date range", status: 422 };
        const failures = (await client.query("SELECT provider,account_email,last_sync_failure,last_error FROM oauth_accounts WHERE user_id=public.worker_app_user_id() AND last_sync_failure >= $1 AND last_sync_failure < $2 ORDER BY id", [start,end])).rows;
        const diagnostics = (await client.query("SELECT ts_server,details FROM tv_diag_log WHERE user_id=public.worker_app_user_id() AND event='calendar_publish_result' AND ts_server >= $1 AND ts_server < $2 ORDER BY ts_server DESC", [start,end])).rows;
        if (historical) return { checked_at: new Date().toISOString(), window: { start: start.toISOString(), end: end.toISOString(), start_date: url.searchParams.get("start_date"), end_date: url.searchParams.get("end_date") }, counts: { sync_failures: failures.length, publish_failure_rows: diagnostics.length, distinct_publish_failure_reasons: 0, total_publish_diagnostics: diagnostics.length }, meaningful_points: ["Report uses persisted diagnostics."], sync_failure_accounts: failures, publish_failure_reasons: [], publish_failures: diagnostics.slice(0,25), recent_error_messages: [...new Set(failures.map((item) => item.last_error).filter(Boolean))].slice(0,10) };
        return { checked_at: new Date().toISOString(), window: { label: "today_utc", start: start.toISOString(), end: end.toISOString() }, has_failures: Boolean(failures.length || diagnostics.length), summary_lines: failures.length || diagnostics.length ? ["Persisted failures were recorded today."] : ["No sync or publish failures were recorded for this user today."], counts: { decrypt_warning_accounts: 0, sync_failures_today: failures.length, publish_failures_today: diagnostics.length, publish_diagnostics_today: diagnostics.length }, decrypt_warning_accounts: [], sync_failure_accounts: failures, publish_failures: diagnostics };
    }
    if (action === "tv-stale-refresh-summary") { const hours = Math.min(336, Math.max(1, Number(url.searchParams.get("hours")) || 24)); const rows = (await client.query("SELECT ts_server,user_id,device_id,details reason,elapsed_min,visibility FROM tv_diag_log WHERE event='stale_snapshot_used' AND ts_server >= now()-make_interval(hours=>$1) ORDER BY ts_server DESC LIMIT 200", [hours])).rows; return { checked_at: new Date().toISOString(), window: { hours }, counts: { stale_snapshot_events: rows.length, unique_users: new Set(rows.map(r=>r.user_id).filter(Boolean)).size, unique_devices: new Set(rows.map(r=>r.device_id).filter(Boolean)).size }, reason_counts: [], meaningful_points: ["Stale snapshots preserved visible TV events during refresh failures."], recent_rows: rows }; }
    return { error: "Unsupported admin system operation", status: 404 };
}

async function maintenanceRoute(client, request, parts) {
    const scan = async () => ({
        users: (await client.query("SELECT u.id FROM users u WHERE NOT EXISTS(SELECT 1 FROM oauth_accounts a WHERE a.user_id=u.id) AND NOT EXISTS(SELECT 1 FROM events e WHERE e.owner_id=u.id) AND NOT EXISTS(SELECT 1 FROM tasks t WHERE t.owner_id=u.id) AND NOT EXISTS(SELECT 1 FROM date_sticky_notes d WHERE d.owner_id=u.id) LIMIT 500")).rows.map(r=>r.id),
        oauth_accounts: (await client.query("SELECT a.id FROM oauth_accounts a LEFT JOIN users u ON u.id=a.user_id WHERE u.id IS NULL LIMIT 500")).rows.map(r=>r.id),
        events: (await client.query("SELECT e.id FROM events e LEFT JOIN users u ON u.id=e.owner_id WHERE e.owner_id IS NOT NULL AND u.id IS NULL LIMIT 500")).rows.map(r=>r.id),
        notes: (await client.query("SELECT n.id FROM notes n LEFT JOIN events e ON e.id=n.event_id WHERE n.event_id IS NOT NULL AND e.id IS NULL LIMIT 500")).rows.map(r=>r.id),
        tasks: (await client.query("SELECT t.id FROM tasks t LEFT JOIN users u ON u.id=t.owner_id WHERE t.owner_id IS NOT NULL AND u.id IS NULL LIMIT 500")).rows.map(r=>r.id),
        date_sticky_notes: (await client.query("SELECT d.id FROM date_sticky_notes d LEFT JOIN users u ON u.id=d.owner_id WHERE d.owner_id IS NOT NULL AND u.id IS NULL LIMIT 500")).rows.map(r=>r.id),
    });
    if (request.method === "GET" && parts[2] === "orphans") return scan();
    if (request.method === "POST" && parts[2] === "orphans" && parts[3] === "delete") { const found = await scan(); for (const [table, ids] of Object.entries(found)) if (ids.length) await client.query(`DELETE FROM ${table} WHERE id=ANY($1)`, [ids]); return { deleted: Object.fromEntries(Object.entries(found).map(([key,value])=>[key,value.length])) }; }
    return { error: "Unsupported maintenance operation", status: 404 };
}

export async function handleAdminApi(request, env, adapter, userId) {
    let body = {}; if (!["GET","DELETE"].includes(request.method)) { try { body = await request.json(); } catch { return response({ detail: "Invalid JSON body" }, 400); } }
    const url = new URL(request.url); const parts = url.pathname.split("/").filter(Boolean);
    try {
        const result = await adapter.runWithIdentity(userId, async (client) => {
            const admin = await client.query("SELECT public.worker_app_is_admin() AS allowed");
            if (!admin.rows[0]?.allowed) return { error: "Admin only", status: 403 };
            if (parts[1] === "users") return usersRoute(client, request, parts, body);
            if (parts[1] === "providers") return providersRoute(client, request, parts, body);
            if (parts[1] === "system") return systemRoute(client, request, parts, url, env);
            if (parts[1] === "maintenance") return maintenanceRoute(client, request, parts);
            return { error: "Admin route not found", status: 404 };
        });
        if (result?.error) return response({ detail: result.error }, result.status || 400);
        return response(result);
    } catch (error) {
        const duplicate = error?.code === "23505";
        return response({ detail: duplicate ? "A record with those unique fields already exists" : "Admin operation failed" }, duplicate ? 409 : 500);
    }
}