//import { getColorByKey, getSoftColor, getBestTextColor } from "./calendar.colors.js";

import {
  toDayString,
  getActiveRangeLabel
} from "./core.js";

/**************************************************************
 * ✅ GLOBAL STATE
 * (do not initialize sessionEventCache here — single source in calendar.js)
 **************************************************************/

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