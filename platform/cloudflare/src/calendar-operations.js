import { runAccountSyncNow } from "./scheduled-calendar-sync.js";

function normalizeProvider(value) {
    const provider = String(value || "").trim().toLowerCase();
    if (["google", "gmail"].includes(provider)) return "google";
    if (["microsoft", "outlook", "office365", "ms", "msft"].includes(provider)) return "microsoft";
    if (["apple", "icloud", "caldav"].includes(provider)) return "apple";
    return provider;
}

function formatSyncFailureMessage(accounts, results) {
    const accountsById = new Map(accounts.map((account) => [account.id, account]));
    const failed = results.filter((result) => ["failed", "reauth_required"].includes(result.status));
    if (!failed.length) return null;
    const details = failed.map((result) => {
        const account = accountsById.get(result.accountId);
        const provider = normalizeProvider(result.provider || account?.provider || "calendar");
        const email = String(account?.account_email || "").trim();
        const label = email ? `${provider} (${email})` : provider;
        return result.status === "reauth_required"
            ? `Reconnect ${label}`
            : `${label} sync failed (${result.errorType || "ProviderError"})`;
    });
    return details.join("; ");
}

export async function materializeDedup(adapter, userId) {
    return adapter.runWithIdentity(userId, async (client) => {
        const result = await client.query(`
            SELECT id, title, start_time, end_time, description, color, source,
                   account_email, external_ids, created_at
            FROM public.events
            WHERE owner_id = public.worker_app_user_id()
            ORDER BY created_at NULLS FIRST, id
            FOR UPDATE
        `);
        const groups = new Map();
        for (const row of result.rows) {
            const title = String(row.title || "").trim().toLowerCase();
            if (!title || !row.start_time) continue;
            const minute = (value) => value ? new Date(value).toISOString().slice(0, 16) : "";
            const key = `${title}|${minute(row.start_time)}|${minute(row.end_time)}`;
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(row);
        }
        let changed = 0;
        for (const rows of groups.values()) {
            if (rows.length < 2) continue;
            rows.sort((left, right) => Number(!(left.source === "local" && left.external_ids)) - Number(!(right.source === "local" && right.external_ids)));
            const canonical = rows[0]; const externalIds = { ...(canonical.external_ids || {}) };
            for (const duplicate of rows.slice(1)) {
                Object.assign(externalIds, duplicate.external_ids || {});
                await client.query("DELETE FROM public.notes WHERE event_id=$1", [duplicate.id]);
                await client.query("DELETE FROM public.events WHERE id=$1", [duplicate.id]);
                changed += 1;
            }
            await client.query(`UPDATE public.events SET external_ids=$2::jsonb, source='local', account_email='local',
                description=COALESCE(NULLIF(description,''),$3), color=COALESCE(color,$4), updated_at=now() WHERE id=$1`,
                [canonical.id, JSON.stringify(externalIds), rows.find((row) => row.description)?.description || "", rows.find((row) => row.color)?.color || null]);
        }
        const promoted = await client.query(`UPDATE public.events SET source='local',account_email='local',updated_at=now()
            WHERE owner_id=public.worker_app_user_id() AND external_ids IS NOT NULL
              AND NOT (source='local' AND lower(COALESCE(account_email,''))='local')`);
        return changed + promoted.rowCount;
    });
}

export async function runManualCalendarSync(adapter, env, userId, accountKey, dedupEnabled) {
    const normalizedKey = String(accountKey || "").trim().toLowerCase();
    const accounts = await adapter.runWithIdentity(userId, async (client) => (await client.query(`
        SELECT id, provider, account_email, sync_range_days FROM public.oauth_accounts
                WHERE user_id=public.worker_app_user_id() AND sync_enabled IS TRUE
                    AND lower(COALESCE(account_email, '')) NOT LIKE '%@example.com'
                ORDER BY id
    `)).rows);
    const selected = normalizedKey ? accounts.filter((account) => `${normalizeProvider(account.provider)}:${String(account.account_email).trim().toLowerCase()}` === normalizedKey) : accounts;
    if (normalizedKey && !selected.length) return { status: "error", message: "Sync account not found" };
    const results = [];
    for (const account of selected) results.push(await runAccountSyncNow(env, userId, account.id));
    const changed = dedupEnabled ? await materializeDedup(adapter, userId) : 0;
    const configuredRange = selected.length
        ? Math.max(...selected.map((account) => Number(account.sync_range_days) || 30))
        : 30;
    const rangeDays = Math.max(1, Math.min(365, configuredRange));
    const now = Date.now();
    const message = formatSyncFailureMessage(selected, results);
    return {
        status: message ? "error" : "success",
        ...(message ? { message } : {}),
        result: { results, dedup_changed: changed },
        range_days: rangeDays,
        range_start: new Date(now - rangeDays * 86400000).toISOString(),
        range_end: new Date(now + rangeDays * 86400000).toISOString(),
        account: normalizedKey || null,
    };
}

export async function upsertLegacyEventNote(adapter, userId, data) {
    return adapter.runWithIdentity(userId, async (client) => {
        if (data.note_id) {
            const result = await client.query(`UPDATE public.notes AS note SET content=COALESCE($2,note.content),
                x=COALESCE($3,note.x),y=COALESCE($4,note.y) FROM public.events AS event
                WHERE note.id=$1 AND event.id=note.event_id AND event.owner_id=public.worker_app_user_id() RETURNING note.id`,
                [String(data.note_id), data.content ?? null, data.x ?? null, data.y ?? null]);
            if (!result.rowCount) return null;
        } else {
            const eventId = Number(data.event_id);
            const owned = await client.query("SELECT 1 FROM public.events WHERE id=$1 AND owner_id=public.worker_app_user_id()", [eventId]);
            if (!owned.rowCount) return null;
            await client.query("INSERT INTO public.notes(id,content,color,x,y,event_id) VALUES($1,$2,'yellow',$3,$4,$5)", [crypto.randomUUID(), String(data.content || ""), Number(data.x) || 120, Number(data.y) || 120, eventId]);
        }
        return { ok: true };
    });
}