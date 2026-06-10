console.log("🔥 JS FILE LOADED");
console.log("🔐 TOKEN AT LOAD:", localStorage.getItem("token"));

/**************************************************************
 * ✅ TOKEN ENGINE (SINGLE SOURCE OF TRUTH)
 **************************************************************/
function getTokenSafe() {
  const token = localStorage.getItem("token");

  if (!token) {
    console.warn("⚠️ No token → redirecting to login");
    window.location.replace("/login");
    return null;
  }

  return token;
}

/**************************************************************
 * ✅ AUTH GUARD (SAFE VERSION + NO STALE TOKEN)
 ****************************+**********************************/
if (window.location.pathname.includes("calendar-ui")) {
  getTokenSafe();
}


/**************************************************************
 * ✅ CENTRALIZED API FETCH (TOKEN SAFE)
 **************************************************************/
async function apiFetch(url, options = {}) {
  const authToken = getTokenSafe();
  // ✅ STOP EARLY (NO TOKEN)
  if (!authToken) return null;

  let res;

  try {
    res = await fetch(url, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + authToken,
        ...(options.headers || {})
      }
    });
  } catch (err) {
    console.warn("⚠️ Network issue:", err);
    return null; // ✅ NO CRASH
  }

  // ✅ HANDLE AUTH CLEANLY
  if (res.status === 401) {
    console.warn("⚠️ Session expired → redirect");

    localStorage.removeItem("token");

    window.location.replace("/login");

    return null; // ✅ NO THROW
  }

  return res;
}

/**************************************************************
 * ✅ GLOBAL STATE
 **************************************************************/
let calendar = null;
let isAppSyncing = false;
let editingEventId = null;
let editingNoteId = null;
let lastGoodEvents = [];
let providerAccountCounts = {};
let allAccountKeys = new Set();   // ✅ MASTER ACCOUNT LIST
let needsCacheRefresh = false;
let lastLoadedAccounts = [];
let recentlySynced = new Set();

// ✅ GLOBAL SYNC STATE (NEW)

/**************************************************************
 * ✅ GOLD STANDARD: PER-ACCOUNT SYNC TRACKER
 * ------------------------------------------------------------
 * PURPOSE:
 * Track which specific accounts are currently syncing
 *
 * WHY:
 * - Eliminates global spinner problem
 * - Enables independent UI state per account
 * - Matches real multi-account architecture
 *
 * STRUCTURE:
 * Set<string> → account_key
 **************************************************************/
let syncingAccounts = new Set();

/**************************************************************
 * ✅ ACCOUNT SYNC STATUS MAP
 * key → "ok" | "error"
 **************************************************************/
let accountStatusMap = {};


// ✅ RANGE CONTROL (NEW)
let currentRangeDays = 30;  // ✅ Default = Monthly
let currentRangeStart = null;
let currentRangeEnd = null; 

// ✅ Track selected day
let selectedDate = null;

// ✅ NEW: account filter
let activeAccountFilters = new Set();

/**************************************************************
 * ✅ SESSION EVENT CACHE (SEC) — GOLD STANDARD
 * - Single fetch per session
 * - All filtering becomes client-side
 * - Eliminates redundant API calls
 **************************************************************/
let sessionEventCache = [];
let sessionCacheRange = {
  start: null,
  end: null
};
let isInitialLoadComplete = false;

/**************************************************************
 * ✅ SMART REFRESH ENGINE (REPLACES refetchEvents)
 **************************************************************/
function smartRefresh({ reason = "unknown", force = false } = {}) {

  console.log(`🧠 SMART REFRESH → ${reason}`);

  if (force) {
    console.log("⚠️ FORCE REFETCH");
    calendar.refetchEvents();
    return;
  }

  // ✅ NO SERVER CALL — JUST RE-RENDER UI FROM CACHE
  applyClientSideFilters();

  updateDayDetails();
  updateWeekView();
  highlightSelectedDay(selectedDate);

}

/**************************************************************
 * ✅ CACHE MUTATION ENGINE (STEP TOWARD ZERO-REFETCH)
 **************************************************************/
function updateEventInCache(updatedEvent) {

  const index = sessionEventCache.findIndex(e => e.id === updatedEvent.id);

  if (index !== -1) {
    sessionEventCache[index] = {
      ...sessionEventCache[index],
      ...updatedEvent
    };
  }
}

/**************************************************************
 * ✅ HELPERS
 **************************************************************/
function normalizeKey(provider, email) {
  return `${normalizeProvider(provider)}:${(email || "").toLowerCase().trim()}`;
}
/**************************************************************
 * ✅ IS DATE IN ACTIVE RANGE
 **************************************************************/
function isDateInActiveRange(date) {

  if (!calendar) return true;

  const { start, end } = getActiveRangeLabel(currentRangeDays);

  if (!start || !end) return true;

  return date >= start && date <= end;
}

/**************************************************************
 * ✅ APPLY RANGE TOOLTIPS (SAFE + REUSABLE)
 **************************************************************/
function applyRangeTooltips() {

  document.querySelectorAll(".range-btn").forEach(btn => {

    if (btn.id === "customRange") return;

    const previewDays =
      btn.id === "monthly" ? 30 :
      btn.id === "quarterly" ? 90 :
      btn.id === "semiAnnual" ? 180 :
      btn.id === "yearly" ? 365 :
      currentRangeDays;

    const preview = getActiveRangeLabel(previewDays);

    if (preview.label) {
      btn.title = `Range: ${preview.label}`;
    }
  });
}


/**************************************************************
 * ✅ RANGE CALCULATOR (SINGLE SOURCE OF TRUTH)
 * ------------------------------------------------------------
 * DO NOT duplicate logic elsewhere
 * ALL range UI derives from here
 **************************************************************/
function getActiveRangeLabel(days) {

  if (!calendar) {
    return { start: null, end: null, label: "" };
  }

  const base = calendar.getDate();

  const start = new Date(base);
  const end = new Date(base);

  start.setDate(base.getDate() - days);
  end.setDate(base.getDate() + days);

  const format = d =>
    d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });

  return {
    start,
    end,
    label: `${format(start)} → ${format(end)}`
  };
}

/**************************************************************
 * ✅ GOLD STANDARD: CONTRAST ENGINE (WCAG SAFE)
 * ------------------------------------------------------------
 * PURPOSE:
 * Ensure text is ALWAYS readable against ANY background color
 *
 * RULE:
 * ALWAYS use this instead of hardcoded "#fff" or "#222"
 *
 * WHY:
 * - human perception ≠ raw RGB
 * - prevents unreadable text on vibrant colors
 * - matches modern design systems (Google, Apple, Microsoft)
 **************************************************************/
function normalizeColorHarmony(hex) {

  // ✅ round color to softer palette bands
  const num = parseInt(hex.replace("#", ""), 16);

  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;

  // ✅ clamp extremes (removes neon harshness)
  r = Math.min(220, Math.max(60, r));
  g = Math.min(220, Math.max(60, g));
  b = Math.min(220, Math.max(60, b));

  return "#" + [r, g, b]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}
function getLuminance(hex) {
  const rgb = hex.replace("#", "").match(/.{2}/g)
    .map(x => parseInt(x, 16) / 255)
    .map(c => (
      c <= 0.03928
        ? c / 12.92
        : Math.pow((c + 0.055) / 1.055, 2.4)
    ));

  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function getBestTextColor(bgHex) {

  if (!bgHex || typeof bgHex !== "string") {
    return "#000"; // ✅ safe fallback
  }

  const bgLum = getLuminance(bgHex);

  // ✅ WCAG contrast ratios
  const whiteContrast = (1.05) / (bgLum + 0.05);
  const blackContrast = (bgLum + 0.05) / 0.05;

  return whiteContrast > blackContrast ? "#fff" : "#000";
}

/**************************************************************
 * ✅ GOLD STANDARD: TOAST SYSTEM
 * ------------------------------------------------------------
 * FEATURES:
 * ✅ non-blocking UX (no alert())
 * ✅ auto-dismiss
 * ✅ animated
 * ✅ reusable
 *
 * TYPES:
 * - success (green)
 * - error (red)
 * - neutral (gray)
 **************************************************************/
function showToast(message, type = "success") {

  const toast = document.createElement("div");

  toast.textContent = message;

  /**************************************************************
   * ✅ BASE STYLE
   **************************************************************/
  toast.style.position = "fixed";
  toast.style.bottom = "20px";
  toast.style.right = "20px";
  toast.style.padding = "10px 14px";
  toast.style.borderRadius = "6px";
  toast.style.color = "#fff";
  toast.style.fontSize = "13px";
  toast.style.zIndex = "9999";

  toast.style.boxShadow = "0 4px 10px rgba(0,0,0,0.25)";
  toast.style.opacity = "0";
  toast.style.transform = "translateY(10px)";
  toast.style.transition = "all 0.25s ease";

  /**************************************************************
   * ✅ TYPE COLORS
   **************************************************************/
  if (type === "success") {
    toast.style.background = "#16a34a";
  } else if (type === "error") {
    toast.style.background = "#dc2626";
  } else {
    toast.style.background = "#333";
  }

  document.body.appendChild(toast);

  /**************************************************************
   * ✅ ANIMATE IN
   **************************************************************/
  setTimeout(() => {
    toast.style.opacity = "1";
    toast.style.transform = "translateY(0)";
  }, 10);

  /**************************************************************
   * ✅ AUTO REMOVE
   **************************************************************/
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}


function setSyncBanner(state = "hidden") {

  
  // 🔕 GLOBAL DISABLE (safe toggle) AKA: HARD KILL SWITCH for that Pulsing Syncing Calendars... Orange banner
  return;

  const banner = document.getElementById("syncBanner");
  if (!banner) return;

  /**************************************************************
   * ✅ RESET FIRST (CRITICAL)
   **************************************************************/
  banner.style.animation = "none";
  banner.style.display = "none";
  banner.style.background = "";
  banner.style.color = "";

  banner.style.display = "block";
  banner.style.position = "fixed";
  banner.style.top = "calc(var(--header-height, 60px) + 10px)";
  banner.style.left = "50%";
  banner.style.transform = "translateX(-50%)";
  banner.style.padding = "8px 12px";
  banner.style.borderRadius = "8px";
  banner.style.fontSize = "13px";
  banner.style.boxShadow = "0 4px 10px rgba(0,0,0,0.25)";
  banner.style.zIndex = "9999";

/*  SURGICAL FIX (DO THIS EXACTLY)
✅ STEP 1 — Disable the ENTIRE SYNCING STATE

  if (state === "syncing") {
    banner.textContent = "⏳ Syncing calendars...";
    banner.style.background = "#f59e0b";
    banner.style.color = "#fff";
    //banner.style.animation = "pulse 1s infinite";
  }
*/
  if (state === "syncing") {
    // 🔕 Sync banner disabled during debugging
    banner.style.display = "none";
  }
  else if (state === "success") {
    banner.textContent = "✅ Sync complete";
    banner.style.background = "#16a34a";
    banner.style.color = "#fff";

    setTimeout(() => {
      banner.style.display = "none";
    }, 1500);
  }
}

//CENTRALIZE RENDERING
function renderAccountsSafe() {
  if (!lastLoadedAccounts || !lastLoadedAccounts.length) return;
  console.trace("🧠 RENDER ACCOUNTS TRIGGERED");
  renderAccounts(lastLoadedAccounts);
}

/**************************************************************
 * ✅ NORMALIZE TO LOCAL DAY (CRITICAL FIX)
 **************************************************************/
function normalizeToLocalDay(dateInput) {
  const d = new Date(dateInput);

  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate(),
    0, 0, 0, 0
  );
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

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
 * ✅ SAFE DAY KEY (CRITICAL FIX FOR TIMEZONE DRIFT)
 * - Uses LOCAL calendar day exactly as FullCalendar sees it
 * - DO NOT normalize again
 **************************************************************/
function getEventDayKey(dateInput) {
  if (!dateInput) return null;

  const d = new Date(dateInput);

  return d.getFullYear() + "-" +
    String(d.getMonth() + 1).padStart(2, "0") + "-" +
    String(d.getDate()).padStart(2, "0");
}

/**************************************************************
 * ✅ ABSOLUTE COLOR SOURCE (DO NOT BYPASS)
 **************************************************************/
function resolveEventColor(event) {
  return getColorByKey(
    event?.extendedProps?.account_key,
    normalizeProvider(event?.extendedProps?.source)
  );
}


/**************************************************************
 * ✅ SAFE COLOR ACCESSOR (WORKS WITH OR WITHOUT FULL EVENT)
 **************************************************************/
function getColorByKey(key, provider) {
  if (!key) {
    console.warn("⚠️ Missing account key for color");
    return "#999";
  }

  const color =
    accountColorOverrides[key] ||
    accountColorMap[key] ||
    getBaseProviderColor(provider);

  if (!color) {
    console.warn("⚠️ No color resolved:", key, provider);
    return "#999";
  }

  return color;
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

  // ✅ ALREADY HAS timezone info → LEAVE IT ALONE
  const hasTZ =
    typeof dt === "string" &&
    (dt.endsWith("Z") || dt.match(/[\+\-]\d{2}:\d{2}$/));

  if (typeof dt === "string" && !hasTZ) {
    dt = dt + "Z";  // only add if truly missing
  }

  const parsed = new Date(dt);

  if (isNaN(parsed.getTime())) {
    console.warn("⚠️ Failed parse:", dt);
    return null;
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

/**************************************************************
 * ✅ CACHE RANGE TOOLTIP (SINGLE SOURCE OF TRUTH)
 * - Uses PRELOADED backend range
 * - No recalculation
 * - Safe if cache not ready
 **************************************************************/
function updateCustomRangeTooltip() {

  const btn = document.getElementById("customRange");
  if (!btn) return;

  const { start, end } = sessionCacheRange || {};

  // ✅ SINGLE formatter (ONLY ONE)
  const format = (d) =>
    d
      ? d.toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric"
        })
      : "N/A";

  if (!start || !end) {
    btn.title =
`📦 Cached Event Range

From: ${format(start)}
To:   ${format(end)}

Client-side filtering enabled`;
    return;
  }

  btn.title =
`Loaded Data Range
${format(start)} → ${format(end)}

(Full dataset cached for this session)`;
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
 * ✅ GOLD STANDARD: SINGLE ACCOUNT SYNC ENGINE
 * ------------------------------------------------------------
 * BEHAVIOR:
 * 1. mark account as syncing
 * 2. re-render UI (instant visual feedback)
 * 3. perform API call
 * 4. update status map
 * 5. remove syncing state
 * 6. refresh UI safely
 *
 * GUARANTEES:
 * ✅ no stuck states (finally block)
 * ✅ UI always consistent
 * ✅ multi-account safe
 **************************************************************/
async function syncSingleAccount(accountKey) {

  console.log("🔄 Syncing only:", accountKey);

  /**************************************************************
   * ✅ STEP 1 — MARK THIS ACCOUNT SYNCING
   **************************************************************/
  syncingAccounts.add(accountKey);
  console.log("✅ ADD SYNC accountKey:", accountKey);
  

  try {
    /**************************************************************
     * ✅ STEP 2 — CALL BACKEND
     **************************************************************/
    const res = await apiFetch(`/calendar/sync?account=${accountKey}`, {
      method: "POST"
    });

    if (!res) return;

    const data = await res.json();

    console.log("✅ Sync result:", data);

    /**************************************************************
     * ✅ STEP 3 — UPDATE STATUS MAP
     **************************************************************/
    if (data.results) {
      data.results.forEach(r => {
        accountStatusMap[r.key] = r.status;
      });
    }

    /**************************************************************
     * ✅ STEP 4 — USER FEEDBACK (TOAST)
     **************************************************************/
    showToast(`✅ Synced ${accountKey}`, "success");

  } catch (err) {

    console.error("❌ Sync failed:", err);

    showToast(`❌ Sync failed: ${accountKey}`, "error");

  } finally {

    /**************************************************************
     * ✅ STEP 5 — ALWAYS CLEAN UP STATE
     * (this prevents stuck "syncing" UI)
     **************************************************************/
    syncingAccounts.delete(accountKey);
    recentlySynced.add(accountKey);
    renderAccountsSafe();  // ✅ THIS IS THE MISSING PIECE

    setTimeout(() => {
      recentlySynced.delete(accountKey);
      renderAccountsSafe();
    }, 1500);
  }

  /**************************************************************
   * ✅ STEP 6 — REFRESH DATA
   **************************************************************/
  needsCacheRefresh = true;
  smartRefresh({ reason: "single_account_sync" });
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

  // ✅ Final validation
  if (!getTokenSafe()) return;
  await loadAccounts();
  renderAccountsSafe();

  // ✅ LOAD DATA FIRST (critical) check for Full preload or parial
  if (!sessionEventCache.length || needsCacheRefresh) {
    console.log("🔄 Refreshing cache (needed)");
    await preloadEventCache();
    needsCacheRefresh = false;
  } else {
    console.log("⚡ Using existing session cache");
  }



  initCalendar(calendarEl);
  /**************************************************************
   * ✅ APPLY TOOLTIPS AFTER CALENDAR READY
   **************************************************************/
  setTimeout(() => {
    applyRangeTooltips();
  }, 50);
  
  /**************************************************************
   * ✅ INITIAL RANGE DISPLAY (FIRST LOAD)
   **************************************************************/
  setTimeout(() => {

    const { label } = getActiveRangeLabel(currentRangeDays);

    const rangeEl = document.getElementById("rangeDisplay");

    if (rangeEl) {
      rangeEl.textContent = `Showing: ${label}`;
    }

  }, 0);

  // ✅ CRITICAL FIX — ALIGN SELECTED DATE
  selectedDate = toDayString(calendar.getDate());

  bindUIEvents();

  updateDayDetails();
  updateWeekView();
  highlightSelectedDay(selectedDate);
}

function showReconnectBanner(accounts) {

  const broken = accounts.filter(a => a.status === "error");

  if (!broken.length) return;

  const banner = document.createElement("div");

  banner.style.background = "#fee2e2";
  banner.style.color = "#991b1b";
  banner.style.padding = "8px";
  banner.style.marginBottom = "8px";

  banner.innerHTML = `
    ⚠ Some accounts need reconnect:
    ${broken.map(a => a.account_email).join(", ")}
    <button onclick="window.location='/accounts/ui'">Fix</button>
  `;

  document.body.prepend(banner);
}

/**************************************************************
 * ✅ LOAD ACCOUNTS (SEPARATE FROM EVENTS)
 **************************************************************/
async function loadAccounts() {
  lastLoadedAccounts = [];

  try {
    const res = await apiFetch("/accounts");
    if (!res) return [];

    if (!res.ok) {
      console.error("API error:", res.status, await res.text());
      throw new Error("API failed: " + res.status);
    }

    const data = await res.json();  // ✅ DEFINE HERE

    lastLoadedAccounts = data;

    console.log("🔥 RAW ACCOUNT DATA:", data);

    data.forEach(acc => {
      const key = `${acc.provider}:${(acc.account_email || "").toLowerCase().trim()}`;

      console.log("🔑 MAPPING:", key, acc.status);

      if (acc.status) {
        accountStatusMap[key] = acc.status;
      }
    });

    // ✅ ✅ FIX: CALL USING data (INSIDE SCOPE)
    showReconnectBanner(data);

    renderAccounts(data);

    return data;

  } catch (err) {
    console.error("❌ Failed to load accounts:", err);
    return [];
  }
}

/**************************************************************
 * ✅ HANDLE OAuth RETURN (?connected=)
 **************************************************************/
function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  needsCacheRefresh = true;

  
  if (connected) {
    console.log("✅ Connected:", connected);
    needsCacheRefresh = true;   // ✅ ADD THIS
    syncSingleAccount(connected);

    // ✅ FORCE CALENDAR REFRESH AFTER AUTH
    setTimeout(() => {
      if (calendar) {
        console.log("🔄 FORCING REFETCH AFTER LOGIN");
        smartRefresh({ reason: "event_saved" });
      } else {
        console.warn("⚠️ Calendar not ready yet for refetch");
      }
    }, 500);

    // Clean URL
    window.history.replaceState({}, document.title, "/calendar-ui");
  }
}

function applyChipStyle(row, key, isActive) {
  
  const [provider] = key.split(":");
  const color = getColorByKey(key, provider);


  /**************************************************************
   * ✅ CHIP BACKGROUND — SOFTENED (GOLD STANDARD)
   * - keeps color identity
   * - removes heavy/dark look
   **************************************************************/
  const softBg = lightenColor(color, 0.65); // ✅ tuned to match your old screenshot

  row.style.backgroundColor = softBg;
  row.style.transition = "all 0.15s ease";
  /**************************************************************
   * ✅ TEXT — DARK FOR LIGHT BACKGROUND
   **************************************************************/
  /**************************************************************
   * ✅ DYNAMIC TEXT CONTRAST (REPLACES HARDCODE)
   **************************************************************/
  row.style.color = getBestTextColor(softBg);
  //row.style.color = "#222";

  // ✅ CLEAN CHIP LOOK
  row.style.borderRadius = "999px";
  row.style.display = "inline-flex";
  row.style.alignItems = "center";
  row.style.gap = "4px";
  row.style.padding = "4px 8px";

  // ✅ RESET JUNK
  row.style.boxShadow = "none";
  row.style.transform = "none";

  if (isActive) {
    // ✅ ACTIVE = bold outline (like before)
    row.style.border = "2px solid rgba(0,0,0,0.6)";
    row.style.opacity = "1";
  } else {
    // ✅ INACTIVE = faded (THIS WAS MISSING FEEL)
    row.style.border = "2px solid transparent";
    row.style.opacity = "0.45";
  }
}

async function preloadEventCache() {
  console.log("🧠 PRELOADING CACHE");
  isAppSyncing = true;
  
  console.log("🟡 SYNC MODE ON");
  /****************************************************************
   * ✅ FORCE SYNC STATE FOR DOTS DURING PRELOAD
   ****************************************************************/
  syncingAccounts.clear();
  lastLoadedAccounts.forEach(acc => {
    const provider = normalizeProvider(acc.provider || "other");
    const email = (acc.account_email || "").toLowerCase().trim();
    if (!email) return;

    const key = normalizeKey(provider, email);

    syncingAccounts.add(key);

    console.log("✅ PRELOAD SYNC KEY:", key);
  });

  /**************************************************************
   ✅ ADD THIS LINE RIGHT HERE
  **************************************************************/
  renderAccountsSafe();

  //setSyncBanner("syncing");
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  
  start.setMonth(start.getMonth() - 6);
  end.setMonth(end.getMonth() + 6);

  const res = await apiFetch(
    
    `/calendar/unified?start=${start.toISOString()}&end=${end.toISOString()}`
  );

  if (!res) return;


  if (!res.ok) throw new Error("API failed");

  const data = await res.json();

  const rawEvents = data.events || [];
  const backendStatus = data.account_status || {};
  console.log("🔥 BACKEND account_status:", backendStatus);

  // ✅ 🔴 CRITICAL: UPDATE GLOBAL STATUS MAP
  Object.assign(accountStatusMap, backendStatus);

  console.log("🧠 STATUS MAP UPDATED:", accountStatusMap);

  sessionEventCache = rawEvents.map(ev => {
    const safeStart = safeParseDate(ev.start);
    if (!safeStart) return null;

    const safeEnd = safeParseDate(ev.end);
    const provider = normalizeProvider(ev.source);

    let account = ev.account_email || ev.account || "";
    account = account.toLowerCase().trim();

    const normalizedAccount = (account || "")
      .toLowerCase()
      .trim();

    const account_key = normalizeKey(provider, account);
    
    const color = getColorByKey(account_key, provider);

    return {
      id: Math.random().toString(36),
      title: ev.title || "Untitled",
      start: safeStart,
      end: safeEnd || null,

      extendedProps: {
        source: provider,
        account,
        account_key,
        notes: ev.notes || []
      }
    };

  }).filter(Boolean);

  sessionCacheRange = { start, end };
  isInitialLoadComplete = true;
  
  //setSyncBanner("success");
  console.log("✅ PRELOAD COMPLETE:", sessionEventCache.length);
    isAppSyncing = false;
  
  console.log("✅ SYNC MODE OFF");  
  syncingAccounts.clear();
  console.log("🧼 CLEARED syncingAccounts:", syncingAccounts);
  renderAccountsSafe();
  // ✅ ADD THIS LINE (CRITICAL — ONLY PLACE IT NEEDS TO RUN)
  updateCustomRangeTooltip();

  console.log(
    "LATEST EVENT DATE:",
    sessionEventCache.reduce((max, ev) => {
      return ev.start > max ? ev.start : max;
    }, new Date(0))
  );

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
    events: function(fetchInfo, successCallback) {

      const viewStart = normalizeToLocalDay(fetchInfo.start);
      const viewEnd   = normalizeToLocalDay(fetchInfo.end);   
      const visibleEvents = sessionEventCache.filter(ev => {

      if (!ev.start) return false;

      const evDay = normalizeToLocalDay(ev.start);

      const inRange =
        evDay >= viewStart && evDay < viewEnd;

      const key = ev.extendedProps?.account_key;

      const matchesAccount =
        key === "local:local" ||
        activeAccountFilters.has(key);

      return inRange && matchesAccount;
    });


      successCallback(visibleEvents);
    },

    // ✅ ✅ ✅ PUT IT RIGHT HERE (IMPORTANT)
    eventsSet: () => {
      // ✅ ONLY initialize once — NEVER override user selection
      if (!selectedDate) {
        selectedDate = toDayString(calendar.getDate());
      }

      updateWeekView();
      updateDayDetails();
      highlightSelectedDay(selectedDate);
      
    },
    
    datesSet: () => {

      selectedDate = toDayString(calendar.getDate());

      updateWeekView();
      updateDayDetails();
      highlightSelectedDay(selectedDate);

      /**************************************************************
       * ✅ NEW: UPDATE RANGE TOOLTIPS ON NAVIGATION
       **************************************************************/
      applyRangeTooltips();

      /**************************************************************
       * ✅ NEW: UPDATE RANGE DISPLAY (STAYS IN SYNC)
       **************************************************************/
      const { label } = getActiveRangeLabel(currentRangeDays);

      const rangeEl = document.getElementById("rangeDisplay");

      if (rangeEl) {
        rangeEl.textContent = `Showing: ${label}`;
      }
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

    
    /**************************************************
     * CLICK EVENT
     **************************************************/
    // ✅ CLICK DAY → CREATE + UPDATE SIDEBAR
    dateClick: (info) => {

      console.log("🧠 DATE CLICK:", info.date);

      // ✅ THIS is the actual clicked cell
      selectedDate = toDayString(info.date);

      updateDayDetails();
      updateWeekView();
      highlightSelectedDay(selectedDate);
    },

    /**************************************************
     * ✅ DOUBLE CLICK HANDLER (SAFE)
     **************************************************/
    dayCellDidMount: function (info) {

      let clickTimer = null;

      /**************************************************************
       * ✅ RANGE VISUALIZATION (NEW)
       **************************************************************/
      const cellDate = new Date(info.date);

      if (!isDateInActiveRange(cellDate)) {
        info.el.style.opacity = "0.35";   // ✅ dim out-of-range
        info.el.style.filter = "grayscale(0.2)";
      } else {
        info.el.style.backgroundColor = "rgba(59,130,246,0.08)"; // ✅ subtle blue highlight
      }

      /**************************************************************
       * ✅ EXISTING DOUBLE CLICK LOGIC
       **************************************************************/
      info.el.addEventListener("click", () => {
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          openCreateModal(info.date);
        } else {
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
        const res = await apiFetch(`/calendar/event/${info.event.id}`, {
          method: "PUT",
          body: JSON.stringify({
            start_time: info.event.start.toISOString(),
            end_time: info.event.end?.toISOString()
          })
        });

        if (!res) return;

      } catch (err) {
        console.error("❌ Drag update failed:", err);
      }
    },

    /**************************************************
     * NOTES UI
     **************************************************/
    eventContent: function(arg) {

      const ev = arg.event;
      const source = ev.extendedProps?.source;

      const container = document.createElement("div");

      const color = getColorByKey(
        ev.extendedProps.account_key,
        normalizeProvider(source)
      );

      container.style.backgroundColor = color;

      /**************************************************************
       * ✅ APPLY CONTRAST TEXT (CRITICAL FIX)
       **************************************************************/
      container.style.color = getBestTextColor(color);

      container.style.display = "flex";
      container.style.alignItems = "center";
      container.style.gap = "4px";

      container.style.padding = "2px 4px";
      container.style.borderRadius = "4px";
      container.style.height = "100%";

      // ✅ ICON
      const icon = createSourceIcon(source);
      container.appendChild(icon);

      // ✅ TITLE
      const title = document.createElement("span");
      title.textContent = ev.title;
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
  local: "#7ca3af",   // ✅ ADD THIS Local color (bluegray)
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

  if (!sessionCacheRange.start || !sessionCacheRange.end) {
    alert("Range not loaded yet");
    return;
  }

  const start = sessionCacheRange.start;
  const end = sessionCacheRange.end;

  const format = (d) =>
    d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric"
    });

  const message = `
📦 Event Cache Range

From: ${format(start)}
To:   ${format(end)}

✅ This is the full dataset loaded for this session
(used for client-side filtering)
  `;

  alert(message);
}

/* =====================================================
✅ UNIFIED FILTER ENGINE (GOLD STANDARD)
Single source of truth for ALL client-side filtering
===================================================== */
function applyClientSideFilters() {
  if (!calendar) return;

  console.log("ACTIVE FILTERS:", [...activeAccountFilters]);

  /**************************************************************
   * ✅ JUST REFETCH EVENTS (THEY ARE NOW FILTERED AT SOURCE)
   **************************************************************/
  calendar.refetchEvents();

  updateDayDetails();
  updateWeekView();
}


/* =====================================================
✅ ACCOUNT LIST + COLOR MAP BUILDER (WITH HIDE SUPPORT)
===================================================== */
function renderAccounts(accounts) {
  
  /*
  if (syncingAccounts.size > 0) {
    setSyncBanner("syncing");
  }
  */

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

  // ✅ inject local account if any events exist
  // ✅ ALWAYS INCLUDE LOCAL ACCOUNT (FIX)
  normalizedAccounts.push({
    provider: "local",
    email: "local"
  });

  
  // ✅ ✅ MOVE THIS HERE (AFTER normalizedAccounts exists)
    allAccountKeys = new Set(
      normalizedAccounts
        .map(({ provider, email }) => email ? `${provider}:${email}` : null)
        .filter(Boolean)
    );


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

    const key = normalizeKey(provider, email);

    const color = getFinalAccountColor(key, provider, index);

    accountColorMap[key] = color;

    const row = document.createElement("div");
    row.classList.add("chip");
    row.dataset.key = key;
    row.title = `${email} • Click to filter \n Ctrl+Click for multi-select`;

    const container = document.createElement("div");
    container.style.display = "flex";
    container.style.alignItems = "center";
    container.style.gap = "4px";

    const icon = createSourceIcon(provider);
    container.appendChild(icon);

    if ((providerAccountCounts[provider] || 0) > 1) {

      const prefix = email.split("@")[0].slice(0, 2).toUpperCase() || "X";

      const badge = document.createElement("span");
      badge.classList.add("account-badge");
      badge.textContent = prefix;

      // ✅ SINGLE SOURCE (NO DRIFT)
      const baseColor = getColorByKey(key, provider);
      badge.style.background = baseColor;
      
      /**************************************************************
       * ✅ CONTRAST-SAFE BADGE TEXT
       **************************************************************/
      badge.style.color = getBestTextColor(baseColor);

      //badge.style.color = "#fff";
      badge.style.border = "none";
      badge.style.fontSize = "10px";
      badge.style.fontWeight = "bold";
      badge.style.padding = "1px 4px";
      badge.style.borderRadius = "4px";
      badge.style.flexShrink = "0";

      container.appendChild(badge);
    }

    //✅ INSERT DEBUG LOG RIGHT HERE:
    console.log("🔍 CHIP STATE:", key, syncingAccounts.has(key)); // ✅ ADD THIS

    const title = document.createElement("span");
    title.textContent = `${provider}: ${email.split("@")[0]}`;

    container.appendChild(title);
    row.appendChild(container);


    /**************************************************************
     * ✅ REPLACE NATIVE PICKER WITH GRID PICKER (SURGICAL)
     **************************************************************/
    const pickerWrap = document.createElement("div");

    /**************************************************************
     * ✅ Color Picker INITIAL STATE — ALWAYS HIDDEN
     **************************************************************/
    pickerWrap.style.display = "none";
    pickerWrap.style.position = "fixed";
    pickerWrap.style.background = "#fff";
    pickerWrap.style.padding = "8px";
    pickerWrap.style.border = "1px solid #ccc";
    pickerWrap.style.borderRadius = "8px";
    pickerWrap.style.zIndex = "9999";
    pickerWrap.style.boxShadow = "0 8px 20px rgba(0,0,0,0.2)";

    /**************************************************************
     * ✅ IRO COLOR PICKER (ADVANCED)
     **************************************************************/
    let iroPicker = null;

    //🔥 ADD RANDOM PALETTE GENERATOR
    function generateDynamicPalette() {

      const baseTypes = ["red", "green", "blue"];
      const type = baseTypes[Math.floor(Math.random() * baseTypes.length)];

      let colors = [];

      for (let i = 0; i < 24; i++) {

        let r = 0, g = 0, b = 0;
        
        /*   Your Dynamic palette now behaves like your others:
          Row 1 → base tones
          Row 2 → brighter / lighter
          Row 3 → deeper / more saturated ✅
        */
        const row = Math.floor(i / 8); // ✅ 0,1,2 → rows

        if (type === "red") {
          r = 180 + Math.random() * 75;
          g = 60 + Math.random() * 80;
          b = 60 + Math.random() * 80;
        }
        else if (type === "green") {
          r = 60 + Math.random() * 80;
          g = 180 + Math.random() * 75;
          b = 60 + Math.random() * 80;
        }
        else { // blue
          r = 60 + Math.random() * 80;
          g = 60 + Math.random() * 80;
          b = 180 + Math.random() * 75;
        }

        // ✅ ADJUST BY ROW (THIS IS THE MAGIC)
        if (row === 1) {
          // lighter
          r += 30; g += 30; b += 30;
        }
        if (row === 2) {
          // stronger / richer
          r *= 0.85; g *= 0.85; b *= 0.85;
        }


        const col = "#" + [r, g, b]
          .map(x => Math.floor(x).toString(16).padStart(2, "0"))
          .join("");

        colors.push(col);
      }

      return colors;
    }

    
    function initIroPicker() {

      pickerWrap.innerHTML = "";
      /**************************************************************
       * ✅ CURRENT COLOR PREVIEW (TOP BAR)
       **************************************************************/
      const preview = document.createElement("div");
      preview.style.height = "20px";
      preview.style.marginBottom = "6px";
      preview.style.borderRadius = "4px";
      const previewColor = getColorByKey(key, provider);

      preview.style.background = previewColor;

      /**************************************************************
       * ✅ CONTRAST TEXT (PREVIEW PANEL)
       **************************************************************/
      preview.style.color = getBestTextColor(previewColor);

      /**************************************************************
       * ✅ CENTER TEXT (PRO UX TOUCH)
       **************************************************************/
      preview.style.display = "flex";
      preview.style.alignItems = "center";
      preview.style.justifyContent = "center";
      preview.style.fontSize = "11px";
      preview.textContent = "Preview";


      // ✅ ADD TO UI FIRST (TOP)
      pickerWrap.appendChild(preview);


      /**************************************************************
       * ✅ TAB BAR
       **************************************************************/
      const tabBar = document.createElement("div");
      tabBar.style.display = "flex";
      tabBar.style.gap = "8px";
      tabBar.style.marginBottom = "6px";

      const standardTab = document.createElement("button");
      standardTab.textContent = "Standard";

      const customTab = document.createElement("button");
      customTab.textContent = "Custom";

      [standardTab, customTab].forEach(btn => {
        btn.style.padding = "4px 6px";
        btn.style.cursor = "pointer";
        btn.style.border = "1px solid #ccc";
        btn.style.borderRadius = "4px";
        btn.style.background = "#f5f5f5";
      });

      tabBar.appendChild(standardTab);
      tabBar.appendChild(customTab);

      /**************************************************************
       * ✅ CONTENT AREAS
       **************************************************************/
      const standardView = document.createElement("div");

      /**************************************************************
       * ✅ PALETTE SELECTOR
       **************************************************************/
      const paletteBar = document.createElement("div");
      paletteBar.style.display = "flex";
      paletteBar.style.gap = "6px";
      paletteBar.style.marginBottom = "6px";

      const softBtn = document.createElement("button");
      softBtn.textContent = "Soft";

      const greyBtn = document.createElement("button");
      greyBtn.textContent = "Greys";

      const neutralBtn = document.createElement("button");
      neutralBtn.textContent = "Neutral";

      const dynamicBtn = document.createElement("button");
      dynamicBtn.textContent = "Dynamic";

      [softBtn, neutralBtn, dynamicBtn, greyBtn].forEach(btn => {
        btn.style.cursor = "pointer";
        btn.style.border = "1px solid #ccc";
        btn.style.borderRadius = "4px";
        btn.style.padding = "3px 6px";
      });

      paletteBar.appendChild(softBtn);
      paletteBar.appendChild(greyBtn);
      paletteBar.appendChild(neutralBtn);
      paletteBar.appendChild(dynamicBtn);

      /**************************************************************
       * ✅ PALETTE BUTTON HOOKS
       **************************************************************/
      softBtn.onclick = () => renderPalette(palettes.soft);
      greyBtn.onclick = () => renderPalette(palettes.greyscale);
      neutralBtn.onclick = () => renderPalette(palettes.neutral);

      dynamicBtn.onclick = () => {
        palettes.dynamic = generateDynamicPalette();  // ✅ refresh
        renderPalette(palettes.dynamic);
      };

      pickerWrap.appendChild(paletteBar);

      const customView = document.createElement("div");

      customView.style.display = "none";

      /**************************************************************
       * ✅ PALETTES (3 MODES)
       **************************************************************/

      const palettes = {

        
          /**************************************************************
           * ✅ GREYSCALE PALETTE (24 PERFECTLY SPACED SHADES)
          **************************************************************/
          greyscale: [
            // ✅ ROW 1 — Dark (strong anchors)
            "#111111", "#1a1a1a", "#222222", "#2b2b2b",
            "#333333", "#3d3d3d", "#474747", "#525252",

            // ✅ ROW 2 — Mid (balanced UI grays)
            "#5c5c5c", "#666666", "#707070", "#7a7a7a",
            "#858585", "#8f8f8f", "#999999", "#a3a3a3",

            // ✅ ROW 3 — Light (soft UI tones)
            "#adadad", "#b8b8b8", "#c2c2c2", "#cccccc",
            "#d6d6d6", "#e0e0e0", "#ebebeb", "#f5f5f5"
          ],
          soft: [
            // ✅ ROW 1 — base soft
            "#d66a6a", "#e09a5f", "#e5d26f",
            "#76c893", "#6fa8dc", "#8e7cc3",
            "#c27ba0", "#6ccccc",

            // ✅ ROW 2 — lighter / pastel
            "#e8a1a1", "#edb784", "#f0e19c",
            "#9edbb0", "#9ec5f5", "#b4a7d6",
            "#d9a8bf", "#9adede",

            // ✅ ROW 3 — RICH / BRIGHT (THIS IS WHAT YOU WANT)
            "#dc2626", // 🔴 strong red (matches your outlined red)
            "#f97316", // bold orange
            "#facc15", // vivid yellow
            "#22c55e", // rich green
            "#2563eb", // 🔵 ROYAL BLUE (your target)
            "#7c3aed", // vibrant purple
            "#db2777", // vivid pink
            "#0ea5e9"  // bright cyan-blue
          ],
          neutral: [
            // ✅ ROW 1 — deep earth (foundation)
            "#3b2f2f", // dark brown
            "#4a3f35", // coffee
            "#5c4a3d", // clay
            "#6a5c4f", // stone
            "#7c6a58", // driftwood
            "#8b7765", // sand brown
            "#9c8a73", // warm taupe
            "#a99a85", // dry grass

            // ✅ ROW 2 — mid earth (balanced tones)
            "#5a4632", // rich soil
            "#6b5138", // bark
            "#7a5c3d", // leather
            "#8a6a45", // camel
            "#9b7b54", // warm tan
            "#ac8d64", // desert sand
            "#bfa176", // wheat
            "#d2b78a", // light ochre

            
            // ✅ ROW 3 — lighter / warm neutrals (UI friendly)
            "#7a6a58", 
            "#8c7b66", 
            "#9e8d74", 
            "#b0a083", 
            "#c3b59b", 
            "#d6cbb4", 
            "#e3d8c6", 
            "#f0e6d6"
          ],
          dynamic: generateDynamicPalette()
      };

      //RENDER FUNCTION (CRITICAL)
      function renderPalette(colors) {

        standardView.innerHTML = "";

        colors.forEach(col => {

          const sw = document.createElement("div");

          sw.style.width = "18px";
          sw.style.height = "18px";
          sw.style.background = col;
          sw.style.cursor = "pointer";
          sw.style.border = "1px solid rgba(0,0,0,0.25)";

          sw.onclick = () => {

            const safeColor = normalizeColorHarmony(col);
            accountColorOverrides[key] = safeColor;

            accountColorMap[key] = col;
            saveColorOverrides(accountColorOverrides);

            preview.style.background = col;
            preview.style.color = getBestTextColor(col);

            applyChipStyle(row, key, true);

            const badge = row.querySelector(".account-badge");
            if (badge) badge.style.background = col;

            calendar.refetchEvents();
            updateWeekView();
          };

          standardView.appendChild(sw);

        });
      }

      standardView.style.display = "grid";
      standardView.style.gridTemplateColumns = "repeat(8, 18px)";
      standardView.style.gap = "4px";

      /**************************************************************
       * ✅ CUSTOM (IRO PICKER)
       **************************************************************/
      let iroPicker = null;

      function initCustomPicker() {
        if (iroPicker) return;

        iroPicker = new iro.ColorPicker(customView, {
          width: 150,
          color: getColorByKey(key, provider),
          layout: [
            { component: iro.ui.Wheel },
            { component: iro.ui.Slider },
          ]
        });

        iroPicker.on("color:change", (c) => {
          
          const raw = c.hexString;
          const col = lightenColor(raw, 0.4);   // ✅ soften it
          const soft = lightenColor(col, 0.4);  // ✅ softness level

          accountColorOverrides[key] = soft;
          accountColorMap[key] = soft;

          preview.style.background = soft;
          accountColorMap[key] = col;
          saveColorOverrides(accountColorOverrides);

          applyChipStyle(row, key, true);

          const badge = row.querySelector(".account-badge");
          if (badge) badge.style.background = col;

          calendar.refetchEvents();
          updateWeekView();
        });
      }

      /**************************************************************
       * ✅ TAB SWITCHING
       **************************************************************/
      standardTab.onclick = () => {
        standardView.style.display = "grid";
        customView.style.display = "none";

        // ✅ ACTIVE TAB STYLE
        standardTab.style.background = "#fff";
        customTab.style.background = "#ddd";
      };
      customTab.onclick = () => {
        standardView.style.display = "none";
        customView.style.display = "block";

        // ✅ ACTIVE TAB STYLE
        customTab.style.background = "#fff";
        standardTab.style.background = "#ddd";

        initCustomPicker();
      };

      /**************************************************************
       * ✅ BUILD DOM
       **************************************************************/
      pickerWrap.appendChild(tabBar);
      pickerWrap.appendChild(standardView);
      pickerWrap.appendChild(customView);

      
      /**************************************************************
       * ✅ DEFAULT PALETTE (INITIAL VIEW)
       **************************************************************/
      renderPalette(palettes.soft);

    }

    /**************************************************************
     * ✅ ADD TO ROW (EXACT SAME POSITION AS OLD PICKER)
     * ✅ SMALL COLOR DOT (PRIMARY UI)
     **************************************************************/
    const colorDot = document.createElement("div");
    colorDot.classList.add("color-dot");

    
    /**************************************************************
     * ✅ GOLD STANDARD: STATUS + ANIMATION ENGINE
     * ------------------------------------------------------------
     * RULES:     * 1. NEVER apply animation before reset
     * 2. syncingAccounts overrides backend state
     * 3. ONLY ONE place defines animation
     **************************************************************/
    let status;

    /**************************************************************
     * ✅ HARD OVERRIDE: syncing ALWAYS wins
     **************************************************************/
    if (syncingAccounts.has(key)) {
      status = "syncing";
    }
    else {
      status = accountStatusMap[key] || "ok";
    }

    /****************************************************************
     * ✅ APPLY VISUAL STATE TO DOT (CRITICAL FIX)
     ****************************************************************/

    // ALWAYS reset first
    colorDot.classList.remove("syncing-dot");

    /**************************************************************
     * ✅ RESET FIRST (CRITICAL — PREVENTS STALE UI)
     **************************************************************/
    colorDot.style.boxShadow = "0 0 0 2px transparent";

    /**************************************************************
     * ✅ STATE: ERROR
     **************************************************************/
    if (status === "error") {
      colorDot.style.boxShadow = "0 0 0 4px #ef4444";
      colorDot.title = "⚠ Reconnect required";
    }

    /**************************************************************
     * ✅ STATE: SYNCING (ONLY PLACE WITH ANIMATION)
     **************************************************************/
    else if (status === "syncing") {
      colorDot.style.boxShadow = "0 0 0 2px #f59e0b";
      colorDot.title = "⏳ Syncing...";
      colorDot.style.opacity = "1";
    }

    colorDot.addEventListener("click", (e) => {
      e.stopPropagation();

      /**************************************************************
       * ✅ ERROR STATE → REDIRECT
       **************************************************************/
      if (status === "error") {

        const [provider, email] = key.split(":");
        const token = getTokenSafe();

        if (provider === "google") {
          window.location.href =
            `/auth/google/login?token=${encodeURIComponent(token)}&reconnect=${encodeURIComponent(email)}`;
        } else if (provider === "microsoft") {
          window.location.href =
            `/ms/login?token=${encodeURIComponent(token)}&reconnect=${encodeURIComponent(email)}`;
        }

        return;
      }

      /**************************************************************
       * ✅ SYNCING STATE → DO NOTHING
       **************************************************************/
      if (status === "syncing") {
        return;
      }

      /**************************************************************
       * ✅ TOGGLE PICKER (FIXED + IRO INIT)
       **************************************************************/
      const isOpen = pickerWrap.style.display !== "none";

      document.querySelectorAll(".color-picker-pop").forEach(el => {
        el.style.display = "none";
      });

      if (isOpen) {
        pickerWrap.style.display = "none";
        iroPicker = null; // ✅ reset instance
          return;

      }

      /**************************************************************
       * ✅ SHOW PICKER
       **************************************************************/
      pickerWrap.style.display = "block";

      /**************************************************************
       * ✅ ⚡ INITIALIZE IRO HERE (THIS IS STEP 4)
       **************************************************************/
      initIroPicker();


      const rect = colorDot.getBoundingClientRect();

      let top = rect.bottom + 6;
      let left = rect.left;

      if (left + 160 > window.innerWidth) {
        left = window.innerWidth - 160 - 8;
      }

      if (top + 120 > window.innerHeight) {
        top = rect.top - 120;
      }

      pickerWrap.style.top = `${top}px`;
      pickerWrap.style.left = `${left}px`;

      pickerWrap.classList.add("color-picker-pop");

      pickerWrap.style.opacity = "1";
      pickerWrap.style.visibility = "visible";

      console.log("✅ DOT CLICK → PICKER OPENED:", key);
    });

    /**************************************************************
     * ✅ ALWAYS APPLY BASE DOT VISUAL (CRITICAL)
     **************************************************************/
    colorDot.style.position = "relative";
    colorDot.style.zIndex = "10";
    colorDot.style.width = "10px";
    colorDot.style.height = "10px";
    colorDot.style.borderRadius = "50%";
    colorDot.style.background = color;
    colorDot.style.marginLeft = "6px";
    colorDot.style.cursor = "pointer";
    
    //colorDot.style.border = "1px solid rgba(0,0,0,0.4)";
    /*********************************************************************
     * ✅ SMART BORDER CONTRAST (PRO UX DETAIL) AUTO-ADAPT PICKER BORDER
     *********************************************************************/
    const borderColor =
      getBestTextColor(color) === "#fff"
        ? "rgba(255,255,255,0.7)"
        : "rgba(0,0,0,0.4)";

    colorDot.style.border = `1px solid ${borderColor}`;

    
    colorDot.style.outline = `1px solid ${getBestTextColor(color)}`;

    /**************************************************************
     * ✅ HIDDEN PALETTE (POPUP STYLE)
     **************************************************************/
    /**************************************************************
     * ✅ FIX: FORCE PROPER POSITIONING (CRITICAL)
     **************************************************************/
    pickerWrap.style.position = "fixed";
    /**************************************************************
     * ✅ GOLD STANDARD: UI SURFACE (NEUTRAL PANEL)
     * ------------------------------------------------------------
     * DO NOT USE dynamic contrast here
     * This is a stable UI layer (like modals / menus)
     *
     * WHY:
     * - prevents visual instability
     * - ensures consistent UX
     * - mirrors pro apps (Notion, Google, Apple)
     **************************************************************/
    /**************************************************************
     * ✅ SMART NEUTRAL SURFACE (SUBTLE BRAND TINT)
     * ------------------------------------------------------------
     * Uses a VERY light tint of the account color
     * Keeps UI consistent but adds personality
     **************************************************************/
    const baseColor = getColorByKey(key, provider);

    // ✅ super-light tint (barely visible)
    const panelBg = lightenColor(baseColor, 0.92);

    pickerWrap.style.background = panelBg;

    /**************************************************************
     * ✅ GUARANTEED READABILITY
     **************************************************************/
    pickerWrap.style.color = getBestTextColor(panelBg);

    /**************************************************************
     * ✅ OPTIONAL: subtle elevation polish
     **************************************************************/
    pickerWrap.style.color = "#111";  // ✅ fixed readable text baseline
    pickerWrap.style.padding = "8px";
    pickerWrap.style.border = "1px solid #ccc";
    pickerWrap.style.borderRadius = "8px";
    pickerWrap.style.zIndex = "9999";
    pickerWrap.style.boxShadow = "0 8px 20px rgba(0,0,0,0.2)";

    colorDot.onmouseenter = () => {
      colorDot.style.transform = "scale(1.2)";
    };

    colorDot.onmouseleave = () => {
      colorDot.style.transform = "scale(1)";
    };

    /**************************************************************
     * ✅ APPEND BOTH
     **************************************************************/
    row.appendChild(colorDot);
    document.body.appendChild(pickerWrap);

    /**************************************************************
     * ✅ CHIP STATE ENGINE (SYNC / SUCCESS / ERROR)
     **************************************************************/
    row.classList.remove("syncing");

    // ✅ remove ALL transient icons first (prevents stacking)
    const existingSpinner = container.querySelector(".chip-spinner");
    if (existingSpinner) existingSpinner.remove();

    const existingSuccess = container.querySelector(".chip-success");
    if (existingSuccess) existingSuccess.remove();

    const existingError = container.querySelector(".chip-error");
    if (existingError) existingError.remove();

    /**************************************************************
     * ✅ STATE 1 — SYNCING
     **************************************************************/
    if (syncingAccounts.has(key)) {

      row.classList.add("syncing");

      const spinner = document.createElement("div");
      spinner.className = "chip-spinner";

      spinner.style.borderTopColor = color;
      spinner.style.marginRight = "4px";

      container.insertBefore(spinner, container.firstChild);
    }

    /**************************************************************
     * ✅ STATE 2 — ERROR (takes priority after sync)
     **************************************************************/
    else if (accountStatusMap[key] === "error") {

      const errorIcon = document.createElement("div");
      errorIcon.className = "chip-error";
      errorIcon.textContent = "⚠️";
      errorIcon.style.marginRight = "4px";

      errorIcon.title = "Sync failed — click to retry";

      errorIcon.onclick = (e) => {
        e.stopPropagation();

        syncingAccounts.add(key);  // ✅ immediate visual feedback
        renderAccountsSafe();      // ✅ show spinner instantly

        syncSingleAccount(key);
      };


      container.insertBefore(errorIcon, container.firstChild);
    }

    /**************************************************************
     * ✅ STATE 3 — SUCCESS (only if not syncing or error)
     **************************************************************/
    else if (recentlySynced.has(key)) {
      const check = document.createElement("div");
      check.className = "chip-success";
      check.textContent = "✅";
      check.style.marginRight = "4px";

      container.insertBefore(check, container.firstChild);

      // ✅ auto remove (keeps UI clean)
      setTimeout(() => {
        check.remove();
      }, 1200);
    }
    
    row.onclick = (e) => {

      // ✅ DO NOT trigger when using color picker
      if (e.target.closest(".color-picker-pop") ||
          e.target.closest(".color-dot")) {
        return;
      }

      const isMultiSelect = e.ctrlKey || e.metaKey;

      if (!isMultiSelect) {
        activeAccountFilters.clear();
        activeAccountFilters.add(key);
      } else {
        if (activeAccountFilters.has(key)) {
          if (activeAccountFilters.size > 1) {
            activeAccountFilters.delete(key);
          }
        } else {
          activeAccountFilters.add(key);
        }
      }

      updateChipSelectionUI();
      applyClientSideFilters();
    };

    el.appendChild(row);

  });  // ✅ ✅ ✅ LOOP ENDS HERE

  /* ✅ RUN ONCE AFTER LOOP */

  /**************************************************************
   * ✅ PRESERVE FILTER STATE (DO NOT WIPE)
   **************************************************************/
  if (!activeAccountFilters.size) {
    activeAccountFilters = new Set(allAccountKeys);
  }
  
  updateChipSelectionUI();

}  // ✅ renderAccounts closes cleanly

//updateChipSelectionUI → overrides style based on activeAccountFilters
function updateChipSelectionUI() {
  const accountContainer = document.getElementById("accounts");

  accountContainer?.querySelectorAll(".chip").forEach(row => {
    const key = row.dataset.key;
    if (!key) return;

    const isActive = activeAccountFilters.has(key);

    // ✅ ONLY DO THIS
    applyChipStyle(row, key, isActive);
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
  
  const dayStart = normalizeToLocalDay(fromDayString(selectedDate));

  const dayEnd = new Date(dayStart);
  dayEnd.setHours(23, 59, 59, 999);

  let events = sessionEventCache.filter(ev => {

    if (!ev.start) return false;

    const key = (ev.extendedProps?.account_key || "").replace(/\s+/g, "");
    if (key !== "local:local" && !activeAccountFilters.has(key)) {
      return false;
    }

    const evStart = new Date(ev.start);
    const evEnd = ev.end ? new Date(ev.end) : new Date(ev.start);

    evStart.setHours(0,0,0,0);

    const evEndDay = new Date(evEnd);
    evEndDay.setHours(23,59,59,999);

    // ✅ SAME OVERLAP MODEL AS WEEK
    return (
      evStart <= dayEnd &&
      evEndDay >= dayStart
    );
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
    const provider = normalizeProvider(ev.extendedProps.source);

    // ✅ SINGLE SOURCE (FIXES SIDEBAR COLORS)
    const color = getColorByKey(key, provider);

    // ✅ OPTIONAL light tint (very nice touch)
    /**************************************************************
     * ✅ SIDEBAR COLOR SYSTEM (GOLD STANDARD)
     **************************************************************/

    // ✅ LEFT COLOR BAND (primary identity)
    row.style.borderLeft = `4px solid ${color}`;

    row.style.background = `${color}1a`;

    /**************************************************************
     * ✅ FIX: FORCE READABLE TEXT (LIGHT BACKGROUND SAFE)
     * ------------------------------------------------------------
     * Background is always LIGHT (alpha tint)
     * Use stable dark text (matches account chips + pro apps)
     **************************************************************/
    row.style.color = "#000";
    /**************************************************************
     * ✅ CONTRAST TEXT AGAINST SOFT BG
     **************************************************************/
    //row.style.color = getBestTextColor(color);
    
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

    // ✅ determine span
    const evStart = new Date(ev.start);
    const evEnd = ev.end ? new Date(ev.end) : new Date(ev.start);

    const isSpan =
      ev.end &&
      evStart.toDateString() !== evEnd.toDateString();

    const selected = new Date(selectedDate + "T00:00:00");

    const isFirstDay =
      selected.toDateString() === evStart.toDateString();

    // ✅ title logic
    titleSpan.textContent = isSpan
      ? (isFirstDay ? ev.title : "↳ continues")
      : ev.title;

    // ✅ badge ONLY on first day
    if (isSpan && isFirstDay) {
      const badge = document.createElement("span");
      badge.textContent = " (multi-day)";
      badge.style.fontSize = "10px";
      badge.style.color = "#777";
      badge.style.marginLeft = "2px";

      titleSpan.appendChild(badge);
    }


    // ✅ BUILD
    row.appendChild(icon);
    row.appendChild(timeEl);
    row.appendChild(titleSpan);
    row.onmouseenter = () => {
      row.style.filter = "brightness(0.96)";
    };

     /**************************************************************
     * ✅ HOVER = SMART INVERT makes item “pop” automatically
     **************************************************************/
    row.onmouseenter = () => {
      row.style.filter = "brightness(0.92)";
      row.style.transform = "scale(1.01)";
    };

    row.onmouseleave = () => {
      row.style.filter = "none";
      row.style.transform = "scale(1)";
    };
    li.appendChild(row);

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

  // ✅ base date
  const base = fromDayString(selectedDate);

  // ✅ compute week range
  const weekStart = normalizeToLocalDay(new Date(base));
  weekStart.setDate(weekStart.getDate() - weekStart.getDay());

  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 7);

  // ✅ FullCalendar end is exclusive → adjust
  weekEnd.setDate(weekEnd.getDate() - 1);

  weekStart.setHours(0, 0, 0, 0);
  weekEnd.setHours(23, 59, 59, 999);

  // ✅ STEP 1: FILTER (range overlap)
  let weekEvents = sessionEventCache.filter(ev => {

    if (!ev.start) return false;

    const key = (ev.extendedProps?.account_key || "").replace(/\s+/g, "");
    if (key !== "local:local" && !activeAccountFilters.has(key)) {
      return false;
    }

    const evStart = new Date(ev.start);
    const evEnd = ev.end ? new Date(ev.end) : new Date(ev.start);

    evStart.setHours(0, 0, 0, 0);

    const evEndDay = new Date(evEnd);
    evEndDay.setHours(23, 59, 59, 999);

    return (
      evStart <= weekEnd &&
      evEndDay >= weekStart
    );
  });

  container.innerHTML = "";

  if (weekEvents.length === 0) {
    container.innerHTML = `<div style="color:#888;">No events this week</div>`;
    return;
  }

  // ✅ STEP 2: EXPAND EVENTS INTO DAILY INSTANCES
  let expanded = [];

  weekEvents.forEach(ev => {

    const evStart = new Date(ev.start);
    const evEnd = ev.end ? new Date(ev.end) : new Date(ev.start);

    evStart.setHours(0, 0, 0, 0);

    const endDay = new Date(evEnd);
    endDay.setHours(0, 0, 0, 0);

    for (let d = new Date(evStart); d <= endDay; d.setDate(d.getDate() + 1)) {

      if (d < weekStart || d > weekEnd) continue;

      expanded.push({
        ev,
        date: new Date(d),
        isSpan: !!ev.end && ev.end !== ev.start,   // ✅ multi-day indicator
        spanStart: toDayString(evStart),
        spanEnd: toDayString(evEnd),
        isFirstDay: toDayString(d) === toDayString(evStart),
        isLastDay: toDayString(d) === toDayString(evEnd)
      });
    }
  });

  // ✅ STEP 3: SORT BY DISPLAY DATE
  expanded.sort((a, b) => a.date - b.date);

  // ✅ STEP 4: RENDER
  let currentDay = "";
  // ✅ TRACK RENDERED EVENTS PER DAY
  let renderedMap = new Map();  

  expanded.forEach(({ ev, date, isSpan, isFirstDay, isLastDay }) => {

    const dayLabel = date.toDateString();
    // ✅ UNIQUE KEY PER DAY
    const dayKey = toDayString(date);

    // ✅ INIT SET IF NEEDED
    if (!renderedMap.has(dayKey)) {
      renderedMap.set(dayKey, new Set());
    }

    // ✅ EVENT UNIQUE ID (fallback safe)
    const eventId = ev.id || ev.title;

    // ✅ SKIP DUPLICATE
    if (renderedMap.get(dayKey).has(eventId)) {
      return;
    }

    // ✅ MARK AS RENDERED
    renderedMap.get(dayKey).add(eventId);

    if (dayLabel !== currentDay) {
      currentDay = dayLabel;

      const dayDiv = document.createElement("div");
      dayDiv.setAttribute("data-day", toDayString(date));

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
      ? new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : "";

    const row = document.createElement("div");

    const inner = document.createElement("div");

    const key = ev.extendedProps?.account_key;
    const provider = normalizeProvider(ev.extendedProps.source);
    const color = getColorByKey(key, provider);

    if (isSpan) {

      inner.style.borderLeft = isFirstDay
        ? `4px solid ${color}`
        : `2px solid ${color}`;

      inner.style.borderRight = isLastDay
        ? `4px solid ${color}`
        : "none";

      inner.style.borderRadius = isFirstDay
        ? "6px 0 0 6px"
        : isLastDay
          ? "0 6px 6px 0"
          : "0";

      inner.style.opacity = isFirstDay || isLastDay ? "1" : "0.85";
    } else {
      inner.style.borderLeft = `4px solid ${color}`;
      inner.style.borderRadius = "6px";
    }
    inner.style.background = `${color}1a`;

    /**************************************************************
     * ✅ FIX: FORCE READABLE TEXT (CONSISTENT WITH DAY VIEW)
     **************************************************************/
    inner.style.color = "#000";
    //inner.style.color = getBestTextColor(color);

    inner.style.display = "flex";
    inner.style.alignItems = "center";
    inner.style.gap = "6px";
    inner.style.marginLeft = "10px";
    inner.style.marginBottom = "4px";
    inner.style.fontSize = "13px";
    inner.style.cursor = "pointer";
    inner.style.padding = "2px 4px";
    inner.style.borderRadius = "4px";

    const icon = createSourceIcon(ev.extendedProps.source);

    const timeEl = document.createElement("span");
    timeEl.textContent = time;
    timeEl.style.color = "#555";

    const titleEl = document.createElement("span");

    titleEl.textContent = isSpan
      ? (isFirstDay ? ev.title : "↳ continues")
      : ev.title;

    // ✅ badge ONLY on first day
    if (isSpan && isFirstDay) {
      const badge = document.createElement("span");
      badge.textContent = " (multi-day)";
      badge.style.fontSize = "10px";
      badge.style.color = "#777";
      badge.style.marginLeft = "2px";

      titleEl.appendChild(badge);
    }

    inner.appendChild(icon);
    inner.appendChild(timeEl);
    inner.appendChild(titleEl);

    row.appendChild(inner);

    row.onclick = () => openCreateModal(null, ev);
    row.title = ev.title;

    container.appendChild(row);
  });
}

/**************************************************************
 * ✅ OAUTH BUTTONS (TOKEN SAFE)
 **************************************************************/
function connectGoogle() {

  // ✅ ALWAYS GET FRESH TOKEN
  const authToken = getTokenSafe();
  window.location.href =
    `/auth/google/login?token=${encodeURIComponent(authToken)}`;
}

// ==================================================
// ✅ ✅ NEW: APPLE OAUTH (MATCHES PATTERN)
// ==================================================
function connectApple() {
  const authToken = getTokenSafe();
  window.location.href =
    `/auth/apple/login?token=${encodeURIComponent(authToken)}`;
}

function connectOutlook() {

  // ✅ ALWAYS GET FRESH TOKEN
  const authToken = getTokenSafe();
  window.location.href =
    `/ms/login?token=${encodeURIComponent(authToken)}`;
}


/**************************************************************
 * ✅ SYNC
 **************************************************************/
async function syncNow() {
  try {
    
    /**************************************************************
     * ✅ STEP 8.1 — START GLOBAL SYNC (SHOW BANNER)
     **************************************************************/
    //setSyncBanner("syncing");
    
    /**************************************************************
     * ✅ GOLD STANDARD: BUILD KEYS EXACTLY LIKE renderAccounts
     **************************************************************/
    syncingAccounts.clear();

    lastLoadedAccounts.forEach(acc => {

      const provider = normalizeProvider(acc.provider || "other");

      const email = (acc.account_email || acc.email || "")
        .toLowerCase()
        .trim();

      if (!email) return;

      const key = normalizeKey(provider, email);

      syncingAccounts.add(key);
      console.log("✅ ADD SYNC KEY:", key);
    });

    await new Promise(resolve => requestAnimationFrame(resolve));

    /**************************************************************
     * ✅ FORCE UI UPDATE
     **************************************************************/
    renderAccountsSafe();   // ✅ ONLY THIS ONE HERE

    /**************************************************************
     * ✅ FORCE BROWSER TO PAINT BEFORE BLOCKING
     **************************************************************/
    await new Promise(resolve => requestAnimationFrame(resolve));
    const res = await apiFetch("/calendar/sync", { method: "POST" });
    if (!res) return;

    const data = await res.json();

    console.log("✅ Sync result:", data);

    /**************************************************************
     * ✅ SHOW SUCCESS STATE (still syncing visually)
     **************************************************************/
    renderAccountsSafe();
    showToast("✅ Sync complete");
    //setSyncBanner("success");

    /**************************************************************
     * ✅ DELAY CLEAR SO USER SEES FINAL STATE
     **************************************************************/
    setTimeout(() => {

      /**************************************************************
       * ✅ UPDATE STATUS MAP
       **************************************************************/
      if (data.results) {
        data.results.forEach(r => {
          accountStatusMap[r.key] = r.status;
        });
      }

      /**************************************************************
       * ✅ 1. CLEAR SYNC STATE
       **************************************************************/
      syncingAccounts.clear();

      /**************************************************************
       * ✅ 2. FORCE CLEAN RENDER
       **************************************************************/
      renderAccountsSafe();
      console.log("🧪 syncingAccounts contents:", [...syncingAccounts]);

      /**************************************************************
       * ✅ 4. NORMAL REFRESH
       **************************************************************/
      needsCacheRefresh = true;
      smartRefresh({ reason: "event_saved" });

    }, 800);

  } catch (err) {
    showToast("❌ Sync failed", "error");
    syncingAccounts.clear();
    
    /**************************************************************
     * ✅ STEP 8.3 — HIDE BANNER ON FAILURE
     **************************************************************/
    //setSyncBanner("hidden");
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
    let res;

    if (editingEventId) {
      // ✅ UPDATE
      res = await apiFetch(`/calendar/event/${editingEventId}`, {
        method: "PUT",
        body: JSON.stringify({
          title,
          start_time: startISO,
          end_time: endISO
        })
      });
    } else {
      // ✅ CREATE
      res = await apiFetch("/calendar/event", {
        method: "POST",
        body: JSON.stringify({
          title,
          start_time: startISO,
          end_time: endISO
        })
      });
    }

    // ✅ ✅ SINGLE CHECK (THIS IS THE FIX)
    if (!res) return;

    closeCreateModal();
    smartRefresh({ reason: "event_saved" });

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
    const res = await apiFetch(`/calendar/event/${editingEventId}`, {
      method: "DELETE"
    });

    if (!res) return;


    closeCreateModal();
    smartRefresh({ reason: "event_deleted" });

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

  const res = await apiFetch("/events/note", {
    method: "POST",
    body: JSON.stringify({
      event_id: editingEventId,
      note_id: editingNoteId,
      content
    })
  });

  if (!res) return;


  document.getElementById("noteEditorModal")?.classList.add("hidden");

  smartRefresh({ reason: "event_saved" });
}

//ADD ONE GLOBAL CLEAN VERSION (OUTSIDE LOOP, TOP LEVEL ONCE)
document.addEventListener("click", (e) => {

  // ✅ allow picker interactions
  if (
    e.target.closest(".color-picker-pop") ||
    e.target.closest(".color-dot")
  ) {
    return;
  }

  document.querySelectorAll(".color-picker-pop").forEach(el => {
    el.style.display = "none";
  });

});

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

  /**************************************************************
   * ✅ OPEN ACCOUNTS UI (SUBTLE NAV)
   **************************************************************/
  document.getElementById("accountsBtn")
    ?.addEventListener("click", () => {

      window.location.href = "/accounts/ui";
    });

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

      document.querySelectorAll(".range-btn")
        .forEach(b => b.classList.remove("active"));

      btn.classList.add("active");

      /**************************************************************
       * ✅ CUSTOM BUTTON
       **************************************************************/
      if (btn.id === "customRange") {

        openCustomRange();

        const rangeEl = document.getElementById("rangeDisplay");

        if (rangeEl && sessionCacheRange.start && sessionCacheRange.end) {

          const format = d => d.toLocaleDateString();

          rangeEl.textContent =
            `Full Range: ${format(sessionCacheRange.start)} → ${format(sessionCacheRange.end)}`;
        }

        return;
      }

      /**************************************************************
       * ✅ RANGE MAPPING
       **************************************************************/
      if (btn.id === "monthly") currentRangeDays = 30;
      else if (btn.id === "quarterly") currentRangeDays = 90;
      else if (btn.id === "semiAnnual") currentRangeDays = 180;
      else if (btn.id === "yearly") currentRangeDays = 365;

      /**************************************************************
       * ✅ UPDATE DISPLAY
       **************************************************************/
      const { label } = getActiveRangeLabel(currentRangeDays);

      const rangeEl = document.getElementById("rangeDisplay");

      if (rangeEl) {
        rangeEl.textContent = `Showing: ${label}`;
      }

      applyClientSideFilters();
      applyRangeTooltips();

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
