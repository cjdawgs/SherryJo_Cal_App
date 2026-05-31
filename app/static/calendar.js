console.log("🔥 JS FILE LOADED");

// ✅ GLOBAL TOKEN (FIX)
const token = localStorage.getItem("token");

/**************************************************************
 * ✅ AUTH GUARD (SAFE VERSION)
 **************************************************************/
if (window.location.pathname.includes("calendar-ui")) {
  
  if (!token) {
    console.warn("⚠️ No token → redirecting to login");
    window.location.replace("/login");
  }
}


/**************************************************************
 * ✅ CENTRALIZED API FETCH
 **************************************************************/
async function apiFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    console.warn("🔐 Session expired → logging out");
    logout();
    throw new Error("Unauthorized");
  }

  return res;
}


/**************************************************************
 * ✅ GLOBAL STATE
 **************************************************************/
let calendar = null;
let editingEventId = null;
let editingNoteId = null;
let lastGoodEvents = [];

// ✅ RANGE CONTROL (NEW)
let currentRangeDays = 30;  // ✅ Default = Monthly
let currentRangeStart = null;
let currentRangeEnd = null; 

// ✅ Track selected day
let selectedDate = new Date();

// ✅ NEW: account filter
let activeAccountFilters = new Set();

/**************************************************************
 * ✅ INIT APP
 **************************************************************/
document.addEventListener("DOMContentLoaded", init);
function init() {
  console.log("✅ calendar.js loaded");

  const calendarEl = document.getElementById("calendar");
  if (!calendarEl) {
    console.warn("Missing #calendar element");
    return;
  }

  handleOAuthRedirect();

  loadAccounts();      // ✅ ✅ ADD THIS LINE

  initCalendar(calendarEl);
  bindUIEvents();

  updateDayDetails(selectedDate);
  updateWeekView();
  highlightSelectedDay(selectedDate);
}

/**************************************************************
 * ✅ LOAD ACCOUNTS (SEPARATE FROM EVENTS)
 **************************************************************/
async function loadAccounts() {
  try {
    const res = await apiFetch("/accounts");

    if (!res.ok) {
      throw new Error("Accounts API failed");
    }

    const data = await res.json();

    console.log("✅ ACCOUNTS API:", data);

    // ✅ IMPORTANT: send directly to renderer
    renderAccounts(data);

  } catch (err) {
    console.error("❌ Failed to load accounts:", err);
  }
}

/**************************************************************
 * ✅ HANDLE OAuth RETURN (?connected=)
 **************************************************************/
function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");

  if (connected) {
    console.log("✅ Connected:", connected);

    syncNow();

    // Clean URL
    window.history.replaceState({}, document.title, "/calendar-ui");
  }
}


/**************************************************************
 * ✅ INIT FULLCALENDAR
 **************************************************************/
function initCalendar(el) {

  
    calendar = new FullCalendar.Calendar(el, {

      initialView: "dayGridMonth",

      // ✅ ✅ CRITICAL FIX
      dayMaxEventRows: 3,   // ✅ clean stacking
      dayMaxEvents: true,


    initialView: "dayGridMonth",

    /**************************************************
     * LOAD EVENTS + ACCOUNTS
     **************************************************/
    events: async (fetchInfo, successCallback, failureCallback) => {
      try {
        const res = await apiFetch(
          `/calendar/unified?range_days=${currentRangeDays}`
        );


        if (!res.ok) {
          throw new Error("API failed: " + res.status);
        }

        const data = await res.json();
        console.log("✅ API response:", data);

        // ✅ Robust + defensive mapping
        const events = Array.isArray(data?.events)
          ? data.events

              // ✅ STEP 1: REMOVE BAD EVENTS
              .filter(ev => ev.start || ev.start?.dateTime)

              // ✅ STEP 2: BUILD account_key FIRST
              .map(ev => {

                const rawStart = ev.start?.dateTime || ev.start;
                const rawEnd = ev.end?.dateTime || ev.end;

                const safeStart = rawStart ? new Date(rawStart) : null;
                if (!safeStart || isNaN(safeStart)) return null;

                const safeEnd = rawEnd ? new Date(rawEnd) : null;

                // ✅ normalize provider
                const source = (ev.source || "").toLowerCase();
                const provider = source === "outlook" ? "microsoft" : source;

                const account = (ev.account || "").toLowerCase();

                // ✅ ✅ THIS IS THE FIX
                const account_key = `${provider}:${account}`;

                return {
                  id: `${ev.id}_${rawStart}`,
                  title: ev.title || "Untitled",

                  start: safeStart,
                  end: safeEnd || null,

                  extendedProps: {
                    source: provider,
                    account: account,
                    account_key: account_key,   // ✅ CREATED HERE
                    conflict: !!ev.conflict,
                    notes: ev.notes || []
                  }
                };
              })

              .filter(Boolean)

              // ✅ STEP 3: FILTER AFTER KEY EXISTS
              .filter(ev => {

                if (activeAccountFilters.size === 0) return true;

                const key = ev.extendedProps.account_key;

                return activeAccountFilters.has(key);
              })

          : [];
        console.log(events.filter(e => e.extendedProps.source === "microsoft").map(e => e.id));

        // ✅ SAVE GOOD EVENTS
        lastGoodEvents = events;
        
        successCallback(events);

        } catch (err) {
          console.error("❌ Event load failed:", err);

          // ✅ DO NOT CLEAR CALENDAR — USE LAST GOOD DATA
          if (lastGoodEvents.length > 0) {
            console.warn("⚠️ Using cached events");
            successCallback(lastGoodEvents);
          } else {
            failureCallback([]);
          }
        }
    },


    // ✅ ✅ ✅ PUT IT RIGHT HERE (IMPORTANT)
    eventsSet: () => {
      console.log("✅ eventsSet fired");
      updateWeekView();
    },

    eventDidMount: (info) => {

    // ✅ ✅ APPLY NEW COLOR SYSTEM
    applyEventColor(info.el, info.event);

    // ✅ Keep your styling
    info.el.style.border = "none";
    info.el.style.borderRadius = "6px";
    info.el.style.padding = "2px 4px";
    info.el.style.fontWeight = "500";

    // ✅ Conflict override (unchanged)
    if (info.event.extendedProps.conflict) {
      info.el.style.borderLeft = "4px solid red";
    }

    // ✅ Tooltip (unchanged)
    info.el.title =
      info.event.extendedProps.source + " | " +
      (info.event.extendedProps.account || "");
  },

    /**************************************************
     * CLICK EVENT
     **************************************************/
    // ✅ CLICK DAY → CREATE + UPDATE SIDEBAR
    dateClick: (info) => {

      // ✅ SAVE selected date (VERY IMPORTANT)
      selectedDate = info.date;

      // ✅ ONLY update UI (no modal)
      updateDayDetails(info.date);
      updateWeekView();

      // ✅ store selected date for highlight
      highlightSelectedDay(info.date);

      // ✅ NEW: scroll week panel to this day
      setTimeout(() => {
        scrollWeekToDate(info.date);
      }, 50); // slight delay ensures DOM is ready
    },

    /**************************************************
     * ✅ DOUBLE CLICK HANDLER (SAFE)
     **************************************************/
    dayCellDidMount: function (info) {

      let clickTimer = null;

      info.el.addEventListener("click", () => {
        if (clickTimer) {
          // ✅ DOUBLE CLICK detected
          clearTimeout(clickTimer);
          clickTimer = null;

          openCreateModal(info.date); // ONLY here!

        } else {
          // ✅ WAIT to see if second click happens
          clickTimer = setTimeout(() => {
            clickTimer = null;
          }, 250);
        }
      });

    },


    // ✅ CLICK EVENT → EDIT + UPDATE SIDEBAR
    eventClick: (info) => {
      openCreateModal(null, info.event);

      // ✅ use event date to update sidebar
      if (info.event.start) {
        // ✅ SAVE selected date here too
        selectedDate = info.event.start;

        updateDayDetails(info.event.start);

        // ✅ keep sidebar + scroll aligned
        setTimeout(() => {
          scrollWeekToDate(info.event.start);
        }, 50);
      }
      updateWeekView();
    },


    /**************************************************
     * DRAG → UPDATE BACKEND
     **************************************************/
    eventDrop: async (info) => {
      try {
        await apiFetch(`/calendar/event/${info.event.id}`, {
          method: "PUT",
          body: JSON.stringify({
            start_time: info.event.start.toISOString(),
            end_time: info.event.end?.toISOString()
          })
        });
      } catch (err) {
        console.error("❌ Drag update failed:", err);
      }
    },

    /**************************************************
     * NOTES UI
     **************************************************/
    eventContent: (arg) => {

      const notes = arg.event.extendedProps.notes || [];
      const source = arg.event.extendedProps.source;

      const wrap = document.createElement("div");

      // ✅ ROW CONTAINER (icon + text inline)
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "4px";

      // ✅ ICON (BRAND STYLE MINI)
      const icon = document.createElement("span");

      icon.style.display = "flex";
      icon.style.alignItems = "center";
      icon.style.justifyContent = "center";
      icon.style.width = "12px";
      icon.style.height = "12px";
      icon.style.borderRadius = "3px";
      icon.style.flexShrink = "0";

      icon.style.opacity = "0.9";      // ✅ subtle polish
      icon.style.marginRight = "3px";  // ✅ spacing

      if (source === "google") {
        icon.textContent = "G";
        icon.style.fontSize = "9px";
        icon.style.fontWeight = "bold";
        icon.style.color = "#fff";
        icon.style.backgroundColor = "#34a853"; // Google green
      }
      else if (source === "microsoft") {
        // ✅ mimic Microsoft tile
        icon.textContent = "■";
        icon.style.fontSize = "8px";
        icon.style.color = "#fff";
        icon.style.backgroundColor = "#2563eb";
      }
      


      // ✅ TITLE (clean + ellipsis)
      const title = document.createElement("div");
      title.textContent = arg.event.title;
      title.style.fontSize = "12px";
      title.style.whiteSpace = "nowrap";
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";
      title.style.fontWeight = "500";

      // ✅ BUILD ROW
      row.appendChild(icon);
      row.appendChild(title);
      wrap.appendChild(row);

      // ✅ NOTES (unchanged)
      notes.forEach(note => {
        const noteIcon = document.createElement("span");
        noteIcon.textContent = "📝";
        noteIcon.title = stripHtml(note.content);

        noteIcon.onclick = (e) => {
          e.stopPropagation();
          editNote(arg.event.id, note.id);
        };

        wrap.appendChild(noteIcon);
      });

      return { domNodes: [wrap] };
    }

  });

  calendar.render();
}

/* =====================================================
✅ COLOR ENGINE (CENTRALIZED + SCALABLE)
===================================================== */

// ✅ Base colors per provider
const BASE_COLORS = {
  google: "#1f9d55",
  microsoft: "#1d4ed8",
  apple: "#ef4444",
  other: "#eab308"
};

// ✅ Store final color per account
let accountColorMap = {};

// ✅ Lighten function
function lightenColor(hex, percent) {
  const num = parseInt(hex.replace("#", ""), 16);

  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;

  r = Math.min(255, Math.floor(r + (255 - r) * percent));
  g = Math.min(255, Math.floor(g + (255 - g) * percent));
  b = Math.min(255, Math.floor(b + (255 - b) * percent));

  return "#" + [r, g, b]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

// ✅ NON-LINEAR contrast (fixes your “greens too close” issue)
function getAccountColor(provider, index) {
  const base = BASE_COLORS[provider] || BASE_COLORS.other;

  // ✅ THIS IS THE SECRET SAUCE
  // First step has a minimum jump → avoids subtle differences
  const percent = Math.min(0.20 + (index * 0.32), 0.75);

  return lightenColor(base, percent);
}

function openCustomRange() {

  const days = prompt("Enter custom range (days):");

  if (!days || isNaN(days)) return;

  currentRangeDays = parseInt(days);

  console.log("📅 Custom range:", currentRangeDays);

  calendar.refetchEvents();
}

/* =====================================================
✅ APPLY COLOR TO EVENT ELEMENT
===================================================== */

function applyEventColor(el, event) {
    
  const key = event.extendedProps?.account_key;
  const color = accountColorMap[key];

  if (!color) return;

  // ✅ Background
  el.style.backgroundColor = color;

  // ✅ PERFECT READABILITY (tuned threshold)
  const num = parseInt(color.replace("#", ""), 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;

  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  // ✅ Slightly more aggressive threshold (fix washed text)
  el.style.color = brightness > 155 ? "#000" : "#fff";

  // ✅ Visual separator (huge UX win)
  el.style.borderLeft = "4px solid rgba(0,0,0,0.25)";
}

// ✅ REUSABLE ICON BUILDER (USE EVERYWHERE)
function createSourceIcon(source) {

  const icon = document.createElement("span");

  icon.style.display = "flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";
  icon.style.width = "12px";
  icon.style.height = "12px";
  icon.style.borderRadius = "3px";
  icon.style.flexShrink = "0";
  icon.style.opacity = "0.9";
  icon.style.marginRight = "4px";

  if (source === "google") {
    icon.textContent = "G";
    icon.style.fontSize = "9px";
    icon.style.fontWeight = "bold";
    icon.style.color = "#fff";
    icon.style.backgroundColor = "#34a853";
  }
  else if (source === "microsoft") {
    icon.textContent = "■";
    icon.style.fontSize = "8px";
    icon.style.color = "#fff";
    icon.style.backgroundColor = "#2563eb";
  }
  else {
    icon.style.backgroundColor = "#999";
  }

  return icon;
}

/* =====================================================
✅ ACCOUNT LIST + COLOR MAP BUILDER (WITH HIDE SUPPORT)
===================================================== */
function renderAccounts(accounts) {
  const el = document.getElementById("accounts");
  if (!el) return;

  if (!accounts || accounts.length === 0) {
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");

  accountColorMap = {};
  const providerCounts = {};

  el.innerHTML = "";

  accounts.forEach(acc => {

    const providerRaw = (acc.provider || "other").toLowerCase();
    const provider = providerRaw === "outlook" ? "microsoft" : providerRaw;

    const email = (acc.account_email || acc.email || "").toLowerCase();
    if (!email) return;

    if (!providerCounts[provider]) {
      providerCounts[provider] = 0;
    }

    const index = providerCounts[provider]++;
    const color = getAccountColor(provider, index);

    const key = `${provider}:${email}`;
    accountColorMap[key] = color;

    // ✅ CREATE CHIP
    const row = document.createElement("div");
    row.dataset.key = key;
    row.title = email;

    // DOT
    const dot = document.createElement("span");
    dot.style.backgroundColor = color;
    row.appendChild(dot);

    // LABEL
    const shortName = email.split("@")[0];

    let suffix = "";
    if (provider === "google") suffix = "(G)";
    if (provider === "microsoft") suffix = "(MS)";
    if (provider === "apple") suffix = "(A)";

    const label = document.createElement("span");
    label.textContent = `${shortName} ${suffix}`;
    row.appendChild(label);

    // CLICK FILTER
    row.onclick = () => {
      if (activeAccountFilters.has(key)) {
        activeAccountFilters.delete(key);
      } else {
        activeAccountFilters.add(key);
      }

      updateChipSelectionUI();
      calendar.refetchEvents();
    };

    el.appendChild(row);
  });

  updateChipSelectionUI();
}
function updateChipSelectionUI() {

  document.querySelectorAll("#accounts div").forEach(row => {
    const key = row.dataset.key;

    if (!key) return;

    if (activeAccountFilters.has(key)) {
      row.classList.add("active");
    } else {
      row.classList.remove("active");
    }
  });
}


//✅ ✅ DAY DETAILS FUNCTION
function updateDayDetails(date) {

  const titleEl = document.getElementById("selectedDateTitle");
  const listEl = document.getElementById("dayEventsList");

  if (!titleEl || !listEl || !calendar) return;

  
  const selected = new Date(date);

  // ✅ NORMALIZE
  selected.setHours(0,0,0,0);


  // ✅ Softer, cleaner header
  titleEl.innerHTML = `
    <div style="
      font-size:15px;
      font-weight:600;
      color:#333;
      margin-bottom:6px;
    ">
      ${date.toDateString()}
    </div>
  `;

  let events = calendar.getEvents().filter(ev => {
    if (!ev.start) return false;

    const evDate = new Date(ev.start);

    // ✅ NORMALIZE EVENT DATE
    evDate.setHours(0,0,0,0);

    return evDate.getTime() === selected.getTime();
  });


  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  listEl.innerHTML = "";

  if (events.length === 0) {
    listEl.innerHTML = `<li style="color:#888;">No events</li>`;
    return;
  }

  events.forEach(ev => {

    const li = document.createElement("li");

    const time = ev.start
      ? new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : "";

    const row = document.createElement("div");

    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";
    row.style.marginBottom = "6px";
    row.style.fontSize = "13px";
    row.style.cursor = "pointer";
    row.style.transition = "background 0.15s ease";
    row.style.padding = "3px 6px";
    row.style.borderRadius = "6px";

    // ✅ NEW ICON
    const icon = createSourceIcon(ev.extendedProps.source);

    // ✅ TIME
    const timeEl = document.createElement("span");
    timeEl.textContent = time;
    timeEl.style.color = "#777";
    timeEl.style.fontSize = "11px";

    // ✅ TITLE
    const titleEl = document.createElement("span");
    titleEl.textContent = ev.title;
    titleEl.style.fontWeight = "500";

    // ✅ BUILD
    row.appendChild(icon);
    row.appendChild(timeEl);
    row.appendChild(titleEl);

    li.appendChild(row);

    li.onmouseenter = () => {
      li.firstChild.style.background = "#f5f7fa";
    };

    li.onmouseleave = () => {
      li.firstChild.style.background = "transparent";
    };


    // ✅ CLICK → open edit modal
    li.onclick = () => {
      openCreateModal(null, ev);

      // ✅ scroll into view smoothly
      li.scrollIntoView({
        behavior: "smooth",
        block: "nearest"
      });
    };


    // ✅ HOVER PREVIEW
    li.title = ev.title;

    listEl.appendChild(li);
  });
}

//✅ ✅ WEEK VIEW FUNCTION
function updateWeekView() {

  const container = document.getElementById("weekView");
  if (!container || !calendar) return;

  const events = calendar.getEvents();

  // ✅ USE selected date OR fallback to today
  const baseDate = selectedDate || new Date();

  // ✅ START OF WEEK
  const start = new Date(baseDate);
  start.setDate(baseDate.getDate() - baseDate.getDay());

  // ✅ NORMALIZE START (CRITICAL)
  start.setHours(0,0,0,0);

  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  // ✅ NORMALIZE END (CRITICAL)
  end.setHours(0,0,0,0);


  let weekEvents = events.filter(ev => {
    if (!ev.start) return false;

    const evDate = new Date(ev.start);

    // ✅ PURE DATE COMPARISON (correct)
    return evDate >= start && evDate < end;
  });


  container.innerHTML = "";

  if (weekEvents.length === 0) {
    container.innerHTML = `<div style="color:#888;">No events this week</div>`;
    return;
  }

  weekEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

  let currentDay = "";

  weekEvents.forEach(ev => {

    const evDate = new Date(ev.start);
    const dayLabel = evDate.toDateString();

    // ✅ Better section header (lighter + separated)
    if (dayLabel !== currentDay) {
      currentDay = dayLabel;


      const dayDiv = document.createElement("div");
      // ✅ tag for auto-scroll targeting
      dayDiv.setAttribute("data-day", evDate.toISOString().split("T")[0]);
      dayDiv.innerHTML = `
        <div style="
          margin-top:12px;
          margin-bottom:4px;
          font-size:13px;
          font-weight:600;
          color:#444;
          border-top:1px solid #ddd;
          padding-top:6px;
        ">
          ${dayLabel}
        </div>
      `;

      container.appendChild(dayDiv);
    }

    const time = ev.start
      ? evDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : "";

    const row = document.createElement("div");
    row.onmouseenter = () => {
      row.firstChild.style.background = "#f5f7fa";
    };

    row.onmouseleave = () => {
      row.firstChild.style.background = "transparent";
    };

    console.log("WEEK RANGE:", start, end);

    const inner = document.createElement("div");

    inner.style.display = "flex";
    inner.style.alignItems = "center";
    inner.style.gap = "6px";
    inner.style.marginLeft = "10px";
    inner.style.marginBottom = "4px";
    inner.style.fontSize = "13px";
    inner.style.cursor = "pointer";
    inner.style.transition = "background 0.15s ease";
    inner.style.padding = "2px 4px";
    inner.style.borderRadius = "4px";

    // ✅ NEW ICON
    const icon = createSourceIcon(ev.extendedProps.source);

    // ✅ TIME
    const timeEl = document.createElement("span");
    timeEl.textContent = time;
    timeEl.style.color = "#555";

    // ✅ TITLE
    const titleEl = document.createElement("span");
    titleEl.textContent = ev.title;

    // ✅ BUILD
    inner.appendChild(icon);
    inner.appendChild(timeEl);
    inner.appendChild(titleEl);

    row.appendChild(inner);

        // ✅ CLICK → OPEN MODAL
        row.onclick = () => {
          openCreateModal(null, ev);

          // ✅ scroll selected item into view
          row.scrollIntoView({
            behavior: "smooth",
            block: "nearest"
          });
        };

    // ✅ HOVER TOOLTIP
    row.title = ev.title;

    container.appendChild(row);
  });
}


/**************************************************************
 * ✅ OAUTH BUTTONS
 **************************************************************/
function connectGoogle() {
  const token = localStorage.getItem("token");

  window.location.href =
    `/auth/google/login?token=${encodeURIComponent(token)}`;
}

function connectOutlook() {
  const token = localStorage.getItem("token");

  window.location.href =
    `/ms/login?token=${encodeURIComponent(token)}`;
}

/**************************************************************
 * ✅ SYNC
 **************************************************************/
async function syncNow() {
  try {
    await apiFetch("/calendar/sync", { method: "POST" });

    alert("✅ Sync complete");

    calendar.refetchEvents();

  } catch (err) {
    console.error("❌ Sync failed:", err);
  }
}


/**************************************************************
 * ✅ CREATE / EDIT EVENT MODAL
 **************************************************************/
function openCreateModal(date = null, event = null) {
  const modal = document.getElementById("createEventModal");
  if (!modal) return;


  const deleteBtn = document.getElementById("deleteEventBtn");

  // hide by default
  deleteBtn.style.display = "none";

  // show only if editing
  if (event) {
    deleteBtn.style.display = "inline-block";
  }

  modal.style.opacity = "0";
  modal.classList.add("show");
  setTimeout(() => {
    modal.style.opacity = "1";
  }, 10);

  document.getElementById("modalOverlay")?.classList.add("show");

  // ✅ RESET FORM
  document.getElementById("eventTitle").value = "";

  // ✅ CURRENT TIME
  const now = new Date();

  // ✅ DEFAULT DATE = TODAY
  const todayStr = now.toISOString().split("T")[0];
  document.getElementById("eventDate").value = todayStr;

  // ✅ NEXT FULL HOUR
  const nextHour = new Date(now);

  if (now.getMinutes() === 0) {
    nextHour.setHours(now.getHours());
  } else {
    nextHour.setHours(now.getHours() + 1);
  }

  nextHour.setMinutes(0);
  nextHour.setSeconds(0);

  // ✅ END = +1 HOUR
  const endHour = new Date(nextHour);
  endHour.setHours(endHour.getHours() + 1);

  // ✅ FORMAT HH:MM
  const formatTime = (d) => d.toTimeString().slice(0, 5);

  // ✅ SET DEFAULT TIMES
  document.getElementById("eventStart").value = formatTime(nextHour);
  document.getElementById("eventEnd").value = formatTime(endHour);

  editingEventId = null;

  // ✅ If clicking an existing event → EDIT MODE
  if (event) {
    editingEventId = event.id;

    document.getElementById("eventTitle").value = event.title;

    if (event.start) {
      const d = new Date(event.start);
      document.getElementById("eventDate").value =
        d.toISOString().split("T")[0];
      document.getElementById("eventStart").value =
        d.toTimeString().slice(0, 5);
    }

    if (event.end) {
      const d = new Date(event.end);
      document.getElementById("eventEnd").value =
        d.toTimeString().slice(0, 5);
    }
  }

  // ✅ If clicking a day → PRE-FILL DATE
  if (date && !event) {
    document.getElementById("eventDate").value =
      date.toISOString().split("T")[0];
  }

  // ✅ AUTO-FOCUS TITLE INPUT
  document.getElementById("eventTitle")?.focus();

}


function closeCreateModal() {
  const modal = document.getElementById("createEventModal");

  if (modal) {
    modal.style.opacity = "0";
  }
  document.getElementById("createEventModal")
    ?.classList.remove("show");

  document.getElementById("modalOverlay")
    ?.classList.remove("show");
}


/**************************************************************
 * ✅ SAVE EVENT (CREATE OR UPDATE)
 **************************************************************/
async function saveEvent() {
  const title = document.getElementById("eventTitle").value;
  const date = document.getElementById("eventDate").value;
  const start = document.getElementById("eventStart").value;
  const end = document.getElementById("eventEnd").value;

  if (!title || !date) {
    alert("Title and date required");
    return;
  }

  const startISO = start
    ? new Date(`${date}T${start}`).toISOString()
    : new Date(`${date}T00:00`).toISOString();

  const endISO = end
    ? new Date(`${date}T${end}`).toISOString()
    : null;

  try {
    if (editingEventId) {
      // ✅ UPDATE
      await apiFetch(`/calendar/event/${editingEventId}`, {
        method: "PUT",
        body: JSON.stringify({
          title,
          start_time: startISO,
          end_time: endISO
        })
      });
    } else {
      // ✅ CREATE
      await apiFetch("/calendar/event", {
        method: "POST",
        body: JSON.stringify({
          title,
          start_time: startISO,
          end_time: endISO
        })
      });
    }

    closeCreateModal();
    calendar.refetchEvents();

  } catch (err) {
    console.error("❌ Save failed:", err);
  }
}

/**************************************************************
 * ✅ DELETE EVENT (CREATE OR UPDATE)
 **************************************************************/
async function deleteEvent() {
  if (!editingEventId) return;

  const confirmDelete = confirm("Delete this event?");
  if (!confirmDelete) return;

  try {
    await apiFetch(`/calendar/event/${editingEventId}`, {
      method: "DELETE"
    });


    closeCreateModal();
    calendar.refetchEvents();

  } catch (err) {
    console.error("❌ Delete failed:", err);
  }
}

/**************************************************************
 * ✅ LOGOUT
 **************************************************************/
function logout() {
  localStorage.removeItem("token");
  window.location.href = "/login";
}


/**************************************************************
 * ✅ HELPERS
 **************************************************************/

//✅ HIGHLIGHT SELECTED DAY
function highlightSelectedDay(date) {

  document.querySelectorAll(".fc-daygrid-day").forEach(el => {
    el.style.backgroundColor = "";
    el.style.transition = "background 0.2s ease";
  });

  const dateStr = date.toISOString().split("T")[0];

  const el = document.querySelector(`[data-date="${dateStr}"]`);

  if (el) {
    el.style.backgroundColor = "#e8f0fe";
    el.style.borderRadius = "4px";
  }
}

/**************************************************************
 * ✅ AUTO SCROLL WEEK VIEW TO SELECTED DAY
 **************************************************************/
function scrollWeekToDate(date) {

  const dateStr = date.toISOString().split("T")[0];

  const el = document.querySelector(`[data-day="${dateStr}"]`);

  if (el) {
    el.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}


// ✅ CENTRALIZED COLOR LOGIC (DO NOT SCATTER THIS)
function getEventClass(event) {
  const source = event.extendedProps?.source;

  if (source === "google") return "event-pill event-google";
  if (source === "google_alt") return "event-pill event-google-alt";
  if (source === "microsoft") return "event-pill event-microsoft";

  return "event-pill"; // fallback
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}


/**************************************************************
 * ✅ NOTES
 **************************************************************/
function editNote(eventId, noteId = null) {
  editingEventId = eventId;
  editingNoteId = noteId;
  document.getElementById("noteEditorModal")?.classList.remove("hidden");
}

async function saveNoteEditor() {
  const content = document.getElementById("editor").innerHTML;

  await apiFetch("/events/note", {
    method: "POST",
    body: JSON.stringify({
      event_id: editingEventId,
      note_id: editingNoteId,
      content
    })
  });

  document.getElementById("noteEditorModal")?.classList.add("hidden");

  calendar.refetchEvents();
}


/**************************************************************
 * ✅ UI BUTTON BINDINGS
 **************************************************************/
function bindUIEvents() {

  // ✅ Create button
  const createBtn = document.getElementById("createBtn");
  console.log("createBtn:", createBtn);

  if (createBtn) {
    createBtn.addEventListener("click", () => {
      console.log("🔥 CREATE BUTTON CLICKED");
      openCreateModal();
    });
  }

  // ✅ OAuth buttons
  document.getElementById("googleBtn")
    ?.addEventListener("click", connectGoogle);

  document.getElementById("outlookBtn")
    ?.addEventListener("click", connectOutlook);

  // ✅ Task button
  document.getElementById("addTaskBtn")
    ?.addEventListener("click", addTask);

  // ✅ Modal buttons
  document.getElementById("saveEventBtn")
    ?.addEventListener("click", saveEvent);

  document.getElementById("cancelEventBtn")
    ?.addEventListener("click", closeCreateModal);

  document.getElementById("deleteEventBtn")
    ?.addEventListener("click", deleteEvent);

  // ✅ Existing buttons
  document.getElementById("syncBtn")
    ?.addEventListener("click", syncNow);

  document.getElementById("logoutBtn")
    ?.addEventListener("click", logout);

  // ✅ Make sure endDate is always after startDate and is deafulted to StartDate plus 1 hr
  document.getElementById("eventStart")
    ?.addEventListener("change", () => {
      const startVal = document.getElementById("eventStart").value;
      if (!startVal) return;

      const [hour, minute] = startVal.split(":").map(Number);

      const endDate = new Date();
      endDate.setHours(hour + 1);
      endDate.setMinutes(minute || 0);

      document.getElementById("eventEnd").value =
        endDate.toTimeString().slice(0, 5);
    });

  //✅ Press Enter → Save
  document.getElementById("createEventModal")
    ?.addEventListener("keydown", (e) => {

      if (e.key === "Enter") {
        e.preventDefault();

        // avoid weird behavior in future textareas
        if (e.target.tagName.toLowerCase() === "textarea") return;

        saveEvent();
      }
    });

    /**************************************************
    ✅ RANGE BUTTONS (THIS WAS MISSING)
    **************************************************/
    document.querySelectorAll(".range-btn").forEach(btn => {

      btn.addEventListener("click", () => {

        // ✅ Update UI (active highlight)
        document.querySelectorAll(".range-btn")
          .forEach(b => b.classList.remove("active"));

        btn.classList.add("active");

        // ✅ CUSTOM RANGE
        if (btn.id === "customRange") {
          openCustomRange();
          return;
        }

        // ✅ GET RANGE VALUE
        currentRangeDays = parseInt(btn.dataset.range);

        console.log("📅 Range changed:", currentRangeDays);

        // ✅ THIS LINE TRIGGERS EVERYTHING
        calendar.refetchEvents();
      });

    });


}

/**************************************************************
 * ✅ KEYBOARD SHORTCUTS
 **************************************************************/
document.addEventListener("keydown", (e) => {

  // ✅ ESC = CLOSE MODAL
  if (e.key === "Escape") {
    closeCreateModal();
  }

  // ✅ N = CREATE NEW EVENT
  if (e.key.toLowerCase() === "n") {
    openCreateModal();
  }

});
