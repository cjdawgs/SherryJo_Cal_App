export class TvDiagnosticsForbiddenError extends Error {}

function normalizedEntry(entry, userAgent) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("Diagnostic entry must be an object");
    const event = String(entry.event || "").trim().slice(0, 64);
    if (!event) throw new TypeError("Diagnostic event is required");
    return {
        event,
        details: String(entry.details || "").slice(0, 256),
        ts_client: String(entry.ts || "").slice(0, 32),
        elapsed_min: Number.isInteger(entry.sessionElapsedMin) ? entry.sessionElapsedMin : null,
        visibility: String(entry.visibilityState || "").slice(0, 32),
        guard_enabled: typeof entry.guardEnabled === "boolean" ? entry.guardEnabled : null,
        guard_timeout: Number.isInteger(entry.guardTimeout) ? entry.guardTimeout : null,
        device_id: String(entry.device_id || "").slice(0, 64),
        device_ua: String(userAgent || "").slice(0, 512),
    };
}

export async function executeTvDiagnosticsWrite(adapter, { userId, body, userAgent }) {
    const entries = Array.isArray(body?.entries) ? body.entries : [body];
    if (!entries.length || entries.length > 50) throw new TypeError("Diagnostic batch must contain 1 to 50 entries");
    const normalized = entries.map((entry) => normalizedEntry(entry, userAgent));
    await adapter.runWithIdentity(userId, (client) => client.query(
        "SELECT public.worker_record_tv_diagnostics($1::jsonb)",
        [JSON.stringify(normalized)],
    ));
    return { ok: true, accepted: normalized.length };
}

export async function executeTvDiagnosticsRead(adapter, { userId, scope, hours, eventGroup }) {
    const normalizedScope = String(scope || "own").trim().toLowerCase();
    const normalizedGroup = String(eventGroup || "all").trim().toLowerCase();
    if (!["own", "all"].includes(normalizedScope)) throw new TypeError("Unsupported diagnostic scope");
    if (!["all", "repair_risk"].includes(normalizedGroup)) throw new TypeError("Unsupported event_group");
    const boundedHours = hours === null || hours === undefined || hours === "" ? null : Math.min(Math.max(Number(hours), 1), 720);
    if (boundedHours !== null && !Number.isInteger(boundedHours)) throw new TypeError("hours must be an integer");
    try {
        const result = await adapter.runWithIdentity(userId, (client) => client.query(
            "SELECT * FROM public.worker_read_tv_diagnostics($1, $2, $3)",
            [normalizedScope, boundedHours, normalizedGroup],
        ));
        return {
            entries: result.rows.map((row) => ({
                ...row,
                ts_server: row.ts_server instanceof Date ? row.ts_server.toISOString() : row.ts_server,
                device_id: row.device_id || "", device_ua: row.device_ua || "", details: row.details || "",
                ts_client: row.ts_client || "", visibility: row.visibility || "",
            })),
            scope: normalizedScope,
            source: "db",
            filters: { hours: boundedHours, event_group: normalizedGroup },
        };
    } catch (error) {
        if (error?.code === "42501" || /admin only/i.test(String(error?.message || ""))) {
            throw new TvDiagnosticsForbiddenError("Admin only");
        }
        throw error;
    }
}