//import { getColorByKey, getSoftColor, getBestTextColor } from "./calendar.colors.js";

import {
  toDayString,
  getActiveRangeLabel
} from "./core.js";

// ✅ apiFetch is needed for eventDrop / eventResize persistence.
//    api.js exports it AND sets window.apiFetch — importing directly
//    avoids any module-scope lookup issues.
import { apiFetch } from "./api.js";


/**************************************************************
 * ✅ CONTEXT MENU (right-click on events AND empty date cells)
 * --------------------------------------------------------
 * One shared <div> element, rebuilt dynamically on each open.
 *
 * openContextMenu(x, y, fcEvent)
 *   → Right-click ON an event
 *   → Menu: ➕ Create Event | ✏️ Edit | 🗑 Delete
 *
 * openDateContextMenu(x, y, date)
 *   → Right-click on an EMPTY date cell
 *   → Menu: ➕ Create Event
 *
 * Both close on outside click or Escape.
 **************************************************************/
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
  // Use actual rendered size when available, fall back to estimates
  const menuW = menu.offsetWidth  || 185;
  const menuH = menu.offsetHeight || 140;
  menu.style.left = (x + menuW > vw ? x - menuW : x) + "px";
  menu.style.top  = (y + menuH > vh ? y - menuH : y) + "px";
  menu.classList.add("visible");
}

// ✅ RIGHT-CLICK ON EVENT — Create Event / Edit / Delete
function openContextMenu(x, y, fcEvent) {
  const menu = ensureContextMenu();

  // Rebuild menu items fresh (prevents stale onclick closures)
  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="create">➕ Create Event</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item" data-action="edit">✏️ Edit</div>
    <div class="ctx-menu-separator"></div>
    <div class="ctx-menu-item danger" data-action="delete">🗑 Delete</div>
  `;

  positionContextMenu(menu, x, y);

  // ➕ Create Event — opens blank create modal (not pre-filled with this event)
  menu.querySelector("[data-action='create']").onclick = () => {
    closeContextMenu();
    window.openCreateModal?.();
  };

  // ✏️ Edit — opens edit modal pre-filled with this event
  menu.querySelector("[data-action='edit']").onclick = () => {
    closeContextMenu();
    window.openCreateModal?.(null, fcEvent);
  };

  // 🗑 Delete — deletes this event after confirmation
  menu.querySelector("[data-action='delete']").onclick = async () => {
    closeContextMenu();
    window.editingEventId = fcEvent.extendedProps?.backendId || Number(fcEvent.id);
    await window.deleteEvent?.();
  };
}

// ✅ RIGHT-CLICK ON EMPTY DATE CELL — Create Event only
function openDateContextMenu(x, y, date) {
  const menu = ensureContextMenu();

  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="create">➕ Create Event</div>
  `;

  positionContextMenu(menu, x, y);

  // Opens create modal pre-filled with the right-clicked date
  menu.querySelector("[data-action='create']").onclick = () => {
    closeContextMenu();
    window.openCreateModal?.(date);
  };
}

function closeContextMenu() {
  const menu = document.getElementById("eventContextMenu");
  if (menu) menu.classList.remove("visible");
}

// Close on any outside click or Escape
document.addEventListener("click", () => closeContextMenu());
document.addEventListener("keydown", e => {
  if (e.key === "Escape") closeContextMenu();
});

/**************************************************************
 * ✅ GLOBAL STATE
 * (do not initialize sessionEventCache here — single source in calendar.js)
 **************************************************************/

// =========================================================
// ✅ PHASE 3 & 4: SELECTED EVENT STATE
// ---------------------------------------------------------
// Single source of truth for event highlighting.
// All views (month/week/day) read window.selectedEventId.
// setSelectedEvent() updates the ID and triggers a re-render
// so eventClassNames can add/remove the 'event-selected' class.
// =========================================================
window.selectedEventId = null;

/**
 * setSelectedEvent(id)
 * ----------------------
 * Sets the globally selected event and re-renders the calendar
 * so eventClassNames applies the highlight to the correct event only.
 * Passing null or an already-selected id clears/toggles selection.
 */
function setSelectedEvent(id) {
  const strId = id ? String(id) : null;
  // ✅ Toggle: clicking the same event deselects it
  window.selectedEventId = window.selectedEventId === strId ? null : strId;
  console.log("✅ SELECTED EVENT:", window.selectedEventId);
  if (window.calendar) {
    // refetchEvents re-reads the in-memory sessionEventCache (fast, no network)
    // and re-renders all events, triggering eventClassNames for each.
    window.calendar.refetchEvents();
  }
}
window.setSelectedEvent = setSelectedEvent;

/**************************************************************
 ✅ HIGHLIGHT DAY (FINAL CLEAN VERSION)
**************************************************************/
export function highlightSelectedDay(dateStr) {

  // ✅ clear previous highlights (MONTH VIEW ONLY)
  document.querySelectorAll(".fc-daygrid-day").forEach(d => {
    d.style.background = "";
  });

  // ✅ find correct day cell
  const dayCell = document.querySelector(
    `.fc-daygrid-day[data-date="${dateStr}"]`
  );

  // ✅ apply highlight if found
  if (dayCell) {
    dayCell.style.setProperty(
      "background-color",
      "rgba(66,133,244,0.35)",
      "important"
    );
  } else {
    console.warn("⚠️ could not find day cell for:", dateStr);
  }
}

/*******************************************************
✅ RANGE PILL RENDER ENGINE (GLOBAL — CORRECT PLACEMENT)
*******************************************************/
export function renderRangePill() {

  let el = document.getElementById("rangeDisplay");

  if (!el) {
    // ✅ Retry after header injection completes
    setTimeout(renderRangePill, 50);
    return;
  }

  const days = window.currentRangeDays || 30;
  const range = getActiveRangeLabel(days);

  el.textContent = "📅 " + (range?.label || "NO RANGE");

  el.style.display = "inline-block";
  el.style.padding = "6px 12px";
  el.style.margin = "8px 0";
  el.style.borderRadius = "999px";
  el.style.background = "#eee";

  console.log("✅ RANGE PILL RENDER:", el.textContent);
}

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

  window.calendar = new FullCalendar.Calendar(el, {

    /* ✅ UNIFIED HEADER ROW */
    headerToolbar: {
      left: "title",
      center: "rangeGroup",
      right: "today prev,next dayGridMonth,timeGridWeek,timeGridDay"
    },

    customButtons: {
      rangeGroup: {
        text: ""   // placeholder
      }
    },

    /* ✅ ✅ ✅ ADD THIS BLOCK RIGHT HERE */
    buttonText: {
      dayGridMonth: "Month",
      timeGridWeek: "Week",
      timeGridDay: "Day"
    },

    // ✅ PHASE 2: Week view starts on Sunday (firstDay:0) so Sun→Sat range
    // is always correct when gotoDate() or changeView() is called.
    firstDay: 0,

    // =========================================================
    // ✅ INTERACTIVITY — Drag/drop, resize, click
    // ---------------------------------------------------------
    // editable:    allows drag-and-drop repositioning of events
    // selectable:  allows clicking empty days to create events
    // =========================================================
    editable:   true,
    droppable:  false,  // external drag-in disabled (not needed)
    selectable: true,

    eventDisplay: "block",

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
    // =========================================================
    // ✅ PHASE 4: EVENT CLASS NAMES — highlight selected event only
    // ---------------------------------------------------------
    // eventClassNames fires on every event render (initial + after
    // refetchEvents). Returns ['event-selected'] for the one event
    // matching window.selectedEventId, empty array for all others.
    // The CSS class is defined in style.css (.fc-event.event-selected).
    // =========================================================
    eventClassNames: function(arg) {
      return String(arg.event.id) === String(window.selectedEventId)
        ? ['event-selected']
        : [];
    },

    eventDidMount: function(info) {

      
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
      }

      // =========================================================
      // ✅ PHASE 5: DOUBLE-CLICK — open edit modal
      // ---------------------------------------------------------
      // ONLY path that opens the edit modal from a calendar event.
      // Single-click NEVER opens modal (handled by eventClick below).
      // =========================================================
      info.el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        console.log("EVENT DBLCLICK →", info.event.title, info.event.id);
        if (typeof window.openCreateModal === "function") {
          window.openCreateModal(null, info.event);
        }
      });

      // =========================================================
      // ✅ PHASE 6: RIGHT-CLICK CONTEXT MENU
      // ---------------------------------------------------------
      // Second path for edit/delete — right-click opens context menu.
      // Prevents browser's native context menu via e.preventDefault().
      // =========================================================
      info.el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openContextMenu(e.clientX, e.clientY, info.event);
      });
    },

    // =========================================================
    // ✅ DATE CLICK — update sidebar panels only.
    // ---------------------------------------------------------
    // CRITICAL RULE: clicking a date NEVER changes the main
    // calendar view (Month/Week/Day). ONLY the toolbar buttons
    // (Month | Week | Day) may change the calendar view.
    //
    // Single click → updates sidebar Day panel + Week panel
    // Double click → opens create-event modal for that date
    //
    // Double-click is detected by timing two rapid dateClick
    // events on the same dateStr within 300 ms.
    // =========================================================
    dateClick: function(info) {
      console.log("DATE CLICK:", info.dateStr);

      const dateStr = info.dateStr;

      // ✅ Double-click detection on date cells
      if (window._dateClickTimer && window._lastClickedDate === dateStr) {
        // Second click arrived — treat as double-click
        clearTimeout(window._dateClickTimer);
        window._dateClickTimer = null;
        window._lastClickedDate = null;
        console.log("DATE DBLCLICK → open create modal:", dateStr);
        if (typeof window.openCreateModal === "function") {
          window.openCreateModal(info.date);
        }
        return;
      }

      // ✅ First click — wait to see if a second arrives
      window._lastClickedDate = dateStr;
      window._dateClickTimer = setTimeout(() => {
        window._dateClickTimer = null;
        window._lastClickedDate = null;

        // ✅ Update global selected date (sidebar reads this)
        window.selectedDate = dateStr;

        // ✅ Highlight the clicked day cell in the calendar grid
        highlightSelectedDay(dateStr);

        // ✅ Refresh sidebar Day panel (red panel)
        window.updateDayDetails?.();

        // ✅ Refresh sidebar Week panel (orange panel) — Sun→Sat of selected date
        window.updateWeekView?.();

        console.log("DATE SINGLE CLICK → sidebar updated:", dateStr);
      }, 280);
    },

    // =========================================================
    // ✅ PHASE 3: EVENT CLICK (SINGLE) — highlight only, NO modal
    // ---------------------------------------------------------
    // CRITICAL RULE: single click NEVER opens the edit modal.
    //   → Modal opens ONLY on double-click (eventDidMount dblclick)
    //   → OR via right-click → Edit menu item (contextmenu)
    // This handler ONLY updates selectedEventId and re-renders.
    // =========================================================
    eventClick: function(info) {
      // ✅ Block FullCalendar's default URL navigation / popover
      info.jsEvent.preventDefault();
      info.jsEvent.stopPropagation();

      // ✅ Resolve event ID (prefer extendedProps.backendId for consistency)
      const id = String(
        info.event.extendedProps?.backendId ||
        info.event.id ||
        ""
      );
      console.log("EVENT SELECTED:", id, info.event.title);

      // ✅ Update selection — triggers refetchEvents → eventClassNames re-runs
      setSelectedEvent(id);
    },

    // =========================================================
    // ✅ EVENT DROP — drag-and-drop to a new date/time
    //
    // Flow:
    //   1. FullCalendar moves the event optimistically (instant UI)
    //   2. We PUT the new times to the backend
    //   3. On failure → info.revert() rolls back the UI
    //   4. On success → window.sessionEventCache is updated in-place
    // =========================================================
    eventDrop: async function(info) {
      const ev      = info.event;
      const backendId = ev.extendedProps?.backendId || Number(ev.id);

      console.log("EVENT MOVED:", ev.title, "→", ev.start, backendId);

      if (!backendId) {
        console.warn("⚠️ Cannot move: event has no backendId");
        // Only revert non-local events (external/synced ones are read-only)
        info.revert();
        return;
      }

      try {
        const res = await apiFetch(`/calendar/event/${backendId}`, {
          method: "PUT",
          body: {
            start: ev.start?.toISOString(),
            end:   ev.end?.toISOString() || null,
          },
        });

        if (!res || !res.ok) {
          console.error("❌ Move failed", res?.status);
          info.revert();
          window.showToast?.("❌ Move failed", "error");
          return;
        }

        const data = await res.json();
        console.log("✅ Event move persisted", data);

        // ✅ Update cache in-place so reload reflects new times
        if (Array.isArray(window.sessionEventCache)) {
          const idx = window.sessionEventCache.findIndex(
            e => e.extendedProps?.backendId === backendId ||
                 String(e.id) === String(ev.id)
          );
          if (idx !== -1) {
            window.sessionEventCache[idx] = {
              ...window.sessionEventCache[idx],
              start: new Date(data.event.start || ev.start),
              end:   data.event.end ? new Date(data.event.end) : null,
            };
          }
        }

        window.showToast?.("✅ Event moved");

      } catch (err) {
        console.error("❌ Move error:", err);
        info.revert();
        window.showToast?.("❌ Move error: " + err.message, "error");
      }
    },

    // =========================================================
    // ✅ EVENT RESIZE — drag the end-handle to a new end time
    //    Same persistence logic as eventDrop
    // =========================================================
    eventResize: async function(info) {
      const ev        = info.event;
      const backendId = ev.extendedProps?.backendId || Number(ev.id);

      console.log("EVENT RESIZED:", ev.title, "new end →", ev.end, backendId);

      if (!backendId) {
        info.revert();
        return;
      }

      try {
        const res = await apiFetch(`/calendar/event/${backendId}`, {
          method: "PUT",
          body: {
            start: ev.start?.toISOString(),
            end:   ev.end?.toISOString()  || null,
          },
        });

        if (!res || !res.ok) {
          console.error("❌ Resize failed", res?.status);
          info.revert();
          window.showToast?.("❌ Resize failed", "error");
          return;
        }

        // ✅ Update cache
        if (Array.isArray(window.sessionEventCache)) {
          const idx = window.sessionEventCache.findIndex(
            e => e.extendedProps?.backendId === backendId ||
                 String(e.id) === String(ev.id)
          );
          if (idx !== -1) {
            window.sessionEventCache[idx] = {
              ...window.sessionEventCache[idx],
              start: new Date(ev.start),
              end:   ev.end ? new Date(ev.end) : null,
            };
          }
        }

        window.showToast?.("✅ Event resized");

      } catch (err) {
        console.error("❌ Resize error:", err);
        info.revert();
        window.showToast?.("❌ Resize error: " + err.message, "error");
      }
    },

    eventsSet: function() {
      if (typeof window.updateChipEventCounts === "function") {
        setTimeout(() => {
          window.updateChipEventCounts();
        }, 0);
      }
    },

    datesSet: function() {
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
    }

  });

  window.calendar.render();

  // =========================================================
  // ✅ RIGHT-CLICK ON EMPTY DATE CELLS
  // ---------------------------------------------------------
  // Event contextmenu handlers call stopPropagation(), so this
  // calendar-level listener ONLY fires for non-event right-clicks.
  // Walk up the DOM from the click target to find a [data-date]
  // attribute (present on month day cells, week/day col headers,
  // and timeGrid column wrappers). If found, show the date menu.
  // =========================================================
  const calEl = document.getElementById("calendar");
  if (calEl) {
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
      if (!dateStr) return; // no date cell found — let browser handle
      e.preventDefault();
      e.stopPropagation();
      console.log("DATE CONTEXTMENU:", dateStr);
      openDateContextMenu(e.clientX, e.clientY, new Date(dateStr + "T00:00:00"));
    });
  }

  setTimeout(() => {
    if (typeof window.updateChipEventCounts === "function") {
      window.updateChipEventCounts();
    }
  }, 0);
  /* ======================================================
  ✅ INJECT RANGE INTO HEADER (SAFE ADDITION)
  ✅ CENTER RANGE PILL (FINAL LAYOUT)
  ====================================================== */
  setTimeout(() => {

    const center = document.querySelector(".fc-toolbar-chunk:nth-child(2)");

    if (!center) {
      console.warn("❌ center toolbar not found");
      return;
    }

    center.innerHTML = `
      <div style="
        display:flex;
        justify-content:center;
        align-items:center;
        width:100%;
      ">
        <div id="rangeDisplay" style="
          font-size:12px;
          padding:6px 12px;
          border-radius:999px;
          background:#eee;
        "></div>
      </div>
    `;

    console.log("✅ RANGE PILL CENTERED");

  }, 50);
  
    console.log("✅ FullCalendar loaded");
}