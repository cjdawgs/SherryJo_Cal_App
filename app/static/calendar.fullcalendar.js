//import { getColorByKey, getSoftColor, getBestTextColor } from "./calendar.colors.js";

import { apiFetch } from "/static/api.js";
import {
  toDayString,
  getActiveRangeLabel
} from "/static/core.js";

/**************************************************************
 * ✅ GLOBAL STATE
 * (do not initialize sessionEventCache here — single source in calendar.js)
 **************************************************************/

/**************************************************************
 ✅ HIGHLIGHT SELECTED DAY — ALL VIEWS
 Month  : .fc-daygrid-day[data-date]
 Week   : .fc-col-header-cell[data-date] + .fc-timegrid-col[data-date]
 Day    : .fc-col-header-cell[data-date] + .fc-timegrid-col[data-date]
**************************************************************/
export function highlightSelectedDay(dateStr) {
  if (!dateStr) return;

  const HIGHLIGHT = "rgba(66,133,244,0.35)";

  // ✅ Clear previous highlights across ALL view types
  document.querySelectorAll(".fc-daygrid-day").forEach(d => {
    d.style.background = "";
  });
  document.querySelectorAll(".fc-timegrid-col").forEach(d => {
    d.style.background = "";
  });
  document.querySelectorAll(".fc-col-header-cell").forEach(d => {
    d.style.background = "";
  });

  let found = false;

  // ✅ Month view — day grid cell
  const dayCell = document.querySelector(
    `.fc-daygrid-day[data-date="${dateStr}"]`
  );
  if (dayCell) {
    dayCell.style.setProperty("background-color", HIGHLIGHT, "important");
    found = true;
  }

  // ✅ Week / Day view — column header (day name + date number row)
  const colHeader = document.querySelector(
    `.fc-col-header-cell[data-date="${dateStr}"]`
  );
  if (colHeader) {
    colHeader.style.setProperty("background-color", HIGHLIGHT, "important");
    found = true;
  }

  // ✅ Week / Day view — time grid column background
  const timeCol = document.querySelector(
    `.fc-timegrid-col[data-date="${dateStr}"]`
  );
  if (timeCol) {
    timeCol.style.setProperty("background-color", HIGHLIGHT, "important");
    found = true;
  }

  if (!found) {
    console.warn("⚠️ could not find day cell for:", dateStr);
  }

  renderVisibleDateStickyIcons();
}

function stickyCountFromNotes(notes = [], legacySticky = null) {
  const list = Array.isArray(notes)
    ? notes.filter((s) => String(s?.content || "").trim())
    : [];
  if (list.length) return list.length;
  return String(legacySticky?.content || "").trim() ? 1 : 0;
}

function buildStickyIcon({ count = 1, title = "Open sticky note", dragPayload = null } = {}) {
  const icon = document.createElement("span");
  icon.className = "stickyEventIcon";
  icon.title = title;
  icon.textContent = "🗒";
  icon.style.cursor = "grab";
  icon.style.userSelect = "none";
  icon.style.webkitUserDrag = "element";

  if (dragPayload) {
    icon.draggable = true;
    icon.addEventListener("dragstart", (e) => {
      beginStickyDrag(dragPayload, e);
    });
    icon.addEventListener("dragend", () => clearStickyDragPayload());
  }

  // Prevent day/event click handlers from stealing sticky icon interactions.
  ["pointerdown", "mousedown", "touchstart"].forEach((evtName) => {
    icon.addEventListener(evtName, (e) => {
      e.stopPropagation();
    }, { passive: true });
  });

  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "stickyCountBadge";
    badge.textContent = String(count);
    icon.appendChild(badge);
  }

  return icon;
}

function renderVisibleDateStickyIcons() {
  document.querySelectorAll(".dateStickyAnchor").forEach((el) => el.remove());

  const countMap = window.getAllDateStickyCounts?.() || {};

  const addAnchor = (target, dateStr) => {
    if (!target) return;

    const dateCount = Number(countMap[dateStr] || 0);
    if (!dateCount) return;

    const holder = document.createElement("span");
    holder.className = "dateStickyAnchor";

    // ✅ Do NOT add any event listeners to the holder.
    // The icon handles click/dblclick/contextmenu via its own listeners,
    // which will stopPropagation() and preventDefault() as needed.
    // This allows both normal events AND drag-start to work correctly.

    const icon = buildStickyIcon({
      count: dateCount,
      title: window.getDateStickyTooltip?.(dateStr) || `Open date sticky note (${dateCount})`,
      dragPayload: {
        scope: "date",
        dateKey: dateStr
      }
    });

    icon.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.openDateStickyModal?.(dateStr);
    });

    icon.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      window.editDateStickyNote?.(dateStr);
    });

    icon.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openStickyIconContextMenu(e.clientX, e.clientY, {
        scope: "date",
        dateStr,
        count: dateCount
      });
    });

    holder.appendChild(icon);
    target.prepend(holder);
  };

  document.querySelectorAll(".fc-daygrid-day[data-date]").forEach((cell) => {
    const dateStr = cell.getAttribute("data-date");
    if (!dateStr) return;
    const monthCell = cell.querySelector(".fc-daygrid-day-top") || cell;
    addAnchor(monthCell, dateStr);
  });

  document.querySelectorAll(".fc-col-header-cell[data-date]").forEach((headerCell) => {
    const dateStr = headerCell.getAttribute("data-date");
    if (!dateStr) return;
    const colHeader = headerCell.querySelector(".fc-col-header-cell-cushion") || headerCell;
    addAnchor(colHeader, dateStr);
  });
}

window.renderVisibleDateStickyIcons = renderVisibleDateStickyIcons;

/*******************************************************
✅ RANGE PILL RENDER ENGINE (GLOBAL — CORRECT PLACEMENT)
*******************************************************/
export function renderRangePill() {
  const el = document.getElementById("rangeDisplay");
  if (!el) return;

  const days = window.currentRangeDays || 30;
  const range = getActiveRangeLabel(days);

  el.textContent = `📅 ${range?.label || "NO RANGE"}`;

  console.log("✅ RANGE PILL RENDER:", el.textContent);
}

// =========================================================
// ✅ CONTEXT MENU — right-click on events AND empty date cells
// =========================================================
function ensureContextMenu() {
  let menu = document.getElementById("eventContextMenu");
  if (menu) return menu;
  menu = document.createElement("div");
  menu.id = "eventContextMenu";
  document.body.appendChild(menu);
  return menu;
}

function positionContextMenu(menu, x, y) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const menuW = menu.offsetWidth  || 185;
  const menuH = menu.offsetHeight || 140;
  menu.style.left = (x + menuW > vw ? x - menuW : x) + "px";
  menu.style.top  = (y + menuH > vh ? y - menuH : y) + "px";
  menu.classList.add("visible");
}

function openContextMenu(x, y, fcEvent) {
  const menu = ensureContextMenu();
  const precisionLabel = getDragPrecisionModeLabel();
  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="create" title="Create Event">➕ Create Event</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item" data-action="edit" title="Edit">✏️ Edit</div>
    <div class="ctx-menu-item" data-action="sticky" title="New Sticky Note">🗒 New Sticky Note</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item" data-action="toggle-precision" title="Toggle drag confirmation">🎯 Precision Drag: ${precisionLabel}</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item danger" data-action="delete" title="Delete">🗑 Delete</div>
  `;
  positionContextMenu(menu, x, y);
  menu.querySelector("[data-action='create']").onclick = () => {
    closeContextMenu();
    window.openCreateModal?.();
  };
  menu.querySelector("[data-action='edit']").onclick = () => {
    closeContextMenu();
    window.openCreateModal?.(null, fcEvent);
  };
  menu.querySelector("[data-action='sticky']").onclick = () => {
    closeContextMenu();
    window.openStickyModalForNew?.(fcEvent);
  };
  menu.querySelector("[data-action='toggle-precision']").onclick = () => {
    closeContextMenu();
    setDragPrecisionMode(!window.dragPrecisionMode);
  };
  menu.querySelector("[data-action='delete']").onclick = async () => {
    closeContextMenu();
    window.editingEventId = fcEvent.extendedProps?.backendId || Number(fcEvent.id);
    await window.deleteEvent?.();
  };
}

function openStickyIconContextMenu(x, y, payload) {
  const menu = ensureContextMenu();
  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="open-sticky">🗒 Open Sticky</div>
    <div class="ctx-menu-item" data-action="edit-sticky">✏️ Edit Specific Sticky</div>
    <div class="ctx-menu-item danger" data-action="delete-sticky">🧽 Delete Specific Sticky</div>
  `;
  positionContextMenu(menu, x, y);

  menu.querySelector("[data-action='open-sticky']").onclick = () => {
    closeContextMenu();
    if (payload.scope === "date") {
      window.openDateStickyModal?.(payload.dateStr);
      return;
    }
    if (payload.scope === "event") {
      window.openStickyModal?.(payload.fcEvent);
    }
  };

  menu.querySelector("[data-action='delete-sticky']").onclick = async () => {
    closeContextMenu();
    if (payload.scope === "date") {
      window.deleteDateStickyNote?.(payload.dateStr);
      return;
    }
    if (payload.scope === "event") {
      await window.deleteEventStickyNote?.(payload.fcEvent);
    }
  };

  menu.querySelector("[data-action='edit-sticky']").onclick = () => {
    closeContextMenu();
    if (payload.scope === "date") {
      window.editDateStickyNote?.(payload.dateStr);
      return;
    }
    if (payload.scope === "event") {
      window.editEventStickyNote?.(payload.fcEvent);
    }
  };
}

function getFirstEventOnDate(dateStr) {
  const cal = window.calendar;
  if (!cal || !dateStr) return null;

  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd = new Date(dayStart);
  dayEnd.setDate(dayEnd.getDate() + 1);

  const list = cal.getEvents().filter((ev) => {
    const start = ev.start ? new Date(ev.start) : null;
    const end = ev.end ? new Date(ev.end) : start;
    if (!start || !end) return false;
    return start < dayEnd && end >= dayStart;
  });

  list.sort((a, b) => {
    const aMs = a.start ? new Date(a.start).getTime() : 0;
    const bMs = b.start ? new Date(b.start).getTime() : 0;
    return aMs - bMs;
  });

  return list[0] || null;
}

function openDateContextMenu(x, y, dateStr) {
  const firstEvent = getFirstEventOnDate(dateStr);
  const hasDateSticky = Number(window.getDateStickyCount?.(dateStr) || 0) > 0;
  const precisionLabel = getDragPrecisionModeLabel();

  const menu = ensureContextMenu();
  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="create" title="Create Event">➕ Create Event</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item" data-action="edit" title="Edit">✏️ Edit</div>
    <div class="ctx-menu-item" data-action="sticky" title="New Sticky Note">🗒 New Sticky Note</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item" data-action="toggle-precision" title="Toggle drag confirmation">🎯 Precision Drag: ${precisionLabel}</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item danger" data-action="delete" title="Delete">🗑 Delete</div>
  `;
  positionContextMenu(menu, x, y);

  menu.querySelector("[data-action='create']").onclick = () => {
    closeContextMenu();
    const date = new Date(dateStr + "T00:00:00");
    window.openCreateModal?.(date);
  };

  menu.querySelector("[data-action='edit']").onclick = () => {
    closeContextMenu();
    if (firstEvent) {
      window.openCreateModal?.(null, firstEvent);
      return;
    }
    const date = new Date(dateStr + "T00:00:00");
    window.openCreateModal?.(date);
  };

  menu.querySelector("[data-action='sticky']").onclick = () => {
    closeContextMenu();
    if (firstEvent) {
      window.openStickyModalForNew?.(firstEvent);
      return;
    }
    window.openDateStickyModal?.(dateStr);
  };

  menu.querySelector("[data-action='toggle-precision']").onclick = () => {
    closeContextMenu();
    setDragPrecisionMode(!window.dragPrecisionMode);
  };

  menu.querySelector("[data-action='delete']").onclick = async () => {
    closeContextMenu();
    if (firstEvent) {
      window.editingEventId = firstEvent.extendedProps?.backendId || Number(firstEvent.id);
      await window.deleteEvent?.();
      return;
    }
    if (hasDateSticky) {
      await window.deleteDateStickyNote?.(dateStr);
      return;
    }
    window.showToast?.("No event or sticky note in this block", "error");
  };
}

function closeContextMenu() {
  const menu = document.getElementById("eventContextMenu");
  if (menu) menu.classList.remove("visible");
}

document.addEventListener("click", () => closeContextMenu());
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeContextMenu();
});

// =========================================================
// ✅ SELECTED EVENT STATE (single source of truth)
// Highlight one event at a time across all views.
// =========================================================
window.selectedEventId = null;

function setSelectedEvent(id) {
  const strId = id ? String(id) : null;
  window.selectedEventId = strId;
  console.log("✅ SELECTED EVENT:", window.selectedEventId);
  if (window.calendar) {
    window.calendar.refetchEvents();
  }
}
window.setSelectedEvent = setSelectedEvent;

function setSelectedDateFromInteraction(dateLike) {
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return;

  const dateStr = toDayString(d);
  window.selectedDate = dateStr;
  highlightSelectedDay(dateStr);
  window.updateDayDetails?.();
  window.updateWeekView?.();
  window.dispatchEvent(new Event("selectedDateChanged"));
}

// =========================================================
// ✅ VIEW-SWITCH TRACKING — used by datesSet to navigate
// to selectedDate when the user switches Month/Week/Day.
// =========================================================
let _prevViewType = null;
let _navigatingToSelected = false;
let stickyDragPayload = null;
let highlightedDropEl = null;
let mobileShowAllDays = true;
let mobileShowEarlyHours = false;
let mobileShowLateHours = false;
let lastAppliedHiddenDaysKey = "";
let lastAppliedTimeWindowKey = "";
const DRAG_PRECISION_STORAGE_KEY = "sj_drag_precision_mode_v1";

function loadDragPrecisionMode() {
  try {
    const raw = localStorage.getItem(DRAG_PRECISION_STORAGE_KEY);
    if (raw === null) {
      window.dragPrecisionMode = true;
      return;
    }
    window.dragPrecisionMode = raw !== "0";
  } catch {
    window.dragPrecisionMode = true;
  }
}

function setDragPrecisionMode(enabled) {
  window.dragPrecisionMode = !!enabled;
  try {
    localStorage.setItem(DRAG_PRECISION_STORAGE_KEY, window.dragPrecisionMode ? "1" : "0");
  } catch {
    // ignore localStorage failures
  }
  window.showToast?.(`Precision drag ${window.dragPrecisionMode ? "ON" : "OFF"}`);
}

function getDragPrecisionModeLabel() {
  return window.dragPrecisionMode ? "ON" : "OFF";
}

const WEEK_HEADER_COLOR_STORAGE_KEY = "sj_week_header_color_v1";
const DEFAULT_WEEK_HEADER_COLOR = "#12c7b5";

function normalizeHexColor(value) {
  const v = String(value || "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(v)) return null;
  return v.toLowerCase();
}

function applyWeekHeaderColor(color) {
  const next = normalizeHexColor(color) || DEFAULT_WEEK_HEADER_COLOR;
  document.documentElement.style.setProperty("--week-header-color", next);
  window.weekHeaderColor = next;
}

function loadWeekHeaderColor() {
  try {
    const stored = localStorage.getItem(WEEK_HEADER_COLOR_STORAGE_KEY);
    applyWeekHeaderColor(stored || DEFAULT_WEEK_HEADER_COLOR);
  } catch {
    applyWeekHeaderColor(DEFAULT_WEEK_HEADER_COLOR);
  }
}

function openWeekHeaderColorPicker() {
  let picker = document.getElementById("weekHeaderColorPicker");
  if (!picker) {
    picker = document.createElement("input");
    picker.id = "weekHeaderColorPicker";
    picker.type = "color";
    picker.style.position = "fixed";
    picker.style.left = "-9999px";
    picker.style.top = "-9999px";
    picker.style.opacity = "0";
    picker.style.pointerEvents = "none";
    picker.addEventListener("input", (e) => {
      const next = e.target?.value || DEFAULT_WEEK_HEADER_COLOR;
      applyWeekHeaderColor(next);
      try {
        localStorage.setItem(WEEK_HEADER_COLOR_STORAGE_KEY, window.weekHeaderColor || next);
      } catch {
        // ignore localStorage errors
      }
    });
    document.body.appendChild(picker);
  }

  picker.value = normalizeHexColor(window.weekHeaderColor) || DEFAULT_WEEK_HEADER_COLOR;
  picker.click();
}

function toDateTimeLocalValue(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parseDateTimeLocalValue(value, fallback) {
  if (!value) return fallback instanceof Date ? fallback : null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback instanceof Date ? fallback : null;
  return parsed;
}

function ensureDragPrecisionModal() {
  let overlay = document.getElementById("dragPrecisionOverlay");
  if (overlay) return overlay;

  overlay = document.createElement("div");
  overlay.id = "dragPrecisionOverlay";
  overlay.style.cssText = "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,0.35);z-index:1000002;";
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:10px;padding:14px;min-width:320px;max-width:94vw;box-shadow:0 16px 40px rgba(0,0,0,0.25)">
      <h4 style="margin:0 0 8px 0;color:#1e293b">Confirm Event Drop</h4>
      <p id="dragPrecisionMessage" style="margin:0 0 10px 0;color:#475569;font-size:13px"></p>
      <label style="display:block;font-size:12px;color:#334155;margin-bottom:3px">Start</label>
      <input id="dragPrecisionStart" type="datetime-local" style="width:100%;margin-bottom:8px;padding:6px;border:1px solid #cbd5e1;border-radius:6px" />
      <label style="display:block;font-size:12px;color:#334155;margin-bottom:3px">End</label>
      <input id="dragPrecisionEnd" type="datetime-local" style="width:100%;margin-bottom:12px;padding:6px;border:1px solid #cbd5e1;border-radius:6px" />
      <div style="display:flex;justify-content:flex-end;gap:8px">
        <button id="dragPrecisionCancel" type="button" style="padding:6px 10px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc;cursor:pointer">Cancel</button>
        <button id="dragPrecisionConfirm" type="button" style="padding:6px 10px;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer">Apply</button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  return overlay;
}

function confirmEventMoveWithPrecision({ title, start, end }) {
  return new Promise((resolve) => {
    const overlay = ensureDragPrecisionModal();
    const msgEl = overlay.querySelector("#dragPrecisionMessage");
    const startInput = overlay.querySelector("#dragPrecisionStart");
    const endInput = overlay.querySelector("#dragPrecisionEnd");
    const cancelBtn = overlay.querySelector("#dragPrecisionCancel");
    const confirmBtn = overlay.querySelector("#dragPrecisionConfirm");

    if (!startInput || !endInput || !cancelBtn || !confirmBtn) {
      resolve({ confirmed: false, start, end });
      return;
    }

    if (msgEl) {
      msgEl.textContent = `${title || "Event"} - review or type exact date/time before saving.`;
    }
    startInput.value = toDateTimeLocalValue(start);
    endInput.value = toDateTimeLocalValue(end || start);
    overlay.style.display = "flex";

    const close = (result) => {
      overlay.style.display = "none";
      cancelBtn.onclick = null;
      confirmBtn.onclick = null;
      resolve(result);
    };

    cancelBtn.onclick = () => close({ confirmed: false, start, end });
    confirmBtn.onclick = () => {
      const nextStart = parseDateTimeLocalValue(startInput.value, start) || start;
      let nextEnd = parseDateTimeLocalValue(endInput.value, end || start) || end || start;
      if (nextStart && nextEnd && nextEnd <= nextStart) {
        nextEnd = new Date(nextStart.getTime() + 30 * 60000);
      }
      close({ confirmed: true, start: nextStart, end: nextEnd });
    };
  });
}

loadDragPrecisionMode();
loadWeekHeaderColor();

function setStickyDragPayload(payload) {
  stickyDragPayload = payload;
}

function clearStickyDragPayload() {
  stickyDragPayload = null;
  clearDropHighlight();
}

function beginStickyDrag(payload, e) {
  if (!payload) return;
  setStickyDragPayload(payload);

  if (e?.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    const marker = payload.scope === "date"
      ? `date:${payload.dateKey || ""}`
      : `event:${payload.fcEventId || payload.eventId || ""}`;
    e.dataTransfer.setData("text/plain", marker);
    e.dataTransfer.setData("application/x-sherryjo-sticky", JSON.stringify(payload));
  }
}

window.beginStickyDrag = beginStickyDrag;
window.clearStickyDragPayload = clearStickyDragPayload;

function getDateFromNode(node, root) {
  let ptr = node;
  while (ptr && ptr !== root) {
    if (ptr.dataset?.date) return ptr.dataset.date;
    ptr = ptr.parentElement;
  }
  return null;
}

function getDateTargetElement(node, root) {
  let ptr = node;
  while (ptr && ptr !== root) {
    if (ptr.dataset?.date) return ptr;
    ptr = ptr.parentElement;
  }
  return null;
}

function clearDropHighlight() {
  if (!highlightedDropEl) return;
  highlightedDropEl.classList.remove("stickyDropTarget");
  highlightedDropEl.classList.remove("stickyDropTargetEvent");
  highlightedDropEl = null;
}

function setDropHighlight(el, mode) {
  if (!el) return;
  if (highlightedDropEl === el) return;

  clearDropHighlight();
  highlightedDropEl = el;
  if (mode === "event") {
    highlightedDropEl.classList.add("stickyDropTargetEvent");
  } else {
    highlightedDropEl.classList.add("stickyDropTarget");
  }
}

const CALENDAR_LAYOUT_PROFILES = {
  mobile: {
    defaultView: "timeGridWeek",
    eventMaxStack: 8,
    dayMaxEvents: 6,
    slotDuration: "00:30:00",
    slotLabelInterval: "02:00:00",
    slotMinTime: "06:00:00",
    slotMaxTime: "18:00:00",
    allDaySlot: false,
    expandRows: false,
    toolbarLeft: "today prev,next",
    toolbarCenter: "title",
    toolbarRight: "earlyHoursToggle,lateHoursToggle,mobileDaysToggle timeGridWeek,timeGridDay,dayGridMonth"
  },
  tablet: {
    defaultView: "timeGridWeek",
    eventMaxStack: 10,
    dayMaxEvents: 8,
    slotDuration: "00:30:00",
    slotLabelInterval: "01:00:00",
    slotMinTime: "06:00:00",
    slotMaxTime: "22:00:00",
    allDaySlot: true,
    expandRows: true,
    toolbarLeft: "today prev,next",
    toolbarCenter: "title",
    toolbarRight: "earlyHoursToggle,lateHoursToggle timeGridWeek,timeGridDay,dayGridMonth"
  },
  desktop: {
    defaultView: "dayGridMonth",
    eventMaxStack: 6,
    dayMaxEvents: 6,
    slotDuration: "00:30:00",
    slotLabelInterval: "01:00:00",
    slotMinTime: "00:00:00",
    slotMaxTime: "24:00:00",
    allDaySlot: true,
    expandRows: true,
    toolbarLeft: "title",
    toolbarCenter: "",
    toolbarRight: "today prev,next dayGridMonth,timeGridWeek,timeGridDay"
  },
  large: {
    defaultView: "dayGridMonth",
    eventMaxStack: 10,
    dayMaxEvents: 10,
    slotDuration: "00:15:00",
    slotLabelInterval: "01:00:00",
    slotMinTime: "00:00:00",
    slotMaxTime: "24:00:00",
    allDaySlot: true,
    expandRows: true,
    toolbarLeft: "title",
    toolbarCenter: "",
    toolbarRight: "today prev,next dayGridMonth,timeGridWeek,timeGridDay"
  }
};

function getCalendarProfile(mode) {
  return CALENDAR_LAYOUT_PROFILES[mode] || CALENDAR_LAYOUT_PROFILES.desktop;
}

function getCalendarHeightForMode(mode) {
  const viewportHeight = Math.max(540, window.innerHeight || 700);

  if (mode === "mobile") {
    return Math.max(520, viewportHeight - 190);
  }
  if (mode === "tablet") {
    return Math.max(620, viewportHeight - 185);
  }
  if (mode === "large") {
    return Math.max(900, viewportHeight - 165);
  }
  return Math.max(700, viewportHeight - 170);
}

function toHourToken(hourValue) {
  return `${String(Math.max(0, Math.min(24, hourValue))).padStart(2, "0")}:00:00`;
}

function stripLeadingTimeRange(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const stripped = raw
    // e.g. "8:00 - 10:00 Title"
    .replace(/^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*[-–—]\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*/i, "")
    // e.g. "8:00 10:00 Title" or "8:0010:00 Title"
    .replace(/^\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?(?:\s+|\s*[-–—]?\s*)\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*/i, "")
    .trim();
  return stripped || raw;
}

function formatCompactTimeRange(eventObj) {
  const start = eventObj?.start instanceof Date ? eventObj.start : null;
  if (!start || Number.isNaN(start.getTime())) return "";

  const end = eventObj?.end instanceof Date ? eventObj.end : null;
  const formatClock = (d) => {
    const h24 = d.getHours();
    const h12 = h24 % 12 || 12;
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${h12}:${mm}`;
  };

  const startLabel = formatClock(start);
  if (!end || Number.isNaN(end.getTime())) return startLabel;

  // For FullCalendar end-exclusive minute-equivalent ranges, still show clean range.
  const endLabel = formatClock(end);
  return `${startLabel} ${endLabel}`;
}

function getCalendarDayDiff(start, end) {
  if (!(start instanceof Date) || !(end instanceof Date)) return 0;
  const s = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const e = new Date(end.getFullYear(), end.getMonth(), end.getDate());
  return Math.max(0, Math.round((e.getTime() - s.getTime()) / 86400000));
}

function classifyEventPriority(fcEvent, durationMs = 0) {
  const start = fcEvent?.start ? new Date(fcEvent.start) : null;
  const end = fcEvent?.end ? new Date(fcEvent.end) : start;
  const durHours = durationMs / 3600000;
  const allDay = !!fcEvent?.allDay;
  const titleLen = String(fcEvent?.title || "").trim().length;
  const detailLen = String(fcEvent?.extendedProps?.description || "").trim().length;
  const dayDiff = getCalendarDayDiff(start, end || start);
  const isMultiDaySpanning = dayDiff >= 1;

  // Numeric priority formula (lower = lower visual layer priority).
  // 0: multi-day spanning
  // 1: all-day informational blocks
  // 2: short timed events (<= 1h)
  // 3: timed events > 1h and < 2h
  // 4: timed events >= 2h (must get 3-4 grid blocks)
  let score = 2;
  if (isMultiDaySpanning) {
    score = 0;
  } else if (allDay) {
    score = 1;
  } else if (durHours >= 2) {
    score = 4;
  } else if (durHours > 1) {
    score = 3;
  } else {
    score = 2;
  }

  const lane = score < 2 ? "back" : "front";

  // Display width guidance (1, 2, 3-4 grid blocks).
  let spanBlocks = 1;
  if (score >= 4) {
    spanBlocks = (titleLen + detailLen) >= 54 ? 4 : 3;
  } else if (score >= 3) {
    spanBlocks = 2;
  }

  return { score, lane, spanBlocks };
}

function formatCompactWeekTitle(start, endExclusive) {
  if (!(start instanceof Date) || !(endExclusive instanceof Date)) return "";
  const end = new Date(endExclusive);
  end.setDate(end.getDate() - 1);

  const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
  const m1 = start.toLocaleDateString(undefined, { month: "short" });
  const m2 = end.toLocaleDateString(undefined, { month: "short" });
  const y = end.getFullYear();

  if (sameMonth) return `${m1} ${start.getDate()} - ${end.getDate()}, ${y}`;
  return `${m1} ${start.getDate()} - ${m2} ${end.getDate()}, ${y}`;
}

function applyCompactToolbarTitle() {
  const cal = window.calendar;
  if (!cal) return;

  const mode = window.layoutMode;
  if (mode !== "mobile" && mode !== "tablet") return;

  const titleEl = document.querySelector(".fc-toolbar-title");
  if (!titleEl) return;

  const view = cal.view;
  const viewType = view?.type || "";
  let text = titleEl.textContent || "";

  if (viewType === "timeGridWeek") {
    text = formatCompactWeekTitle(new Date(view.currentStart), new Date(view.currentEnd));
  } else if (viewType === "dayGridMonth") {
    text = new Date(view.currentStart).toLocaleDateString(undefined, { month: "long", year: "numeric" });
  } else if (viewType === "timeGridDay") {
    const d = new Date(view.currentStart);
    text = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  titleEl.textContent = text;
  titleEl.style.whiteSpace = "nowrap";
  titleEl.style.textOverflow = "clip";
  titleEl.style.overflow = "visible";

  const baseSize = mode === "mobile" ? 11 : 12;
  let fontSize = baseSize;
  titleEl.style.fontSize = `${fontSize}px`;

  const parent = titleEl.parentElement;
  const maxWidth = Math.max(72, parent?.clientWidth || 180);

  while (titleEl.scrollWidth > maxWidth && fontSize > 8) {
    fontSize -= 0.5;
    titleEl.style.fontSize = `${fontSize}px`;
  }
}

function updateMobileDaysToggleLabel() {
  const btn = document.querySelector(".fc-mobileDaysToggle-button");
  if (!btn) return;
  btn.textContent = mobileShowAllDays ? "Focus" : "All Days";
}

function updateMobileHourToggleLabels() {
  const earlyBtn = document.querySelector(".fc-earlyHoursToggle-button");
  if (earlyBtn) {
    earlyBtn.textContent = mobileShowEarlyHours ? "6a-" : "6a+";
  }
  const lateBtn = document.querySelector(".fc-lateHoursToggle-button");
  if (lateBtn) {
    lateBtn.textContent = mobileShowLateHours ? "6p-" : "6p+";
  }
}

function getViewEventsInRange(rangeStart, rangeEnd) {
  const cache = window.sessionEventCache || [];
  return cache.filter((ev) => {
    const start = ev?.start ? new Date(ev.start) : null;
    const end = ev?.end ? new Date(ev.end) : start;
    if (!start || Number.isNaN(start.getTime())) return false;
    if (!end || Number.isNaN(end.getTime())) return false;
    return start < rangeEnd && end >= rangeStart;
  });
}

function applyMobileWeekCompression() {
  const cal = window.calendar;
  if (!cal) return;

  if (window.layoutMode !== "mobile" && window.layoutMode !== "tablet") {
    const emptyKey = "[]";
    if (lastAppliedHiddenDaysKey !== emptyKey) {
      cal.setOption("hiddenDays", []);
      lastAppliedHiddenDaysKey = emptyKey;
    }
    return;
  }

  const view = cal.view;
  if (!view || (view.type !== "timeGridWeek" && view.type !== "timeGridDay")) {
    const emptyKey = "[]";
    if (lastAppliedHiddenDaysKey !== emptyKey) {
      cal.setOption("hiddenDays", []);
      lastAppliedHiddenDaysKey = emptyKey;
    }

    const profile = getCalendarProfile(window.layoutMode || "desktop");
    const defaultWindowKey = `${profile.slotMinTime}|${profile.slotMaxTime}`;
    if (lastAppliedTimeWindowKey !== defaultWindowKey) {
      cal.setOption("slotMinTime", profile.slotMinTime);
      cal.setOption("slotMaxTime", profile.slotMaxTime);
      lastAppliedTimeWindowKey = defaultWindowKey;
    }

    setTimeout(updateMobileDaysToggleLabel, 0);
    setTimeout(updateMobileHourToggleLabels, 0);
    return;
  }

  const rangeStart = view.activeStart ? new Date(view.activeStart) : null;
  const rangeEnd = view.activeEnd ? new Date(view.activeEnd) : null;
  if (!rangeStart || !rangeEnd) return;

  if (view.type === "timeGridDay") {
    const hiddenKey = "[]";
    if (lastAppliedHiddenDaysKey !== hiddenKey) {
      cal.setOption("hiddenDays", []);
      lastAppliedHiddenDaysKey = hiddenKey;
    }
  }

  const visibleEvents = getViewEventsInRange(rangeStart, rangeEnd);

  const isMobileMode = window.layoutMode === "mobile";
  let minHour = isMobileMode ? 6 : 6;
  let maxHour = isMobileMode ? 18 : 22;

  if (visibleEvents.length) {
    let earliest = 24;
    let latest = 0;

    visibleEvents.forEach((ev) => {
      const s = new Date(ev.start);
      const e = ev.end ? new Date(ev.end) : s;
      earliest = Math.min(earliest, s.getHours());
      latest = Math.max(latest, e.getHours() + (e.getMinutes() > 0 ? 1 : 0));
    });

    minHour = Math.max(isMobileMode ? 6 : 5, earliest - 1);
    maxHour = Math.min(isMobileMode ? 22 : 24, latest + 1);
    if (maxHour - minHour < 8) {
      maxHour = Math.min(isMobileMode ? 22 : 24, minHour + (isMobileMode ? 8 : 10));
    }
  }

  if (mobileShowEarlyHours) {
    minHour = 0;
  }
  if (mobileShowLateHours) {
    maxHour = 24;
  }

  const minToken = toHourToken(minHour);
  const maxToken = toHourToken(maxHour);
  const timeWindowKey = `${minToken}|${maxToken}`;

  if (lastAppliedTimeWindowKey !== timeWindowKey) {
    cal.setOption("slotMinTime", minToken);
    cal.setOption("slotMaxTime", maxToken);
    lastAppliedTimeWindowKey = timeWindowKey;
  }

  const activeDows = new Set();
  visibleEvents.forEach((ev) => {
    const start = new Date(ev.start);
    if (!Number.isNaN(start.getTime())) {
      activeDows.add(start.getDay());
    }
  });

  let hiddenDays = [];
  if (view.type === "timeGridWeek" && isMobileMode && !mobileShowAllDays) {
    hiddenDays = [0, 1, 2, 3, 4, 5, 6].filter((dow) => !activeDows.has(dow));
    if (hiddenDays.length >= 6) {
      hiddenDays = [0, 1, 2, 3, 4, 5, 6].filter((dow) => dow !== new Date(window.selectedDate || Date.now()).getDay());
    }
  }

  const hiddenKey = JSON.stringify(hiddenDays);
  if (lastAppliedHiddenDaysKey !== hiddenKey) {
    cal.setOption("hiddenDays", hiddenDays);
    lastAppliedHiddenDaysKey = hiddenKey;
  }

  setTimeout(updateMobileDaysToggleLabel, 0);
  setTimeout(updateMobileHourToggleLabels, 0);
}

export function applyCalendarLayoutMode(mode, { switchView = false } = {}) {
  const cal = window.calendar;
  if (!cal) return;

  const profile = getCalendarProfile(mode);

  cal.setOption("headerToolbar", {
    left: profile.toolbarLeft,
    center: profile.toolbarCenter,
    right: profile.toolbarRight
  });
  cal.setOption("eventMaxStack", profile.eventMaxStack);
  cal.setOption("dayMaxEvents", profile.dayMaxEvents);
  cal.setOption("slotDuration", profile.slotDuration);
  cal.setOption("slotLabelInterval", profile.slotLabelInterval);
  cal.setOption("slotMinTime", profile.slotMinTime);
  cal.setOption("slotMaxTime", profile.slotMaxTime);
  cal.setOption("allDaySlot", profile.allDaySlot);
  cal.setOption("expandRows", profile.expandRows);
  const useOverlap = mode === "mobile" || mode === "tablet";
  cal.setOption("slotEventOverlap", useOverlap);
  cal.setOption("height", getCalendarHeightForMode(mode));
  cal.setOption("contentHeight", "auto");

  if (mode !== "mobile" && mode !== "tablet") {
    mobileShowAllDays = false;
    mobileShowEarlyHours = false;
    mobileShowLateHours = false;
    lastAppliedHiddenDaysKey = "";
    lastAppliedTimeWindowKey = "";
    cal.setOption("hiddenDays", []);
  }

  if (switchView && cal.view?.type !== profile.defaultView) {
    cal.changeView(profile.defaultView);
    if (window.selectedDate) {
      cal.gotoDate(window.selectedDate);
    }
  }

  applyMobileWeekCompression();
  updateMobileHourToggleLabels();
  setTimeout(() => applyCompactToolbarTitle(), 0);
  setTimeout(() => renderVisibleDateStickyIcons(), 70);
}

window.applyCalendarLayoutMode = applyCalendarLayoutMode;

/**
 * ==========================================================
 * ✅ FULLCALENDAR INIT (EXPORTED — SINGLE SOURCE OF TRUTH)
 * ==========================================================
 * This MUST be imported — never global
 * ==========================================================
 */
export function initFullCalendar() {

  const el = document.getElementById("calendar");
  if (!el) {
    console.warn("⚠️ Missing #calendar element");
    return;
  }

  console.log("✅ Initializing FullCalendar");

  // ✅ SAFE DEFAULT DATE
  if (!window.selectedDate) {
    const today = new Date();
    window.selectedDate = toDayString(today);
  }

  const initialLayoutMode = window.layoutMode || "desktop";
  const initialProfile = getCalendarProfile(initialLayoutMode);
  const initialUseOverlap = initialLayoutMode === "mobile" || initialLayoutMode === "tablet";

  window.calendar = new FullCalendar.Calendar(el, {

    /* ✅ UNIFIED HEADER ROW */
    headerToolbar: {
      left: initialProfile.toolbarLeft,
      center: initialProfile.toolbarCenter,
      right: initialProfile.toolbarRight
    },

    initialView: initialProfile.defaultView,
    eventMaxStack: initialProfile.eventMaxStack,
    dayMaxEvents: initialProfile.dayMaxEvents,
    slotDuration: initialProfile.slotDuration,
    slotLabelInterval: initialProfile.slotLabelInterval,
    slotMinTime: initialProfile.slotMinTime,
    slotMaxTime: initialProfile.slotMaxTime,
    allDaySlot: initialProfile.allDaySlot,
    expandRows: initialProfile.expandRows,
    slotEventOverlap: initialUseOverlap,
    height: getCalendarHeightForMode(initialLayoutMode),
    contentHeight: "auto",

    customButtons: {
      mobileDaysToggle: {
        text: "All Days",
        click: () => {
          mobileShowAllDays = !mobileShowAllDays;
          lastAppliedHiddenDaysKey = "";
          applyMobileWeekCompression();
          updateMobileDaysToggleLabel();
        }
      },
      earlyHoursToggle: {
        text: "Early",
        click: () => {
          mobileShowEarlyHours = !mobileShowEarlyHours;
          lastAppliedTimeWindowKey = "";
          applyMobileWeekCompression();
          updateMobileHourToggleLabels();
        }
      },
      lateHoursToggle: {
        text: "Late",
        click: () => {
          mobileShowLateHours = !mobileShowLateHours;
          lastAppliedTimeWindowKey = "";
          applyMobileWeekCompression();
          updateMobileHourToggleLabels();
        }
      }
    },

    /* ✅ ✅ ✅ ADD THIS BLOCK RIGHT HERE */
    buttonText: {
      dayGridMonth: "Month",
      timeGridWeek: "Week",
      timeGridDay: "Day"
    },

    // ✅ Week starts Sunday; editable/selectable enable drag+click
    firstDay: 0,
    editable:   true,
    droppable:  false,
    selectable: true,
    snapDuration: "00:05:00",
    dragRevertDuration: 180,
    eventDragMinDistance: 8,

    eventDisplay: "block",

    // =========================================================
    // ✅ PHASE 4: EVENT CLASS NAMES — highlight selected event
    // eventClassNames fires on every render; returns
    // ['event-selected'] for the matching event only.
    // =========================================================
    eventClassNames: function(arg) {
      return String(arg.event.id) === String(window.selectedEventId)
        ? ['event-selected']
        : [];
    },

    events: function(fetchInfo, successCallback) {
      if (!window.sessionEventCache) {
        console.warn("❌ No cache yet");
        successCallback([]);
        return;
      }

      const rangeStart = new Date(fetchInfo.start);
      const rangeEnd = new Date(fetchInfo.end);

      const sourceEvents = typeof window.getFilteredEvents === "function"
        ? window.getFilteredEvents({ start: rangeStart, end: rangeEnd })
        : window.sessionEventCache;

      const activeFilters = typeof window.getActiveAccountFilters === "function"
        ? window.getActiveAccountFilters()
        : new Set();

      const isAccountVisible = (eventLike) => {
        if (!activeFilters || activeFilters.size === 0) return true;

        const directKey = eventLike?.extendedProps?.account_key;
        if (directKey) return activeFilters.has(directKey);

        const provider = normalizeProvider(eventLike?.extendedProps?.source || eventLike?.source || "local");
        const account = (
          eventLike?.extendedProps?.account ||
          eventLike?.extendedProps?.account_email ||
          eventLike?.account ||
          eventLike?.account_email ||
          "local"
        ).toLowerCase().trim();

        return activeFilters.has(`${provider}:${account}`);
      };

      const events = sourceEvents.map(ev => {

        const provider = normalizeProvider(ev.extendedProps?.source);

        let email = ev.extendedProps?.account || "";

        // ✅ STRIP BAD SUFFIX
        email = email.split(" ")[0];

        email = email.toLowerCase().trim();

        const key = `${provider}:${email}`;
        const raw =
          (window.getColorByKey && window.getColorByKey(key)) ||
          "#4285f4";

        const soft =
          (window.applySoftColor && window.applySoftColor(raw)) ||
          raw;

        return {
          ...ev,
          backgroundColor: soft,
          borderColor: raw,
          textColor:
            (window.getBestTextColor &&
            window.getBestTextColor(soft)) ||
            "#000"
        };

      }).filter(ev => {

        if (!isAccountVisible(ev)) {
          return false;
        }

        const evStart = new Date(ev.start);
        const evEnd = ev.end ? new Date(ev.end) : evStart;

        return evStart <= rangeEnd && evEnd >= rangeStart;
      });

      console.log("✅ EVENTS SENT:", events.length);

      successCallback(events);
    },
    eventDidMount: function(info) {

      info.el.dataset.eventId = String(info.event.id || "");

      
      const provider = normalizeProvider(info.event.extendedProps?.source);

      let email = info.event.extendedProps?.account || "";

      // ✅ REMOVE ANY TRAILING " 2", " 3", ETC
      email = email.split(" ")[0];

      email = email.toLowerCase().trim();

      const key = `${provider}:${email}`;

      const raw =
        (window.getColorByKey && window.getColorByKey(key)) || "#4285f4";

      const soft =
        (window.applySoftColor && window.applySoftColor(raw)) || raw;

      info.el.style.setProperty("--event-accent", raw);

      const mode = window.layoutMode;
      const viewType = window.calendar?.view?.type || "";
      const evStart = info.event.start ? new Date(info.event.start) : null;
      const evEnd = info.event.end ? new Date(info.event.end) : evStart;
      const durationMs = evStart && evEnd ? Math.max(0, evEnd.getTime() - evStart.getTime()) : 0;
      const isLongEvent = durationMs >= 90 * 60000;
      const isSmallWeekView = (mode === "mobile" || mode === "tablet") && (viewType === "timeGridWeek" || viewType === "timeGridDay");
      const priority = classifyEventPriority(info.event, durationMs);
      const isBackLayer = priority.lane === "back";
      const spanBlocks = priority.spanBlocks;

      if (isSmallWeekView && isLongEvent && !isBackLayer) {
        info.el.classList.add("fc-event-long-mobile");
      }

      const isWeekLikeView = viewType === "timeGridWeek" || viewType === "timeGridDay";
      if (isWeekLikeView) {
        const stickyCount = stickyCountFromNotes(info.event.extendedProps?.stickyNotes || [], info.event.extendedProps?.stickyNote);

        info.el.classList.remove("fc-event-priority-front", "fc-event-priority-back", "fc-event-priority-sticky", "fc-event-priority-active");
        if (isBackLayer) {
          info.el.classList.add("fc-event-priority-back");
          info.el.style.zIndex = "2";
        } else if (stickyCount > 0) {
          info.el.classList.add("fc-event-priority-sticky", "fc-event-priority-front");
          info.el.style.zIndex = String(priority.score >= 4 ? 18 : priority.score >= 3 ? 14 : 10);
        } else {
          info.el.classList.add("fc-event-priority-front");
          info.el.style.zIndex = String(priority.score >= 4 ? 16 : priority.score >= 3 ? 12 : 8);
        }

        if (String(info.event.id) === String(window.selectedEventId)) {
          info.el.classList.add("fc-event-priority-active");
          info.el.style.zIndex = "30";
        }

        const harness = info.el.closest(".fc-timegrid-event-harness");
        if (harness) {
          harness.classList.remove("fc-harness-priority-front", "fc-harness-priority-back", "fc-harness-priority-active");
          if (isBackLayer) {
            harness.classList.add("fc-harness-priority-back");
          } else {
            harness.classList.add("fc-harness-priority-front");
          }

          if (String(info.event.id) === String(window.selectedEventId)) {
            harness.classList.add("fc-harness-priority-active");
          }
        }
      }

      // ✅ KILL fullcalendar default wrapper styles
      info.el.style.background = "transparent";
      info.el.style.border = "none";

      // ✅ TARGET ACTUAL CONTENT
      const inner = info.el.querySelector(".fc-event-main");

      if (inner) {
        inner.style.backgroundColor = soft;
        inner.style.boxShadow = "inset 0 0 0 9999px " + soft;
        inner.style.borderLeft = `4px solid ${raw}`;
        inner.style.borderRadius = "6px";
        inner.style.padding = "0 4px";
        inner.style.fontSize = "11px";
        inner.style.color = "#111827";
        if (isSmallWeekView) {
          const compactWidthPx = Math.max(180, info.el.clientWidth || 0);
          const visibleSource = getBestCompactEventText(info.event);
          const brief = summarizeText(visibleSource || "Untitled", compactWidthPx <= 220 ? 30 : 36);
          const titleNode = info.el.querySelector(".fc-event-title");
          const titleContainerNode = info.el.querySelector(".fc-event-title-container");
          const timeNode = info.el.querySelector(".fc-event-time");
          const frameNode = inner.querySelector(".fc-event-main-frame") || inner;
          let compactTimeNode = frameNode.querySelector(".fc-compact-event-time");

          // Remove legacy custom compact title nodes from previous renders.
          frameNode.querySelectorAll(".fc-compact-event-title").forEach((n) => n.remove());

          // Keep all compact content clipped inside the event shell.
          info.el.style.setProperty("overflow", "hidden", "important");
          frameNode.style.display = "flex";
          frameNode.style.flexDirection = "column";
          frameNode.style.alignItems = "stretch";
          frameNode.style.justifyContent = "flex-start";
          frameNode.style.alignContent = "flex-start";
          frameNode.style.flexWrap = "nowrap";
          frameNode.style.rowGap = "0";
          frameNode.style.gap = "0";
          frameNode.style.width = "100%";
          frameNode.style.minWidth = "0";
          frameNode.style.overflow = "hidden";

          if (!compactTimeNode) {
            compactTimeNode = document.createElement("span");
            compactTimeNode.className = "fc-compact-event-time";
            frameNode.insertBefore(compactTimeNode, frameNode.firstChild || null);
          }

          if (compactTimeNode) {
            compactTimeNode.style.display = "block";
            compactTimeNode.style.fontWeight = "500";
            compactTimeNode.style.color = "#111827";
            compactTimeNode.style.whiteSpace = "nowrap";
            compactTimeNode.style.writingMode = "horizontal-tb";
            compactTimeNode.style.textOrientation = "mixed";
            compactTimeNode.style.fontSize = "10px";
            compactTimeNode.style.lineHeight = "1.0";
            compactTimeNode.style.width = "100%";
            compactTimeNode.style.minWidth = "0";
            compactTimeNode.style.alignSelf = "stretch";
            compactTimeNode.style.margin = "0";
            const compactRange = formatCompactTimeRange(info.event);
            compactTimeNode.textContent = compactRange || "";
          }

          if (titleNode) {
            titleNode.style.color = "#111827";
            titleNode.textContent = brief;
            titleNode.style.display = "block";
            titleNode.style.width = "100%";
            titleNode.style.minWidth = "0";
            titleNode.style.whiteSpace = "nowrap";
            titleNode.style.overflow = "hidden";
            titleNode.style.textOverflow = "ellipsis";
            titleNode.style.wordBreak = "normal";
            titleNode.style.overflowWrap = "normal";
            titleNode.style.writingMode = "horizontal-tb";
            titleNode.style.textOrientation = "mixed";
            titleNode.style.lineHeight = "1.0";
            titleNode.style.fontWeight = "500";
            titleNode.style.fontSize = "10px";
            titleNode.style.margin = "0";
            titleNode.style.marginTop = "-1px";
          }

          if (titleContainerNode) {
            titleContainerNode.style.display = "block";
            titleContainerNode.style.height = "auto";
            titleContainerNode.style.minHeight = "0";
            titleContainerNode.style.margin = "0";
            titleContainerNode.style.padding = "0";
            titleContainerNode.style.flex = "0 0 auto";
            titleContainerNode.style.overflow = "hidden";
          }

          if (timeNode) {
            timeNode.style.display = "none";
            timeNode.textContent = "";
          }

          const effectiveSpan = Math.max(2, spanBlocks);
          const spanPct = effectiveSpan >= 4 ? "400%" : effectiveSpan === 3 ? "300%" : "200%";
          info.el.style.setProperty("width", spanPct, "important");
          info.el.style.setProperty("max-width", effectiveSpan >= 4 ? "420px" : effectiveSpan === 3 ? "340px" : "260px", "important");
          info.el.style.setProperty("opacity", "1", "important");
          inner.style.opacity = "1";
          inner.style.color = "#111827";
          inner.style.fontWeight = "500";
        }

        const stickyList = info.event.extendedProps?.stickyNotes || [];
        const stickyCount = stickyCountFromNotes(stickyList, info.event.extendedProps?.stickyNote);
        if (stickyCount > 0) {
          const icon = buildStickyIcon({
            count: stickyCount,
            title: stickyCount > 1 ? `Open sticky notes (${stickyCount})` : "Open sticky note",
            dragPayload: {
              scope: "event",
              fcEventId: String(info.event.id)
            }
          });
          icon.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.openStickyModal?.(info.event);
          });

          icon.addEventListener("dblclick", (e) => {
            e.preventDefault();
            e.stopPropagation();
            window.editEventStickyNote?.(info.event);
          });

          icon.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openStickyIconContextMenu(e.clientX, e.clientY, {
              scope: "event",
              fcEvent: info.event,
              count: stickyCount
            });
          });

          inner.appendChild(icon);
        }
      }

      // =========================================================
      // ✅ RIGHT-CLICK CONTEXT MENU on events
      // =========================================================
      info.el.addEventListener("contextmenu", (e) => {
        const stickyTarget = e.target instanceof Element
          ? e.target.closest(".stickyEventIcon")
          : null;
        if (stickyTarget) {
          e.preventDefault();
          e.stopPropagation();
          openStickyIconContextMenu(e.clientX, e.clientY, {
            scope: "event",
            fcEvent: info.event,
            count: stickyCountFromNotes(
              info.event.extendedProps?.stickyNotes || [],
              info.event.extendedProps?.stickyNote
            )
          });
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, info.event);
      });

      info.el.title = getEventSummary(info.event);
    },

    // =========================================================
    // ✅ DATE CLICK — update selectedDate + sidebar.
    // Double-click (two clicks ≤280 ms) opens create modal.
    // Single click updates selectedDate and sidebars only —
    // NEVER changes the main calendar view.
    // =========================================================
    dateClick: function(info) {
      const dateStr = info.dateStr;
      console.log("DATE CLICK:", dateStr);

      // ✅ Double-click detection
      if (window._dateClickTimer && window._lastClickedDate === dateStr) {
        clearTimeout(window._dateClickTimer);
        window._dateClickTimer = null;
        window._lastClickedDate = null;
        console.log("DATE DBLCLICK → open create modal:", dateStr);
        if (typeof window.openCreateModal === "function") {
          window.openCreateModal(info.date);
        }
        return;
      }

      // ✅ First click — wait to see if second click arrives
      window._lastClickedDate = dateStr;
      window._dateClickTimer = setTimeout(() => {
        window._dateClickTimer = null;
        window._lastClickedDate = null;

        // ✅ SINGLE SOURCE OF TRUTH — update global selected date
        setSelectedDateFromInteraction(info.date);
        // Date click is also an interaction that clears explicit event focus.
        setSelectedEvent(null);

        console.log("DATE SINGLE CLICK → sidebar updated:", dateStr);
      }, 280);
    },

    // =========================================================
    // ✅ EVENT CLICK — single click selects; double-click opens editor.
    //
    // Native browser dblclick is unreliable inside FullCalendar
    // because eventClick calls stopPropagation(), disrupting the
    // browser's double-click detection sequence.
    // Solution: same timer-based detection used by dateClick.
    //
    //   First click  (≤280 ms gap) → wait for second click
    //   Second click (≤280 ms gap) → open edit modal
    //   First click  (>280 ms gap) → select event (highlight)
    // =========================================================
    eventClick: function(info) {
      info.jsEvent.preventDefault();
      info.jsEvent.stopPropagation();

      const id = String(
        info.event.extendedProps?.backendId ||
        info.event.id ||
        ""
      );

      // ✅ Double-click detection
      if (window._eventClickTimer && window._lastClickedEventId === id) {
        clearTimeout(window._eventClickTimer);
        window._eventClickTimer = null;
        window._lastClickedEventId = null;
        console.log("EVENT DBLCLICK →", info.event.title, id);
        window.openCreateModal?.(null, info.event);
        return;
      }

      // ✅ First click — wait to see if second arrives
      window._lastClickedEventId = id;
      window._eventClickTimer = setTimeout(() => {
        window._eventClickTimer = null;
        window._lastClickedEventId = null;
        console.log("EVENT SELECTED:", id, info.event.title);
        setSelectedDateFromInteraction(info.event.start || info.event.extendedProps?.start || info.event.startStr);
        setSelectedEvent(id);
      }, 280);
    },

    eventsSet: function() {
      if (typeof window.updateChipEventCounts === "function") {
        setTimeout(() => {
          window.updateChipEventCounts();
        }, 0);
      }
      applyMobileWeekCompression();
      setTimeout(() => applyGridHoverSummaries(), 40);
      setTimeout(() => applyMobileStartHourOutlines(), 55);
      setTimeout(() => applyCompactToolbarTitle(), 0);
    },

    datesSet: function(info) {
      const currentViewType = info.view.type;
      const cal = window.calendar;
      const previousViewType = _prevViewType;

      if (
        window.layoutMode === "mobile" &&
        previousViewType !== currentViewType &&
        currentViewType === "timeGridWeek"
      ) {
        mobileShowAllDays = true;
        lastAppliedHiddenDaysKey = "";
      }

      // =========================================================
      // ✅ PHASE 5: VIEW-SWITCH FIX
      // When the user clicks Month/Week/Day toolbar button,
      // navigate to selectedDate so it never resets to today.
      // Guard _navigatingToSelected prevents an infinite loop
      // (gotoDate triggers another datesSet).
      // =========================================================
      if (
        !_navigatingToSelected &&
        previousViewType !== null &&
        previousViewType !== currentViewType &&
        window.selectedDate &&
        cal
      ) {
        _prevViewType = currentViewType;
        _navigatingToSelected = true;
        console.log("SWITCH VIEW:", currentViewType, window.selectedDate);
        setTimeout(() => {
          cal.gotoDate(window.selectedDate);
          _navigatingToSelected = false;
          // Re-apply highlight in ALL views after navigation
          setTimeout(() => highlightSelectedDay(window.selectedDate), 50);
        }, 0);
        return;
      }

      _prevViewType = currentViewType;
      _navigatingToSelected = false;

      // ✅ Re-apply highlight on every render, across ALL view types
      if (window.selectedDate) {
        setTimeout(() => highlightSelectedDay(window.selectedDate), 50);
      }
      setTimeout(() => renderVisibleDateStickyIcons(), 70);
      applyMobileWeekCompression();
      setTimeout(() => applyGridHoverSummaries(), 40);
      setTimeout(() => applyMobileStartHourOutlines(), 55);
      setTimeout(() => applyCompactToolbarTitle(), 0);

      // ✅ Log for debugging
      console.log("VIEW INIT DATE:", window.selectedDate, "view:", currentViewType);

      if (typeof window.updateChipEventCounts === "function") {
        setTimeout(() => {
          window.updateChipEventCounts();
        }, 0);
      }
    },

    viewDidMount: function() {
      if (typeof window.updateChipEventCounts === "function") {
        setTimeout(() => {
          window.updateChipEventCounts();
        }, 0);
      }
      setTimeout(() => renderVisibleDateStickyIcons(), 80);
      setTimeout(() => applyGridHoverSummaries(), 60);
      setTimeout(() => applyMobileStartHourOutlines(), 70);
      setTimeout(() => applyCompactToolbarTitle(), 0);
    },

    // ✅ DRAG-DROP OR RESIZE EVENT — save changes to backend + undo/redo
    // Fires when user drags event to new date/time or resizes duration
    // CRITICAL: Skip this callback if we're programmatically updating via setDates() in undo/redo
    eventChange: async function(info) {
      if (window.skipEventChange) {
        console.log(`[eventChange] Skipped due to skipEventChange flag`);
        return;
      }

      const event = info.event;
      const eventId = String(event.extendedProps?.backendId || event.id || "");
      console.log(`[eventChange] eventId=${eventId}, title=${event.title}, extProps keys:`, Object.keys(event.extendedProps || {}));
      if (!eventId) {
        console.warn("[eventChange] No eventId found, aborting");
        return;
      }

      // Capture previous state
      const prevStart = info.oldEvent.start;
      const prevEnd = info.oldEvent.end;
      const newStart = event.start;
      const newEnd = event.end;
      let effectiveStart = newStart;
      let effectiveEnd = newEnd;

      if (window.dragPrecisionMode !== false) {
        const confirmation = await confirmEventMoveWithPrecision({
          title: event.title,
          start: newStart,
          end: newEnd || newStart
        });

        if (!confirmation.confirmed) {
          info.revert();
          window.showToast?.("Move cancelled", "error");
          return;
        }

        effectiveStart = confirmation.start;
        effectiveEnd = confirmation.end;

        const changedByUser =
          (effectiveStart?.getTime?.() || 0) !== (newStart?.getTime?.() || 0) ||
          (effectiveEnd?.getTime?.() || 0) !== (newEnd?.getTime?.() || 0);

        if (changedByUser) {
          window.skipEventChange = true;
          event.setDates(effectiveStart, effectiveEnd || effectiveStart);
          window.skipEventChange = false;
        }
      }

      try {
        // Build payload with ISO 8601 datetime strings (like buildEventPayload does)
        const dateStr = effectiveStart ? effectiveStart.toISOString().split("T")[0] : prevStart.toISOString().split("T")[0];
        const startTimeStr = effectiveStart ? effectiveStart.toTimeString().slice(0, 5) : "00:00";
        const endTimeStr = effectiveEnd ? effectiveEnd.toTimeString().slice(0, 5) : "00:00";

        const payload = {
          start_time: new Date(`${dateStr}T${startTimeStr}`).toISOString(),
          end_time: new Date(`${dateStr}T${endTimeStr}`).toISOString()
        };
        console.log(`[eventChange] Moving ${event.title} to payload:`, payload);

        // Helper: find FC event by backendId and move it visually
        const updateFcEventVisual = (targetStart, targetEnd) => {
          const allFcEvents = window.calendar?.getEvents() || [];
          const fcEvent = allFcEvents.find(e =>
            String(e.extendedProps?.backendId) === String(eventId) ||
            String(e.id) === String(eventId)
          );
          if (fcEvent) {
            console.log(`[eventChange] Updating FC event ${eventId} visually to:`, targetStart, targetEnd);
            // Set flag to prevent recursive eventChange callbacks
            window.skipEventChange = true;
            fcEvent.setDates(targetStart, targetEnd || targetStart);
            window.skipEventChange = false;
          } else {
            console.warn(`[eventChange] FC event ${eventId} not found, relying on smartRefresh`);
          }
        };

        // Create undo/redo command — both execute() and undo() do full visual updates
        const command = {
          label: "Move event",
          execute: async () => {
            console.log(`[eventChange.execute] Sending PUT /calendar/event/${eventId} with:`, payload);
            const res = await apiFetch(`/calendar/event/${eventId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            console.log(`[eventChange.execute] Response:`, res?.status, "ok:", res?.ok);
            if (!res || !res.ok) {
              const errorText = await res?.text?.() || "Unknown error";
              console.error(`[eventChange.execute] API error: ${res?.status} ${errorText}`);
              throw new Error(`API returned ${res?.status}: ${errorText}`);
            }
            const data = await res.json();
            // Update cache + visuals so redo looks right
            const nextEvent = window.normalizeEventForCache(data?.event || data);
            window.upsertCacheEvent(nextEvent);
            updateFcEventVisual(effectiveStart, effectiveEnd);
            window.smartRefresh?.({ reason: "event_moved", force: true });
            return data;
          },
          undo: async () => {
            console.log(`[eventChange.undo] Starting undo for eventId=${eventId}`);
            const prevDateStr = prevStart ? prevStart.toISOString().split("T")[0] : dateStr;
            const prevStartTimeStr = prevStart ? prevStart.toTimeString().slice(0, 5) : "00:00";
            const prevEndTimeStr = prevEnd ? prevEnd.toTimeString().slice(0, 5) : "00:00";
            const restorePayload = {
              start_time: new Date(`${prevDateStr}T${prevStartTimeStr}`).toISOString(),
              end_time: new Date(`${prevDateStr}T${prevEndTimeStr}`).toISOString()
            };
            console.log(`[eventChange.undo] Restoring to:`, restorePayload);
            const res = await apiFetch(`/calendar/event/${eventId}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(restorePayload)
            });
            console.log(`[eventChange.undo] API response:`, res?.status, "ok:", res?.ok);
            if (!res || !res.ok) {
              const errorText = await res?.text?.() || "Unknown error";
              throw new Error(`Restore failed: ${res?.status} ${errorText}`);
            }
            const data = await res.json();
            // Update cache + visuals so undo looks right
            const restoredEvent = window.normalizeEventForCache(data?.event || data);
            window.upsertCacheEvent(restoredEvent);
            updateFcEventVisual(prevStart, prevEnd);
            window.smartRefresh?.({ reason: "event_restored", force: true });
            return data;
          }
        };

        // Initial drag: execute already called by FullCalendar — just register the command
        // (execute() will be called by undo/redo manager on redo)
        const data = await command.execute();
        console.log(`[eventChange] Execution successful, registering with undo/redo manager`);

        // Add to undo/redo history (already executed above)
        await window.undoRedoManager.registerExecuted(command);

        window.showToast?.("✅ Event moved");
        window.updateDayDetails?.();
        window.updateWeekView?.();

        if (typeof window.updateUndoRedoButtonStates === "function") {
          window.updateUndoRedoButtonStates();
        }
      } catch (err) {
        console.error("❌ Move failed:", err.message, err.stack);
        window.showToast?.(`❌ Move failed: ${err.message}`, "error");
        // Revert the change visually
        info.revert();
      }
    }

  });

  window.calendar.render();
  applyCalendarLayoutMode(initialLayoutMode, { switchView: false });
  updateMobileDaysToggleLabel();
  updateMobileHourToggleLabels();

  // =========================================================
  // ✅ RIGHT-CLICK ON EMPTY DATE CELLS (not on events)
  // Event contextmenu handlers call stopPropagation(), so this
  // calendar-level listener ONLY fires for non-event right-clicks.
  // =========================================================
  const calEl = document.getElementById("calendar");
  if (calEl) {
    calEl.addEventListener("dragover", (e) => {
      if (!stickyDragPayload) return;

      const dateStr = getDateFromNode(e.target, calEl);
      const dateTargetEl = getDateTargetElement(e.target, calEl);
      const eventNode = e.target instanceof Element ? e.target.closest(".fc-event") : null;

      // Event takes priority over date when both are available.
      const canDropEventToEvent = stickyDragPayload.scope === "event" && !!eventNode;
      const canDropEventToDate = stickyDragPayload.scope === "event" && !eventNode && !!dateStr;
      const canDropDateToEvent = stickyDragPayload.scope === "date" && !!eventNode;
      const canDropDateToDate = stickyDragPayload.scope === "date" && !eventNode && !!dateStr;

      if (canDropEventToEvent || canDropEventToDate || canDropDateToEvent || canDropDateToDate) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

        if ((canDropEventToEvent || canDropDateToEvent) && eventNode) {
          setDropHighlight(eventNode, "event");
        } else if ((canDropEventToDate || canDropDateToDate) && dateTargetEl) {
          setDropHighlight(dateTargetEl, "date");
        }
      } else {
        clearDropHighlight();
      }
    });

    calEl.addEventListener("dragleave", (e) => {
      if (!stickyDragPayload) return;
      const related = e.relatedTarget;
      if (related instanceof Node && calEl.contains(related)) return;
      clearDropHighlight();
    });

    calEl.addEventListener("drop", async (e) => {
      if (!stickyDragPayload || !window.calendar) return;

      const dateStr = getDateFromNode(e.target, calEl);
      const eventNode = e.target instanceof Element ? e.target.closest(".fc-event") : null;
      const droppedEventId = eventNode?.dataset?.eventId || null;

      // Event drop takes priority: if dropped on an event card, move sticky to that event.
      if (stickyDragPayload.scope === "event" && droppedEventId) {
        e.preventDefault();
        const sourceEvent = window.calendar.getEventById(stickyDragPayload.fcEventId);
        const targetEvent = window.calendar.getEventById(String(droppedEventId));
        if (sourceEvent && targetEvent && sourceEvent.id !== targetEvent.id) {
          // Move sticky notes from source event to target event.
          await window.moveEventStickyToEvent?.(sourceEvent, targetEvent);
        }
        clearStickyDragPayload();
        return;
      }

      // Fallback: event sticky dropped on a date cell (not an event).
      if (stickyDragPayload.scope === "event" && dateStr && !droppedEventId) {
        e.preventDefault();
        const sourceEvent = window.calendar.getEventById(stickyDragPayload.fcEventId);
        if (sourceEvent) {
          await window.moveEventStickyToDate?.(sourceEvent, dateStr);
        }
        clearStickyDragPayload();
        return;
      }

      if (stickyDragPayload.scope === "date" && droppedEventId) {
        e.preventDefault();
        const targetEvent = window.calendar.getEventById(String(droppedEventId));
        if (targetEvent) {
          await window.moveDateStickyToEvent?.(stickyDragPayload.dateKey, targetEvent);
        }
        clearStickyDragPayload();
        return;
      }

      if (stickyDragPayload.scope === "date" && dateStr && !droppedEventId) {
        e.preventDefault();
        await window.moveDateStickyToDate?.(stickyDragPayload.dateKey, dateStr);
        clearStickyDragPayload();
        return;
      }

      clearDropHighlight();
    });

    calEl.addEventListener("contextmenu", (e) => {
      const headerTarget = e.target instanceof Element
        ? e.target.closest(".fc-header-toolbar, .fc-toolbar-title")
        : null;
      if (headerTarget) {
        e.preventDefault();
        e.stopPropagation();
        openWeekHeaderColorPicker();
        return;
      }

      let dateStr = null;
      let node = e.target;
      while (node && node !== calEl) {
        if (node.dataset?.date) {
          dateStr = node.dataset.date;
          break;
        }
        node = node.parentElement;
      }

      e.preventDefault();
      e.stopPropagation();

      if (!dateStr) {
        dateStr = window.selectedDate || toDayString(window.calendar?.getDate?.() || new Date());
      }

      console.log("DATE CONTEXTMENU:", dateStr);
      openDateContextMenu(e.clientX, e.clientY, dateStr);
    });
  }

  // ✅ Initial chip count update
  setTimeout(() => {
    if (typeof window.updateChipEventCounts === "function") {
      window.updateChipEventCounts();
    }
  }, 0);

  console.log("✅ FullCalendar loaded");
}

function summarizeText(text, maxLen = 72) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen)}...`;
}

function getBestCompactEventText(ev) {
  if (!ev) return "";

  const candidates = [];
  const addCandidate = (value) => {
    const normalized = stripLeadingTimeRange(String(value || "")).replace(/\s+/g, " ").trim();
    if (normalized) candidates.push(normalized);
  };

  addCandidate(ev.title || "");
  addCandidate(ev.extendedProps?.description || "");

  const stickyNotes = ev.extendedProps?.stickyNotes || [];
  const firstSticky = Array.isArray(stickyNotes)
    ? stickyNotes.find((s) => String(s?.content || "").trim())
    : null;
  addCandidate(firstSticky?.content || ev.extendedProps?.stickyNote?.content || "");

  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] || "";
}

function getEventSummary(ev) {
  if (!ev) return "";
  const title = summarizeText(ev.title || "Untitled");

  const stickyNotes = ev.extendedProps?.stickyNotes || [];
  const firstSticky = Array.isArray(stickyNotes)
    ? stickyNotes.find((s) => String(s?.content || "").trim())
    : null;
  const legacySticky = ev.extendedProps?.stickyNote;
  const stickyText = summarizeText(firstSticky?.content || legacySticky?.content || "", 60);

  return stickyText ? `${title}\n🗒 ${stickyText}` : title;
}

function applyGridHoverSummaries() {
  const cache = Array.isArray(window.sessionEventCache) ? window.sessionEventCache : [];
  if (!cache.length) return;

  const byDate = new Map();
  cache.forEach((ev) => {
    const start = ev?.start ? new Date(ev.start) : null;
    if (!start || Number.isNaN(start.getTime())) return;
    const dateKey = start.toISOString().slice(0, 10);
    if (!byDate.has(dateKey)) byDate.set(dateKey, []);
    byDate.get(dateKey).push(ev);
  });

  const applyTitle = (selector) => {
    document.querySelectorAll(selector).forEach((el) => {
      const dateKey = el.getAttribute("data-date");
      if (!dateKey) return;
      const list = byDate.get(dateKey) || [];
      if (!list.length) {
        el.title = "Create event or sticky note";
        return;
      }

      const first = list[0];
      const extra = list.length - 1;
      const firstSummary = summarizeText(first?.title || "Untitled", 54);
      const sticky = first?.extendedProps?.stickyNotes?.[0]?.content
        || first?.extendedProps?.stickyNote?.content
        || "";
      const stickySummary = summarizeText(sticky, 52);
      const countLine = extra > 0 ? `\n+${extra} more` : "";
      const stickyLine = stickySummary ? `\n🗒 ${stickySummary}` : "";
      el.title = `${firstSummary}${stickyLine}${countLine}`;
    });
  };

  applyTitle(".fc-timegrid-col[data-date]");
  applyTitle(".fc-daygrid-day[data-date]");
}

function applyMobileStartHourOutlines() {
  document.querySelectorAll(".fc-timegrid-slot-lane.mobileStartHourSlot").forEach((el) => {
    el.classList.remove("mobileStartHourSlot");
  });

  const cal = window.calendar;
  const mode = window.layoutMode;
  const viewType = cal?.view?.type || "";
  if (!cal || (mode !== "mobile" && mode !== "tablet")) return;
  if (viewType !== "timeGridWeek" && viewType !== "timeGridDay") return;

  const seen = new Set();
  cal.getEvents().forEach((ev) => {
    const start = ev?.start ? new Date(ev.start) : null;
    if (!start || Number.isNaN(start.getTime())) return;
    const token = `${String(start.getHours()).padStart(2, "0")}:00:00`;
    if (seen.has(token)) return;
    seen.add(token);
    const lane = document.querySelector(`.fc-timegrid-slot-lane[data-time="${token}"]`);
    lane?.classList.add("mobileStartHourSlot");
  });
}