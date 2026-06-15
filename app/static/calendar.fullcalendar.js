/**************************************************************
 * ✅ GLOBAL STATE
 **************************************************************/
window.sessionEventCache = [];
console.log("✅ FULLCAL FILE VERSION (FIXED)");

/**************************************************************
 ✅ SAFE DOM GETTER
**************************************************************/
function safeGet(id, warn = true) {
  const el = document.getElementById(id);
  if (!el && warn) console.warn(`❌ Missing element: #${id}`);
  return el;
}

function toLocalDateStr(d) {
  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

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

/**************************************************************
 ✅ CALENDAR INIT (FIXED)
**************************************************************/
function initFullCalendar() {

  const el = safeGet("calendar");
  // ✅ FORCE TODAY IMMEDIATELY
  if (!window.selectedDate) {
    const today = new Date();
    window.selectedDate = toLocalDateStr(today);
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
     ✅ EVENTS PIPELINE (FIXED)
     ✅ SINGLE SOURCE FILTER ENGINE (NO DUPLICATE LOGIC)
    **************************************************************/
    events: function(fetchInfo, successCallback) {

      // ✅ use unified engine ONLY
      const events = getFilteredEvents({
        start: fetchInfo.start,
        end: fetchInfo.end
      });

      successCallback(events);
    },

    /**************************************************************
     ✅ LIFECYCLE FIXES
    **************************************************************/
    eventsSet: () => {
      console.log("🔥 eventsSet → forcing UI sync");

      /**************************************************************
      ✅ DO NOT OVERRIDE USER-SELECTION
      **************************************************************/
      if (!window.selectedDate) {
        const today = new Date();
        window.selectedDate = toDayString(today);
      }


      /**************************************************************
      ✅ DIRECT, SYNCHRONOUS, RELIABLE UPDATES
      **************************************************************/
      updateDayDetails();   // ✅ FIXES YOUR 1 EVENT BUG
      updateWeekView();     // (optional but correct)
      highlightSelectedDay(window.selectedDate);

      console.log("✅ DAY + WEEK SYNC COMPLETE:", window.selectedDate);
    },


    datesSet: (arg) => {
      console.log("[FC datesSet]", arg);

      let el = document.getElementById("rangeDisplay");

      if (!el) {
        el = document.createElement("div");
        el.id = "rangeDisplay";

        // ✅ NEW: semantic + styling hook
        el.className = "range-badge";

        // ✅ ALWAYS ATTACH (NO CONDITIONS, NO FAILURES)
        const calendarEl = document.getElementById("calendar");

        if (calendarEl && calendarEl.parentNode) {
          calendarEl.parentNode.insertBefore(el, calendarEl);
        } else {
          document.body.prepend(el); // fallback (never fails)
        }
      }

      // ✅ SAFE DATE EXTRACTION
      // ==================================================
      // ✅ GOOGLE-STYLE RANGE FORMATTER (GOLD STANDARD)
      // ==================================================
      function formatRange(start, end) {
          // ✅ CLONE to avoid mutation
          const s = new Date(start);
          const e = new Date(end);

          // ✅ FullCalendar end is exclusive → subtract 1 day
          e.setDate(e.getDate() - 1);

          const sameYear = s.getFullYear() === e.getFullYear();
          const sameMonth = s.getMonth() === e.getMonth();

          const format = (d, options) =>
              d.toLocaleDateString(undefined, options);

          // ✅ CASE 1: SAME MONTH + YEAR
          if (sameYear && sameMonth) {
              return `${format(s, { month: "short" })} ${s.getDate()} → ${e.getDate()}, ${e.getFullYear()}`;
          }

          // ✅ CASE 2: SAME YEAR, DIFFERENT MONTH
          if (sameYear) {
              return `${format(s, { month: "short", day: "numeric" })} → ${format(e, { month: "short", day: "numeric" })}, ${e.getFullYear()}`;
          }

          // ✅ CASE 3: DIFFERENT YEAR
          return `${format(s, { month: "short", day: "numeric", year: "numeric" })} → ${format(e, { month: "short", day: "numeric", year: "numeric" })}`;
      }

      // ✅ FORCE TEXT (NO OPTIONALS)
      
      // ==================================================
      // ✅ SINGLE SOURCE TEXT (NO DUPLICATES)
      // ==================================================
      const displayText = formatRange(arg.start, arg.end);
      // ✅ ICON + TEXT (THIS IS THE ONLY RENDER POINT)
      el.innerHTML = `<span style="margin-right:6px">📅</span>${displayText}`;
      // ==================================================
      // ✅ FADE-IN ANIMATION
      // ==================================================
      el.style.opacity = "0";
      el.style.transform = "translateY(-4px)";

      // ==================================================
      // ✅ STICKY HEADER
      // ==================================================
      el.style.position = "sticky";
      el.style.top = "0";
      el.style.zIndex = "1000";

      el.style.backdropFilter = "blur(6px)";

      
      console.log("✅ RANGE SET:", el.textContent);

      // ==================================================
      // ✅ GOOGLE-STYLE BADGE UI (PRODUCTION GRADE)
      // ==================================================
      el.style.all = "unset";

      el.style.display = "inline-block";
      el.style.padding = "6px 12px";
      el.style.borderRadius = "999px"; // ✅ pill shape

      el.style.fontSize = "13px";
      el.style.fontWeight = "500";

      el.style.background = "rgba(241,243,244,0.85)";
      el.style.color = "#202124";

      el.style.boxShadow = "0 1px 2px rgba(0,0,0,0.1)";
      el.style.border = "1px solid rgba(0,0,0,0.08)";

      el.style.margin = "8px 0";
      el.style.transition = "all 0.25s ease";

      // ==================================================
      // ✅ DARK MODE SUPPORT
      // ==================================================
      const isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

      if (isDark) {
        el.style.background = "rgba(60,64,67,0.85)";
        el.style.color = "#e8eaed";
        el.style.border = "1px solid rgba(255,255,255,0.08)";
      }

      /**************************************************************
      ✅ SAFE SYNC (NO TIMING HACKS)
      **************************************************************/
      if (!window.selectedDate) {
        window.selectedDate = toDayString(calendar.getDate());
      }
      highlightSelectedDay(window.selectedDate);
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