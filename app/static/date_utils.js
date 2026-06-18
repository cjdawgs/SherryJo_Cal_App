/**
 * ==========================================================
 * ✅ DATE UTILITIES (SINGLE SOURCE OF TRUTH)
 * ==========================================================
 * Used by:
 * - calendar.js
 * - calendar.fullcalendar.js
 * ==========================================================
 */

/**
 * ✅ FORMAT DATE → YYYY-MM-DD
 */
export function toDayString(d) {
    if (!d) return null;

    const dt = new Date(d);

    return dt.getFullYear() + "-" +
        String(dt.getMonth() + 1).padStart(2, "0") + "-" +
        String(dt.getDate()).padStart(2, "0");
}

/**
 * ✅ PARSE STRING → DATE
 */
export function fromDayString(dayStr) {
    if (!dayStr || typeof dayStr !== "string") {
        console.warn("⚠️ invalid dayStr → fallback to today:", dayStr);
        return new Date();
    }

    const [y, m, d] = dayStr.split("-");
    return new Date(y, m - 1, d);
}