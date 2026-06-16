console.log("🔥 JS FILE LOADED");
console.log("🔐 TOKEN AT LOAD:", localStorage.getItem("token"));


function getCalendar() {
  return window.calendar || null;
}

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
let isAppSyncing = false;
let editingEventId = null;
let editingNoteId = null;
let providerAccountCounts = {};
let allAccountKeys = new Set();   // ✅ MASTER ACCOUNT LIST
window.selectedDate = null;

let lastLoadedAccounts = [];
let recentlySynced = new Set();
/**************************************************************
 ✅ GLOBAL DELETE BLACKLIST (PERSISTS DURING SESSION)
**************************************************************/
window.deletedEventIds = window.deletedEventIds || new Set();
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
window.currentRangeDays = window.currentRangeDays || 30;
// ✅ Default = Monthly
let currentRangeStart = null;
let currentRangeEnd = null; 

// ✅ NEW: account filter
let activeAccountFilters = new Set();

/**************************************************************
 * ✅ SESSION EVENT CACHE (SEC) — GOLD STANDARD
 * - Single fetch per session
 * - All filtering becomes client-side
 * - Eliminates redundant API calls
 **************************************************************/

window.sessionEventCache = window.sessionEventCache || [];
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
    window.calendar.refetchEvents();
    return;
  }

  applyClientSideFilters(); // ✅ ONLY THIS
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

/**************************************************************
✅ GLOBAL CALENDAR ACCESSOR (SINGLE SOURCE OF TRUTH)
**************************************************************/
function getCalendarSafe() {
  if (!window.calendar) {
    console.warn("⚠️ calendar not ready");
    return null;
  }
  return window.calendar;
}

/**************************************************************
✅ ✅ ✅ GOLD STANDARD — TRUE DATE OVERLAP ENGINE
**************************************************************/
function getFilteredEvents({ start, end }) {

  if (!start || !end) {
    console.warn("❌ INVALID RANGE PASSED TO FILTER", start, end);
    return [];
  }

  const rangeStart = new Date(start);
  const rangeEnd   = new Date(end);

  return sessionEventCache.filter(ev => {

    if (!ev || !ev.start) return false;

    const evStart = new Date(ev.start);
    const evEnd   = ev.end ? new Date(ev.end) : evStart;

    // ✅ STRICT OVERLAP ONLY
    if (evEnd < rangeStart) return false;
    if (evStart > rangeEnd) return false;

    // ✅ ACCOUNT FILTER ONLY
    const key = ev.extendedProps?.account_key;
    if (activeAccountFilters.size && !activeAccountFilters.has(key)) {
      return false;
    }

    return true;
  });
}



function normalizeKey(provider, email) {
  return `${normalizeProvider(provider)}:${(email || "").toLowerCase().trim()}`;
}

function buildAccountKey(ev) {
  const source = (ev.source || "").toLowerCase();
  const email = (ev.account_email || "").toLowerCase().trim();

  if (source === "local") return "local:local";

  return `${source}:${email}`;
}

window.buildAccountKey = buildAccountKey;
// ==================================================
// 🧠 DEBUG TOOL — EVENT PIPELINE INSPECTOR
// --------------------------------------------------
// PURPOSE:
// Allows instant verification of cache health
// across ALL providers
// ==================================================
window.debugEvents = () => {

  if (!sessionEventCache || sessionEventCache.length === 0) {
    console.warn("⚠️ CACHE EMPTY OR NOT READY");
    return {};
  }

  const result = sessionEventCache.reduce((acc, e) => {
    const src = e?.extendedProps?.source;

    if (!src) {
      console.warn("⚠️ MISSING SOURCE:", e);
      return acc;
    }

    acc[src] = (acc[src] || 0) + 1;
    return acc;

  }, {});

  console.log("✅ PROVIDER VALIDATION:", result);
  console.log("📦 CACHE SIZE:", sessionEventCache.length);

  return result;
};

window.systemHealth = () => {

  const breakdown = debugEvents();

  const missingEvents = sessionEventCache.filter(
    e => !e.extendedProps?.account_key
  );

  if (missingEvents.length > 0) {
    console.warn("⚠️ BAD EVENTS:", missingEvents);
  }

  console.log("✅ SYSTEM HEALTH OK");

  return {
    providers: breakdown,
    missing: missingEvents.length
  };
};

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
✅ RANGE RESOLVER (SINGLE SOURCE OF TRUTH)
- ALL UI and logic must use this
**************************************************************/
function getRangeDays(type) {

  const map = {
    monthly: 30,
    quarterly: 90,
    semi: 180,
    yearly: 365
  };

  return map[type] || currentRangeDays;
}

/**************************************************************
 ✅ RANGE CALCULATOR (SINGLE SOURCE OF TRUTH)
 ✅ RANGE ENGINE (FIXED — GLOBAL SAFE)
**************************************************************/
function getActiveRangeLabel(days) {

  const cal = getCalendarSafe();
  if (!cal) {
    return { start: null, end: null, label: "" };
  }

  const base = new Date(); // ✅ anchor to TODAY

  const start = new Date(base);
  const end = new Date(base);

  // ✅ split range evenly around today
  const half = Math.floor(days / 2);

  start.setDate(base.getDate() - half);
  end.setDate(base.getDate() + half);

  const format = (d) =>
    d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric"
    });

  const label = `${format(start)} → ${format(end)}`;

  return { start, end, label };
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

  const banner = document.getElementById("syncBanner");
  if (!banner) return;

  if (state === "syncing") {
    banner.style.display = "none";
    return;
  }

  if (state === "success") {
    banner.style.display = "block";  // ✅ small improvement
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

  // ✅ HARD BLOCK: never render during modal interaction
  if (window.isModalOpen) {
    console.log("⏸️ Blocked renderAccounts (modal open)");
    return;
  }

  // ✅ NEW: BLOCK DURING ACTIVE INPUT
  const activeEl = document.activeElement;
  if (activeEl && activeEl.id === "eventTitle") {
    console.log("⏸️ Blocked renderAccounts (typing)");
    return;
  }

  if (!lastLoadedAccounts || !lastLoadedAccounts.length) return;

  renderAccounts(lastLoadedAccounts);
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
  if (!dayStr || typeof dayStr !== "string") {
    console.warn("⚠️ invalid dayStr → fallback to today:", dayStr);
    return new Date();
  }
  const [y, m, d] = dayStr.split("-");
  return new Date(y, m - 1, d);
}


/**************************************************************
 * ✅ ABSOLUTE COLOR SOURCE (DO NOT BYPASS)
 **************************************************************/
function resolveEventColor(event) {
  return getColorByKey(
    event?.extendedProps?.account_key
  );
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

  return parsed;
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
  if (!sessionEventCache.length) {
    console.log("🔄 Refreshing cache (needed)");

    await preloadEventCache();          // ✅ ADD THIS BACK
    
  } else {
    console.log("⚡ Using existing session cache");
  }

  
  // ✅ THIS IS THE ONLY CALENDAR INIT YOU NEED
  initFullCalendar();
  renderRangePill(); // ✅ ensure initial render
  
  applyRangeTooltips();

  // ✅ CRITICAL FIX — ALIGN SELECTED DATE
  if (window.calendar) {
    window.selectedDate = toDayString(window.calendar.getDate());
  }

  bindUIEvents();
  applyRangeTooltips(); // ✅ ensures hover text shows immediately

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
    
  if (connected) {
    console.log("✅ Connected:", connected);
    syncSingleAccount(connected);

    // Clean URL
    window.history.replaceState({}, document.title, "/calendar-ui");
  }
}

function applyChipStyle(row, key, isActive) {

  const [provider] = key.split(":");

  /************************************************************
   ✅ CENTRAL COLOR ENGINE (DO NOT BYPASS)
  ************************************************************/
  const finalColor = getSoftAccountColor(key, provider);

  row.style.backgroundColor = finalColor;
  row.style.color = getBestTextColor(finalColor);

  row.style.transition = "all 0.15s ease";

  row.style.borderRadius = "999px";
  row.style.display = "inline-flex";
  row.style.alignItems = "center";
  row.style.gap = "4px";
  row.style.padding = "4px 8px";

  row.style.boxShadow = "none";
  row.style.transform = "none";

  if (isActive) {
    row.style.border = "2px solid rgba(0,0,0,0.6)";
    row.style.opacity = "1";
  } else {
    row.style.border = "2px solid transparent";
    row.style.opacity = "0.45";
  }
}

async function preloadEventCache() {
  console.log("🧠 PRELOADING CACHE");
  document.body.style.cursor = "wait";
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

    let safeEnd = safeParseDate(ev.end);

    /**************************************************************
     ✅ FIX APPLE TIME SHIFT (CORRECT LAYER)
    **************************************************************/
    if (ev.source === "apple") {

      const fix = (d) => {
        if (!d) return null;

        return new Date(
          d.getFullYear(),
          d.getMonth(),
          d.getDate(),
          d.getHours(),
          d.getMinutes()
        );
      };

      // ✅ IMPORTANT: Fix AFTER parsing
      safeStart.setTime(fix(safeStart).getTime());

      if (safeEnd) {
        safeEnd.setTime(fix(safeEnd).getTime());
      }
    }
    const provider = normalizeProvider(ev.source);

    let account =
      ev.account_email ||
      ev.account ||
      ev.extendedProps?.account_email ||
      "local";

    account = account.toLowerCase().trim();

    const normalizedAccount = (account || "")
      .toLowerCase()
      .trim();

    
    const account_key = buildAccountKey({
      source: provider,
      account_email: account
    });

    
    const color = getColorByKey(account_key, provider);
    const backendId = ev.id || null;           // ✅ ONLY DB ID
    const displayId = ev.external_id || ev.id; // ✅ used for UI
    /**************************************************************
     ✅ CRITICAL FILTER — BLOCK DELETED EVENTS FROM RE-ENTERING
     ✅ CRITICAL FIX — BLOCK BOTH IDS ALWAYS
    **************************************************************/
    if (
      window.deletedEventIds?.has(backendId) ||
      window.deletedEventIds?.has(displayId)
    ) {
      console.warn(
        "🚫 BLOCKED REHYDRATED EVENT:",
        { backendId, displayId, title: ev.title }
      );
      return null;
    }
    
    // ✅ DROP events with NO usable ID
    if (!displayId) {
      console.warn("🚫 Dropping invalid event:", ev);
      return null;
    }

    return {
      id: displayId,   // ✅ FullCalendar uses this

      title: ev.title || "Untitled",
      start: safeStart,
      end: safeEnd || null,

      extendedProps: {
        backendId,      // ✅ THIS IS THE KEY FIX
        source: provider,
        account,
        account_key,
        notes: ev.notes || []
      }
    };

  }).filter(ev => ev && ev.id);

  // ✅ KEEP THIS
  sessionCacheRange = { start, end };

  // ✅ ✅ ✅ ADD DEDUPE RIGHT HERE
  const seen = new Set();

  sessionEventCache = sessionEventCache.filter(ev => {
    if (!ev || !ev.id) return false;

    const key = `${ev.id}-${ev.start.toISOString()}`;

    if (seen.has(key)) {
      console.warn("🚫 DUPLICATE REMOVED:", ev.title, key);
      return false;
    }

    seen.add(key);
    return true;
  });
  isInitialLoadComplete = true;
  
  //setSyncBanner("success");
  console.log("✅ PRELOAD COMPLETE:", sessionEventCache.length);
  // ✅ ✅ ✅ CRITICAL — MAKE EVENTS AVAILABLE TO FULLCALENDAR
  window.ALL_EVENTS = sessionEventCache;
  isAppSyncing = false;
  
  console.log("✅ SYNC MODE OFF");  
  syncingAccounts.clear();
  document.body.style.cursor = "default";
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

    
  dayMaxEventRows: false,
  dayMaxEvents: false,
  eventDisplay: "block",

    // ✅ ONLY ONE EVENTS BLOCK EXISTS
    /**************************************************************
✅ SINGLE SOURCE FILTER ENGINE (FINAL)
**************************************************************/
events: function(fetchInfo, successCallback) {

  const events = getFilteredEvents({
    start: fetchInfo.start,
    end: fetchInfo.end
  });

  successCallback(events);
},

    // ✅ ✅ ✅ PUT IT RIGHT HERE (IMPORTANT)
    eventsSet: () => {

      // ✅ ONLY set default ON FIRST LOAD
      if (!window.selectedDate) {
        window.selectedDate = toDayString(new Date());
      }

      console.log("✅ eventsSet using:", window.selectedDate);

      updateWeekView();
      updateDayDetails();
      highlightSelectedDay(window.selectedDate);
    },
    
    datesSet: () => {

      if (!window.selectedDate) {
        window.selectedDate = toDayString(calendar.getDate());
      }

      updateWeekView();
      updateDayDetails();
      highlightSelectedDay(window.selectedDate);

      /**************************************************************
       * ✅ NEW: UPDATE RANGE TOOLTIPS ON NAVIGATION
       **************************************************************/
      applyRangeTooltips();

      /**************************************************************
       * ✅ NEW: UPDATE RANGE DISPLAY (STAYS IN SYNC)
       **************************************************************/
      const { label } = getActiveRangeLabel(currentRangeDays);

    },

    /**************************************************
     * CLICK EVENT
     **************************************************/
    // ✅ CLICK DAY → CREATE + UPDATE SIDEBAR
    eventClick: (info) => {

      window.selectedDate = toDayString(info.event.start);

      updateDayDetails();
      updateWeekView();
      highlightSelectedDay(window.selectedDate);
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
        window.selectedDate = toDayString(info.event.start);

        updateDayDetails();
        highlightSelectedDay(window.selectedDate);

        scrollWeekToDate(window.selectedDate);
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
        ev.extendedProps.account_key
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
      // ✅ TIME
      const timeEl = document.createElement("span");

      if (ev.start) {
        timeEl.textContent =
          new Date(ev.start).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit"
          }) + " ";

        timeEl.style.fontSize = "11px";
        timeEl.style.opacity = "0.75";
      }

      // ✅ TITLE
      const title = document.createElement("span");
      title.textContent = ev.title;
      title.style.fontWeight = "500";

      // ✅ APPEND
      container.appendChild(timeEl);
      container.appendChild(title);

      container.style.transition = "transform 0.1s ease";

      container.onmouseenter = () => {
        container.style.transform = "scale(1.02)";
      };

      container.onmouseleave = () => {
        container.style.transform = "scale(1)";
      };

      return { domNodes: [container] };
    }
  });
  window.calendar = calendar;
  window.calendar.render();
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
  window.calendar.refetchEvents();
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

            accountColorOverrides[key] = col;
            accountColorMap[key] = col;
            saveColorOverrides(accountColorOverrides);

            preview.style.background = col;
            preview.style.color = getBestTextColor(col);

            applyChipStyle(row, key, true);

            const badge = row.querySelector(".account-badge");
            if (badge) badge.style.background = col;

            // ✅ SAFE CALENDAR ACCESS (FIXED)
            const cal = window.calendar;

            if (cal) {
              cal.refetchEvents();
            } else {
              console.warn("⚠️ calendar not ready at palette click");
            }

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

        /*iroPicker.on("color:change", (c) => {
          
          const raw = c.hexString;
          const col = lightenColor(raw, 0.4);   // ✅ soften it
          const soft = lightenColor(col, 0.4);  // ✅ softness level

          accountColorOverrides[key] = soft;
          accountColorMap[key] = soft;
        */
      
        iroPicker.on("color:change", (c) => {

          const raw = c.hexString;

          /************************************************************
           ✅ STORE RAW COLOR (SOURCE OF TRUTH)
          ************************************************************/
          accountColorOverrides[key] = raw;
          accountColorMap[key] = raw;

          saveColorOverrides(accountColorOverrides);

          /************************************************************
           ✅ PREVIEW = SOFT (UI ONLY)
          ************************************************************/
          const soft = applySoftColor(raw);

          preview.style.background = soft;
          preview.style.color = getBestTextColor(soft);

          /************************************************************
           ✅ UI UPDATE
          ************************************************************/
          applyChipStyle(row, key, true);

          const badge = row.querySelector(".account-badge");

          if (badge) {
            badge.style.background = raw;                 // ✅ stays strong
            badge.style.color = getBestTextColor(raw);
          }

          window.calendar.refetchEvents();   // ✅ events stay RAW
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
  // ✅ ALWAYS default to ALL accounts on first load
  /**************************************************************
   ✅ FORCE ALL ACCOUNTS ACTIVE (CRITICAL FIX)
  **************************************************************/
  activeAccountFilters = new Set([...allAccountKeys]);
  
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

  if (!window.selectedDate) {
    window.selectedDate = toDayString(new Date());
  }

  const titleEl = document.getElementById("selectedDateTitle");
  const listEl = document.getElementById("dayEventsList");

  if (!titleEl || !listEl) return;

  const safeDate = fromDayString(window.selectedDate);
  /**************************************************************
  ✅ STRICT DAY RANGE (THIS IS THE FIX)
  **************************************************************/
  const start = new Date(safeDate);
  start.setHours(0, 0, 0, 0);

  const end = new Date(safeDate);
  end.setHours(23, 59, 59, 999);

  const events = getFilteredEvents({ start, end });

  console.log("✅ DAY FILTER RANGE:", start, end);
  console.log("✅ DAY EVENTS FOUND:", events.length);

  /**************************************************************
  ✅ HEADER
  **************************************************************/
  titleEl.textContent = safeDate.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  });

  console.log("✅ DAY EVENTS FOUND:", events.length);

  listEl.replaceChildren();

  /**************************************************************
  ✅ RENDER
  **************************************************************/
  events.forEach(ev => {

    const li = document.createElement("li");

    const key = ev.extendedProps?.account_key;
    const color = getColorByKey(key);

    li.style.borderLeft = `4px solid ${color}`;
    li.style.background = `${color}14`;
    li.style.padding = "6px";
    li.style.marginBottom = "4px";
    li.style.borderRadius = "6px";

    li.textContent = ev.title;

    listEl.appendChild(li);
  });
}


//✅ ✅ WEEK VIEW FUNCTION
/**************************************************************
✅ WEEK VIEW — FINAL PRODUCTION VERSION
---------------------------------------------------------------
✅ Correct Sunday start
✅ Multi-day expansion
✅ ZERO timezone drift
✅ Single render pipeline
**************************************************************/
function updateWeekView() {

  const container = document.getElementById("weekView");
  if (!container) return;

  container.innerHTML = "";

  if (!window.selectedDate) return;

  const selected = new Date(window.selectedDate);

  /**************************************************************
  ✅ FORCE WEEK START (SUNDAY)
  **************************************************************/
  const startOfWeek = new Date(selected);
  startOfWeek.setDate(selected.getDate() - selected.getDay());
  startOfWeek.setHours(0,0,0,0);

  /**************************************************************
  ✅ BUILD EXACT 7 DAYS (NO PARSING BUGS)
  **************************************************************/
  const weekDays = [];

  for (let i = 0; i < 7; i++) {
    const d = new Date(startOfWeek);
    d.setDate(startOfWeek.getDate() + i);

    // ✅ CRITICAL: Prevent timezone drift
    d.setHours(12,0,0,0);

    weekDays.push(d);
  }

  /**************************************************************
  ✅ DAY MAP (NO STRING → DATE REPARSE)
  **************************************************************/
  const weekMap = {};

  weekDays.forEach(d => {
    const key = toDayString(d);
    weekMap[key] = {
      date: d,
      events: []
    };
  });

  /**************************************************************
  ✅ EXPAND EVENTS ACROSS ALL DAYS
  **************************************************************/
  sessionEventCache.forEach(e => {

    if (!e.start) return;

    const evStart = new Date(e.start);
    const evEnd   = e.end ? new Date(e.end) : evStart;

    evStart.setHours(0,0,0,0);
    evEnd.setHours(0,0,0,0);

    for (let d = new Date(evStart); d <= evEnd; d.setDate(d.getDate() + 1)) {

      // ✅ CRITICAL: Prevent timezone drift
      d.setHours(12,0,0,0);

      const key = toDayString(d);

      if (weekMap[key]) {
        weekMap[key].events.push(e);
      }
    }
  });

  /**************************************************************
  ✅ RENDER (ORDERED, STABLE)
  **************************************************************/
  weekDays.forEach(d => {

    const key = toDayString(d);
    const dayData = weekMap[key];

    /**************************************************
    ✅ DAY HEADER
    **************************************************/
    const header = document.createElement("div");
    header.style.fontWeight = "bold";
    header.style.marginTop = "8px";

    header.textContent =
      dayData.date.toLocaleDateString(undefined, {
        weekday: "long",
        month: "short",
        day: "numeric"
      });

    container.appendChild(header);

    /**************************************************
    ✅ EVENTS
    **************************************************/
    dayData.events.forEach(e => {

      const row = document.createElement("div");

      const raw = getColorByKey(e.extendedProps?.account_key) || "#4285f4";
      const soft = getSoftColor(raw);

      row.style.backgroundColor = soft;
      row.style.borderLeft = `3px solid ${raw}`;
      row.style.color = getBestTextColor(soft);
      row.style.fontSize = "12px";
      row.style.marginBottom = "3px";
      row.style.padding = "3px 6px";

      row.textContent = e.title;

      container.appendChild(row);
    });
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

    /**************************************************************
     * ✅ FORCE UI UPDATE
     **************************************************************/
    renderAccountsSafe();   // ✅ ONLY THIS ONE HERE

    /**************************************************************
     * ✅ FORCE BROWSER TO PAINT BEFORE BLOCKING
     **************************************************************/
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
    smartRefresh({ reason: "event_saved" });

    
    setTimeout(() => {
      showToast("✅ Sync complete");
    }, 300);


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
