const TV_STATE_READ_SQL = `
    SELECT
        to_char(state.selected_date, 'YYYY-MM-DD') AS selected_date,
        COALESCE(state.current_view, 'day') AS current_view,
        state.focused_event_id,
        users.email,
        users.role,
        COALESCE(state.sleep_guard_enabled, true) AS sleep_guard_enabled,
        COALESCE(state.sleep_guard_timeout_minutes, 0) AS sleep_guard_timeout_minutes
    FROM public.users
    LEFT JOIN public.tv_user_state AS state ON state.user_id = users.id
    WHERE users.id = public.worker_app_user_id()
`;

const TV_STATE_WRITE_SQL = `
    INSERT INTO public.tv_user_state (
        user_id, selected_date, current_view, focused_event_id,
        sleep_guard_enabled, sleep_guard_timeout_minutes
    ) VALUES (
        public.worker_app_user_id(), $1::date, COALESCE($2, 'day'), $3,
        COALESCE($4, true), COALESCE($5, 0)
    )
    ON CONFLICT (user_id) DO UPDATE SET
        selected_date = CASE WHEN $6 THEN $1::date ELSE tv_user_state.selected_date END,
        current_view = CASE WHEN $7 THEN $2 ELSE tv_user_state.current_view END,
        focused_event_id = CASE WHEN $8 THEN $3 ELSE tv_user_state.focused_event_id END,
        sleep_guard_enabled = CASE WHEN $9 THEN $4 ELSE tv_user_state.sleep_guard_enabled END,
        sleep_guard_timeout_minutes = CASE WHEN $10 THEN $5 ELSE tv_user_state.sleep_guard_timeout_minutes END,
        updated_at = now()
    RETURNING to_char(selected_date, 'YYYY-MM-DD') AS selected_date, current_view,
        focused_event_id, sleep_guard_enabled, sleep_guard_timeout_minutes
`;

export class TvStateUserNotFoundError extends Error {}

function stateView(row) {
    return {
        selectedDate: row.selected_date || null,
        currentView: row.current_view || "day",
        focusedEventId: row.focused_event_id ?? null,
        currentUserEmail: row.email || null,
        currentUserRole: row.role || null,
        sleepGuardEnabled: row.sleep_guard_enabled !== false,
        sleepGuardTimeoutMinutes: Number(row.sleep_guard_timeout_minutes || 0),
    };
}

function normalizePatch(body, allowSleepTimeout) {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new TypeError("TV state patch must be an object");
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key) && body[key] !== null;
    const selectedDate = has("selectedDate") ? String(body.selectedDate) : null;
    if (has("selectedDate") && !/^\d{4}-\d{2}-\d{2}$/.test(selectedDate)) throw new TypeError("selectedDate must be YYYY-MM-DD");
    const currentView = has("currentView") ? String(body.currentView).trim() : null;
    if (has("currentView") && (!currentView || currentView.length > 40)) throw new TypeError("currentView is invalid");
    const focusedEventId = has("focusedEventId") ? Number(body.focusedEventId) : null;
    if (has("focusedEventId") && (!Number.isSafeInteger(focusedEventId) || focusedEventId <= 0)) throw new TypeError("focusedEventId is invalid");
    const sleepGuardEnabled = has("sleepGuardEnabled") ? Boolean(body.sleepGuardEnabled) : null;
    let sleepGuardTimeoutMinutes = has("sleepGuardTimeoutMinutes") ? Number(body.sleepGuardTimeoutMinutes) : null;
    if (has("sleepGuardTimeoutMinutes") && (!Number.isInteger(sleepGuardTimeoutMinutes) || sleepGuardTimeoutMinutes < 0)) {
        throw new TypeError("sleepGuardTimeoutMinutes is invalid");
    }
    sleepGuardTimeoutMinutes = allowSleepTimeout ? Math.min(sleepGuardTimeoutMinutes ?? 0, 1440) : 0;
    return {
        values: [selectedDate, currentView, focusedEventId, sleepGuardEnabled, sleepGuardTimeoutMinutes],
        present: [has("selectedDate"), has("currentView"), has("focusedEventId"), has("sleepGuardEnabled"), has("sleepGuardTimeoutMinutes") || !allowSleepTimeout],
    };
}

export async function executeTvStateRead(adapter, userId) {
    const result = await adapter.runWithIdentity(userId, (client) => client.query(TV_STATE_READ_SQL));
    if (!result.rows.length) throw new TvStateUserNotFoundError("User not found");
    return stateView(result.rows[0]);
}

export async function executeTvStateWrite(adapter, { userId, body, allowSleepTimeout = false }) {
    const patch = normalizePatch(body, allowSleepTimeout);
    const result = await adapter.runWithIdentity(userId, (client) => client.query(
        TV_STATE_WRITE_SQL,
        [...patch.values, ...patch.present],
    ));
    const current = await executeTvStateRead(adapter, userId);
    return { ...current, ...stateView(result.rows[0]), currentUserEmail: current.currentUserEmail, currentUserRole: current.currentUserRole };
}