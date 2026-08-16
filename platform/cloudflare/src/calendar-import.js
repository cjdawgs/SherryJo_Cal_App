import ICAL from "ical.js";
import { parse as parseCsv } from "csv-parse/sync";

import { executeCalendarPublish } from "./calendar-publish.js";
import { CalendarPublishPostgresAdapter } from "./calendar-publish-postgres.js";

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 2000;

export class CalendarImportError extends Error {}

function dateValue(value) {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeEvent(row, index, warnings) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
        warnings.push(`Entry ${index}: skipped non-object item`);
        return null;
    }
    const field = (...names) => names.map((name) => row[name]).find((value) => value !== undefined && String(value).trim()) ?? null;
    const title = String(field("title", "summary", "name", "subject") || "Untitled Event").trim().slice(0, 255);
    const startRaw = field("start", "start_time", "startDate", "start_date", "dtstart");
    const endRaw = field("end", "end_time", "endDate", "end_date", "dtend");
    const start = dateValue(startRaw);
    if (!start) {
        warnings.push(`Entry ${index}: ${startRaw ? `invalid start date/time '${startRaw}'` : "missing start date/time"}`);
        return null;
    }
    let end = dateValue(endRaw);
    if (end && end <= start) end = new Date(start.getTime() + 60 * 60 * 1000);
    const rawSticky = row.sticky_notes ?? row.stickyNotes;
    const stickyNotes = (Array.isArray(rawSticky) ? rawSticky : rawSticky ? [rawSticky] : []).flatMap((item) => {
        const content = String(typeof item === "object" ? item?.content || item?.text || "" : item).trim();
        return content ? [{ content, color: String(item?.color || "#F7E68A") }] : [];
    });
    return {
        title,
        description: String(field("description", "notes", "body") || "").trim(),
        start_time: start.toISOString(),
        end_time: end?.toISOString() || null,
        sticky_notes: stickyNotes,
    };
}

function parseJson(text) {
    let data;
    try { data = JSON.parse(text); } catch (error) { throw new CalendarImportError(`Invalid JSON file: ${error.message}`); }
    const rows = Array.isArray(data) ? data : Array.isArray(data?.events) ? data.events : [data];
    const warnings = [];
    return { events: rows.map((row, index) => normalizeEvent(row, index + 1, warnings)).filter(Boolean), warnings };
}

function parseCsvText(text) {
    let rows;
    try {
        rows = parseCsv(text, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
    } catch (error) {
        throw new CalendarImportError(`Invalid CSV file: ${error.message}`);
    }
    const warnings = [];
    return { events: rows.map((row, index) => normalizeEvent(row, index + 2, warnings)).filter(Boolean), warnings };
}

function parseIcs(text) {
    let root;
    try { root = ICAL.Component.fromString(text); } catch (error) { throw new CalendarImportError(`Invalid ICS file: ${error.message}`); }
    const warnings = [];
    const events = [];
    for (const [index, component] of root.getAllSubcomponents("vevent").entries()) {
        try {
            const event = new ICAL.Event(component);
            const start = event.startDate?.toJSDate();
            if (!(start instanceof Date) || Number.isNaN(start.getTime())) {
                warnings.push(`Skipped '${event.summary || "Untitled Event"}': missing DTSTART`);
                continue;
            }
            let end = event.endDate?.toJSDate() || null;
            if (end && end <= start) end = new Date(start.getTime() + 60 * 60 * 1000);
            events.push({
                title: String(event.summary || "Untitled Event").trim().slice(0, 255),
                description: String(event.description || "").trim(),
                start_time: start.toISOString(), end_time: end?.toISOString() || null, sticky_notes: [],
            });
        } catch (error) {
            warnings.push(`Skipped ICS event ${index + 1} due to parse error: ${error.message}`);
        }
    }
    return { events, warnings };
}

export function parseCalendarImport(filename, bytes) {
    if (!(bytes instanceof Uint8Array) || !bytes.length) throw new CalendarImportError("Uploaded file is empty");
    if (bytes.byteLength > MAX_FILE_BYTES) throw new CalendarImportError("File too large (max 8MB)");
    const extension = String(filename || "").trim().toLowerCase().split(".").pop();
    const text = new TextDecoder("utf-8").decode(bytes);
    let parsed;
    if (["ics", "ical"].includes(extension)) parsed = parseIcs(text);
    else if (extension === "csv") parsed = parseCsvText(text);
    else if (extension === "json") parsed = parseJson(text);
    else throw new CalendarImportError("Unsupported file type. Use .ics, .ical, .csv, or .json");
    if (parsed.events.length > MAX_EVENTS) {
        parsed.warnings.push(`Only the first ${MAX_EVENTS} events were imported`);
        parsed.events = parsed.events.slice(0, MAX_EVENTS);
    }
    return parsed;
}

export async function executeCalendarImport(adapter, { userId, events, stickyMode = "description", now = new Date(), returnIds = false }) {
    const rows = events.map((event) => {
        const stickyText = event.sticky_notes.map((note) => `- ${note.content}`).join("\n");
        const description = stickyMode === "description" && stickyText
            ? `${event.description ? `${event.description}\n\n` : ""}Sticky Notes:\n${stickyText}`
            : event.description;
        return { ...event, description };
    });
    if (!rows.length) return returnIds ? [] : 0;
    const result = await adapter.runWithIdentity(userId, (client) => client.query(`
        INSERT INTO public.events (
            owner_id, title, description, start_time, end_time, source, account_email,
            sticky_notes, status, created_at, updated_at
        )
        SELECT public.worker_app_user_id(), item.title, item.description,
            item.start_time, item.end_time, 'local', 'local', item.sticky_notes,
            'pending', $2::timestamptz, $2::timestamptz
        FROM jsonb_to_recordset($1::jsonb) AS item(
            title text, description text, start_time timestamptz,
            end_time timestamptz, sticky_notes jsonb
        )
        RETURNING id
    `, [JSON.stringify(rows), now.toISOString()]));
    return returnIds ? result.rows.map((row) => Number(row.id)).filter(Number.isSafeInteger) : result.rows.length;
}

export async function handleCalendarImport(request, env, adapter, userId) {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_FILE_BYTES + 1024 * 1024) return new Response(JSON.stringify({ detail: "File too large (max 8MB)" }), { status: 413, headers: { "content-type": "application/json" } });
    const form = await request.formData();
    const file = form.get("file");
    if (!file || typeof file.arrayBuffer !== "function" || !String(file.name || "").trim()) throw new CalendarImportError("Missing file name");
    const parsed = parseCalendarImport(file.name, new Uint8Array(await file.arrayBuffer()));
    const stickyMode = String(new URL(request.url).searchParams.get("publish_sticky_mode") || "description").trim().toLowerCase();
    const importedIds = await executeCalendarImport(adapter, { userId, events: parsed.events, stickyMode, returnIds: true });
    const imported = importedIds.length;
    const publishRequested = new URL(request.url).searchParams.get("publish") === "true";
    const warnings = [...parsed.warnings];
    let publishResult = { published: 0, created: 0, failed: 0, warnings: [] };
    if (publishRequested && imported) {
        publishResult = await executeCalendarPublish(new CalendarPublishPostgresAdapter(adapter), {
            userId,
            body: { event_ids: importedIds, publish_all_accounts: true },
            env,
        });
        warnings.push(...(publishResult.warnings || []));
    }
    return new Response(JSON.stringify({
        status: "success", imported, published_events: publishResult.published || 0,
        published_creates: publishResult.created || 0,
        published_updates: Math.max(0, Number(publishResult.published || 0) - Number(publishResult.created || 0)),
        publish_failed: publishResult.failed || 0, warnings, publish_sticky_mode: stickyMode,
    }), { headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" } });
}