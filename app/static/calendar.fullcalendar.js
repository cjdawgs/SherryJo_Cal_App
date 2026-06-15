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
 ✅ SIDEBAR
**************************************************************/
window.updateSidebar = function(dateStr) {
  const dayContainer = document.getElementById("dayEventsList");
  const weekContainer = document.getElementById("weekView");

  if (!dayContainer || !weekContainer) return;

  dayContainer.innerHTML = "";
  weekContainer.innerHTML = "";

  if (!window.sessionEventCache.length) {
    dayContainer.innerHTML = "<li>No events</li>";
    return;
  }

  const selectedDate = dateStr || window.selectedDate;

  const dayEvents = window.sessionEventCache.filter(e => {
    if (!e.start) return false;

    const selected = new Date(selectedDate);

    const start = new Date(e.start);
    const end = e.end ? new Date(e.end) : start;

    // ✅ normalize to remove time portion
    start.setHours(0,0,0,0);
    end.setHours(0,0,0,0);
    selected.setHours(0,0,0,0);

    return selected >= start && selected <= end;
  });

  if (dayEvents.length === 0) {
    dayContainer.innerHTML = "<li>No events</li>";
  } else {
    dayEvents.forEach(e => {
      const li = document.createElement("li");

      const raw = getColorByKey(e.extendedProps?.account_key) || "#4285f4";
      const soft = getSoftColor(raw);

      li.style.backgroundColor = soft;
      li.style.borderLeft = `3px solid ${raw}`;
      li.style.color = getBestTextColor(soft);
      li.style.padding = "3px 5px";
      li.style.borderRadius = "5px";
      li.style.marginBottom = "3px";
      li.style.fontSize = "12px";
      li.style.lineHeight = "1.2";


      li.textContent = e.title;
      dayContainer.appendChild(li);
    });
  }

  // WEEK
  const selected = new Date(selectedDate);
  const startOfWeek = new Date(selected);
  startOfWeek.setDate(selected.getDate() - selected.getDay());

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);

  const weekEvents = window.sessionEventCache.filter(e => {
    if (!e.start) return false;
    const d = new Date(e.start);
    return d >= startOfWeek && d < endOfWeek;
  });

  weekEvents.forEach(e => {
    const row = document.createElement("div");

    const raw = getColorByKey(e.extendedProps?.account_key) || "#4285f4";
    const soft = getSoftColor(raw);

    row.style.backgroundColor = soft;
    row.style.borderLeft = `3px solid ${raw}`;
    row.style.color = getBestTextColor(soft);
    row.style.fontSize = "12px";
    row.style.lineHeight = "1.2";
    row.style.marginBottom = "3px";
    row.style.padding = "3px 6px";

    row.textContent = e.title;
    weekContainer.appendChild(row);
  });
};

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
    **************************************************************/
    events: function(fetchInfo, successCallback) {

      /**************************************************************
      ✅ SINGLE SOURCE OF TRUTH (NO DUPLICATE LOGIC)
      **************************************************************/
      const events = getFilteredEvents({
        start: fetchInfo.start,
        end: fetchInfo.end
      });

      /**************************************************************
      ✅ ENSURE DATE OBJECT SAFETY
      **************************************************************/
      const normalized = events.map(ev => ({
        ...ev,
        start: ev.start instanceof Date ? ev.start : new Date(ev.start),
        end: ev.end
          ? (ev.end instanceof Date ? ev.end : new Date(ev.end))
          : null
      }));

      successCallback(normalized);
    },

  
    /**************************************************************
     ✅ LIFECYCLE FIXES
    **************************************************************/
    eventsSet: () => {
      console.log("🔥 eventsSet → forcing UI sync");

      /**************************************************************
      ✅ ENSURE selectedDate EXISTS
      **************************************************************/
      if (!window.selectedDate) {
        window.selectedDate = toDayString(calendar.getDate());
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

      requestAnimationFrame(() => {
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });
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


      // ✅ KEEP YOUR EXISTING LOGIC
      setTimeout(() => {
        highlightSelectedDay(window.selectedDate);
        updateSidebar(window.selectedDate);
      }, 50);
    },

    dateClick: (info) => {
      window.selectedDate = info.dateStr;
      highlightSelectedDay(window.selectedDate);
      updateSidebar(window.selectedDate);
    }

  });

  // ✅ RENDER AFTER CONFIG
  window.calendar.render();
 
  setTimeout(() => window.calendar?.refetchEvents(), 0);

  console.log("✅ FullCalendar loaded");

}