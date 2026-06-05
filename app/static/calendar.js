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
 ****************************+**********************************/
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
let providerAccountCounts = {};

// ✅ RANGE CONTROL (NEW)
let currentRangeDays = 30;  // ✅ Default = Monthly
let currentRangeStart = null;
let currentRangeEnd = null; 

// ✅ Track selected day
let selectedDate = null;

// ✅ NEW: account filter
let activeAccountFilters = new Set();

/**************************************************************
 * ✅ HELPERS
 **************************************************************/
//CREATE A SINGLE SOURCE FORMATTED STRING (FOR COMPARISON + KEYS)
function toDayString(d) {
  if (!d) return null;

  const dt = new Date(d);

  return dt.getFullYear() + "-" +
    String(dt.getMonth() + 1).padStart(2, "0") + "-" +
    String(dt.getDate()).padStart(2, "0");
}

function fromDayString(dayStr) {
  const [y, m, d] = dayStr.split('-');
  return new Date(y, m - 1, d);
}
/**************************************************************
 * ✅ FINAL COLOR RESOLVER (OVERRIDE → FALLBACK)
 **************************************************************/
function getFinalAccountColor(key, provider, index) {

  // ✅ SAFE CHECK (more robust than truthy)
  if (Object.prototype.hasOwnProperty.call(accountColorOverrides, key)) {
    return accountColorOverrides[key];
  }

  return getAccountColor(provider, index);
}

// ✅ SAFE DATE PARSER (FULLY FIXED)
function safeParseDate(dt) {
  if (!dt) return null;

  const parsed = new Date(dt);

  if (isNaN(parsed.getTime())) {
    console.warn("⚠️ Failed parse:", dt);
    return null;
  }

  // ✅ HARD GUARD: prevent accidental string misuse later
  if (typeof dt === "string" && !dt.includes("T")) {
    console.warn("⚠️ Non-ISO date detected:", dt);
  }

  return parsed;
}

//✅ HIGHLIGHT SELECTED DAY
function highlightSelectedDay(dayStr) {
  document.querySelectorAll(".fc-daygrid-day").forEach(el => {
    el.style.backgroundColor = "";
    el.style.transition = "background 0.2s ease";
  });

  const el = document.querySelector(`[data-date="${dayStr}"]`);

  if (el) {
    el.style.backgroundColor = "#e8f0fe";
    el.style.borderRadius = "4px";
  }
}

// ✅ AUTO SCROLL WEEK VIEW TO SELECTED DAY
function scrollWeekToDate(dayStr) {
  const container = document.getElementById("weekView");
  const el = container?.querySelector(`[data-day="${dayStr}"]`);

  if (el) {
    container.scrollTo({
      top: el.offsetTop,
      behavior: "smooth"
    });
  }
}

// ✅ STRIP HTML FROM NOTES FOR TOOLTIP (SAFETY)
function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}

/*
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
  source = normalizeProvider(source);  // ✅ ADD THIS LINE
  // ==================================================
  // ✅ BASE CONTAINER (UNCHANGED — DO NOT MODIFY)
  // ==================================================
  const icon = document.createElement("span");

  icon.style.display = "flex";
  icon.style.alignItems = "center";
  icon.style.justifyContent = "center";
  
  icon.style.width = "16px";
  icon.style.height = "16px";

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

  // ✅ CRITICAL FIX — ALIGN SELECTED DATE
  selectedDate = toDayString(calendar.getDate());

  bindUIEvents();

  updateDayDetails();
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
      console.error("API error:", res.status, await res.text());
      throw new Error("API failed: " + res.status);
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

/**************************************************************
 * ✅ HARD COLOR ENFORCER (ANTI-FULLCAL OVERRIDE)
 * Ensures colors ALWAYS match accountColorMap
 **************************************************************/
function enforceAllEventColors() {

  if (!calendar) return;

  const elements = document.querySelectorAll(".fc-event");

  elements.forEach(el => {

    const id =
      el.getAttribute("data-event-id") ||
      el.getAttribute("data-id");

    if (!id) return;

    const event = calendar.getEventById(id);
    if (!event) return;

    const key = event.extendedProps?.account_key;
    const provider = normalizeProvider(event.extendedProps?.source);

    const color =
      accountColorMap[key] ||
      accountColorOverrides[key] ||
      getBaseProviderColor(provider);

    el.style.setProperty("background-color", color, "important");
    el.style.setProperty("border-color", color, "important");
  });
}

/************************************************************
 * ✅ INIT FULLCALENDAR
 **************************************************************/
function initCalendar(el) {
    calendar = new FullCalendar.Calendar(el, {

      initialView: "dayGridMonth",
      timeZone: "local",

      // ✅ LOCK WEEK START (CRITICAL FOR CONSISTENCY)
      firstDay: 0,  // ✅ Sunday = start of week

      dayMaxEventRows: 6,
      dayMaxEvents: false,

// ✅ ONLY ONE EVENTS BLOCK EXISTS
events: async (fetchInfo, successCallback, failureCallback) => {

  let filteredEvents = []; // ✅ FIX: declare OUTSIDE try

  try {
    console.log("🔄 Fetching events...");

    // ✅ STEP 1: FETCH
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

    // ✅ STEP 2: NORMALIZE RESPONSE
    const rawEvents = Array.isArray(data)
      ? data
      : Array.isArray(data?.events)
      ? data.events
      : [];

    console.log(`📦 Raw events count: ${rawEvents.length}`);

    // ✅ STEP 3: MAP
    let mappedEvents = rawEvents
      .filter(ev => {
        if (!ev.start) {
          console.warn("⚠️ Missing start:", ev);
          return false;
        }
        return true;
      })

      .map(ev => {

        const rawStart = ev.start;
        const rawEnd = ev.end;

        // ✅ SINGLE SOURCE PARSING (NO HACKS)
        const safeStart = safeParseDate(rawStart);
        if (!safeStart) return null;   // prevent bad events
        const safeEnd = safeParseDate(rawEnd);
        const provider = normalizeProvider(ev.source);

        const account = (
          ev.account_email ||
          ev.account ||
          ""
        ).toLowerCase().trim();

        const account_key = `${provider}:${account}`;

        const safeId = [
          provider,
          account,
          ev.external_id || ev.id || "noid",
          rawStart
        ].join("|");

        return {
          id: safeId,
          title: ev.title || ev.summary || "Untitled",
          start: safeStart,
          end: safeEnd || null,
          
          /* ✅ DO NOT ASSIGN COLORS HERE
            → Event color is applied ONLY in eventDidMount
          */
          backgroundColor: "transparent",
          borderColor: "transparent",

          textColor: "#ffffff",

          classNames: ["source-" + provider],

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

    
    // ✅ STEP 4: APPLY ACCOUNT FILTER
    filteredEvents = mappedEvents;

    if (activeAccountFilters.size > 0) {
      filteredEvents = mappedEvents.filter(ev => {
        const key = ev.extendedProps.account_key;
        return activeAccountFilters.has(key);
      });
    }


    console.log(`🎯 Final events: ${filteredEvents.length}`);

    // ✅ STEP 5: RETURN
    lastGoodEvents = filteredEvents;
    successCallback(filteredEvents);

  } catch (err) {
    console.error("❌ Event load failed:", err);

    if (lastGoodEvents.length > 0) {
      console.warn("⚠️ Using cached events");
      successCallback(lastGoodEvents);
    } else {
      failureCallback(err);
    }
  }
},

    // ✅ ✅ ✅ PUT IT RIGHT HERE (IMPORTANT)
    eventsSet: () => {
      console.log("✅ eventsSet fired");

      // ✅ ONLY initialize once — NEVER override user selection
      if (!selectedDate) {
        selectedDate = toDayString(calendar.getDate());
      }

      updateWeekView();
      updateDayDetails();
      highlightSelectedDay(selectedDate);
      setTimeout(enforceAllEventColors, 0);
    },


    /* =====================================================
    ✅ SINGLE SOURCE OF TRUTH (COLOR ENGINE)
      ✅ GOLD RULE — EVENT REFETCH POLICY

      ONLY use calendar.refetchEvents() when:
      ✔ Backend data changes (create/update/delete/sync)
      ✔ Event dataset changes (filters, range)

      NEVER use refetchEvents() for:
      ✘ Color updates
      ✘ UI styling
      ✘ Local overrides

      Use enforceAllEventColors() instead.

      This guarantees:
      ✅ zero flicker
      ✅ no race conditions
      ✅ consistent color application

    ===================================================== */
    eventDidMount: (info) => {

      const key = info.event.extendedProps.account_key;
      const provider = normalizeProvider(info.event.extendedProps.source);



      const color =
        accountColorMap[key] ||              // ✅ primary
        accountColorOverrides[key] ||        // ✅ user override
        getBaseProviderColor(provider);      // ✅ fallback

      /* =====================================================
      ✅ FORCE APPLY (OVERRIDES FULLCAL + CSS)
      ===================================================== */

      info.el.style.setProperty("background-color", color, "important");
      info.el.style.setProperty("border-color", color, "important");

      /* ✅ text contrast */
      info.el.style.color = "#fff";

      /* ✅ consistent styling */
      info.el.style.border = "none";
      info.el.style.borderRadius = "6px";
      info.el.style.padding = "2px 4px";
    },

    /**************************************************
     * CLICK EVENT
     **************************************************/
    // ✅ CLICK DAY → CREATE + UPDATE SIDEBAR
    dateClick: (info) => {

      // ✅ SAVE selected date (VERY IMPORTANT)
      selectedDate = toDayString(info.date);

      // ✅ ONLY update UI (no modal)
      updateDayDetails();
      
      // ✅ store selected date for highlight
      highlightSelectedDay(selectedDate);
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
        selectedDate = toDayString(info.event.start);

        updateDayDetails();
        highlightSelectedDay(selectedDate);

        setTimeout(() => {
          scrollWeekToDate(selectedDate);
        }, 50);
      }
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
    eventContent: function(arg) {

      const source = arg.event.extendedProps?.source;

      const container = document.createElement("div");
      container.style.display = "flex";
      container.style.alignItems = "center";
      container.style.gap = "4px";

      // ✅ ICON
      const icon = createSourceIcon(source);

      // ✅ ACCOUNT + PROVIDER
      const account = arg.event.extendedProps.account || "";
      const provider = normalizeProvider(arg.event.extendedProps?.source);
      const accountShort = account.split("@")[0] || "X";

      // ✅ TITLE
      const title = document.createElement("div");
      title.textContent = arg.event.title;
      title.style.fontSize = "12px";
      title.style.fontWeight = "500";
      title.style.whiteSpace = "nowrap";
      title.style.overflow = "hidden";
      title.style.textOverflow = "ellipsis";

      // ✅ BUILD ORDER (FIXED)
      container.appendChild(icon);

      // ✅ ONLY show badge when needed
      if ((providerAccountCounts[provider] || 0) > 1) {
        const badge = document.createElement("span");
        badge.textContent = accountShort.slice(0, 2).toUpperCase();

        badge.style.fontSize = "10px";
        badge.style.fontWeight = "bold";
        badge.style.background = "rgba(255,255,255,0.25)";
        badge.style.color = "#fff";
        badge.style.padding = "1px 4px";
        badge.style.borderRadius = "4px";
        badge.style.flexShrink = "0";

        container.appendChild(badge);
      }

      container.appendChild(title);

      return { domNodes: [container] };
    }

  });

  calendar.render();
}


/* =====================================================
✅ COLOR ENGINE (CENTRALIZED + SCALABLE)
===================================================== */

// ✅ Base colors per provider
const BASE_COLORS = {
  google: "#34a853",      // ✅ FIXED (matches event chip)
  microsoft: "#2563eb",   // ✅ matches event
  apple: "#ef4444",
  other: "#999"
};

/**************************************************************
 * ✅ USER COLOR OVERRIDE STORAGE (LOCAL, BULLETPROOF)
 **************************************************************/

// ✅ STORAGE KEY (single source of truth)
const ACCOUNT_COLOR_STORAGE_KEY = "accountColorOverrides";

// ✅ LOAD SAVED OVERRIDES
function loadColorOverrides() {
  try {
    const raw = localStorage.getItem(ACCOUNT_COLOR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.warn("⚠️ Failed to parse color overrides");
    return {};
  }
}

// ✅ SAVE OVERRIDES
function saveColorOverrides(map) {
  localStorage.setItem(
    ACCOUNT_COLOR_STORAGE_KEY,
    JSON.stringify(map)
  );
}

// ✅ GET CURRENT OVERRIDES
let accountColorOverrides = loadColorOverrides();

// ✅ NORMALIZE PROVIDER (SINGLE SOURCE OF TRUTH)
function normalizeProvider(provider) {
  const p = (provider || "").toLowerCase();
  return p === "outlook" ? "microsoft" : p;
}

// ✅ BASE PROVIDER COLOR (SINGLE SOURCE OF TRUTH)
function getBaseProviderColor(provider) {
  const normalized = normalizeProvider(provider);
  return BASE_COLORS[normalized] || BASE_COLORS.other;
}



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
  const base = getBaseProviderColor(provider);
  // ✅ THIS IS THE SECRET SAUCE
  // First step has a minimum jump → avoids subtle differences
  const percent = Math.min(0.35 + (index * 0.40), 0.85);

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
    color = getBaseProviderColor(event.extendedProps.source);
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

/* =====================================================
✅ ACCOUNT LIST + COLOR MAP BUILDER (WITH HIDE SUPPORT)
===================================================== */
function renderAccounts(accounts) {
  providerAccountCounts = {};
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
  
  const normalizedAccounts = accounts.map(acc => {
    const provider = normalizeProvider(acc.provider || "other");

    const email = (acc.account_email || acc.email || "")
      .toLowerCase()
      .trim();

    return { provider, email };
  });

  // ✅ PRE-CALCULATE COUNTS FIRST
  normalizedAccounts.forEach(({ provider }) => {
    if (!providerAccountCounts[provider]) {
      providerAccountCounts[provider] = 0;
    }
    providerAccountCounts[provider]++;
  });

  normalizedAccounts.forEach(({ provider, email }) => {
    if (!providerAccountCounts[provider]) {
      providerAccountCounts[provider] = 0;
    }

    if (!email) return;

    if (!providerCounts[provider]) {
      providerCounts[provider] = 0;
    }

    const index = providerCounts[provider]++;

    // ✅ SINGLE SOURCE KEY (ONLY ONCE)
    const key = `${provider}:${email}`;

    // ✅ APPLY OVERRIDE OR GENERATED COLOR
    const color = getFinalAccountColor(key, provider, index);

    // ✅ STORE FINAL COLOR
    accountColorMap[key] = color;

    // ✅ CREATE CHIP
    const row = document.createElement("div");
    row.classList.add("chip");   // ✅ ADD ONLY HERE
    row.dataset.key = key;
    row.title = `${email} • Click to filter \n Ctrl+Click for multi-select`;

    // LABEL for accounts
    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.alignItems = "center";
    container.style.gap = "4px";

    // ✅ ICON
    const icon = createSourceIcon(provider);
    container.appendChild(icon);

    // ✅ BADGE (same as event)
    if ((providerAccountCounts[provider] || 0) > 1) {
      const prefix = email.split("@")[0].slice(0, 2).toUpperCase() || "X";

      const badge = document.createElement("span");
      badge.classList.add("account-badge");

      badge.textContent = prefix;

      const baseColor = accountColorMap[key] || getBaseProviderColor(provider);

      badge.style.background = baseColor;
      badge.style.color = "#fff";
      badge.style.border = "none";
      badge.style.fontSize = "10px";
      badge.style.fontWeight = "bold";
      badge.style.padding = "1px 4px";
      badge.style.borderRadius = "4px";
      badge.style.flexShrink = "0";
    
      container.appendChild(badge);
    }

    // ✅ TITLE
    const title = document.createElement("span");
    title.textContent = email.split("@")[0];

    container.appendChild(title);

    // ✅ FINAL APPEND
    row.appendChild(container);

    /**************************************************************
     * ✅ COLOR PICKER (INLINE, NON-INTRUSIVE)
     **************************************************************/

    const picker = document.createElement("input");
    picker.type = "color";

    // ✅ use current color
    picker.value = color;
    // ✅ bold matching border
    picker.style.outline = "none";

    // ✅ STRONG OUTER RING (this is what you want)
    picker.style.border = "none";                 // ✅ remove native frame COMPLETELY
    picker.style.borderRadius = "50%";
    picker.style.transform = "scale(0.75)";       // ✅ smaller dot (hides gray edge)
    picker.style.backgroundColor = color;         // ✅ FORCE fill
    picker.style.boxShadow = `0 0 0 3px ${color}`; // ✅ strong outer ring


    // ✅ keep compact
    picker.style.marginLeft = "6px";
    picker.style.width = "18px";
    picker.style.height = "18px";
    
    picker.style.padding = "0";
    picker.style.cursor = "pointer";
    picker.title = "Click = set color • Right-click = reset";

    // ✅ STOP FILTER CLICK CONFLICT
    picker.onclick = (e) => e.stopPropagation();

    // ✅ HANDLE CHANGE
    picker.oninput = (e) => {
      const newColor = e.target.value;

      // ✅ save override
      accountColorOverrides[key] = newColor;
      saveColorOverrides(accountColorOverrides);

      // ✅ update local map immediately
      accountColorMap[key] = newColor;

      picker.style.backgroundColor = newColor;
      picker.style.boxShadow = `0 0 0 3px ${newColor}`;
      // ✅ update chip visuals instantly
      row.style.backgroundColor = `${newColor}26`;
      row.style.border = `2.5px solid ${newColor}`;
      row.style.color = newColor;

      // ✅ update badge if exists
      const badge = row.querySelector(".account-badge");
      if (badge) {
        badge.style.background = newColor;
      }

      // ✅ UI refresh (no reload)
      // ✅ instant visual update
      enforceAllEventColors();
    };

    /**************************************************************
     * ✅ RIGHT-CLICK → RESET TO DEFAULT COLOR
     **************************************************************/
    picker.oncontextmenu = (e) => {
      e.preventDefault(); // ✅ prevent browser menu

      // ✅ remove override
      delete accountColorOverrides[key];

      const defaultColor = getAccountColor(provider, index);

      row.style.backgroundColor = `${defaultColor}26`;
      row.style.border = `2.5px solid ${defaultColor}`;
      row.style.color = defaultColor;

      const badge = row.querySelector(".account-badge");
      if (badge) {
        badge.style.background = defaultColor;
      }

      picker.style.backgroundColor = defaultColor;
      picker.style.boxShadow = `0 0 0 3px ${defaultColor}`;


      // ✅ persist removal
      saveColorOverrides(accountColorOverrides);

      // ✅ rebuild color using default logic
      delete accountColorMap[key]; // forces recalculation

      // ✅ refresh UI
      enforceAllEventColors();
    };


    row.appendChild(picker);

    // ✅ MATCH EVENT-STYLE CHIP (COLOR + STRUCTURE)
    // ✅ LIGHT TINT BACKGROUND (matches your screenshot)
    // ✅ MATCH EVENT CHIP TINT + STRONGER BORDER
    row.style.backgroundColor = `${color}26`;   // stronger tint (matches event feel)
    row.style.border = `2.5px solid ${color}`;  // thicker border (as you want)
    row.style.color = color;

    // ✅ STRUCTURE
    row.style.display = "inline-flex";
    row.style.alignItems = "center";
    row.style.gap = "4px";

    // ✅ CHIP SHAPE
    row.style.borderRadius = "999px";
    row.style.padding = "4px 8px";

    row.style.outline = "none";
    row.style.boxShadow = "none"; 

    
    /* ✅ DATASET CHANGE → MUST REFRESH EVENTS
      This modifies which events are visible,
      so FullCalendar must refetch + re-render.
      *** CLICK FILTER Exclusive First Click + Toggle with Ctrl
    */
    row.onclick = (e) => {
      const isMultiSelect = e.ctrlKey || e.metaKey;
      if (!isMultiSelect) {
        // ✅ SINGLE CLICK = RESET TO ONLY THIS
        activeAccountFilters.clear();
        activeAccountFilters.add(key);

      } else {
        // ✅ CTRL CLICK = TOGGLE
        if (activeAccountFilters.has(key)) {
          if (activeAccountFilters.size > 1) {
            activeAccountFilters.delete(key);
          }
        } else {
          activeAccountFilters.add(key);
        }
      }

    updateChipSelectionUI();
    //This is a DATASET CHANGE, not just UI. We need to refetch to apply the filter.
    calendar.refetchEvents();
  };


    el.appendChild(row);
  });

  // ✅ Default: all accounts active on first load
  if (activeAccountFilters.size === 0) {
    normalizedAccounts.forEach(({ provider, email }) => {
      if (!email) return;
      activeAccountFilters.add(`${provider}:${email}`);
    });
  }
  updateChipSelectionUI();
}
function updateChipSelectionUI() {
  const accountContainer = document.getElementById("accounts");
  accountContainer?.querySelectorAll(".chip").forEach(row => {
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
function updateDayDetails() {
  if (!selectedDate) return;  // ✅ guard
  const titleEl = document.getElementById("selectedDateTitle");
  const listEl = document.getElementById("dayEventsList");

  if (!titleEl || !listEl || !calendar) return;
  
  
  // ✅ Softer, cleaner header
  const safeDate = fromDayString(selectedDate);

  titleEl.innerHTML = `
    <div style="
      font-size:15px;
      font-weight:600;
      color:#333;
      margin-bottom:6px;
    ">
      ${safeDate.toDateString()}
    </div>
  `;
  
  let events = calendar.getEvents().filter(ev => {
    if (!ev.start) return false;

    const evDay = toDayString(ev.start);
    return evDay === selectedDate;
  });

  events.sort((a, b) => a.start - b.start);

  listEl.innerHTML = "";

  if (events.length === 0) {
    listEl.innerHTML = `<li style="color:#888;">No events</li>`;
    return;
  }

  events.forEach(ev => {

    const li = document.createElement("li");
    
    const time = ev.start
      ? ev.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : "";

    const row = document.createElement("div");
    const key = ev.extendedProps?.account_key;
    const color = accountColorMap[key] || getBaseProviderColor(ev.extendedProps.source);

    // ✅ subtle colored band
    row.style.borderLeft = `4px solid ${color}`;
    row.style.paddingLeft = "6px";

    // ✅ OPTIONAL light tint (very nice touch)
    row.style.background = `${color}1a`;

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
    const titleSpan = document.createElement("span");
    titleSpan.textContent = ev.title;
    titleSpan.style.fontWeight = "500";

    // ✅ BUILD
    row.appendChild(icon);
    row.appendChild(timeEl);
    row.appendChild(titleSpan);

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
  // ✅ base date is now STRING → convert to Date
  const base = fromDayString(selectedDate);

  // ✅ compute week range
  const start = new Date(base);
  start.setDate(base.getDate() - base.getDay());

  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  // ✅ string boundaries
  const startDay = toDayString(start);
  const endDay = toDayString(end);

  // ✅ filter events
  let weekEvents = events.filter(ev => {
    if (!ev.start) return false;

    const evDay = toDayString(ev.start);

    return evDay >= startDay && evDay < endDay;
  });

  container.innerHTML = "";

  if (weekEvents.length === 0) {
    container.innerHTML = `<div style="color:#888;">No events this week</div>`;
    return;
  }

  weekEvents.sort((a, b) => a.start - b.start);

  let currentDay = "";

  weekEvents.forEach(ev => {

    const evDate = ev.start;
    const dayLabel = evDate.toDateString();

    // ✅ Better section header (lighter + separated)
    if (dayLabel !== currentDay) {
      currentDay = dayLabel;


      const dayDiv = document.createElement("div");
      // ✅ tag for auto-scroll targeting
      dayDiv.setAttribute(
        "data-day",
        toDayString(ev.start)
      );

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

    const inner = document.createElement("div");
    const key = ev.extendedProps?.account_key;
    const color = accountColorMap[key] || getBaseProviderColor(ev.extendedProps.source);

    // ✅ colored band
    inner.style.borderLeft = `4px solid ${color}`;
    inner.style.paddingLeft = "6px";

    // ✅ optional tint
    inner.style.background = `${color}1a`;

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
  const todayStr = toDayString(now);
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
      const d = event.start;
      document.getElementById("eventDate").value =
        toDayString(d);
      document.getElementById("eventStart").value =
        d.toTimeString().slice(0, 5);
    }

    if (event.end) {
      const d = event.end;
      document.getElementById("eventEnd").value =
        d.toTimeString().slice(0, 5);
    }
  }

  // ✅ If clicking a day → PRE-FILL DATE
  if (date && !event) {
    document.getElementById("eventDate").value =
      toDayString(date);
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
