/**************************************************************
 * ✅ GLOBAL STATE
 **************************************************************/
window.sessionEventCache = [];

/**************************************************************
 ✅ HIGHLIGHT DAY (FINAL CLEAN VERSION)
**************************************************************/
function highlightSelectedDay(dateStr) {

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
function renderRangePill() {

  let el = document.getElementById("rangeDisplay");

  if (!el) {
    el = document.createElement("div");
    el.id = "rangeDisplay";

    const calendarEl = document.getElementById("calendar");

    if (calendarEl && calendarEl.parentNode) {
      calendarEl.parentNode.insertBefore(el, calendarEl);
    } else {
      document.body.prepend(el);
    }
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

/**************************************************************
 ✅ CALENDAR INIT (FIXED)
**************************************************************/
function initFullCalendar() {

  const el = document.getElementById("calendar");
  if (!el) return;

  // ✅ FORCE TODAY IMMEDIATELY
  if (!window.selectedDate) {
    const today = new Date();
    window.selectedDate = toDayString(today);
    console.log("✅ INIT TODAY:", window.selectedDate);
  }

  if (!el) return;

  window.calendar = new FullCalendar.Calendar(el, {

    initialView: "dayGridMonth",

    headerToolbar: {
      left: "prev,next today",
      center: "title",
      right: "dayGridMonth,timeGridWeek,timeGridDay"
    },

    /**************************************************************
     ✅ EVENTS PIPELINE (FIXED)
     ✅ SINGLE SOURCE FILTER ENGINE (NO DUPLICATE LOGIC)    
    **************************************************************/ 
    events: function(fetchInfo, successCallback) {

      if (!window.ALL_EVENTS) {
        console.log("❌ NO EVENTS AVAILABLE");
        successCallback([]);
        return;
      }

      const filtered = window.ALL_EVENTS.filter(e => {
        const start = new Date(e.start);
        const end = e.end ? new Date(e.end) : start;

        return start < fetchInfo.end && end >= fetchInfo.start;
      });

      console.log("✅ EVENTS SERVED:", filtered.length);

      successCallback(filtered);
    },

    // ✅ RESTORE EVENT COLORS (CRITICAL)
    eventContent: function(arg) {
      const ev = arg.event;

      const color = getColorByKey(ev.extendedProps?.account_key) || "#4285f4";

      const container = document.createElement("div");
      container.style.fontSize = "12px";
      container.style.lineHeight = "1.2";
      container.style.padding = "1.5px 3px";
      container.style.borderRadius = "4px";
      container.style.backgroundColor = color;
      container.style.borderLeft = `4px solid ${color}`;
      container.style.color = getBestTextColor(color);

      container.textContent = ev.title;

      return { domNodes: [container] };
    },
    
    /**************************************************************
     ✅ LIFECYCLE FIXES
    **************************************************************/
    eventsSet: () => {
      /**************************************************************
      ✅ RESERVED HOOK (NO UI SIDE EFFECTS)
      - DO NOT UPDATE selectedDate HERE
      - DO NOT UPDATE DAY/WEEK UI HERE
      - Pure lifecycle observation only
      **************************************************************/
    },
    

    /**************************************************************
     ✅ LIFECYCLE FIXES
    **************************************************************/
    eventDidMount: () => {
      /**************************************************************
      ✅ RESERVED HOOK (NO UI SIDE EFFECTS)
      - DO NOT UPDATE selectedDate HERE
      - DO NOT UPDATE DAY/WEEK UI HERE
      - Pure lifecycle observation only
      **************************************************************/
    },

    datesSet: function () {
      console.log("[FC datesSet fired]");

      renderRangePill();

      const cal = window.calendar;
      if (!cal) return;

      const current = toDayString(cal.getDate());

      window.selectedDate = current;

      updateDayDetails();
      updateWeekView();
      highlightSelectedDay(current);

      console.log("✅ DATE SYNC:", current);
    },
    dateClick: (info) => {

      window.selectedDate = info.dateStr;

      console.log("✅ CLICK:", window.selectedDate);

      highlightSelectedDay(window.selectedDate);

      /**************************************************************
      ✅ USE NEW RENDER ENGINE ONLY
      **************************************************************/
      updateDayDetails();
      updateWeekView();
    }
  });

  // ✅ RENDER AFTER CONFIG
  window.calendar.render();

  console.log("✅ FullCalendar loaded");

}