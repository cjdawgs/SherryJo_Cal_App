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
  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="create">➕ Create Event</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item" data-action="edit">✏️ Edit</div>
    <div class="ctx-menu-item" data-action="sticky">🗒 New Sticky Note</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item danger" data-action="delete">🗑 Delete</div>
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

function openDateContextMenu(x, y, dateStr) {
  const menu = ensureContextMenu();
  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="create">➕ Create Event</div>
    <div class="ctx-menu-item" data-action="date-sticky">🗒 Date Sticky Note</div>
  `;
  positionContextMenu(menu, x, y);
  menu.querySelector("[data-action='create']").onclick = () => {
    closeContextMenu();
    const date = new Date(dateStr + "T00:00:00");
    window.openCreateModal?.(date);
  };
  menu.querySelector("[data-action='date-sticky']").onclick = () => {
    closeContextMenu();
    window.openDateStickyModal?.(dateStr);
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
  // Toggle: clicking the same event again clears selection
  window.selectedEventId = window.selectedEventId === strId ? null : strId;
  console.log("✅ SELECTED EVENT:", window.selectedEventId);
  if (window.calendar) {
    window.calendar.refetchEvents();
  }
}
window.setSelectedEvent = setSelectedEvent;

// =========================================================
// ✅ VIEW-SWITCH TRACKING — used by datesSet to navigate
// to selectedDate when the user switches Month/Week/Day.
// =========================================================
let _prevViewType = null;
let _navigatingToSelected = false;
let stickyDragPayload = null;
let highlightedDropEl = null;
let mobileShowAllDays = false;
let mobileShowEarlyHours = false;
let mobileShowLateHours = false;
let lastAppliedHiddenDaysKey = "";
let lastAppliedTimeWindowKey = "";

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
    eventMaxStack: 2,
    dayMaxEvents: 2,
    slotDuration: "00:30:00",
    slotLabelInterval: "02:00:00",
    slotMinTime: "06:00:00",
    slotMaxTime: "18:00:00",
    allDaySlot: false,
    expandRows: false,
    toolbarRight: "today prev,next earlyHoursToggle,lateHoursToggle,mobileDaysToggle timeGridWeek,timeGridDay,dayGridMonth"
  },
  tablet: {
    defaultView: "timeGridWeek",
    eventMaxStack: 4,
    dayMaxEvents: 4,
    slotDuration: "00:30:00",
    slotLabelInterval: "01:00:00",
    slotMinTime: "06:00:00",
    slotMaxTime: "22:00:00",
    allDaySlot: true,
    expandRows: true,
    toolbarRight: "today prev,next earlyHoursToggle,lateHoursToggle timeGridWeek,timeGridDay,dayGridMonth"
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

function updateMobileDaysToggleLabel() {
  const btn = document.querySelector(".fc-mobileDaysToggle-button");
  if (!btn) return;
  btn.textContent = mobileShowAllDays ? "Focused Days" : "All Days";
}

function updateMobileHourToggleLabels() {
  const earlyBtn = document.querySelector(".fc-earlyHoursToggle-button");
  if (earlyBtn) {
    earlyBtn.textContent = mobileShowEarlyHours ? "Early On" : "Early";
  }
  const lateBtn = document.querySelector(".fc-lateHoursToggle-button");
  if (lateBtn) {
    lateBtn.textContent = mobileShowLateHours ? "Late On" : "Late";
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

  if (window.layoutMode !== "mobile") {
    const emptyKey = "[]";
    if (lastAppliedHiddenDaysKey !== emptyKey) {
      cal.setOption("hiddenDays", []);
      lastAppliedHiddenDaysKey = emptyKey;
    }
    return;
  }

  const view = cal.view;
  if (!view || view.type !== "timeGridWeek") return;

  const rangeStart = view.activeStart ? new Date(view.activeStart) : null;
  const rangeEnd = view.activeEnd ? new Date(view.activeEnd) : null;
  if (!rangeStart || !rangeEnd) return;

  const visibleEvents = getViewEventsInRange(rangeStart, rangeEnd);

  let minHour = 6;
  let maxHour = 18;

  if (visibleEvents.length) {
    let earliest = 24;
    let latest = 0;

    visibleEvents.forEach((ev) => {
      const s = new Date(ev.start);
      const e = ev.end ? new Date(ev.end) : s;
      earliest = Math.min(earliest, s.getHours());
      latest = Math.max(latest, e.getHours() + (e.getMinutes() > 0 ? 1 : 0));
    });

    minHour = Math.max(6, earliest - 1);
    maxHour = Math.min(22, latest + 1);
    if (maxHour - minHour < 8) {
      maxHour = Math.min(22, minHour + 8);
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
  if (!mobileShowAllDays) {
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
    left: "title",
    center: "",
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
  cal.setOption("slotEventOverlap", mode === "desktop" || mode === "large");
  cal.setOption("height", getCalendarHeightForMode(mode));
  cal.setOption("contentHeight", "auto");

  if (mode !== "mobile") {
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

  window.calendar = new FullCalendar.Calendar(el, {

    /* ✅ UNIFIED HEADER ROW */
    headerToolbar: {
      left: "title",
      center: "",
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
    slotEventOverlap: false,
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

      const events = window.sessionEventCache.map(ev => {

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
        inner.style.padding = "2px 6px";
        inner.style.fontSize = "11px";

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
        window.selectedDate = dateStr;
        console.log("SELECTED DATE:", window.selectedDate);

        // ✅ Highlight the clicked day cell in the calendar grid
        highlightSelectedDay(dateStr);

        // ✅ Refresh sidebar panels
        window.updateDayDetails?.();
        window.updateWeekView?.();

        // ✅ Notify all listeners
        window.dispatchEvent(new Event("selectedDateChanged"));

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
        window.openStickyModalForNew?.(info.event);
        return;
      }

      // ✅ First click — wait to see if second arrives
      window._lastClickedEventId = id;
      window._eventClickTimer = setTimeout(() => {
        window._eventClickTimer = null;
        window._lastClickedEventId = null;
        console.log("EVENT SELECTED:", id, info.event.title);
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
    },

    datesSet: function(info) {
      const currentViewType = info.view.type;
      const cal = window.calendar;

      // =========================================================
      // ✅ PHASE 5: VIEW-SWITCH FIX
      // When the user clicks Month/Week/Day toolbar button,
      // navigate to selectedDate so it never resets to today.
      // Guard _navigatingToSelected prevents an infinite loop
      // (gotoDate triggers another datesSet).
      // =========================================================
      if (
        !_navigatingToSelected &&
        _prevViewType !== null &&
        _prevViewType !== currentViewType &&
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

      try {
        // Build payload with ISO 8601 datetime strings (like buildEventPayload does)
        const dateStr = newStart ? newStart.toISOString().split("T")[0] : prevStart.toISOString().split("T")[0];
        const startTimeStr = newStart ? newStart.toTimeString().slice(0, 5) : "00:00";
        const endTimeStr = newEnd ? newEnd.toTimeString().slice(0, 5) : "00:00";

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
            updateFcEventVisual(newStart, newEnd);
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

      if (canDropEventToEvent || canDropEventToDate || canDropDateToEvent) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

        if ((canDropEventToEvent || canDropDateToEvent) && eventNode) {
          setDropHighlight(eventNode, "event");
        } else if (canDropEventToDate && dateTargetEl) {
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

      clearDropHighlight();
    });

    calEl.addEventListener("contextmenu", (e) => {
      let dateStr = null;
      let node = e.target;
      while (node && node !== calEl) {
        if (node.dataset?.date) {
          dateStr = node.dataset.date;
          break;
        }
        node = node.parentElement;
      }
      if (!dateStr) return;
      e.preventDefault();
      e.stopPropagation();
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