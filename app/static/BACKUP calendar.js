console.log("🔥 JS FILE LOADED");
console.log("🔐 TOKEN AT LOAD:", localStorage.getItem("token"));

/**************************************************************
 * ✅ TOKEN ENGINE (SINGLE SOURCE OF TRUTH)
 **************************************************************/
function getTokenOrFail() {
  const token = localStorage.getItem("token");

  if (!token) {
    console.error("❌ NO TOKEN — redirecting to login");
    window.location.replace("/login");
    throw new Error("No token");
  }

  return token;
}

/**************************************************************
 * ✅ AUTH GUARD (SAFE VERSION + NO STALE TOKEN)
 **************************************************************/
if (window.location.pathname.includes("calendar-ui")) {

  // ✅ ALWAYS READ FRESH TOKEN (NO GLOBAL CACHE)
  getTokenOrFail();
  
}

/**************************************************************
 * ✅ CENTRALIZED API FETCH (TOKEN SAFE)
 **************************************************************/
async function apiFetch(url, options = {}) {

  const authToken = getTokenOrFail();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + authToken,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    console.error("❌ 401 — token invalid or expired");
    localStorage.removeItem("token");
    window.location.replace("/login");
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
async function init() {
  console.log("✅ calendar.js loaded");

  const calendarEl = document.getElementById("calendar");
  if (!calendarEl) {
    console.warn("Missing #calendar element");
    return;
  }
  handleOAuthRedirect();

  /**************************************************************
   * ✅ WAIT FOR TOKEN (CLEAN + CORRECT)
   **************************************************************/
  let attempts = 0;

  while (!localStorage.getItem("token") && attempts < 10) {
    console.log("⏳ Waiting for token...");
    await new Promise(r => setTimeout(r, 200));
    attempts++;
  }

  if (!localStorage.getItem("token")) {
    console.warn("❌ Token never became available");
    window.location.replace("/login");
    return;
  }

  // ✅ Final validation
  getTokenOrFail();
  
  await loadAccounts();

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

    // ✅ send to renderer
    renderAccounts(data);

    return data;  // ✅ REQUIRED (for await)

  } catch (err) {
    console.error("❌ Failed to load accounts:", err);
    return [];   // ✅ prevents crash
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

    // ✅ FORCE CALENDAR REFRESH AFTER AUTH
    setTimeout(() => {
      if (calendar) {
        console.log("🔄 FORCING REFETCH AFTER LOGIN");
        calendar.refetchEvents();
      } else {
        console.warn("⚠️ Calendar not ready yet for refetch");
      }
    }, 500);

    // Clean URL
    window.history.replaceState({}, document.title, "/calendar-ui");
  }
}


// ==================================================
// ✅ FIX: FORCE UTC / SAFE DATE PARSING (APPLE CRITICAL)
// ==================================================
function safeParseDate(dt) {
  if (!dt) return null;

  // ✅ already ISO or timezone-aware
  if (dt.includes("Z") || dt.includes("+")) {
    return new Date(dt);
  }

  // ==================================================
  // ✅ FIX: PRESERVE LOCAL TIME (DO NOT FORCE UTC)
  // ==================================================
  const parsed = new Date(dt);

  if (isNaN(parsed.getTime())) {
    console.warn("⚠️ Failed parse:", dt);
    return null;
  }

  return parsed;
}

/**************************************************************
 * ✅ INIT FULLCALENDAR
 **************************************************************/
function initCalendar(el) {
    calendar = new FullCalendar.Calendar(el, {

      initialView: "dayGridMonth",
      timeZone: "UTC",
      dayMaxEventRows: 6,
      dayMaxEvents: false,

      // ✅ ONLY ONE EVENTS BLOCK EXISTS
      events: async (fetchInfo, successCallback, failureCallback) => {
    
        try {
        console.log("🔄 Fetching events...");

        // ==================================================
        // ✅ STEP 1: FETCH FROM API
        //  - USE FULLCALENDAR DATE RANGE (CRITICAL FIX)
        // ==================================================
        const start = fetchInfo.startStr;
        const end = fetchInfo.endStr;

        console.log("📅 FULLCAL RANGE:", start, "→", end);

        const res = await apiFetch(
          `/calendar/unified?start=${start}&end=${end}`
        );


        if (!res.ok) {
          throw new Error("API failed: " + res.status);
        }

        const data = await res.json();

        // ✅ CLEAN LOGGING
        console.log(`✅ API returned (${Array.isArray(data) ? data.length : "object"}) items`);

        // ==================================================
        // ✅ STEP 2: NORMALIZE RESPONSE SHAPE
        // ==================================================
        // ✅ WHY:
        // Backend returns array, not { events: [...] }

        const rawEvents = Array.isArray(data)
          ? data
          : Array.isArray(data?.events)
          ? data.events
          : [];

        console.log(`📦 Raw events count: ${rawEvents.length}`);

        // ==================================================
        // ✅ STEP 3: MAP TO FULLCALENDAR FORMAT (FIXED)
        // ==================================================
        let mappedEvents = rawEvents
          
          .filter(ev => {
            if (!ev.start) {
              console.warn("⚠️ Missing start:", ev);
              return false;
            }
            return true;
          })

          // ✅ MAP + NORMALIZE (CRITICAL FIXES CLEAN FINAL BLOCK)
          .map(ev => {

            // ==================================================
            // ✅ FIX: SAFE DATE PARSING (CORRECT LOCATION)
            // ==================================================
            const rawStart = ev.start;
            const rawEnd = ev.end;

            let safeStart = safeParseDate(rawStart);

            if (!safeStart || isNaN(safeStart.getTime())) {
              console.warn("⚠️ Invalid start date skipped:", rawStart);
              return null;
            }

            // ==================================================
            // ✅ BULLETPROOF DATE VALIDATION (FIX)
            // ==================================================
            if (!safeStart || isNaN(safeStart.getTime())) {
              console.warn("⚠️ Invalid start date skipped:", rawStart);
              return null;
            }

            let safeEnd = safeParseDate(rawEnd);

            // ✅ normalize provider
            const source = (ev.source || "").toLowerCase();
            const provider = source === "outlook" ? "microsoft" : source;

            // ==================================================
            // ✅ FIX: NORMALIZE ACCOUNT (MATCH UI EXACTLY)
            // ==================================================
            const account = (
              ev.account_email ||   // ✅ primary (backend aligned)
              ev.account ||         // ✅ fallback
              ""
            )
            .toLowerCase()
            .trim();

            const account_key = `${provider}:${account}`;
            
            if (!account) {
              console.warn("⚠️ Missing account on event:", ev);
            }
            if (!ev.external_id && !ev.id) {
              console.warn("⚠️ NO EVENT ID:", ev);
            }


            // ==================================================
            // ✅ DEBUG: VERIFY KEY MATCHING
            // ==================================================
            console.log("🧪 EVENT KEY:", account_key);

            // ==================================================
            // ✅ FIX: GUARANTEED UNIQUE ID (NO COLLISIONS)
            // ==================================================
            const safeId = [
              provider,
              account,
              ev.external_id || ev.id || "noid",
              rawStart
            ].join("|");


            // ✅ DEBUG (optional)
            if (provider === "apple") {
              console.log("🍎 Apple ID:", safeId);
              console.log("🍎 PASSING APPLE EVENT is OK:", ev.title, safeStart);
            }

            // ==================================================
            // ✅ FINAL RETURN (CLEAN OBJECT ONLY)
            // ==================================================
            return {
              id: safeId,
              title: ev.title || ev.summary || "Untitled",
              start: safeStart,
              end: safeEnd || null,


              extendedProps: {
                source: provider,
                account: account,
                account_key: account_key,
                conflict: !!ev.conflict,
                notes: ev.notes || []
              }
            };
          })
          .filter(Boolean);

        console.log(`🧩 Mapped events: ${mappedEvents.length}`);

        // ✅ DEBUG: RANGE FILTER TEMP DISABLED
        console.log("🚧 Range filter disabled for debugging");

        console.log(`🧩 Filtered events: ${mappedEvents.length}`) ;

        // ==============================================================
        // ✅ DEBUG: VERIFY UNIQUE IDS (CRITICAL ONLY ONE DECLARATION)
        // ==============================================================
        const uniqueIds = new Set(mappedEvents.map(e => e.id));

        console.log("🧪 UNIQUE EVENT IDS:", uniqueIds.size);
        console.log("🧪 TOTAL EVENTS:", mappedEvents.length);

        const appleMapped = mappedEvents.filter(e => e.extendedProps.source === "apple").length;
        console.log("🍎 Apple mapped:", appleMapped);
        

        // ==================================================
        // ✅ STEP 4: APPLY ACCOUNT FILTERS
        // ==================================================
        
        // ==================================================
        // ✅ TEMP: HARD BYPASS FILTER (DEBUG MODE)
        // ==================================================
        const filteredEvents = mappedEvents;


        console.log(`🎯 Filtered events: ${filteredEvents.length}`);
        
        const appleFiltered = filteredEvents.filter(e => e.extendedProps.source === "apple").length;
        console.log("🍎 Apple filtered:", appleFiltered);


        // ==================================================
        // ✅ STEP 5: RETURN TO CALENDAR
        // ==================================================
        lastGoodEvents = filteredEvents;
        console.log("🚨 FINAL EVENTS SENT TO CALENDAR:", filteredEvents.length);

        const appleFinal = filteredEvents.filter(e => e.extendedProps.source === "apple").length;
        console.log("🍎 Apple FINAL SENT:", appleFinal);

        successCallback(filteredEvents);

        setTimeout(() => {
          const stored = calendar.getEvents();
          console.log("📊 CALENDAR STORED EVENTS:", stored.length);

          if (stored.length > 0) {
            console.log("✅ SAMPLE STORED:", stored[0]);
          } else {
            console.warn("❌ FULLCALENDAR REJECTED ALL EVENTS");
          }
        }, 500);



        } catch (err) {
          console.error("❌ Event load failed:", err);

          // ✅ FALLBACK TO LAST KNOWN GOOD DATA
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
      console.log("🧪 RENDERING EVENT:", info.event.title, info.event.start, info.event.extendedProps.source);

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
    /*eventContent: (arg) => {

      const notes = arg.event.extendedProps.notes || [];
      const source = arg.event.extendedProps.source;

      const wrap = document.createElement("div");

      // ✅ ROW CONTAINER (icon + text inline)
      const row = document.createElement("div");
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.gap = "4px";

      // ==================================================
      // ✅ ICON (CENTRALIZED — USE SINGLE SOURCE)
      // ==================================================
      const icon = createSourceIcon(source);

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
    }  */

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


function applyEventColor(el, event) {
  const key = event.extendedProps?.account_key;
  let color = accountColorMap[key];

  if (!color) {
    const source = event.extendedProps.source;

    if (source === "apple") color = "#ef4444";
    else if (source === "google") color = "#34a853";
    else if (source === "microsoft") color = "#2563eb";
    else color = "#999";
  }

  el.style.backgroundColor = color;

  const num = parseInt(color.replace("#", ""), 16);
  const r = (num >> 16) & 0xff;
  const g = (num >> 8) & 0xff;
  const b = num & 0xff;

  const brightness = (r * 299 + g * 587 + b * 114) / 1000;

  el.style.color = brightness > 155 ? "#000" : "#fff";

  el.style.borderLeft = "4px solid rgba(0,0,0,0.25)";
}


/**************************************************************
 * ✅ REUSABLE ICON BUILDER (COMPONENT STANDARD)
 * ------------------------------------------------------------
 * PURPOSE:
 * - Provide consistent provider icons across UI
 * - Centralized (used by eventContent, day view, week view)
 *
 * STANDARD:
 * ✅ single source of truth
 * ✅ no layout changes
 * ✅ SVG only (no external deps)
 * ✅ safe fallback
 **************************************************************/
function createSourceIcon(source) {

  // ==================================================
  // ✅ BASE CONTAINER (UNCHANGED — DO NOT MODIFY)
  // ==================================================
  const icon = document.createElement("span");

  icon.style.display = "flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";
  icon.style.width = "12px";
  icon.style.height = "12px";
  icon.style.flexShrink = "0";
  icon.style.marginRight = "4px";

  // ✅ required so SVG renders cleanly
  icon.style.lineHeight = "0";


  // ==================================================
  // ✅ GOOGLE (OFFICIAL MULTI-COLOR MARK)
  // ==================================================
  if (source === "google") {
    icon.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 48 48">
        <path fill="#EA4335" d="M24 9.5c3.5 0 6.7 1.2 9.2 3.6l6.9-6.9C36 2.5 30.4 0 24 0 14.8 0 6.7 5.4 3 13.3l8.1 6.3C13.2 13.1 18.3 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.2-.4-4.7H24v9h12.4c-.5 2.8-2.1 5.2-4.5 6.8l7 5.4c4.1-3.8 6.3-9.6 6.3-16.5z"/>
        <path fill="#FBBC05" d="M11 28.6c-.5-1.5-.8-3-.8-4.6s.3-3.2.8-4.6L2.9 13.1C1.1 16.8 0 20.3 0 24s1.1 7.2 2.9 10.9l8.1-6.3z"/>
        <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7-5.4c-1.9 1.3-4.4 2.1-8.9 2.1-5.7 0-10.8-3.7-13-8.9l-8.1 6.3C6.7 42.6 14.8 48 24 48z"/>
      </svg>
    `;
  }


  // ==================================================
  // ✅ MICROSOFT (OFFICIAL 4-SQUARE GRID)
  // ==================================================
  else if (source === "microsoft") {
      icon.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24">
          <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
          <rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>
          <rect x="1" y="13" width="10" height="10" fill="#00A4EF"/>
          <rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
        </svg>
      `;
  }


  // ==================================================
  // ✅ APPLE (MINIMAL MONOCHROME)
  // - Small sizes → full Apple logo readability drops
  // - Use simplified glyph for clarity
  // ==================================================
  else if (source === "apple") {
      icon.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="#111">
          <path d="M16.3 1.4c0 1.1-.4 2.2-1.1 2.9-.7.8-1.9 1.4-3 1.3-.1-1.1.4-2.2 1.1-2.9.7-.8 2-1.4 3-1.3zM20.6 17.9c-.9 2-1.3 2.9-2.4 4.5-1.5 2.3-3.6 5.2-6.2 5.2-2.3 0-2.9-1.5-6-1.5s-3.7 1.5-6 1.5c-2.6 0-4.6-2.6-6.1-4.9-2.1-3.2-3.6-7.3-1.4-10.3 1.6-2.2 4.2-3.4 6.7-3.4 2.3 0 4.4 1.5 6 1.5 1.4 0 4.2-1.9 7.1-1.6 1.2.1 4.6.5 6.7 3.6-.2.1-4 2.3-3.9 7 .1 5.5 4.9 7.4 5 7.4z"/>
        </svg>
      `;

  }


  // ==================================================
  // ✅ FALLBACK (SAFE DEFAULT)
  // ==================================================
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

    
    // ==================================================
    // ✅ FIX: MATCH EVENT KEY EXACTLY
    // ==================================================
    const email = (acc.account_email || acc.email || "")
      .toLowerCase()
      .trim();

    if (!email) return;

    if (!providerCounts[provider]) {
      providerCounts[provider] = 0;
    }

    const index = providerCounts[provider]++;
    const color = getAccountColor(provider, index);

    const key = `${provider}:${email}`;
    
    // ==================================================
    // ✅ DEBUG: ACCOUNT MAP KEYS
    // ==================================================
    console.log("🧪 ACCOUNT KEY:", key);

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

    console.log("🎯 Account key:", key);

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

    return (
      evDate.getFullYear() === selected.getFullYear() &&
      evDate.getMonth() === selected.getMonth() &&
      evDate.getDate() === selected.getDate()
    );
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
 * ✅ OAUTH BUTTONS (TOKEN SAFE)
 **************************************************************/
function connectGoogle() {

  // ✅ ALWAYS GET FRESH TOKEN
  const authToken = getTokenOrFail();
  window.location.href =
    `/auth/google/login?token=${encodeURIComponent(authToken)}`;
}

// ==================================================
// ✅ ✅ NEW: APPLE OAUTH (MATCHES PATTERN)
// ==================================================
function connectApple() {
  const authToken = getTokenOrFail();
  window.location.href =
    `/auth/apple/login?token=${encodeURIComponent(authToken)}`;
}

function connectOutlook() {

  // ✅ ALWAYS GET FRESH TOKEN
  const authToken = getTokenOrFail();
  window.location.href =
    `/ms/login?token=${encodeURIComponent(authToken)}`;
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

  document.getElementById("appleBtn")
    ?.addEventListener("click", connectApple);    

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
