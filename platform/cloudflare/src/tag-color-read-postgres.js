const DEFAULT_EVENT_COLOR = "#4F8EF7";

export const TAG_COLOR_READ_SQL = `
    SELECT tag_key, label, color, enabled
    FROM public.event_tag_color_settings
    WHERE owner_id = public.worker_app_user_id()
`;

function normalizeHexColor(value) {
    const color = String(value || "").trim();
    return /^#[0-9a-f]{6}$/i.test(color) ? color : DEFAULT_EVENT_COLOR;
}

export function serializeTagColorRows(rows) {
    const settings = {};
    for (const row of rows) {
        if (!row.tag_key) continue;
        settings[row.tag_key] = {
            label: row.label,
            color: normalizeHexColor(row.color),
            enabled: Boolean(row.enabled),
        };
    }
    return { settings };
}

export async function executeTagColorRead(adapter, userId) {
    const result = await adapter.runWithIdentity(
        userId,
        (client) => client.query(TAG_COLOR_READ_SQL),
    );
    return serializeTagColorRows(result.rows);
}