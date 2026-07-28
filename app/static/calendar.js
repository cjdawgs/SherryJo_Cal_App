import {
  initFullCalendar,
  applyCalendarLayoutMode,
  renderRangePill,
  highlightSelectedDay
} from "/static/calendar.fullcalendar.js";

import {
  initDateStickyStore,
  applyRangeTooltips,
  bindUIEvents,
  openCreateModal
} from "/static/calendar.ui.js";

import {
  toDayString,
  fromDayString,
  getActiveRangeLabel
} from "/static/core.js";

import { apiFetch, requireAuth, getAuthToken } from "/static/api.js";
import { setupUndoRedoKeyboard } from "/static/undo_redo.js";

console.log("🔥 JS FILE LOADED");
console.log("🔐 TOKEN AT LOAD:", localStorage.getItem("token"));

// Initialize undo/redo keyboard shortcuts
setupUndoRedoKeyboard();

window.highlightSelectedDay = highlightSelectedDay;

if (!document.getElementById("chip-spinner-style")) {
  const style = document.createElement("style");
  style.id = "chip-spinner-style";
  style.textContent = `
    @keyframes chipSpin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }
  `;
  document.head.appendChild(style);
}


function getCalendar() {
  return window.calendar || null;
}

const LAYOUT_BREAKPOINTS = {
  mobileMax: 640,
  tabletMax: 1024,
  desktopMax: 1920
};

window.layoutMode = window.layoutMode || "desktop";
window.sidebarCollapsed = window.sidebarCollapsed ?? false;
window.sidebarDrawerOpen = window.sidebarDrawerOpen ?? false;

function detectLayoutMode(width = window.innerWidth) {
  if (width <= LAYOUT_BREAKPOINTS.mobileMax) return "mobile";
  if (width <= LAYOUT_BREAKPOINTS.tabletMax) return "tablet";
  if (width <= LAYOUT_BREAKPOINTS.desktopMax) return "desktop";
  return "large";
}

function setSidebarDrawerOpen(isOpen) {
  window.sidebarDrawerOpen = !!isOpen;

  const toggleBtn = document.getElementById("sidebarToggleBtn");
  const backdrop = document.getElementById("sidebarDrawerBackdrop");

  document.body.classList.toggle("sidebar-drawer-open", window.sidebarDrawerOpen);

  if (toggleBtn) {
    toggleBtn.setAttribute("aria-expanded", window.sidebarDrawerOpen ? "true" : "false");
  }

  if (backdrop) {
    backdrop.setAttribute("aria-hidden", window.sidebarDrawerOpen ? "false" : "true");
  }
}

function applyControlBandDensity(mode) {
  const createBtn = document.getElementById("createBtn");
  const accountsBtn = document.getElementById("accountsBtn");
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");
  const syncBtn = document.getElementById("syncBtn");
  const publishBtn = document.getElementById("publishBtn");
  const dedupBtn = document.getElementById("dedupBtn");
  const logoutBtn = document.getElementById("logoutBtn");

  if (!createBtn) return;

  const withIconLabel = (btn, label) => {
    if (!btn) return;
    if (!btn.dataset.iconHtml) {
      btn.dataset.iconHtml = btn.innerHTML;
    }
    btn.innerHTML = `${btn.dataset.iconHtml}<span class="btnLabel">${label}</span>`;
  };

  if (mode === "mobile") {
    createBtn.textContent = "＋ Create";
    createBtn.title = "Create Event";
    withIconLabel(accountsBtn, "Account Menu");
    withIconLabel(undoBtn, "Undo");
    withIconLabel(redoBtn, "Redo");
    withIconLabel(syncBtn, "Sync");
    withIconLabel(publishBtn, "Publish");
    withIconLabel(dedupBtn, isDedupEnabled() ? "Dedup: ON" : "Dedup: OFF");
    withIconLabel(logoutBtn, "Logout");
    _updateDedupBtnUI();
    updatePublishButtonState();
    return;
  }

  if (mode === "tablet") {
    createBtn.textContent = "＋ Create Event";
    createBtn.title = "Create Event";
    withIconLabel(accountsBtn, "Account Menu");
    withIconLabel(undoBtn, "Undo");
    withIconLabel(redoBtn, "Redo");
    withIconLabel(syncBtn, "Sync");
    withIconLabel(publishBtn, "Publish");
    withIconLabel(dedupBtn, isDedupEnabled() ? "Dedup: ON" : "Dedup: OFF");
    withIconLabel(logoutBtn, "Logout");
    _updateDedupBtnUI();
    updatePublishButtonState();
    return;
  }

  createBtn.textContent = "➕ Create Event";
  createBtn.title = "Example: 'Doctor Appointment at 3pm' or 'Team Meeting 10:00–11:00'";
  withIconLabel(accountsBtn, "Account Menu");
  withIconLabel(undoBtn, "Undo");
  withIconLabel(redoBtn, "Redo");
  withIconLabel(syncBtn, "Sync Now");
  withIconLabel(publishBtn, "Publish");
  withIconLabel(dedupBtn, isDedupEnabled() ? "Dedup: ON" : "Dedup: OFF");
  withIconLabel(logoutBtn, "Logout");
  _updateDedupBtnUI();
  updatePublishButtonState();
}

function applyLayoutMode({ forceViewSwitch = false } = {}) {
  const nextMode = detectLayoutMode(window.innerWidth);
  const modeChanged = window.layoutMode !== nextMode;

  window.layoutMode = nextMode;
  document.body.dataset.layoutMode = nextMode;

  document.body.classList.toggle("sidebar-collapsed", nextMode === "tablet" && window.sidebarCollapsed);

  if (nextMode !== "mobile") {
    setSidebarDrawerOpen(false);
  }

  const shouldSwitchView = forceViewSwitch || modeChanged;
  applyCalendarLayoutMode(nextMode, { switchView: shouldSwitchView });
  applyControlBandDensity(nextMode);
}

function bindResponsiveSidebarControls() {
  const toggleBtn = document.getElementById("sidebarToggleBtn");
  const closeBtn = document.getElementById("sidebarCloseBtn");
  const backdrop = document.getElementById("sidebarDrawerBackdrop");

  if (!toggleBtn || toggleBtn.dataset.bound === "1") {
    return;
  }

  toggleBtn.dataset.bound = "1";

  toggleBtn.addEventListener("click", () => {
    if (window.layoutMode === "mobile") {
      setSidebarDrawerOpen(!window.sidebarDrawerOpen);
      return;
    }

    if (window.layoutMode === "tablet") {
      window.sidebarCollapsed = !window.sidebarCollapsed;
      document.body.classList.toggle("sidebar-collapsed", window.sidebarCollapsed);
    }
  });

  closeBtn?.addEventListener("click", () => {
    setSidebarDrawerOpen(false);
  });

  backdrop?.addEventListener("click", () => {
    setSidebarDrawerOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && window.sidebarDrawerOpen) {
      setSidebarDrawerOpen(false);
    }
  });
}

function initializeResponsiveLayout() {
  bindResponsiveSidebarControls();
  applyLayoutMode({ forceViewSwitch: true });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    window.clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      applyLayoutMode({ forceViewSwitch: false });
    }, 140);
  });

  document.getElementById("calendar")?.addEventListener("click", () => {
    if (window.layoutMode === "mobile" && window.sidebarDrawerOpen) {
      setSidebarDrawerOpen(false);
    }
  });
}

/**************************************************************
 * ✅ AUTH GUARD (SAFE VERSION + NO STALE TOKEN)
 **************************************************************/
if (window.location.pathname.includes("calendar-ui")) {
  requireAuth();
}


/**************************************************************
 * ✅ CENTRALIZED API FETCH (TOKEN SAFE)
 **************************************************************/

/**************************************************************
 * ✅ GLOBAL STATE
 **************************************************************/
let calendar = null;
let isAppSyncing = false;
// ✅ editingEventId is shared with calendar.ui.js via window so both modules
//    read/write the same value without circular imports.
window.editingEventId = window.editingEventId ?? null;

const DEDUP_STORAGE_KEY = "calendar_dedup_enabled";
window.dedupEnabled = window.dedupEnabled ?? (() => {
  try {
    const stored = window.localStorage?.getItem(DEDUP_STORAGE_KEY);
    if (stored === null) return true;
    return stored !== "0" && stored !== "false";
  } catch {
    return true;
  }
})();

function isDedupEnabled() {
  return window.dedupEnabled !== false;
}

function _updateDedupBtnUI() {
  const btn = document.getElementById("dedupBtn");
  if (!btn) return;

  const enabled = isDedupEnabled();
  btn.classList.toggle("dedup-on", enabled);
  btn.classList.toggle("dedup-off", !enabled);
  btn.setAttribute("aria-pressed", enabled ? "true" : "false");
  btn.title = enabled
    ? "Toggle cross-account deduplication (currently ON)"
    : "Toggle cross-account deduplication (currently OFF)";

  const labelEl = btn.querySelector(".btnLabel");
  if (labelEl) {
    labelEl.textContent = enabled ? "Dedup: ON" : "Dedup: OFF";
  }
}

function setDedupEnabled(nextEnabled) {
  window.dedupEnabled = !!nextEnabled;
  try {
    window.localStorage?.setItem(DEDUP_STORAGE_KEY, window.dedupEnabled ? "1" : "0");
  } catch {
    // Ignore storage failures; the UI state still updates immediately.
  }

  _updateDedupBtnUI();
  if (window.layoutMode) {
    applyControlBandDensity(window.layoutMode);
  }
}

function refreshAfterDedupChange() {
  applyClientSideFilters();
  updateDayDetails();
  updateWeekView();
}

async function materializeDedupedEventsToLocal() {
  const res = await apiFetch("/calendar/dedup-materialize", {
    method: "POST"
  });
  if (!res) return null;

  const raw = await res.text();
  const data = raw ? JSON.parse(raw) : {};
  if (!res.ok || String(data?.status || "").toLowerCase() === "error") {
    throw new Error(data?.message || `Dedup materialize failed (${res.status})`);
  }
  return data;
}

async function toggleDedup() {
  const nextEnabled = !isDedupEnabled();
  setDedupEnabled(nextEnabled);

  if (nextEnabled) {
    try {
      showToast("Materializing deduped events into Local...", "info");
      await materializeDedupedEventsToLocal();
      await preloadEventCache({
        silent: true,
        monthsBack: QUICK_CACHE_MONTHS_BACK,
        monthsForward: QUICK_CACHE_MONTHS_FORWARD,
        preserveSelectedDate: true
      });
      scheduleFullCacheExpansion("dedup_materialize_expand");
    } catch (err) {
      console.error("❌ Dedup materialize failed", err);
      showToast("Dedup is on, but Local materialization failed", "error");
    }
  }

  refreshAfterDedupChange();
  showToast(isDedupEnabled() ? "Dedup enabled" : "Dedup disabled", "info");
}

window.isDedupEnabled = isDedupEnabled;
window.toggleDedup = toggleDedup;
window.setDedupEnabled = setDedupEnabled;

// ── Session modification tracking ───────────────────────────────────────────
// Tracks event IDs edited/created this session so Publish is scoped only to
// events actually changed, covering only their affected accounts and date span.
// Sync NEVER clears this — only an explicit Publish does.
window.sessionModifiedEventIds = window.sessionModifiedEventIds ?? new Set();
window.sessionDeletedProviderEvents = window.sessionDeletedProviderEvents ?? [];
window.pendingPublishChanges = window.pendingPublishChanges ?? new Map();

function describePendingEvent(eventRef, fallback = "Event updated") {
  const title = String(eventRef?.title || eventRef?.extendedProps?.title || "Untitled event").trim();
  return `${fallback}: ${title || "Untitled event"}`;
}

function getPendingPublishChanges() {
  return [...(window.pendingPublishChanges?.values?.() || [])];
}

function hasPendingPublishChanges() {
  return getPendingPublishChanges().length > 0;
}

function renderPublishBadge(btn, count) {
  if (!btn) return;

  let badge = btn.querySelector(".publishCountBadge");
  if (count <= 0) {
    badge?.remove();
    return;
  }

  if (!badge) {
    badge = document.createElement("span");
    badge.className = "publishCountBadge";
    badge.setAttribute("aria-label", "Pending publish items");
    btn.appendChild(badge);
  }

  badge.textContent = String(count);
}

function updatePublishButtonState() {
  const btn = document.getElementById("publishBtn");
  if (!btn) return;

  const pendingCount = getPendingPublishChanges().length;
  const hasChanges = pendingCount > 0;
  btn.disabled = !hasChanges;
  btn.classList.toggle("publish-disabled", !hasChanges);
  btn.setAttribute("aria-disabled", hasChanges ? "false" : "true");
  btn.dataset.pendingCount = String(pendingCount);
  btn.title = hasChanges
    ? `${pendingCount} pending publish item${pendingCount === 1 ? "" : "s"}. Click or right-click to review.`
    : "No event, sticky note, or calendar-view changes pending publish.";
  renderPublishBadge(btn, pendingCount);
}

function registerPendingPublishChange(change = {}) {
  const category = String(change.category || "event").trim() || "event";
  const eventId = change.eventId != null ? Number(change.eventId) : null;
  const key = String(change.key || `${category}:${eventId ?? change.dateKey ?? Date.now()}:${Math.random().toString(16).slice(2)}`);
  const summary = String(change.summary || "Pending calendar change").trim();

  window.pendingPublishChanges.set(key, {
    key,
    category,
    summary,
    eventId,
    dateKey: change.dateKey || null,
    deletedEvent: change.deletedEvent || null,
    localOnly: change.localOnly === true,
    createdAt: change.createdAt || new Date().toISOString()
  });

  if (eventId != null) {
    window.sessionModifiedEventIds.add(eventId);
  }

  updatePublishButtonState();
}

function removePendingPublishChanges(changeKeys = []) {
  const keys = new Set(changeKeys.map(String));
  if (!keys.size) return;

  keys.forEach((key) => window.pendingPublishChanges.delete(key));

  const remainingEventIds = new Set(
    getPendingPublishChanges()
      .map((change) => change.eventId)
      .filter((id) => id != null)
      .map(Number)
  );
  window.sessionModifiedEventIds = new Set(
    [...(window.sessionModifiedEventIds || [])].filter((id) => remainingEventIds.has(Number(id)))
  );

  window.sessionDeletedProviderEvents = getPendingPublishChanges()
    .map((change) => change.deletedEvent)
    .filter(Boolean);

  updatePublishButtonState();
}

function removePendingPublishChangesForEventIds(eventIds = []) {
  const ids = new Set((eventIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)));
  if (!ids.size) return;

  const keysToRemove = getPendingPublishChanges()
    .filter((change) => change?.eventId != null && ids.has(Number(change.eventId)))
    .map((change) => change.key);

  if (!keysToRemove.length) return;
  removePendingPublishChanges(keysToRemove);
}

function clearPendingPublishChanges() {
  window.pendingPublishChanges.clear();
  window.sessionModifiedEventIds.clear();
  window.sessionDeletedProviderEvents = [];
  updatePublishButtonState();
}

window.trackModifiedEvent = function (id, details = {}) {
  if (id == null) return;
  registerPendingPublishChange({
    key: details.key || `${details.category || "event"}:${Number(id)}`,
    category: details.category || "event",
    summary: details.summary || `Event: updated event #${id}`,
    eventId: Number(id),
    localOnly: details.localOnly === true
  });
};

window.trackDeletedProviderEvent = function (eventRef) {
  const externalIds = {
    ...(eventRef?.external_ids || {}),
    ...(eventRef?.extendedProps?.external_ids || {})
  };

  if (!Object.keys(externalIds).length) return;

  const deletedEvent = {
    title: eventRef?.title || "",
    external_ids: externalIds
  };
  window.sessionDeletedProviderEvents.push(deletedEvent);

  registerPendingPublishChange({
    key: `event-delete:${eventRef?.extendedProps?.backendId || eventRef?.id || Date.now()}`,
    category: "event",
    summary: describePendingEvent(eventRef, "Delete event"),
    deletedEvent
  });
};

window.trackPendingPublishChange = registerPendingPublishChange;
window.updatePublishButtonState = updatePublishButtonState;
window.removePendingPublishChangesForEventIds = removePendingPublishChangesForEventIds;
// ────────────────────────────────────────────────────────────────────────────
let editingEventId = null;   // kept for backward-compat within this module
let editingNoteId = null;
let providerAccountCounts = {};
let allAccountKeys = new Set();   // ✅ MASTER ACCOUNT LIST

// ✅ Tracks modifier key state for resilient chip multi-select handling
// in browsers/devtools modes where click.ctrlKey/metaKey can be unreliable.
let chipMultiSelectModifierDown = false;

function initChipModifierTracking() {
  if (window.__chipModifierTrackingBound) return;
  window.__chipModifierTrackingBound = true;

  window.addEventListener("keydown", (e) => {
    if (e.key === "Control" || e.key === "Meta") {
      chipMultiSelectModifierDown = true;
    }
  });

  window.addEventListener("keyup", (e) => {
    if (e.key === "Control" || e.key === "Meta") {
      chipMultiSelectModifierDown = false;
    }
  });

  window.addEventListener("blur", () => {
    chipMultiSelectModifierDown = false;
  });
}

function isChipMultiSelectEvent(e) {
  if (!e) return chipMultiSelectModifierDown;
  const viaFlags = !!(e.ctrlKey || e.metaKey);
  const viaModifierState = typeof e.getModifierState === "function"
    ? !!(e.getModifierState("Control") || e.getModifierState("Meta"))
    : false;
  return viaFlags || viaModifierState || chipMultiSelectModifierDown;
}
window.selectedDate = null;

let lastLoadedAccounts = [];
window.connectedCalendarAccounts = window.connectedCalendarAccounts || [];
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
let currentViewEventCounts = {};

// Expose a safe snapshot getter so other modules can enforce account filtering.
window.getActiveAccountFilters = () => new Set(activeAccountFilters);
let chipClickTimer = null;
let suppressChipClickUntil = 0;

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
window.sessionCacheRange = window.sessionCacheRange || sessionCacheRange;
let isInitialLoadComplete = false;
const QUICK_CACHE_MONTHS_BACK = 1;
const QUICK_CACHE_MONTHS_FORWARD = 1;
const FULL_CACHE_MONTHS_BACK = 6;
const FULL_CACHE_MONTHS_FORWARD = 6;
let backgroundCacheExpandTimer = null;

function scheduleFullCacheExpansion(reason = "background_cache_expand") {
  if (backgroundCacheExpandTimer) {
    clearTimeout(backgroundCacheExpandTimer);
  }

  backgroundCacheExpandTimer = setTimeout(async () => {
    backgroundCacheExpandTimer = null;

    try {
      await preloadEventCache({
        silent: true,
        monthsBack: FULL_CACHE_MONTHS_BACK,
        monthsForward: FULL_CACHE_MONTHS_FORWARD,
        preserveSelectedDate: true
      });
      smartRefresh({ reason, force: true });
    } catch (err) {
      console.warn("⚠️ Background cache expansion failed:", err);
    }
  }, 300);
}

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
// ✅ Expose so calendar.ui.js (separate module) can call it
window.smartRefresh = smartRefresh;

function getCalendarEventAccountKey(ev) {
  if (!ev) return "";

  const directKey = ev.extendedProps?.account_key;
  if (directKey) return directKey;

  const provider = normalizeProvider(ev.extendedProps?.source || ev.source || "local");
  const account = (
    ev.extendedProps?.account ||
    ev.extendedProps?.account_email ||
    "local"
  ).toLowerCase().trim();

  return normalizeKey(provider, account);
}

window.getCalendarEventAccountKey = getCalendarEventAccountKey;

function computeCurrentViewEventCounts() {
  const cal = getCalendar();
  if (!cal || typeof cal.getEvents !== "function") return {};

  const view = cal.view;
  const activeStart = view?.activeStart ? new Date(view.activeStart) : null;
  const activeEnd = view?.activeEnd ? new Date(view.activeEnd) : null;

  const counts = {};

  cal.getEvents().forEach((ev) => {
    if (activeStart && activeEnd) {
      const evStart = ev.start ? new Date(ev.start) : null;
      const evEnd = ev.end ? new Date(ev.end) : evStart;

      if (!evStart) return;
      if (evEnd < activeStart || evStart >= activeEnd) return;
    }

    const key = getCalendarEventAccountKey(ev);
    if (!key) return;

    counts[key] = (counts[key] || 0) + 1;
  });

  return counts;
}

function updateChipEventCounts() {
  const accountsContainer = document.getElementById("accounts");
  if (!accountsContainer) return;

  const hasGetColor = typeof getColorByKey === "function";
  const hasSoftColor = typeof applySoftColor === "function";
  const hasTextColor = typeof getBestTextColor === "function";

  currentViewEventCounts = computeCurrentViewEventCounts();

  accountsContainer.querySelectorAll(".chip").forEach((chip) => {
    const key = chip.dataset.key;
    if (!key) return;

    const count = currentViewEventCounts[key] || 0;

    let badge = chip.querySelector(".chip-event-count");
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "chip-event-count";
      badge.style.marginLeft = "4px";
      badge.style.padding = "0 5px";
      badge.style.borderRadius = "999px";
      badge.style.fontSize = "9px";
      badge.style.fontWeight = "700";
      badge.style.lineHeight = "1.2";
      badge.style.display = "inline-flex";
      badge.style.alignItems = "center";
      badge.style.justifyContent = "center";
      badge.style.minWidth = "14px";

      const header = chip.firstElementChild;
      if (header) {
        header.appendChild(badge);
      }
    }

    const raw = hasGetColor ? getColorByKey(key) : "#64748b";
    const soft = hasSoftColor ? applySoftColor(raw) : raw;
    const text = hasTextColor ? getBestTextColor(soft) : "#111";

    badge.textContent = String(count);
    badge.title = `${count} events in current view`;
    badge.style.background = soft;
    badge.style.color = text;
    badge.style.border = `2px solid ${raw}`;
    badge.style.opacity = count === 0 ? "0.5" : "0.82";
  });
}

window.updateChipEventCounts = updateChipEventCounts;

function consumePendingReconnectSync() {
  const raw = localStorage.getItem("postReconnectSync");
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    localStorage.removeItem("postReconnectSync");

    if (!parsed || typeof parsed !== "object") return null;

    const createdAt = Number(parsed.createdAt || 0);
    if (!createdAt || Date.now() - createdAt > 10 * 60 * 1000) {
      return null;
    }

    return {
      provider: String(parsed.provider || ""),
      account: String(parsed.account || "")
    };
  } catch {
    localStorage.removeItem("postReconnectSync");
    return null;
  }
}

function shouldAutoSyncApple(accountTotals = {}) {
  const hasAppleAccount = lastLoadedAccounts.some((acc) => {
    const provider = normalizeProvider(acc.provider || "");
    const email = (acc.account_email || acc.email || "").toLowerCase().trim();
    return provider === "apple" && !!email;
  });

  if (!hasAppleAccount) return false;

  const appleTotal = Object.entries(accountTotals)
    .filter(([k]) => String(k).startsWith("apple:"))
    .reduce((sum, [, v]) => sum + (Number(v) || 0), 0);

  if (appleTotal > 0) return false;

  const now = Date.now();
  const raw = localStorage.getItem("appleZeroAutoSyncAt");
  const lastRun = raw ? Number(raw) : 0;

  if (lastRun && now - lastRun < 10 * 60 * 1000) {
    return false;
  }

  localStorage.setItem("appleZeroAutoSyncAt", String(now));
  return true;
}

async function logAppleFetchDiagnostics() {
  try {
    const res = await apiFetch("/accounts/apple/debug-fetch");
    if (!res || !res.ok) {
      console.warn("🧪 APPLE DEBUG FETCH unavailable");
      return;
    }

    const data = await res.json();
    console.log("🧪 APPLE DEBUG FETCH:", data);
  } catch (err) {
    console.warn("🧪 APPLE DEBUG FETCH failed", err);
  }
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
  const rangeEnd = new Date(end);

  const events = sessionEventCache.filter(ev => {

    if (!ev || !ev.start) return false;

    const evStart = new Date(ev.start);
    const evEnd = ev.end ? new Date(ev.end) : evStart;

    // ✅ STRICT OVERLAP ONLY
    if (evEnd < rangeStart) return false;
    if (evStart > rangeEnd) return false;

    // ✅ ACCOUNT FILTER ONLY
    const key = getCalendarEventAccountKey(ev);
    if (activeAccountFilters.size && !activeAccountFilters.has(key)) {
      return false;
    }

    return true;
  });

  return dedupeEventsForDisplay(events);
}
window.getFilteredEvents = getFilteredEvents;
function normalizeProvider(provider) {
  const p = (provider || "").toLowerCase();
  return p === "outlook" ? "microsoft" : p;
}

function isPlaceholderAccountRecord(acc) {
  if (!acc) return false;

  const provider = normalizeProvider(acc.provider || "");
  const email = String(acc.account_email || acc.email || "").toLowerCase().trim();
  const accountLabel = String(acc.account_name || acc.username || acc.name || "").toLowerCase().trim();

  if (accountLabel === "test" || accountLabel.startsWith("test_")) return true;

  if (!email) return false;

  const placeholderEmails = new Set([
    "test@example.com",
    "test"
  ]);

  if (placeholderEmails.has(email)) return true;
  if (email.endsWith("@example.com")) return true;

  // Guardrail: placeholder Google test accounts should never appear in prod UI.
  if (provider === "google" && (email === "test" || email.startsWith("test@"))) return true;

  return false;
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

function getDisplayDedupKey(ev) {
  const title = String(ev?.title || "").trim().toLowerCase().replace(/\s+/g, " ");
  const start = ev?.start ? new Date(ev.start) : null;

  if (!title || !start || Number.isNaN(start.getTime())) {
    const fallbackId = String(ev?.id || ev?.extendedProps?.backendId || "").trim();
    return fallbackId || "missing-dedup-key";
  }

  const startMinute = new Date(start);
  startMinute.setSeconds(0, 0);
  return `${title}|${startMinute.toISOString().slice(0, 16)}`;
}

function dedupeEventsForDisplay(events) {
  if (!isDedupEnabled()) return events;

  const seen = new Set();
  return events.filter(ev => {
    const key = getDisplayDedupKey(ev);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

window.dedupeEventsForDisplay = dedupeEventsForDisplay;
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

  const cal = getCalendar();
  if (!cal) return true;

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
// ✅ Expose so calendar.ui.js (separate module) can call it
window.showToast = showToast;


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
  return getColorByKey(key, provider);
}

// ✅ SAFE DATE PARSER (FULLY FIXED)
function safeParseDate(dt) {
  if (!dt) return null;

  // Parse date-only strings as local dates to avoid UTC day drift.
  if (typeof dt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dt)) {
    const [y, m, d] = dt.split("-").map(Number);
    return new Date(y, m - 1, d);
  }

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

function getEventStickyCount(ev) {
  const stickyList = ev?.extendedProps?.stickyNotes || [];
  const listCount = Array.isArray(stickyList)
    ? stickyList.filter((s) => String(s?.content || "").trim()).length
    : 0;
  if (listCount > 0) return listCount;
  return String(ev?.extendedProps?.stickyNote?.content || "").trim() ? 1 : 0;
}

function createStickyIconElement({ count = 1, title = "Open sticky note", onOpen, onEdit, onDelete, dragPayload = null } = {}) {
  const icon = document.createElement("span");
  icon.className = "stickyEventIcon";
  icon.textContent = "🗒";
  icon.title = title;

  if (dragPayload) {
    icon.draggable = true;
    icon.addEventListener("dragstart", (e) => {
      window.beginStickyDrag?.(dragPayload, e);
    });
    icon.addEventListener("dragend", () => {
      window.clearStickyDragPayload?.();
    });
  }

  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "stickyCountBadge";
    badge.textContent = String(count);
    icon.appendChild(badge);
  }

  if (typeof onOpen === "function") {
    icon.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpen();
    });

    icon.addEventListener("dblclick", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (typeof onEdit === "function") {
        onEdit();
        return;
      }
      onOpen();
    });
  }

  if (typeof onDelete === "function") {
    icon.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSidebarStickyMenu(e.clientX, e.clientY, onOpen, onDelete, onEdit);
    });
  }

  return icon;
}

function openSidebarStickyMenu(x, y, onOpen, onDelete, onEdit) {
  let menu = document.getElementById("eventContextMenu");
  if (!menu) {
    menu = document.createElement("div");
    menu.id = "eventContextMenu";
    document.body.appendChild(menu);
  }

  menu.innerHTML = `
    <div class="ctx-menu-item" data-action="open-sticky">🗒 Open Sticky</div>
    <div class="ctx-menu-item" data-action="edit-sticky">✏️ Edit Specific Sticky</div>
    <div class="ctx-menu-item danger" data-action="delete-sticky">🧽 Delete Specific Sticky</div>
  `;

  const menuW = menu.offsetWidth || 185;
  const menuH = menu.offsetHeight || 120;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top = Math.min(y, window.innerHeight - menuH - 8);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.classList.add("visible");

  menu.querySelector("[data-action='open-sticky']")?.addEventListener("click", () => {
    menu.classList.remove("visible");
    if (typeof onOpen === "function") onOpen();
  });

  menu.querySelector("[data-action='delete-sticky']")?.addEventListener("click", () => {
    menu.classList.remove("visible");
    if (typeof onDelete === "function") onDelete();
  });

  menu.querySelector("[data-action='edit-sticky']")?.addEventListener("click", () => {
    menu.classList.remove("visible");
    if (typeof onEdit === "function") {
      onEdit();
      return;
    }
    if (typeof onOpen === "function") onOpen();
  });
}

function getSidebarEventId(ev) {
  return String(ev?.extendedProps?.backendId || ev?.id || "");
}

function selectSidebarEvent(ev) {
  const id = getSidebarEventId(ev);
  if (!id) return;

  if (ev?.start) {
    window.selectedDate = toDayString(new Date(ev.start));
    window.highlightSelectedDay?.(window.selectedDate);
    window.dispatchEvent(new Event("selectedDateChanged"));
  }

  window.setSelectedEvent?.(id);
  updateDayDetails();
  updateWeekView();
}

function bindSidebarEventRow(div, ev) {
  const id = getSidebarEventId(ev);
  if (!div || !id) return;

  div.style.cursor = "pointer";
  div.title = "Click to select. Double-click to edit event.";
  div.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();

    if (window._eventClickTimer && window._lastClickedEventId === id) {
      clearTimeout(window._eventClickTimer);
      window._eventClickTimer = null;
      window._lastClickedEventId = null;
      window.openCreateModal?.(null, ev);
      return;
    }

    window._lastClickedEventId = id;
    window._eventClickTimer = setTimeout(() => {
      window._eventClickTimer = null;
      window._lastClickedEventId = null;
      selectSidebarEvent(ev);
    }, 280);
  });
}

function renderDateStickyHeaderIcon(dateKey, mode = "day") {
  const count = Number(window.getDateStickyCount?.(dateKey) || 0);
  if (!count) return null;

  return createStickyIconElement({
    count,
    title: window.getDateStickyTooltip?.(dateKey)
      || (count > 1 ? `Open date sticky notes (${count})` : "Open date sticky note"),
    onOpen: () => window.openDateStickyModal?.(dateKey),
    onDelete: () => window.deleteDateStickyNote?.(dateKey),
    onEdit: () => window.editDateStickyNote?.(dateKey),
    dragPayload: {
      scope: "date",
      dateKey
    }
  });
}

function setSelectedDayTitleWithSticky(titleEl, selectedDateObj, dateKey) {
  if (!titleEl || !selectedDateObj) return;

  titleEl.textContent = "";
  titleEl.style.display = "flex";
  titleEl.style.alignItems = "center";
  titleEl.style.justifyContent = "flex-start";
  titleEl.style.gap = "6px";

  const icon = renderDateStickyHeaderIcon(dateKey, "day");
  if (icon) {
    titleEl.appendChild(icon);
  }

  const text = document.createElement("span");
  text.textContent = selectedDateObj.toDateString();
  titleEl.appendChild(text);
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

  initChipModifierTracking();

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
  if (!requireAuth()) return;
  showAdminAccessNoticeIfAny();
  await loadAccounts();
  renderAccountsSafe();

  try {
    await initDateStickyStore();
  } catch (err) {
    console.warn("⚠️ Date sticky store init failed:", err);
  }

  // ✅ Expose openCreateModal for use by FullCalendar eventClick / dateClick
  //    (those callbacks live in calendar.fullcalendar.js which is a separate module)
  window.openCreateModal = openCreateModal;

  // ✅ LOAD DATA FIRST (critical) check for Full preload or partial
  if (!sessionEventCache.length) {
    console.log("🔄 Refreshing cache (needed)");

    try {
      await preloadEventCache({
        monthsBack: QUICK_CACHE_MONTHS_BACK,
        monthsForward: QUICK_CACHE_MONTHS_FORWARD
      });
    } catch (err) {
      console.error("❌ preloadEventCache failed:", err);
      showToast("Calendar failed to load. Please refresh.", "error");
    }

  } else {
    console.log("⚡ Using existing session cache");
  }


  // ✅ THIS IS THE ONLY CALENDAR INIT YOU NEED
  initFullCalendar();
  // Keep legacy local reference aligned with the initialized global calendar.
  calendar = getCalendar();
  scheduleFullCacheExpansion("startup_cache_expand");
  initializeResponsiveLayout();
  renderRangePill(); // ✅ ensure initial render

  const reconnectSyncRequest = consumePendingReconnectSync();
  if (reconnectSyncRequest) {
    const label = reconnectSyncRequest.account || reconnectSyncRequest.provider || "reconnected account";
    showToast(`Syncing ${label} after reconnect...`);

    try {
      await syncNow();
    } catch (err) {
      console.error("❌ post-reconnect sync failed:", err);
      showToast("Reconnect succeeded, but auto-sync failed. Click Sync Now.", "error");
    }
  }

  applyRangeTooltips();

  bindUIEvents();
  applyRangeTooltips(); // ✅ ensures hover text shows immediately

  window.addEventListener("accountsUpdated", async () => {
    await reloadAccounts();
    rerenderChips();
    refreshEvents();
  });

}

function showAdminAccessNoticeIfAny() {
  const message = localStorage.getItem("adminAccessNotice");
  if (!message) return;

  localStorage.removeItem("adminAccessNotice");

  const existing = document.getElementById("admin-access-banner");
  if (existing) {
    existing.remove();
  }

  const banner = document.createElement("div");
  banner.id = "admin-access-banner";
  banner.style.background = "#fff1f2";
  banner.style.color = "#9f1239";
  banner.style.border = "1px solid #fecdd3";
  banner.style.borderRadius = "10px";
  banner.style.padding = "10px 12px";
  banner.style.margin = "8px 10px";
  banner.style.fontSize = "13px";
  banner.style.fontWeight = "700";
  banner.textContent = `Admin access required: ${message}`;

  const topbar = document.querySelector(".topbar");
  if (topbar && topbar.parentNode) {
    topbar.parentNode.insertBefore(banner, topbar.nextSibling);
  } else {
    document.body.prepend(banner);
  }

  setTimeout(() => {
    banner.remove();
  }, 6000);
}

function showReconnectBanner(accounts) {
  const broken = accounts.filter(a => a.status === "error" && !isPlaceholderAccountRecord(a));

  const existing = document.getElementById("reconnect-banner");
  if (existing) {
    existing.remove();
  }

  if (!broken.length) return;

  const fixable = broken.filter((a) => {
    const provider = normalizeProvider(a.provider || "");
    return provider === "google" || provider === "microsoft" || provider === "apple";
  });

  const reasonText = (acc) => {
    const raw = String(acc?.last_error || "").trim();
    if (!raw) return "Connection expired or provider auth token is no longer valid.";
    return raw.length > 180 ? `${raw.slice(0, 180)}...` : raw;
  };

  const providerLabel = (value) => {
    const normalized = normalizeProvider(value || "");
    if (normalized === "google") return "Google";
    if (normalized === "microsoft") return "Microsoft";
    if (normalized === "apple") return "Apple";
    return normalized || "Unknown";
  };

  const banner = document.createElement("div");
  banner.id = "reconnect-banner";

  banner.style.background = "#fee2e2";
  banner.style.color = "#991b1b";
  banner.style.border = "1px solid #fecaca";
  banner.style.borderRadius = "10px";
  banner.style.padding = "10px";
  banner.style.marginBottom = "8px";
  banner.style.fontSize = "13px";

  const header = document.createElement("div");
  header.style.fontWeight = "700";
  header.style.marginBottom = "6px";
  header.textContent = `⚠ ${fixable.length} account(s) need reconnect`;
  banner.appendChild(header);

  const list = document.createElement("div");
  list.style.display = "grid";
  list.style.gap = "6px";

  fixable.forEach((acc) => {
    const row = document.createElement("div");
    row.style.background = "#fff";
    row.style.border = "1px solid #fca5a5";
    row.style.borderRadius = "8px";
    row.style.padding = "7px";
    row.style.display = "grid";
    row.style.gap = "4px";

    const who = document.createElement("div");
    who.style.fontWeight = "700";
    who.textContent = `${providerLabel(acc.provider)}: ${acc.account_email || "(unknown account)"}`;

    const why = document.createElement("div");
    why.style.fontSize = "12px";
    why.style.color = "#7f1d1d";
    why.textContent = `Reason: ${reasonText(acc)}`;

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "6px";

    const reconnectBtn = document.createElement("button");
    reconnectBtn.textContent = "Reconnect";
    reconnectBtn.style.border = "1px solid #b91c1c";
    reconnectBtn.style.color = "#b91c1c";
    reconnectBtn.style.fontWeight = "700";
    reconnectBtn.style.background = "#fff";
    reconnectBtn.style.borderRadius = "6px";
    reconnectBtn.style.padding = "4px 8px";
    reconnectBtn.onclick = () => startReconnect(acc.provider, acc.account_email);

    const detailsBtn = document.createElement("button");
    detailsBtn.textContent = "Open Accounts";
    detailsBtn.style.border = "1px solid #fca5a5";
    detailsBtn.style.color = "#7f1d1d";
    detailsBtn.style.background = "#fff";
    detailsBtn.style.borderRadius = "6px";
    detailsBtn.style.padding = "4px 8px";
    detailsBtn.onclick = () => {
      window.location.href = "/accounts/ui";
    };

    actions.appendChild(reconnectBtn);
    actions.appendChild(detailsBtn);

    row.appendChild(who);
    row.appendChild(why);
    row.appendChild(actions);
    list.appendChild(row);
  });

  banner.appendChild(list);

  document.body.prepend(banner);
}

function buildReconnectUrl(provider, email) {
  const token = getAuthToken() || localStorage.getItem("token") || "";

  if (!token) return "/accounts/ui";

  const safeProvider = normalizeProvider(provider || "");
  const encodedToken = encodeURIComponent(token);
  const encodedEmail = encodeURIComponent((email || "").trim());

  if (safeProvider === "google") {
    return `/auth/google/login?token=${encodedToken}&reconnect=${encodedEmail}`;
  }

  if (safeProvider === "microsoft") {
    return `/ms/login?token=${encodedToken}&reconnect=${encodedEmail}`;
  }

  if (safeProvider === "apple") {
    return `/accounts/ui?reconnect=apple&email=${encodedEmail}`;
  }

  return "/accounts/ui";
}

function startReconnect(provider, email) {
  const url = buildReconnectUrl(provider, email);

  if (!url || url === "/accounts/ui") {
    window.location.href = "/accounts/ui";
    return;
  }

  window.location.href = url;
}

function refreshAccountStateFromBackend(reason = "accountsUpdated") {
  console.log(`🔁 Refreshing account state from backend: ${reason}`);
  loadAccounts().then(() => {
    renderAccountsSafe();
    smartRefresh({ reason, force: true });
  });
}

async function reloadAccounts() {
  return loadAccounts();
}

function rerenderChips() {
  renderAccountsSafe();
}

function refreshEvents() {
  smartRefresh({ reason: "accountsUpdated", force: true });
}

const colorPersistTimers = new Map();

async function persistAccountColor(accountId, key, color) {
  const normalizedColor = (color || "").toLowerCase().trim();
  if (!normalizedColor) return;

  if (!accountId) {
    setAccountColor(key, normalizedColor);
    return;
  }

  const res = await apiFetch(`/accounts/${accountId}/color`, {
    method: "PUT",
    body: { color: normalizedColor }
  });

  if (!res || !res.ok) {
    console.error("❌ Failed to persist account color", accountId, normalizedColor);
    return;
  }

  const payload = await res.json();
  const savedColor = (payload?.color || normalizedColor).toLowerCase().trim();

  setAccountColor(key, savedColor);

  const localAccount = lastLoadedAccounts.find((acc) => acc.id === accountId);
  if (localAccount) {
    localAccount.color = savedColor;
  }

  console.log("ACCOUNT COLOR:", key, savedColor);
  window.dispatchEvent(new Event("accountsUpdated"));
}

function queuePersistAccountColor(accountId, key, color) {
  if (colorPersistTimers.has(key)) {
    clearTimeout(colorPersistTimers.get(key));
  }

  const timerId = setTimeout(() => {
    persistAccountColor(accountId, key, color).catch((err) => {
      console.error("❌ Persist account color failed", err);
    });
    colorPersistTimers.delete(key);
  }, 220);

  colorPersistTimers.set(key, timerId);
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
      return [];
    }

    const payload = await res.json();
    const rawData = Array.isArray(payload) ? payload : (payload.accounts || []);
    const data = rawData.filter((acc) => !isPlaceholderAccountRecord(acc));

    lastLoadedAccounts = data;
    window.connectedCalendarAccounts = [...data];

    if (typeof window.hydrateAccountColorMap === "function") {
      window.hydrateAccountColorMap(data);
    }

    console.log("🔥 RAW ACCOUNT DATA:", data);

    data.forEach((account) => {
      const key = `${normalizeProvider(account.provider)}:${(account.account_email || "").toLowerCase().trim()}`;
      console.log("ACCOUNT COLOR:", key, account.color || getColorByKey(key));
    });

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
   * ✅ SINGLE SOURCE OF TRUTH — ALL sub-elements derive color
   *    ONLY from getColorByKey(key) → accountColorMap → backend
   *
   * RAW  = identity color  (dot background, badge, event strips)
   * SOFT = display color   (chip background tint)
   *
   * ❌ FORBIDDEN: hardcoded colors, per-element overrides,
   *              separate dotColor vs chipColor variables
   ************************************************************/
  const raw = getColorByKey(key);          // ← THE ONLY COLOR SOURCE
  const finalColor = applySoftColor(raw);  // ← chip bg only (tinted)

  // ✅ CHIP BACKGROUND (soft tint for readability)
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

  // ✅ COLOR DOT — must always equal raw (account color, NOT soft)
  // ROOT CAUSE FIX: dot was only set once at chip-creation time.
  // Any subsequent call to applyChipStyle (color picker, filter
  // toggle, updateChipSelectionUI) now keeps dot in sync with
  // the chip background — eliminating the divergence entirely.
  const dot = row.querySelector(".color-dot");
  if (dot) {
    dot.style.background = raw;

    // Adaptive border contrast so dot edge is always visible
    const dotBorderColor = getBestTextColor(raw) === "#fff"
      ? "rgba(255,255,255,0.7)"
      : "rgba(0,0,0,0.4)";
    dot.style.border = `1px solid ${dotBorderColor}`;
    dot.style.outline = `1px solid ${getBestTextColor(raw)}`;

    console.log("DOT COLOR SOURCE:", key, raw, "→ dot.background =", raw);
  }

  // ✅ ACCOUNT BADGE — same raw color (multi-account disambiguation)
  const badge = row.querySelector(".account-badge");
  if (badge) {
    badge.style.background = raw;
    badge.style.color = getBestTextColor(raw);
  }
}

async function preloadEventCache({
  silent = false,
  monthsBack = FULL_CACHE_MONTHS_BACK,
  monthsForward = FULL_CACHE_MONTHS_FORWARD,
  preserveSelectedDate = false
} = {}) {
  console.log("🧠 PRELOADING CACHE");
  if (!silent) {
    document.body.style.cursor = "wait";
  }
  isAppSyncing = true;

  console.log("🟡 SYNC MODE ON");
  /****************************************************************
   * ✅ FORCE SYNC STATE FOR DOTS DURING PRELOAD
   * Skip when silent=true (post-sync call) so chip spinners
   * don't reappear after the sync complete toast fires.
   ****************************************************************/
  if (!silent) {
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
  } // end if (!silent)

  const centerDate = safeParseDate(window.selectedDate) || getCalendar()?.getDate?.() || new Date();
  const start = new Date(centerDate);
  const end = new Date(centerDate);

  start.setMonth(start.getMonth() - monthsBack);
  end.setMonth(end.getMonth() + monthsForward);

  const res = await apiFetch(
    `/calendar/unified?start=${start.toISOString()}&end=${end.toISOString()}&dedup=false`
  );

  if (!res) {
    throw new Error("No response from /calendar/unified");
  }

  if (!res.ok) {
    const text = await res.text();
    console.error("❌ /calendar/unified failed:", res.status, text);
    throw new Error(`Calendar preload failed: ${res.status}`);
  }

  const data = await res.json();

  const rawEvents = data.events || [];
  const backendStatus = data.account_status || {};
  const backendTotals = data.account_event_totals || {};
  console.log("🔥 BACKEND account_status:", backendStatus);
  console.log("🧪 VIEW ACCOUNT TOTALS:", backendTotals);
  Object.entries(backendTotals).forEach(([k, v]) => {
    console.log(`🧪 ACCOUNT VIEW TOTAL | ${k} | ${v}`);
  });
  const existingDiagnostics = document.getElementById("accountDiagnostics");
  if (existingDiagnostics) existingDiagnostics.remove();

  // ✅ 🔴 CRITICAL: UPDATE GLOBAL STATUS MAP
  Object.assign(accountStatusMap, backendStatus);

  console.log("🧠 STATUS MAP UPDATED:", accountStatusMap);

  if (shouldAutoSyncApple(backendTotals)) {
    logAppleFetchDiagnostics();
    showToast("Apple has zero events in view. Running one sync...", "error");
    setTimeout(() => {
      syncNow();
    }, 0);
  }

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

    const account_key = buildAccountKey({
      source: provider,
      account_email: account
    });

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

      external_ids: ev.external_ids || {},

      title: ev.title || "Untitled",
      start: safeStart,
      end: safeEnd || null,
      color: ev.color || null,
      color_enabled: ev.color_enabled === true,

      extendedProps: {
        backendId,      // ✅ THIS IS THE KEY FIX
        source: provider,
        account,
        account_key,
        external_ids: ev.external_ids || {},
        notes: ev.notes || [],
        description: ev.description || "",
        tags: ev.tags || [],
        eventColor: ev.color || null,
        eventColorEnabled: ev.color_enabled === true || ev.extendedProps?.eventColorEnabled === true,
        stickyNote: (ev.sticky_notes && ev.sticky_notes[0]) || ev.sticky_note || null,
        stickyNotes: ev.sticky_notes || (ev.sticky_note ? [ev.sticky_note] : []),
        createdAt: ev.created_at || null,
        updatedAt: ev.updated_at || null
      }
    };

  }).filter(ev => ev && ev.id);

  // ✅ KEEP THIS
  sessionCacheRange = { start, end };
  window.sessionCacheRange = { start, end };

  isInitialLoadComplete = true;

  // ✅ Sync window reference so calendar.fullcalendar.js events callback and
  //    calendar.ui.js saveEvent both see the live filled array.
  window.sessionEventCache = sessionEventCache;

  //setSyncBanner("success");
  console.log("✅ PRELOAD COMPLETE:", sessionEventCache.length);

  // ✅ FORCE SIDEBAR INITIALIZATION (PERMANENT FIX)
  if (!preserveSelectedDate || !window.selectedDate) {
    window.selectedDate = toDayString(centerDate);
  }

  if (typeof updateDayDetails === "function") {
    console.log("🔥 INIT DAY VIEW");
    updateDayDetails();
  }

  if (typeof updateWeekView === "function") {
    console.log("🔥 INIT WEEK VIEW");
    updateWeekView();
  }

  // ✅ ✅ ✅ CRITICAL — MAKE EVENTS AVAILABLE TO FULLCALENDAR
  window.ALL_EVENTS = sessionEventCache;
  isAppSyncing = false;

  console.log("✅ SYNC MODE OFF");
  syncingAccounts.clear();
  if (!silent) {
    document.body.style.cursor = "default";
  }
  console.log("🧼 CLEARED syncingAccounts:", syncingAccounts);
  renderAccountsSafe();
  // ✅ ADD THIS LINE (CRITICAL — ONLY PLACE IT NEEDS TO RUN)
  updateCustomRangeTooltip();
  renderRangePill();

  console.log(
    "LATEST EVENT DATE:",
    sessionEventCache.reduce((max, ev) => {
      return ev.start > max ? ev.start : max;
    }, new Date(0))
  );

}
window.preloadEventCache = preloadEventCache;

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
  const cal = getCalendar();
  if (!cal) return;

  console.log("ACTIVE FILTERS:", [...activeAccountFilters]);

  /**************************************************************
   * ✅ JUST REFETCH EVENTS (THEY ARE NOW FILTERED AT SOURCE)
   **************************************************************/
  cal.refetchEvents();

  setTimeout(() => {
    updateChipEventCounts();
  }, 0);
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

    return {
      id: acc.id,
      provider,
      email,
      color: acc.color || null,
    };
  });

  // ✅ inject local account if any events exist
  // ✅ ALWAYS INCLUDE LOCAL ACCOUNT (FIX)
  normalizedAccounts.push({
    id: null,
    provider: "local",
    email: "local",
    color: null,
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

  normalizedAccounts.forEach(({ id: accountId, provider, email }) => {

    if (!providerAccountCounts[provider]) {
      providerAccountCounts[provider] = 0;
    }

    if (!email) return;

    if (!providerCounts[provider]) {
      providerCounts[provider] = 0;
    }

    const index = providerCounts[provider]++;

    const key = normalizeKey(provider, email);
    const raw = getColorByKey(key);
    console.log("RENDER CHIP:", accountId ?? "local", key, raw);

    const row = document.createElement("div");
    row.classList.add("chip");
    row.dataset.key = key;
    row.title = `${email} • Click: only this account\nCtrl/Cmd+Click: add/remove account\nDouble-click: show all accounts`;

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
      const baseColor = raw;
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
     * ✅ UNIFORM PICKER MODULE
     * Use same native color input workflow as Event/Sticky modal
     **************************************************************/
    const accountColorInput = document.createElement("input");
    accountColorInput.type = "color";
    accountColorInput.value = raw;
    accountColorInput.className = "account-color-input";
    accountColorInput.style.position = "absolute";
    accountColorInput.style.opacity = "0";
    accountColorInput.style.pointerEvents = "none";

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
      status = accountStatusMap[key] || "unknown";
    }
    console.log("DOT COLOR SOURCE:", key, raw, "status=", status);

    /****************************************************************
     * ✅ APPLY VISUAL STATE TO DOT (CRITICAL FIX)
     ****************************************************************/

    // ALWAYS reset first
    colorDot.classList.remove("syncing-dot");
    colorDot.title = "Click to change account color (uses system color picker)";

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
        startReconnect(provider, email);

        return;
      }

      /**************************************************************
       * ✅ SYNCING STATE → DO NOTHING
       **************************************************************/
      if (status === "syncing") {
        return;
      }

      /**************************************************************
       * ✅ OPEN UNIFORM NATIVE PICKER
       **************************************************************/
      accountColorInput.click();
    });

    accountColorInput.addEventListener("input", () => {
      const picked = accountColorInput.value;

      setAccountColor(key, picked);
      queuePersistAccountColor(accountId, key, picked);

      applyChipStyle(row, key, true);
      updateChipSelectionUI();

      if (window.calendar) {
        window.calendar.refetchEvents();
      }

      updateDayDetails();
      updateWeekView();
    });

    /**************************************************************
     * ✅ ALWAYS APPLY BASE DOT VISUAL (CRITICAL)
     **************************************************************/
    colorDot.style.position = "relative";
    colorDot.style.zIndex = "10";
    colorDot.style.width = "10px";
    colorDot.style.height = "10px";
    colorDot.style.borderRadius = "50%";
    colorDot.style.background = raw;
    colorDot.style.marginLeft = "6px";
    colorDot.style.cursor = "pointer";

    //colorDot.style.border = "1px solid rgba(0,0,0,0.4)";
    /*********************************************************************
     * ✅ SMART BORDER CONTRAST (PRO UX DETAIL) AUTO-ADAPT PICKER BORDER
     *********************************************************************/
    const borderColor =
      getBestTextColor(raw) === "#fff"
        ? "rgba(255,255,255,0.7)"
        : "rgba(0,0,0,0.4)";

    colorDot.style.border = `1px solid ${borderColor}`;


    colorDot.style.outline = `1px solid ${getBestTextColor(raw)}`;

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
    row.appendChild(accountColorInput);

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

      spinner.style.width = "12px";
      spinner.style.height = "12px";
      spinner.style.border = "2px solid rgba(0,0,0,0.15)";
      spinner.style.borderTopColor = raw;
      spinner.style.borderRadius = "50%";
      spinner.style.animation = "chipSpin 0.9s linear infinite";

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

      errorIcon.title = "Reconnect required — click to reconnect";

      errorIcon.onclick = (e) => {
        e.stopPropagation();

        const [provider, email] = key.split(":");
        startReconnect(provider, email);
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

    row.ondblclick = (e) => {

      // ✅ DO NOT trigger when using color picker
      if (e.target.closest(".account-color-input") ||
        e.target.closest(".color-dot")) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      if (chipClickTimer) {
        clearTimeout(chipClickTimer);
        chipClickTimer = null;
      }

      // Suppress any trailing click event that some browsers emit after dblclick.
      suppressChipClickUntil = Date.now() + 350;

      // ✅ Double-click resets to ALL chips on
      const domKeys = new Set(
        [...document.querySelectorAll("#accounts .chip[data-key]")]
          .map((node) => node.dataset.key)
          .filter(Boolean)
      );
      activeAccountFilters = new Set([...allAccountKeys, ...domKeys]);

      updateChipSelectionUI();
      applyClientSideFilters();
      setTimeout(() => {
        updateChipEventCounts();
        window.updateDayDetails?.();
        window.updateWeekView?.();
      }, 0);
    };

    row.onclick = (e) => {

      // ✅ DO NOT trigger when using color picker
      if (e.target.closest(".account-color-input") ||
        e.target.closest(".color-dot")) {
        return;
      }

      if (Date.now() < suppressChipClickUntil) {
        return;
      }

      // Ignore multi-click click events; dblclick handler owns reset-all behavior.
      if (e.detail > 1) {
        if (chipClickTimer) {
          clearTimeout(chipClickTimer);
          chipClickTimer = null;
        }
        return;
      }

      if (chipClickTimer) {
        clearTimeout(chipClickTimer);
      }

      chipClickTimer = setTimeout(() => {
        chipClickTimer = null;

        const isMultiSelect = isChipMultiSelectEvent(e);

        if (!isMultiSelect) {
          // ✅ Single click = exclusive account filter
          activeAccountFilters.clear();
          activeAccountFilters.add(key);
        } else {
          // ✅ Ctrl/Cmd click = additive toggle behavior
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
        setTimeout(() => {
          updateChipEventCounts();
          window.updateDayDetails?.();
          window.updateWeekView?.();
        }, 0);
      }, 220);
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
  if (activeAccountFilters.size === 0) {
    activeAccountFilters = new Set([...allAccountKeys]);
  }

  updateChipSelectionUI();
  setTimeout(() => {
    updateChipEventCounts();
  }, 0);

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

  updateChipEventCounts();
}


//✅ ✅ DAY DETAILS FUNCTION
function updateDayDetails() {

  const listEl = document.getElementById("dayEventsList");
  const titleEl = document.getElementById("selectedDateTitle");

  if (!listEl) return;

  // ✅ FIX: Parse date string in LOCAL time (not UTC).
  // new Date("2026-06-03") treats the string as UTC midnight, which shifts
  // to the previous day in US timezones. Splitting and using the Date
  // constructor with year/month/day avoids the timezone offset entirely.
  const parts = (window.selectedDate || "").split("-").map(Number);
  if (parts.length < 3 || !parts[0]) return;
  const selected = new Date(parts[0], parts[1] - 1, parts[2]);

  const start = new Date(selected);
  start.setHours(0, 0, 0, 0);
  const dateKey = toDayString(selected);

  const end = new Date(start);
  end.setDate(start.getDate() + 1);

  // ✅ Filter events for this day
  const events = dedupeEventsForDisplay((window.sessionEventCache || []).filter(ev => {
    const evStart = new Date(ev.start);
    const evEnd = ev.end ? new Date(ev.end) : evStart;
    if (!(evStart < end && evEnd >= start)) return false;

    const key = getCalendarEventAccountKey(ev);
    if (activeAccountFilters.size && !activeAccountFilters.has(key)) {
      return false;
    }

    return true;
  }));

  // ✅ Sort ascending by start time
  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  console.log("✅ DAY EVENTS:", events.length, "for", window.selectedDate);

  listEl.innerHTML = "";

  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.style.color = "#94a3b8";
    empty.style.fontSize = "11px";
    empty.style.padding = "6px 4px";
    empty.textContent = "No events";
    listEl.appendChild(empty);
    setSelectedDayTitleWithSticky(titleEl, selected, dateKey);
    return;
  }

  events.forEach(ev => {
    const key = getCalendarEventAccountKey(ev);
    const accountRaw = getColorByKey(key);
    const raw = window.resolveEventRenderColor
      ? window.resolveEventRenderColor(ev, accountRaw)
      : accountRaw;
    const soft = applySoftColor(raw);

    // ✅ Format start time compact: "8a", "12:30p", "2p"
    const evStart = new Date(ev.start);
    const hours = evStart.getHours();
    const mins = evStart.getMinutes();
    const ampm = hours >= 12 ? "p" : "a";
    const h12 = hours % 12 || 12;
    const timeStr = mins === 0
      ? `${h12}${ampm}`
      : `${h12}:${String(mins).padStart(2, "0")}${ampm}`;

    // ✅ Row: [time] [title]
    const div = document.createElement("div");
    div.style.display = "flex";
    div.style.alignItems = "center";
    div.style.gap = "5px";
    div.style.padding = "3px 6px 3px 5px";
    div.style.marginBottom = "3px";
    div.style.borderLeft = `4px solid ${raw}`;
    div.style.background = soft;
    div.style.borderRadius = "5px";
    div.style.overflow = "hidden";
    bindSidebarEventRow(div, ev);

    const timeSpan = document.createElement("span");
    timeSpan.textContent = timeStr;
    timeSpan.style.fontSize = "10px";
    timeSpan.style.fontWeight = "700";
    timeSpan.style.color = "#475569";
    timeSpan.style.whiteSpace = "nowrap";
    timeSpan.style.minWidth = "26px";
    timeSpan.style.flexShrink = "0";

    const titleSpan = document.createElement("span");
    titleSpan.textContent = ev.title;
    titleSpan.style.fontSize = "11px";
    titleSpan.style.flex = "1";
    titleSpan.style.minWidth = "0";
    titleSpan.style.overflow = "hidden";
    titleSpan.style.textOverflow = "ellipsis";
    titleSpan.style.whiteSpace = "nowrap";

    div.appendChild(timeSpan);
    div.appendChild(titleSpan);

    const stickyCount = getEventStickyCount(ev);
    if (stickyCount > 0) {
      const stickyBtn = createStickyIconElement({
        count: stickyCount,
        title: stickyCount > 1 ? `Open sticky notes (${stickyCount})` : "Open sticky note",
        onOpen: () => window.openStickyModal?.(ev),
        onDelete: () => window.deleteEventStickyNote?.(ev),
        onEdit: () => window.editEventStickyNote?.(ev),
        dragPayload: {
          scope: "event",
          fcEventId: String(ev?.id || ev?.extendedProps?.backendId || "")
        }
      });
      stickyBtn.style.flexShrink = "0";
      div.appendChild(stickyBtn);
    }

    listEl.appendChild(div);
  });

  setSelectedDayTitleWithSticky(titleEl, selected, dateKey);
}

window.updateDayDetails = updateDayDetails;


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

  const weekEl = document.getElementById("weekView");
  if (!weekEl) return;

  const parts = (window.selectedDate || "").split("-").map(Number);
  if (parts.length < 3 || !parts[0]) return;
  const selected = new Date(parts[0], parts[1] - 1, parts[2]);

  const start = new Date(selected);
  start.setDate(start.getDate() - start.getDay());

  weekEl.innerHTML = "";

  for (let i = 0; i < 7; i++) {

    const day = new Date(start);
    day.setDate(start.getDate() + i);

    const header = document.createElement("div");
    const dayKey = toDayString(day);
    header.style.fontWeight = "600";
    header.style.marginTop = "8px";
    header.style.display = "flex";
    header.style.alignItems = "center";
    header.style.gap = "6px";

    const dateStickyIcon = renderDateStickyHeaderIcon(dayKey, "week");
    if (dateStickyIcon) {
      header.appendChild(dateStickyIcon);
    }

    const headerText = document.createElement("span");
    headerText.textContent = day.toDateString();
    header.appendChild(headerText);

    weekEl.appendChild(header);

    const events = dedupeEventsForDisplay(window.sessionEventCache.filter(ev => {

      const evStart = new Date(ev.start);
      if (evStart.toDateString() !== day.toDateString()) return false;

      const key = getCalendarEventAccountKey(ev);
      if (activeAccountFilters.size && !activeAccountFilters.has(key)) {
        return false;
      }

      return true;
    }));

    events.forEach(ev => {

      const key = getCalendarEventAccountKey(ev);
      const accountRaw = getColorByKey(key);
      const raw = window.resolveEventRenderColor
        ? window.resolveEventRenderColor(ev, accountRaw)
        : accountRaw;
      const soft = applySoftColor(raw)
      const div = document.createElement("div");
      div.style.padding = "4px";
      div.style.marginBottom = "4px";
      div.style.borderLeft = `4px solid ${raw}`;
      div.style.background = soft;
      div.style.borderRadius = "6px";
      div.style.display = "flex";
      div.style.alignItems = "center";
      div.style.gap = "6px";
      bindSidebarEventRow(div, ev);

      const titleSpan = document.createElement("span");
      titleSpan.textContent = ev.title;
      titleSpan.style.flex = "1";
      titleSpan.style.minWidth = "0";
      titleSpan.style.overflow = "hidden";
      titleSpan.style.textOverflow = "ellipsis";
      titleSpan.style.whiteSpace = "nowrap";

      div.appendChild(titleSpan);

      const stickyCount = getEventStickyCount(ev);
      if (stickyCount > 0) {
        const stickyBtn = createStickyIconElement({
          count: stickyCount,
          title: stickyCount > 1 ? `Open sticky notes (${stickyCount})` : "Open sticky note",
          onOpen: () => window.openStickyModal?.(ev),
          onDelete: () => window.deleteEventStickyNote?.(ev),
          onEdit: () => window.editEventStickyNote?.(ev),
          dragPayload: {
            scope: "event",
            fcEventId: String(ev?.id || ev?.extendedProps?.backendId || "")
          }
        });
        stickyBtn.style.flexShrink = "0";
        div.appendChild(stickyBtn);
      }

      weekEl.appendChild(div);
    });
  }
}
window.updateWeekView = updateWeekView;

/**************************************************************
 * ✅ SYNC
 **************************************************************/
async function syncNow() {
  const syncBtn = document.getElementById("syncBtn");

  if (syncBtn) {
    syncBtn.classList.add("is-syncing");
    syncBtn.disabled = true;
    const labelEl = syncBtn.querySelector(".btnLabel");
    if (labelEl) labelEl.textContent = "Syncing…";
  }

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
    const res = await apiFetch(
      `/calendar/sync${isDedupEnabled() ? "" : "?dedup=false"}`,
      { method: "POST" }
    );
    if (!res) return;

    const raw = await res.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (parseErr) {
      console.error("❌ /calendar/sync returned non-JSON payload:", raw?.slice?.(0, 300));
      throw new Error(`Sync endpoint returned invalid response (${res.status})`);
    }

    if (!res.ok || String(data?.status || "").toLowerCase() === "error") {
      const msg = data?.message || `Sync failed (${res.status})`;
      throw new Error(msg);
    }

    const resultPayload = data.result || data || {};

    console.log("✅ Sync result:", data);

    const accountSyncTotals = resultPayload.account_sync_totals || [];
    if (Array.isArray(accountSyncTotals) && accountSyncTotals.length) {
      accountSyncTotals.forEach((r) => {
        console.log(`🧪 ACCOUNT SYNC TOTAL | ${r.provider}:${r.account_email} | raw=${r.raw || 0} | in_range=${r.in_range || 0} | status=${r.status || "ok"}`);
      });
    }

    /**************************************************************
     * ✅ SHOW SUCCESS STATE (still syncing visually)
     **************************************************************/
    renderAccountsSafe();
    showToast("✅ Sync complete");
    //setSyncBanner("success");

    /**************************************************************
     * ✅ STOP SPINNER — sync data is committed, stop here
     * (preloadEventCache + smartRefresh run after this)
     **************************************************************/
    {
      const btn = document.getElementById("syncBtn");
      if (btn) {
        btn.classList.remove("is-syncing");
        btn.disabled = false;
        const labelEl = btn.querySelector(".btnLabel");
        if (labelEl) labelEl.textContent =
          (window.layoutMode === "desktop" || window.layoutMode === "large") ? "Sync Now" : "Sync";
      }
    }

    /**************************************************************
     * ✅ UPDATE STATUS MAP
     **************************************************************/
    if (resultPayload.results) {
      resultPayload.results.forEach(r => {
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

    /**************************************************************
     * ✅ 4. NORMAL REFRESH — silent=true suppresses chip re-spinners
     **************************************************************/
    // Force a paint so the browser commits "no spinner" before heavy work
    await new Promise(resolve => requestAnimationFrame(resolve));
    document.body.style.cursor = "progress"; // subtle indicator while cache reloads
    await preloadEventCache({
      silent: true,
      monthsBack: QUICK_CACHE_MONTHS_BACK,
      monthsForward: QUICK_CACHE_MONTHS_FORWARD,
      preserveSelectedDate: true
    });
    document.body.style.cursor = "default";
    smartRefresh({ reason: "event_saved", force: true });
    scheduleFullCacheExpansion("post_sync_cache_expand");


    setTimeout(() => {
      showToast("✅ Sync complete");
    }, 300);


  } catch (err) {
    console.error("❌ syncNow failed:", err);
    showToast("❌ Sync failed", "error");
    syncingAccounts.clear();

    /**************************************************************
     * ✅ STEP 8.3 — HIDE BANNER ON FAILURE
     **************************************************************/
    //setSyncBanner("hidden");
  } finally {
    // Re-query to avoid stale reference if DOM was modified during sync
    const btn = document.getElementById("syncBtn");
    if (btn) {
      btn.classList.remove("is-syncing");
      btn.disabled = false;
      const labelEl = btn.querySelector(".btnLabel");
      if (labelEl) labelEl.textContent =
        (window.layoutMode === "desktop" || window.layoutMode === "large") ? "Sync Now" : "Sync";
    }
  }
}

window.syncNow = syncNow;

/**************************************************************
 * ✅ PUBLISH NOW — push local canonical events to all provider accounts
 **************************************************************/
async function publishNow(options = {}) {
  const requestedKeys = Array.isArray(options.changeKeys) ? new Set(options.changeKeys.map(String)) : null;
  const pendingChanges = getPendingPublishChanges();
  const selectedChanges = requestedKeys
    ? pendingChanges.filter((change) => requestedKeys.has(String(change.key)))
    : pendingChanges;

  const modifiedIds = selectedChanges.length
    ? [...new Set(selectedChanges.map((change) => change.eventId).filter((id) => id != null).map(Number))]
    : [...(window.sessionModifiedEventIds || new Set())];
  const deletedEvents = selectedChanges.length
    ? selectedChanges.map((change) => change.deletedEvent).filter(Boolean)
    : [...(window.sessionDeletedProviderEvents || [])];
  const localOnlyChanges = selectedChanges.filter((change) => change.localOnly);

  if (modifiedIds.length === 0 && deletedEvents.length === 0 && localOnlyChanges.length === 0) {
    showToast("ℹ️ No local changes to publish — edit events first", "info");
    updatePublishButtonState();
    return;
  }

  if (modifiedIds.length === 0 && deletedEvents.length === 0 && localOnlyChanges.length > 0) {
    if (selectedChanges.length) {
      removePendingPublishChanges(selectedChanges.map((change) => change.key));
    } else {
      clearPendingPublishChanges();
    }
    showToast(`✅ Cleared ${localOnlyChanges.length} local calendar change${localOnlyChanges.length === 1 ? "" : "s"}`);
    return;
  }

  const publishBtn = document.getElementById("publishBtn");

  if (publishBtn) {
    publishBtn.classList.add("is-publishing");
    publishBtn.disabled = true;
    const labelEl = publishBtn.querySelector(".btnLabel");
    if (labelEl) labelEl.textContent = "Publishing…";
  }

  try {
    const res = await apiFetch("/calendar/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_ids: modifiedIds, deleted_events: deletedEvents }),
    });
    if (!res) return;

    const raw = await res.text();
    let data = {};
    try { data = raw ? JSON.parse(raw) : {}; } catch {
      throw new Error(`Publish endpoint returned invalid response (${res.status})`);
    }

    if (!res.ok || String(data?.status || "").toLowerCase() === "error") {
      throw new Error(data?.message || `Publish failed (${res.status})`);
    }

    const published = data.published ?? 0;
    const deleted = data.deleted ?? 0;
    const failed = data.failed ?? 0;
    const warnings = data.warnings || [];
    const accounts = (data.affected_accounts || []);
    const rangeStart = data.range_start;
    const rangeEnd = data.range_end;

    // Build a concise human-readable summary
    const accountSummary = accounts.length
      ? accounts.map(k => k.split(":")[1] || k).join(", ")
      : "no accounts";
    const rangeSummary = (rangeStart && rangeEnd && rangeStart !== rangeEnd)
      ? ` (${rangeStart} – ${rangeEnd})`
      : rangeStart ? ` (${rangeStart})` : "";

    if (failed > 0) {
      const warningText = warnings.length ? `: ${warnings[0]}` : "";
      showToast(`⚠️ Published ${published} / ${published + failed} events — ${failed} failed${warningText}`, "error");
    } else if (published === 0 && deleted === 0 && localOnlyChanges.length === 0) {
      showToast("ℹ️ Nothing published — events may not be linked to provider accounts yet", "info");
    } else {
      showToast(`✅ Published ${published} updates, ${deleted} deletes → ${accountSummary}${rangeSummary}`);
      if (selectedChanges.length) {
        removePendingPublishChanges(selectedChanges.map((change) => change.key));
      } else {
        clearPendingPublishChanges();
      }
    }

  } catch (err) {
    console.error("❌ publishNow failed:", err);
    showToast("❌ Publish failed", "error");
  } finally {
    const btn = document.getElementById("publishBtn");
    if (btn) {
      btn.classList.remove("is-publishing");
      btn.disabled = false;
      const labelEl = btn.querySelector(".btnLabel");
      if (labelEl) labelEl.textContent = "Publish";
    }
    updatePublishButtonState();
  }
}

window.publishNow = publishNow;

function closePublishReviewMenu() {
  document.getElementById("publishReviewMenu")?.remove();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function openPublishReviewMenu(x, y) {
  closePublishReviewMenu();
  const changes = getPendingPublishChanges();
  if (!changes.length) {
    showToast("No pending publish changes", "info");
    updatePublishButtonState();
    return;
  }

  const menu = document.createElement("div");
  menu.id = "publishReviewMenu";
  menu.className = "publishReviewMenu";

  const rowsHtml = changes.map((change) => `
    <label class="publishReviewItem">
      <input type="checkbox" data-publish-change-key="${escapeHtml(change.key)}" checked />
      <span class="publishReviewText"><strong>${escapeHtml(change.category)}:</strong> ${escapeHtml(change.summary)}</span>
    </label>
  `).join("");

  menu.innerHTML = `
    <div class="publishReviewTitle">Pending Publish Changes</div>
    <div class="publishReviewList">${rowsHtml}</div>
    <div class="publishReviewActions">
      <button type="button" data-publish-review-cancel>Cancel</button>
      <button type="button" data-publish-review-accept>Accept</button>
    </div>
  `;

  document.body.appendChild(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - rect.width - 12))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - rect.height - 12))}px`;

  const acceptBtn = menu.querySelector("[data-publish-review-accept]");
  const syncAcceptState = () => {
    const selected = menu.querySelectorAll("input[data-publish-change-key]:checked").length;
    acceptBtn.disabled = selected === 0;
  };
  menu.addEventListener("change", syncAcceptState);
  syncAcceptState();

  menu.querySelector("[data-publish-review-cancel]")?.addEventListener("click", closePublishReviewMenu);
  acceptBtn?.addEventListener("click", async () => {
    const selectedKeys = [...menu.querySelectorAll("input[data-publish-change-key]:checked")]
      .map((input) => input.dataset.publishChangeKey)
      .filter(Boolean);
    closePublishReviewMenu();
    await publishNow({ changeKeys: selectedKeys });
  });

  setTimeout(() => {
    document.addEventListener("click", closePublishReviewMenu, { once: true });
  }, 0);
}

window.openPublishReviewMenu = openPublishReviewMenu;

function openPublishReviewMenuForButton() {
  const btn = document.getElementById("publishBtn");
  if (!btn) {
    openPublishReviewMenu(window.innerWidth / 2, window.innerHeight / 2);
    return;
  }

  const rect = btn.getBoundingClientRect();
  openPublishReviewMenu(rect.left, rect.bottom + 8);
}

window.openPublishReviewMenuForButton = openPublishReviewMenuForButton;

/**************************************************************
 * ✅ LOGOUT
 **************************************************************/
function logout() {
  localStorage.removeItem("token");
  window.location.href = "/login";
}
window.logout = logout;

async function deleteEvent() {

  // ✅ Use window.editingEventId so we pick up the value set by
  //    openCreateModal (which lives in calendar.ui.js module scope)
  const targetId = window.editingEventId || editingEventId;

  if (!targetId) {
    console.warn("No event selected for deletion");
    return;
  }

  const confirmDelete = confirm("Delete this event?");
  if (!confirmDelete) return;

  console.log("SAVE EVENT TRIGGERED (delete)", targetId);

  const eventToDelete = (window.sessionEventCache || []).find((ev) => {
    return String(ev?.extendedProps?.backendId) === String(targetId) || String(ev?.id) === String(targetId);
  });
  window.trackDeletedProviderEvent?.(eventToDelete);

  const res = await apiFetch(`/calendar/event/${targetId}`, {
    method: "DELETE"
  });

  if (!res || !res.ok) {
    console.error("❌ Delete request failed", res?.status);
    showToast("❌ Delete failed", "error");
    return;
  }

  console.log("✅ Event deleted", targetId);

  // Remove from cache immediately
  sessionEventCache = sessionEventCache.filter(
    e => e.extendedProps?.backendId !== targetId && String(e.id) !== String(targetId)
  );
  window.sessionEventCache = sessionEventCache;

  window.deletedEventIds = window.deletedEventIds || new Set();
  window.deletedEventIds.add(targetId);

  // Close the edit modal
  if (typeof closeCreateModal === "function") closeCreateModal();

  showToast("🗑 Event deleted");
  smartRefresh({ reason: "event_deleted", force: true });
}

window.deleteEvent = deleteEvent;


/**************************************************************
 * ✅ NOTES
 **************************************************************/
function editNote(eventId, noteId = null) {
  editingEventId = eventId;
  window.editingEventId = eventId;   // keep window in sync
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

/**************************************************************
 * ✅ KEYBOARD SHORTCUTS
 **************************************************************/
document.addEventListener("keydown", (e) => {

  const target = e.target;
  const isTypingTarget =
    target instanceof HTMLElement &&
    (
      target.matches("input, textarea, select") ||
      target.isContentEditable ||
      !!target.closest("[contenteditable='true']")
    );

  // Do not trigger app-wide shortcuts while typing/editing text.
  if (isTypingTarget || e.ctrlKey || e.metaKey || e.altKey) {
    return;
  }

  // ✅ ESC = CLOSE MODAL
  if (e.key === "Escape") {
    closeCreateModal();
  }

  // ✅ N = CREATE NEW EVENT
  if (e.key.toLowerCase() === "n" && !window.isModalOpen) {
    openCreateModal();
  }

});

// ─── TV Mode Bridge (strictly additive) ───────────────────────────────────────
// Watches window.selectedDate and pushes changes to /tv/state so the TV
// dashboard always reflects the date the web user is viewing.
// Fire-and-forget: silently swallows all errors — zero impact on web UI.
; (function _tvStateBridge() {
  let _lastPushed = null;

  setInterval(async () => {
    const date = window.selectedDate;
    const token = localStorage.getItem('token');
    if (!date || !token || date === _lastPushed) return;
    _lastPushed = date;
    try {
      await fetch('/tv/state', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ selectedDate: date }),
      });
    } catch (_) { /* intentionally silent */ }
  }, 2000);
})();
