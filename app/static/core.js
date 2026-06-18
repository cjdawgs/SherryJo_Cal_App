/**
 * ==========================================================
 * ✅ CORE SHARED ENGINE
 * ==========================================================
 * ALL cross-file shared logic lives here
 * NO duplication allowed anywhere else
 * ==========================================================
 */


/**************************************************************
 * ✅ DATE HELPERS
 **************************************************************/
export function toDayString(d) {
  if (!d) return null;

  const dt = new Date(d);

  return dt.getFullYear() + "-" +
    String(dt.getMonth() + 1).padStart(2, "0") + "-" +
    String(dt.getDate()).padStart(2, "0");
}

export function fromDayString(dayStr) {
  if (!dayStr || typeof dayStr !== "string") {
    return new Date();
  }

  const [y, m, d] = dayStr.split("-");
  return new Date(y, m - 1, d);
}


/**************************************************************
 * ✅ RANGE ENGINE (THIS FIXES YOUR CURRENT ERROR)
 **************************************************************/
export function getActiveRangeLabel(days) {

  const base = new Date();

  const start = new Date(base);
  const end = new Date(base);

  const half = Math.floor(days / 2);

  start.setDate(base.getDate() - half);
  end.setDate(base.getDate() + half);

  const format = (d) =>
    d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });

  return {
    start,
    end,
    label: `${format(start)} → ${format(end)}`
  };
}