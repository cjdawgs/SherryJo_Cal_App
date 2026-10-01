/**
 * tv_mode.js
 * ----------
 * Admin UI handler for "Enable TV Mode" pairing flow.
 *
 * Responsibilities:
 *  - Open the TV Mode pairing dialog
 *  - Call POST /tv/generate-code (requires existing session JWT)
 *  - Display the pairing code + countdown timer
 *  - Allow regenerating the code
 *
 * Design rules:
 *  - Strictly additive — zero changes to admin.js or calendar.js
 *  - No state duplication — selectedDate is owned by the backend
 *  - No today() fallback — backend drives all date state
 */

import { apiRequest } from "/static/api.js";

// ─────────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────────

const tvDialog = document.getElementById("tvModeDialog");
const tvCodeDisplay = document.getElementById("tvPairingCodeDisplay");
const tvExpiryDisplay = document.getElementById("tvPairingExpiry");
const tvStatus = document.getElementById("tvPairingStatus");
const enableBtn = document.getElementById("enableTVModeBtn");
const closeBtn = document.getElementById("closeTVDialog");
const regenerateBtn = document.getElementById("regenerateTVCode");

// ─────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────

let _countdownTimer = null;

// ─────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────

function clearCountdown() {
  if (_countdownTimer !== null) {
    clearInterval(_countdownTimer);
    _countdownTimer = null;
  }
}

function startCountdown(expiresInSeconds) {
  clearCountdown();

  let remaining = expiresInSeconds;

  function tick() {
    if (remaining <= 0) {
      clearCountdown();
      tvExpiryDisplay.textContent = "Code expired. Generate a new one.";
      tvCodeDisplay.style.opacity = "0.35";
      return;
    }
    const mins = Math.floor(remaining / 60).toString().padStart(2, "0");
    const secs = (remaining % 60).toString().padStart(2, "0");
    tvExpiryDisplay.textContent = `Expires in ${mins}:${secs}`;
    remaining -= 1;
  }

  tick();
  _countdownTimer = setInterval(tick, 1000);
}

function setTVStatus(message, isError = false) {
  if (!tvStatus) return;
  tvStatus.textContent = message || "";
  tvStatus.classList.toggle("error", Boolean(isError));
}

// ─────────────────────────────────────────────────
// CORE: GENERATE CODE
// ─────────────────────────────────────────────────

async function generateCode() {
  setTVStatus("Generating pairing code…");
  tvCodeDisplay.textContent = "—";
  tvCodeDisplay.style.opacity = "1";
  tvExpiryDisplay.textContent = "";
  clearCountdown();
  regenerateBtn.disabled = true;

  try {
    const response = await apiRequest("/tv/generate-code", {
      method: "POST",
    });

    if (!response) {
      setTVStatus("Failed to generate code. Try again.", true);
      return;
    }

    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = (data && (data.detail || data.message)) || `HTTP ${response.status}`;
      setTVStatus(`Failed to generate code: ${detail}`, true);
      return;
    }

    if (!data || !data.pairingCode) {
      setTVStatus("Failed to generate code. Try again.", true);
      return;
    }

    tvCodeDisplay.textContent = data.pairingCode;
    tvCodeDisplay.style.opacity = "1";
    setTVStatus("");
    startCountdown(data.expiresIn ?? 600);
  } catch (err) {
    setTVStatus(`Error: ${err.message || "Unknown error"}`, true);
  } finally {
    regenerateBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────
// EVENT WIRING
// ─────────────────────────────────────────────────

if (enableBtn) {
  enableBtn.addEventListener("click", () => {
    if (!tvDialog) return;
    tvDialog.showModal();
    generateCode();
  });
}

if (closeBtn) {
  closeBtn.addEventListener("click", () => {
    clearCountdown();
    tvDialog?.close();
  });
}

if (regenerateBtn) {
  regenerateBtn.addEventListener("click", generateCode);
}

// Clean up timer if dialog is closed by ESC key or native close
if (tvDialog) {
  tvDialog.addEventListener("close", () => {
    clearCountdown();
  });
}

// ─────────────────────────────────────────────────
// KIOSK URL FLOW
// ─────────────────────────────────────────────────

const kioskDialog = document.getElementById("kioskUrlDialog");
const kioskUrlDisplay = document.getElementById("kioskUrlDisplay");
const kioskUrlStatus = document.getElementById("kioskUrlStatus");
const generateKioskBtn = document.getElementById("generateKioskUrlBtn");
const closeKioskBtn = document.getElementById("closeKioskDialog");
const copyKioskBtn = document.getElementById("copyKioskUrlBtn");
const regenKioskBtn = document.getElementById("regenerateKioskBtn");

function setKioskStatus(msg, isError = false) {
  if (!kioskUrlStatus) return;
  kioskUrlStatus.textContent = msg || "";
  kioskUrlStatus.style.color = isError ? "#ff453a" : "#34c759";
}

async function generateKioskUrl() {
  if (!kioskUrlDisplay) return;
  kioskUrlDisplay.value = "Generating…";
  setKioskStatus("");
  if (regenKioskBtn) regenKioskBtn.disabled = true;

  try {
    const data = await apiRequest("/tv/generate-kiosk-token", { method: "POST" });
    if (!data || !data.kiosk_url) throw new Error("No URL returned");
    kioskUrlDisplay.value = data.kiosk_url;
    setKioskStatus("✓ URL ready — paste into Kitcast as a single Web Page slide.");
  } catch (err) {
    kioskUrlDisplay.value = "";
    setKioskStatus(`Error: ${err.message || "Unknown error"}`, true);
  } finally {
    if (regenKioskBtn) regenKioskBtn.disabled = false;
  }
}

if (generateKioskBtn) {
  generateKioskBtn.addEventListener("click", () => {
    kioskDialog?.showModal();
    generateKioskUrl();
  });
}

if (closeKioskBtn) {
  closeKioskBtn.addEventListener("click", () => kioskDialog?.close());
}

if (copyKioskBtn) {
  copyKioskBtn.addEventListener("click", async () => {
    const url = kioskUrlDisplay?.value;
    if (!url || url === "Generating…") return;
    try {
      await navigator.clipboard.writeText(url);
      setKioskStatus("✓ Copied to clipboard!");
    } catch {
      setKioskStatus("Select the URL above and copy manually.", true);
    }
  });
}

if (regenKioskBtn) {
  regenKioskBtn.addEventListener("click", generateKioskUrl);
}

// ─────────────────────────────────────────────────
// SLEEP GUARD CONTROLS
// ─────────────────────────────────────────────────

const sleepToggleBtn = document.getElementById("tvSleepToggleBtn");
const sleepTimeoutSel = document.getElementById("tvSleepTimeout");
const sleepAdminStatus = document.getElementById("tvSleepAdminStatus");

let _sleepGuardEnabled = true;
let _sleepGuardTimeoutMinutes = 0;
const ENFORCE_NEVER_TIMEOUT_POLICY = true;

function applySleepGuardUI(enabled, timeoutMinutes) {
  _sleepGuardEnabled = enabled;
  _sleepGuardTimeoutMinutes = ENFORCE_NEVER_TIMEOUT_POLICY ? 0 : timeoutMinutes;
  if (sleepToggleBtn) {
    sleepToggleBtn.textContent = enabled ? "Disable" : "Enable";
    sleepToggleBtn.style.opacity = enabled ? "1" : "0.6";
  }
  if (sleepTimeoutSel) {
    sleepTimeoutSel.value = "0";
    sleepTimeoutSel.disabled = true;
    sleepTimeoutSel.title = "Finite TV sleep timeouts are disabled by policy.";
  }
  if (sleepAdminStatus) {
    if (!enabled) {
      sleepAdminStatus.textContent = "Off";
    } else if (_sleepGuardTimeoutMinutes === 0) {
      sleepAdminStatus.textContent = "Active — never times out";
    } else {
      sleepAdminStatus.textContent = `Active — stops after ${_sleepGuardTimeoutMinutes} min`;
    }
  }
}

async function patchSleepGuard(enabled, timeoutMinutes) {
  const normalizedTimeout = ENFORCE_NEVER_TIMEOUT_POLICY ? 0 : Number(timeoutMinutes || 0);
  try {
    await apiRequest("/tv/state", {
      method: "PATCH",
      body: { sleepGuardEnabled: enabled, sleepGuardTimeoutMinutes: normalizedTimeout },
    });
    applySleepGuardUI(enabled, normalizedTimeout);
  } catch (err) {
    if (sleepAdminStatus) sleepAdminStatus.textContent = `Error: ${err.message || "update failed"}`;
  }
}

async function loadSleepGuardState() {
  try {
    const data = await apiRequest("/tv/state", { method: "GET" });
    if (data) {
      applySleepGuardUI(
        data.sleepGuardEnabled !== undefined ? data.sleepGuardEnabled : true,
        data.sleepGuardTimeoutMinutes || 0,
      );
    }
  } catch {
    // Non-fatal — leave controls at defaults
  }
}

if (sleepToggleBtn) {
  sleepToggleBtn.addEventListener("click", () => {
    patchSleepGuard(!_sleepGuardEnabled, _sleepGuardTimeoutMinutes);
  });
}

if (sleepTimeoutSel) {
  sleepTimeoutSel.addEventListener("change", () => {
    patchSleepGuard(_sleepGuardEnabled, 0);
  });
}

// Load current sleep guard state when the admin page loads
loadSleepGuardState();

// ─────────────────────────────────────────────────
// TV DIAGNOSTICS PANEL
// ─────────────────────────────────────────────────

const diagLoadBtn = document.getElementById("tvDiagLoadBtn");
const diagClearBtn = document.getElementById("tvDiagClearBtn");
const diagAutoRefresh = document.getElementById("tvDiagAutoRefresh");
const diagBody = document.getElementById("tvDiagBody");
const diagCount = document.getElementById("tvDiagCount");
const tvHealthLoadBtn = document.getElementById("tvHealthLoadBtn");
const tvHealthClearBtn = document.getElementById("tvHealthClearBtn");
const tvHealthCount = document.getElementById("tvHealthCount");
const tvHealthBody = document.getElementById("tvHealthBody");
const tvHealthPanel = document.querySelector(".tv-health-panel");
const tvHealthSort = document.getElementById("tvHealthSort");
const publishDiagLoadBtn = document.getElementById("publishDiagLoadBtn");
const publishDiagClearBtn = document.getElementById("publishDiagClearBtn");
const publishDiagBody = document.getElementById("publishDiagBody");
const publishDiagCount = document.getElementById("publishDiagCount");
const publishDiagWindow = document.getElementById("publishDiagWindow");
const staleDiagLoadBtn = document.getElementById("tvStaleDiagLoadBtn");
const staleDiagClearBtn = document.getElementById("tvStaleDiagClearBtn");
const staleDiagBody = document.getElementById("tvStaleDiagBody");
const staleDiagCount = document.getElementById("tvStaleDiagCount");
const staleDiagSummary = document.getElementById("tvStaleDiagSummary");
const staleDiagPanel = document.querySelector(".tv-stale-panel");
const repairDiagLoadBtn = document.getElementById("tvRepairDiagLoadBtn");
const repairDiagClearBtn = document.getElementById("tvRepairDiagClearBtn");
const repairDiagBody = document.getElementById("tvRepairDiagBody");
const repairDiagCount = document.getElementById("tvRepairDiagCount");
const repairDiagSummary = document.getElementById("tvRepairDiagSummary");
const repairDiagWindow = document.getElementById("tvRepairDiagWindow");
const repairDiagPanel = document.querySelector(".tv-repair-panel");
const tvLiveStatusLoadBtn = document.getElementById("tvLiveStatusLoadBtn");
const tvLiveStatusClearBtn = document.getElementById("tvLiveStatusClearBtn");
const tvLiveStatusCount = document.getElementById("tvLiveStatusCount");
const tvLiveStatusSelect = document.getElementById("tvLiveStatusSelect");
const tvLiveStatusCard = document.getElementById("tvLiveStatusCard");
const tvLiveStatusPanel = document.getElementById("tvLiveStatusPanel");
let _diagAutoHandle = null;
let _stalePanelLoaded = false;
let _repairPanelLoaded = false;
let _healthPanelLoaded = false;
let _liveStatusPanelLoaded = false;
// device_id -> array of diagnostic rows (most-recent first), cached after the
// last Load/Refresh click so switching the device dropdown never re-fetches.
let _liveStatusRowsByDevice = new Map();
let _liveStatusEmailByUser = new Map();
const LIVE_STATUS_PRESENCE_STALE_MINUTES = 35;
const LIVE_STATUS_LEGACY_HEARTBEAT_MINUTES = 75;
const _tvHealthFailureEvents = new Set([
  "tv_fetch_timeout",
  "tv_fetch_network_error",
  "token_invalid_401",
  "kiosk_token_invalid_401",
]);

function _fmtDiagTime(isoStr) {
  if (!isoStr) return "—";
  try {
    return new Date(isoStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return isoStr; }
}

function _escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function _eventTag(eventName) {
  const value = String(eventName || "");
  if (!value) return "event";
  return value
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
}

function _toTsMs(value) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function _latestTvCheckIn(rows) {
  return rows
    .filter((row) => ["device_presence", "heartbeat"].includes(String(row?.event || "")))
    .sort((a, b) => (_toTsMs(b.ts_server) || 0) - (_toTsMs(a.ts_server) || 0))[0] || null;
}

function _fmtMinutesSince(ms) {
  if (!Number.isFinite(ms)) return "—";
  const mins = Math.max(0, Math.floor((Date.now() - ms) / 60000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function _deriveHiddenStatus(rows) {
  if (!Array.isArray(rows) || !rows.length) {
    return { label: "No visibility data", warn: false, hiddenDurationMinutes: null, isHidden: false };
  }

  let latestVisibility = "";
  for (const row of rows) {
    const vis = String(row?.visibility || "").trim().toLowerCase();
    if (vis) {
      latestVisibility = vis;
      break;
    }
  }

  if (!latestVisibility) {
    return { label: "No visibility data", warn: false, hiddenDurationMinutes: null, isHidden: false };
  }

  if (latestVisibility !== "hidden") {
    return { label: `Visible (${latestVisibility})`, warn: false, hiddenDurationMinutes: 0, isHidden: false };
  }

  let hiddenStartMs = _toTsMs(rows[0]?.ts_server);
  for (const row of rows) {
    const vis = String(row?.visibility || "").trim().toLowerCase();
    const tsMs = _toTsMs(row?.ts_server);
    if (!Number.isFinite(tsMs)) continue;
    if (vis && vis !== "hidden") break;
    hiddenStartMs = tsMs;
  }

  const hiddenFor = _fmtMinutesSince(hiddenStartMs);
  const hiddenDurationMinutes = Number.isFinite(hiddenStartMs)
    ? Math.max(0, Math.floor((Date.now() - hiddenStartMs) / 60000))
    : null;
  const warn = (() => {
    if (!Number.isFinite(hiddenStartMs)) return false;
    return (Date.now() - hiddenStartMs) >= (10 * 60 * 1000);
  })();

  return {
    label: warn ? `Warning: hidden ${hiddenFor}` : `Hidden ${hiddenFor}`,
    warn,
    hiddenDurationMinutes,
    isHidden: true,
  };
}

function _buildHealthBadge(row) {
  if (row.hasAuthFailure) {
    return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#5f1111;color:#ffd9d9;border:1px solid #a23737;font-size:10px;font-weight:700;letter-spacing:0.2px;">RED · auth error</span>';
  }
  if (row.isStale) {
    return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#5f3e11;color:#ffe6bf;border:1px solid #b67a1f;font-size:10px;font-weight:700;letter-spacing:0.2px;">YELLOW · status unknown</span>';
  }
  if (row.failureAfterCheckIn || row.hidden.warn) {
    return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#5f3e11;color:#ffe6bf;border:1px solid #b67a1f;font-size:10px;font-weight:700;letter-spacing:0.2px;">YELLOW · check required</span>';
  }
  return '<span style="display:inline-block;padding:2px 8px;border-radius:999px;background:#124a2b;color:#d5ffe8;border:1px solid #2f8f5a;font-size:10px;font-weight:700;letter-spacing:0.2px;">GREEN · healthy</span>';
}

function _connectionDiagnosis(rows) {
  const timeoutCount = rows.filter((row) => String(row?.event || "") === "tv_fetch_timeout").length;
  const latestSession = rows.find((row) => String(row?.event || "") === "session_start");
  const hasAbortFix = /\bfetch-timeout=abort\b/.test(String(latestSession?.details || ""));
  let restartDiagnosis = "";
  if (latestSession) {
    const sessionIndex = rows.indexOf(latestSession);
    const previousHeartbeat = _latestTvCheckIn(rows.slice(sessionIndex + 1));
    const sessionMs = _toTsMs(latestSession.ts_server);
    const heartbeatMs = _toTsMs(previousHeartbeat?.ts_server);
    if (Number.isFinite(sessionMs) && Number.isFinite(heartbeatMs) && sessionMs - heartbeatMs >= 75 * 60 * 1000) {
      const gapMinutes = Math.floor((sessionMs - heartbeatMs) / 60000);
      restartDiagnosis = `Session restarted after ${Math.floor(gapMinutes / 60)}h ${gapMinutes % 60}m without a heartbeat. Check Fire OS sleep/screensaver, HDMI-CEC, and page lifecycle events.`;
    }
  }

  if (timeoutCount && hasAbortFix) {
    const timeoutDiagnosis = `${timeoutCount} fetch timeout(s); this session aborts timed-out requests. Repeated timeouts point to network/origin latency, not leaked fetches.`;
    return [timeoutDiagnosis, restartDiagnosis].filter(Boolean).join(" ");
  }
  if (timeoutCount) {
    const timeoutDiagnosis = `${timeoutCount} fetch timeout(s); abort protection is not confirmed. Older clients left timed-out fetches running, which could exhaust Silk connections. Reload the TV dashboard to load the AbortController fix.`;
    return [timeoutDiagnosis, restartDiagnosis].filter(Boolean).join(" ");
  }
  if (restartDiagnosis) return restartDiagnosis;
  if (latestSession && !hasAbortFix) return "Client abort-fix marker not seen yet; refresh TV dashboard and check this snapshot again.";
  return "No connection-drop signature in the available diagnostics.";
}

function _sortHealthRows(rows) {
  const mode = String(tvHealthSort?.value || "severity");
  if (mode === "recent-heartbeat") {
    rows.sort((a, b) => b.lastHeartbeatMs - a.lastHeartbeatMs || b.lastSeenMs - a.lastSeenMs);
    return;
  }
  if (mode === "hidden-duration") {
    rows.sort((a, b) => b.hiddenDurationMinutes - a.hiddenDurationMinutes || b.lastSeenMs - a.lastSeenMs);
    return;
  }
  if (mode === "recent-failure") {
    rows.sort((a, b) => b.lastFailureMs - a.lastFailureMs || b.lastSeenMs - a.lastSeenMs);
    return;
  }
  rows.sort((a, b) => b.severityRank - a.severityRank || b.lastSeenMs - a.lastSeenMs);
}

async function loadTvDiag() {
  if (!diagBody) return;
  try {
    const data = await apiRequest("/tv/diag", { method: "GET" });
    if (!data || !data.entries) {
      if (diagCount) diagCount.textContent = "error loading";
      return;
    }
    const entries = data.entries;
    if (diagCount) diagCount.textContent = `${entries.length} entries (most-recent first)`;
    if (entries.length === 0) {
      diagBody.innerHTML = '<tr><td colspan="7" style="opacity:0.4;">No events captured yet.</td></tr>';
      return;
    }
    diagBody.innerHTML = entries.map(e => {
      // Show last 8 chars of device_id so rows from the same device group visually.
      // Full UA is in the title tooltip for hover inspection.
      const shortId = e.device_id ? e.device_id.slice(-8) : '—';
      const ua = e.device_ua || '';
      const deviceLabel = `<span title="${ua.replace(/"/g, '&quot;')}" style="font-family:monospace;cursor:default;">…${shortId}</span>`;
      return `
      <tr>
        <td>${_fmtDiagTime(e.ts_server)}</td>
        <td>${deviceLabel}</td>
        <td>${e.elapsed_min != null ? e.elapsed_min + 'm' : '—'}</td>
        <td style="font-weight:700;color:${e.event.includes('freeze') || e.event.includes('hide') || e.event.includes('unload') ? '#ff9500' : e.event.includes('gap') ? '#ff453a' : '#e0e0f0'}">${e.event}</td>
        <td style="opacity:0.8;">${e.details || '—'}</td>
        <td>${e.visibility || '—'}</td>
        <td>${e.guard_enabled === true ? '✓' : e.guard_enabled === false ? '✗' : '—'}</td>
      </tr>`;
    }).join('');
  } catch (err) {
    if (diagCount) diagCount.textContent = `Error: ${err.message}`;
  }
}

async function loadTvHealth() {
  if (!tvHealthBody) return;
  try {
    const params = new URLSearchParams({ scope: "all", hours: "168" });
    const data = await apiRequest(`/tv/diag?${params.toString()}`, { method: "GET" });
    if (!data || !Array.isArray(data.entries)) {
      if (tvHealthCount) tvHealthCount.textContent = "error loading";
      return;
    }

    const entries = data.entries;
    const byDevice = new Map();
    for (const entry of entries) {
      const deviceId = String(entry?.device_id || "unknown");
      if (!byDevice.has(deviceId)) byDevice.set(deviceId, []);
      byDevice.get(deviceId).push(entry);
    }

    const rows = [];
    for (const [deviceId, deviceRows] of byDevice.entries()) {
      const lastHeartbeat = deviceRows.find((row) => String(row?.event || "") === "heartbeat");
      const lastCheckIn = _latestTvCheckIn(deviceRows);
      const lastFailure = deviceRows.find((row) => _tvHealthFailureEvents.has(String(row?.event || "")));
      const hidden = _deriveHiddenStatus(deviceRows);
      const connectionDiagnosis = _connectionDiagnosis(deviceRows);
      const lastSeenMs = _toTsMs(deviceRows[0]?.ts_server) || 0;

      const lastHeartbeatMs = _toTsMs(lastCheckIn?.ts_server) || 0;
      const lastFailureMs = _toTsMs(lastFailure?.ts_server) || 0;
      const checkInAgeMinutes = lastHeartbeatMs ? Math.floor((Date.now() - lastHeartbeatMs) / 60000) : null;
      const checkInLimit = lastCheckIn?.event === "device_presence"
        ? LIVE_STATUS_PRESENCE_STALE_MINUTES
        : LIVE_STATUS_LEGACY_HEARTBEAT_MINUTES;
      const isStale = checkInAgeMinutes === null || checkInAgeMinutes >= checkInLimit;
      const failureAfterCheckIn = Boolean(lastFailure && lastFailureMs > lastHeartbeatMs && Date.now() - lastFailureMs < LIVE_STATUS_PRESENCE_STALE_MINUTES * 60000);
      const hasAuthFailure = Boolean(failureAfterCheckIn && ["token_invalid_401", "kiosk_token_invalid_401"].includes(String(lastFailure?.event || "")));
      const hiddenDurationMinutes = Number.isFinite(hidden.hiddenDurationMinutes) ? hidden.hiddenDurationMinutes : -1;
      const severityRank = hasAuthFailure ? 3 : isStale || failureAfterCheckIn || hidden.warn ? 2 : 1;

      rows.push({
        deviceId,
        shortId: deviceId === "unknown" ? "unknown" : `…${deviceId.slice(-8)}`,
        lastSeenMs,
        lastHeartbeat: lastCheckIn,
        lastHeartbeatMs,
        isStale,
        hasAuthFailure,
        failureAfterCheckIn,
        hidden,
        connectionDiagnosis,
        hiddenDurationMinutes,
        lastFailure,
        lastFailureMs,
        severityRank,
      });
    }

    _sortHealthRows(rows);

    const hiddenWarnings = rows.filter((row) => row.hidden.warn).length;
    if (tvHealthCount) {
      tvHealthCount.textContent = `${rows.length} device(s) · ${hiddenWarnings} hidden warning(s)`;
    }

    if (!rows.length) {
      tvHealthBody.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">No devices found in the last 7 days.</td></tr>';
      return;
    }

    tvHealthBody.innerHTML = rows.map((row) => {
      const hb = row.lastHeartbeat
        ? `${_fmtDiagTime(row.lastHeartbeat.ts_server)} (${_escapeHtml(String(row.lastHeartbeat.elapsed_min ?? "—"))}m)`
        : "No check-in in window";
      const hiddenStyle = row.hidden.warn ? "color:#ff9500;font-weight:700;" : "";
      const failure = row.lastFailure
        ? `${_fmtDiagTime(row.lastFailure.ts_server)} · ${_escapeHtml(_eventTag(row.lastFailure.event))}`
        : "None in window";
      return `
      <tr>
        <td><span style="font-family:monospace;">${_escapeHtml(row.shortId)}</span></td>
        <td>${_buildHealthBadge(row)}</td>
        <td>${_escapeHtml(hb)}</td>
        <td style="${hiddenStyle}">${_escapeHtml(row.hidden.label)}</td>
        <td>${failure}</td>
        <td>${_escapeHtml(row.connectionDiagnosis)}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    if (tvHealthCount) tvHealthCount.textContent = `Error: ${err.message}`;
  }
}

// ─────────────────────────────────────────────────
// TV LIVE STATUS & UPTIME  (green/yellow/red current-state monitor)
// ─────────────────────────────────────────────────

// Best-effort device identification from the captured User-Agent string.
// This is display-only labeling, not a security control.
function _deviceIdentityLabel(ua) {
  const value = String(ua || "");
  if (/silk/i.test(value)) return "Amazon Fire TV (Silk browser)";
  if (/apple\s*tv|tvos/i.test(value)) return "Apple TV";
  if (/android/i.test(value)) return "Android device";
  if (/crkey|chromecast/i.test(value)) return "Chromecast";
  return value ? "Unknown device" : "Unknown device (no User-Agent captured)";
}

function _fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMinutes = Math.floor(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || !parts.length) parts.push(`${minutes}m`);
  return parts.join(" ");
}

// Derives the current green/yellow/red state for one device from its
// diagnostic rows (most-recent first). This mirrors the FireTV Health
// Snapshot severity logic above, but reports "right now" status plus
// continuous uptime instead of a historical table.
function _computeLiveStatus(rows) {
  const nowMs = Date.now();
  const lastCheckIn = _latestTvCheckIn(rows);
  const lastHeartbeat = rows.find((row) => String(row?.event || "") === "heartbeat");
  const lastFailure = rows.find((row) => _tvHealthFailureEvents.has(String(row?.event || "")));
  const lastSessionStart = rows.find((row) => String(row?.event || "") === "session_start");
  const hidden = _deriveHiddenStatus(rows);

  const lastCheckInMs = _toTsMs(lastCheckIn?.ts_server);
  const minutesSinceCheckIn = Number.isFinite(lastCheckInMs) ? Math.floor((nowMs - lastCheckInMs) / 60000) : null;
  const checkInLimit = lastCheckIn?.event === "device_presence"
    ? LIVE_STATUS_PRESENCE_STALE_MINUTES
    : LIVE_STATUS_LEGACY_HEARTBEAT_MINUTES;
  const isStale = minutesSinceCheckIn === null || minutesSinceCheckIn >= checkInLimit;
  const lastFailureMs = _toTsMs(lastFailure?.ts_server);
  const failureAfterCheckIn = Number.isFinite(lastFailureMs)
    && (!Number.isFinite(lastCheckInMs) || lastFailureMs > lastCheckInMs)
    && nowMs - lastFailureMs < LIVE_STATUS_PRESENCE_STALE_MINUTES * 60000;
  const hasAuthFailure = failureAfterCheckIn
    && ["token_invalid_401", "kiosk_token_invalid_401"].includes(String(lastFailure?.event || ""));

  let status = "green";
  let label = "ONLINE";
  if (hasAuthFailure) {
    status = "red";
    label = "AUTH ERROR";
  } else if (isStale) {
    status = "yellow";
    label = "STATUS UNKNOWN";
  } else if (failureAfterCheckIn || hidden.warn) {
    status = "yellow";
    label = "WARNING";
  }

  const sessionStartMs = _toTsMs(lastSessionStart?.ts_server) || null;
  const uptimeMs = !isStale && status !== "red" && Number.isFinite(sessionStartMs) ? nowMs - sessionStartMs : null;

  return {
    status,
    label,
    isStale,
    lastCheckIn,
    minutesSinceCheckIn,
    lastHeartbeat,
    lastFailure,
    failureAfterCheckIn,
    hidden,
    sessionStartMs,
    uptimeMs,
    connectionDiagnosis: _connectionDiagnosis(rows),
  };
}

// Problem-resolution guidance shown under the status card. Kept data-driven
// (not hardcoded per device) so any device the admin selects gets relevant
// next steps instead of a static, one-size-fits-all message.
function _liveStatusFixList(state) {
  if (state.status === "green") {
    return { ok: true, title: "No action needed", items: ["Device is checking in normally. No troubleshooting steps required."] };
  }

  const items = [];
  if (state.status === "red") {
    items.push("The TV dashboard recently reported an authentication error. Reload the dashboard, then check the TV Re-pair Risk Log if the error continues.");
  } else if (state.status === "yellow") {
    if (state.isStale) {
      items.push("No recent authenticated calendar check-in was recorded. This means status is unknown; old diagnostics alone do not prove the TV is offline.");
      items.push("If the calendar is visible, reload the TV dashboard once to send a fresh check-in, then refresh this panel.");
      items.push("If it is not visible, check TV power, Wi-Fi, and the FireStick sleep-fix steps in the card to the right.");
    }
    if (state.hidden.warn) {
      const hiddenMinutes = Number.isFinite(state.hidden.hiddenDurationMinutes) ? state.hidden.hiddenDurationMinutes : 0;
      items.push(`Screen has been hidden/backgrounded for ${hiddenMinutes}m — check HDMI-CEC and screensaver settings on the TV.`);
    }
    if (state.failureAfterCheckIn && state.lastFailure) {
      items.push(`Last network/token failure: ${_escapeHtml(_eventTag(state.lastFailure.event))}. ${state.connectionDiagnosis}`);
    }
    if (!state.isStale) {
      items.push("The device is checking in, but a recent warning needs review. Reload the TV dashboard if the picture looks frozen or blank.");
    }
  }
  return { ok: false, title: "Suggested fix steps", items };
}

function _renderLiveStatusCard(deviceId) {
  if (!tvLiveStatusCard) return;
  const rows = _liveStatusRowsByDevice.get(deviceId);
  if (!rows || !rows.length) {
    tvLiveStatusCard.innerHTML = "No diagnostic rows found for the selected device.";
    return;
  }

  const state = _computeLiveStatus(rows);
  const fix = _liveStatusFixList(state);
  const shortId = deviceId === "unknown" ? "unknown" : `…${deviceId.slice(-8)}`;
  const userEmail = _liveStatusEmailByUser.get(String(rows[0]?.user_id ?? "")) || "Email unavailable";
  const deviceLabel = _deviceIdentityLabel(rows[0]?.device_ua);

  tvLiveStatusCard.innerHTML = `
    <div class="tv-status-headline">
      <span class="tv-status-dot status-${state.status}"></span>
      <span class="tv-status-label status-${state.status}">${_escapeHtml(state.label)}</span>
      ${state.uptimeMs != null ? `<span class="tv-uptime-badge">UP ${_escapeHtml(_fmtDuration(state.uptimeMs))}</span>` : ""}
    </div>
    <div class="tv-status-fields">
      <div><strong>User email:</strong> ${_escapeHtml(userEmail)}</div>
      <div><strong>Device ID:</strong> <span style="font-family:monospace;">${_escapeHtml(shortId)}</span></div>
      <div><strong>Device type:</strong> ${_escapeHtml(deviceLabel)}</div>
      <div><strong>Last confirmed check-in:</strong> ${state.lastCheckIn ? `${_fmtDiagTime(state.lastCheckIn.ts_server)} (${state.minutesSinceCheckIn}m ago)` : "no check-in recorded"}</div>
      <div><strong>Last heartbeat:</strong> ${state.lastHeartbeat ? _fmtDiagTime(state.lastHeartbeat.ts_server) : "none in window"}</div>
      <div><strong>Current uptime:</strong> ${state.uptimeMs != null ? _fmtDuration(state.uptimeMs) : "unknown (no recent check-in or session_start)"}</div>
    </div>
    <div class="tv-status-fix-box${fix.ok ? " is-ok" : ""}">
      <h4>${_escapeHtml(fix.title)}</h4>
      <ul>${fix.items.map((item) => `<li>${item}</li>`).join("")}</ul>
    </div>
  `;
}

async function loadTvLiveStatus() {
  if (!tvLiveStatusSelect || !tvLiveStatusCard) return;
  try {
    const [data, usersResponse] = await Promise.all([
      apiRequest("/tv/diag?scope=all&hours=168", { method: "GET" }),
      apiRequest("/admin/users", { method: "GET" }),
    ]);
    if (!data || !Array.isArray(data.entries)) {
      if (tvLiveStatusCount) tvLiveStatusCount.textContent = "error loading";
      return;
    }

    const userRows = usersResponse?.ok ? await usersResponse.json() : [];
    _liveStatusEmailByUser = new Map(
      (Array.isArray(userRows) ? userRows : [])
        .filter((user) => user?.id != null && user?.email)
        .map((user) => [String(user.id), String(user.email)])
    );

    const byDevice = new Map();
    for (const entry of data.entries) {
      const deviceId = String(entry?.device_id || "unknown");
      if (!byDevice.has(deviceId)) byDevice.set(deviceId, []);
      byDevice.get(deviceId).push(entry);
    }
    _liveStatusRowsByDevice = byDevice;

    if (tvLiveStatusCount) tvLiveStatusCount.textContent = `${byDevice.size} device(s) in the last 7 days`;

    if (!byDevice.size) {
      tvLiveStatusSelect.innerHTML = '<option value="">No devices found</option>';
      tvLiveStatusCard.innerHTML = "No devices found in the last 7 days.";
      return;
    }

    const previouslySelected = tvLiveStatusSelect.value;
    const options = Array.from(byDevice.entries()).map(([deviceId, rows]) => {
      const shortId = deviceId === "unknown" ? "unknown" : `…${deviceId.slice(-8)}`;
      const userEmail = _liveStatusEmailByUser.get(String(rows[0]?.user_id ?? "")) || "Email unavailable";
      return { deviceId, label: `${userEmail} · ${shortId} · ${_deviceIdentityLabel(rows[0]?.device_ua)}` };
    });

    tvLiveStatusSelect.innerHTML = options
      .map((opt) => `<option value="${_escapeHtml(opt.deviceId)}">${_escapeHtml(opt.label)}</option>`)
      .join("");

    const stillValid = options.some((opt) => opt.deviceId === previouslySelected);
    tvLiveStatusSelect.value = stillValid ? previouslySelected : options[0].deviceId;
    _renderLiveStatusCard(tvLiveStatusSelect.value);
  } catch (err) {
    if (tvLiveStatusCount) tvLiveStatusCount.textContent = `Error: ${err.message}`;
  }
}

async function loadPublishDiag() {
  if (!publishDiagBody) return;
  try {
    const params = new URLSearchParams({ scope: "all" });
    const selectedWindow = publishDiagWindow ? String(publishDiagWindow.value || "").trim() : "";
    if (selectedWindow) params.set("hours", selectedWindow);
    const data = await apiRequest(`/tv/diag?${params.toString()}`, { method: "GET" });
    if (!data || !Array.isArray(data.entries)) {
      if (publishDiagCount) publishDiagCount.textContent = "error loading";
      return;
    }

    const entries = data.entries.filter((entry) => String(entry?.event || "") === "calendar_publish_result");
    const hours = Number(data?.filters?.hours);
    const hasWindow = Number.isFinite(hours) && hours > 0;
    if (publishDiagCount) {
      publishDiagCount.textContent = `${entries.length} publish row(s)${hasWindow ? ` in last ${hours}h` : ""} (${data.source || "db"})`;
    }

    if (!entries.length) {
      publishDiagBody.innerHTML = '<tr><td colspan="4" style="opacity:0.4;">No publish diagnostics found yet.</td></tr>';
      return;
    }

    publishDiagBody.innerHTML = entries.map((entry) => {
      const shortId = entry.device_id ? entry.device_id.slice(-8) : "—";
      const ua = _escapeHtml(entry.device_ua || "");
      const details = _escapeHtml(entry.details || "—");
      return `
      <tr>
        <td>${_fmtDiagTime(entry.ts_server)}</td>
        <td>${entry.user_id ?? "—"}</td>
        <td><span title="${ua}" style="font-family:monospace;cursor:default;">…${shortId}</span></td>
        <td style="opacity:0.86;">${details}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    if (publishDiagCount) publishDiagCount.textContent = `Error: ${err.message}`;
  }
}

function _fmtStaleSummary(data) {
  const counts = data?.counts || {};
  const windowHours = Number(data?.window?.hours || 24);
  const points = Array.isArray(data?.meaningful_points) ? data.meaningful_points : [];
  const reasons = Array.isArray(data?.reason_counts) ? data.reason_counts : [];
  const reasonText = reasons.length
    ? reasons.map((row) => `${row.reason}: ${row.count}`).join(", ")
    : "none";

  return `
    <div><strong>Window:</strong> last ${windowHours} hour(s)</div>
    <div><strong>Fallback events:</strong> ${counts.stale_snapshot_events ?? 0} &middot; <strong>Devices:</strong> ${counts.unique_devices ?? 0} &middot; <strong>Users:</strong> ${counts.unique_users ?? 0}</div>
    <div><strong>Reason mix:</strong> ${_escapeHtml(reasonText)}</div>
    <ul>${points.map((line) => `<li>${_escapeHtml(line)}</li>`).join("")}</ul>
  `;
}

function _repairScenarioLabel(eventName) {
  switch (String(eventName || "")) {
    case "token_invalid_401":
      return "401 token invalid (paired mode)";
    case "kiosk_token_invalid_401":
      return "401 token invalid (kiosk URL mode)";
    case "storage_token_removed":
      return "Token removed from browser storage";
    case "user_unpair_requested":
      return "User pressed Unpair";
    default:
      return String(eventName || "unknown");
  }
}

function _fmtRepairSummary(rows) {
  const counts = new Map();
  const users = new Set();
  const devices = new Set();
  for (const row of rows) {
    const label = _repairScenarioLabel(row.event);
    counts.set(label, (counts.get(label) || 0) + 1);
    if (row.user_id != null) users.add(String(row.user_id));
    if (row.device_id) devices.add(String(row.device_id));
  }
  const mix = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([label, count]) => `${label}: ${count}`)
    .join(", ");

  return `
    <div><strong>Rows:</strong> ${rows.length}</div>
    <div><strong>Users affected:</strong> ${users.size} &middot; <strong>Devices affected:</strong> ${devices.size}</div>
    <div><strong>Scenario mix:</strong> ${_escapeHtml(mix || "none")}</div>
  `;
}

async function loadTvRepairDiag() {
  if (!repairDiagBody) return;
  try {
    const params = new URLSearchParams({ scope: "all", event_group: "repair_risk" });
    const selectedWindow = repairDiagWindow ? String(repairDiagWindow.value || "").trim() : "";
    if (selectedWindow) params.set("hours", selectedWindow);
    const data = await apiRequest(`/tv/diag?${params.toString()}`, { method: "GET" });
    if (!data || !Array.isArray(data.entries)) {
      if (repairDiagCount) repairDiagCount.textContent = "error loading";
      if (repairDiagSummary) repairDiagSummary.textContent = "Unable to load re-pair diagnostics.";
      return;
    }

    const rows = data.entries;
    const hours = Number(data?.filters?.hours);
    const hasWindow = Number.isFinite(hours) && hours > 0;

    if (repairDiagCount) repairDiagCount.textContent = `${rows.length} re-pair risk row(s)${hasWindow ? ` in last ${hours}h` : ""}`;
    if (repairDiagSummary) repairDiagSummary.innerHTML = _fmtRepairSummary(rows);

    if (!rows.length) {
      repairDiagBody.innerHTML = '<tr><td colspan="5" style="opacity:0.4;">No re-pair risk scenarios recorded in current diagnostic rows.</td></tr>';
      return;
    }

    repairDiagBody.innerHTML = rows.map((entry) => {
      const shortId = entry.device_id ? String(entry.device_id).slice(-8) : "—";
      const scenario = _repairScenarioLabel(entry.event);
      return `
      <tr>
        <td>${_fmtDiagTime(entry.ts_server)}</td>
        <td>${entry.user_id ?? "—"}</td>
        <td><span style="font-family:monospace;">…${_escapeHtml(shortId)}</span></td>
        <td>${_escapeHtml(scenario)}</td>
        <td>${_escapeHtml(entry.details || "—")}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    if (repairDiagCount) repairDiagCount.textContent = `Error: ${err.message}`;
    if (repairDiagSummary) repairDiagSummary.textContent = "Error loading re-pair diagnostics.";
  }
}

async function loadTvStaleDiag() {
  if (!staleDiagBody) return;
  try {
    const data = await apiRequest("/admin/system/tv-stale-refresh-summary?hours=168&limit=75", { method: "GET" });
    if (!data || data.ok === false) {
      if (staleDiagCount) staleDiagCount.textContent = "error loading";
      if (staleDiagSummary) staleDiagSummary.textContent = "Unable to load stale refresh safety summary.";
      return;
    }

    const rows = Array.isArray(data.recent_rows) ? data.recent_rows : [];
    if (staleDiagCount) staleDiagCount.textContent = `${rows.length} row(s) in the last 7 days`;
    if (staleDiagSummary) staleDiagSummary.innerHTML = _fmtStaleSummary(data);

    if (!rows.length) {
      staleDiagBody.innerHTML = '<tr><td colspan="5" style="opacity:0.4;">No stale snapshot fallback rows in the selected window.</td></tr>';
      return;
    }

    staleDiagBody.innerHTML = rows.map((entry) => {
      const shortId = entry.device_id ? String(entry.device_id).slice(-8) : "—";
      return `
      <tr>
        <td>${_fmtDiagTime(entry.ts_server)}</td>
        <td>${entry.user_id ?? "—"}</td>
        <td><span style="font-family:monospace;">…${_escapeHtml(shortId)}</span></td>
        <td>${_escapeHtml(entry.reason || "unknown")}</td>
        <td>${_escapeHtml(entry.visibility || "—")}</td>
      </tr>`;
    }).join("");
  } catch (err) {
    if (staleDiagCount) staleDiagCount.textContent = `Error: ${err.message}`;
    if (staleDiagSummary) staleDiagSummary.textContent = "Error loading stale refresh safety summary.";
  }
}

if (diagLoadBtn) {
  diagLoadBtn.addEventListener("click", loadTvDiag);
}

if (diagClearBtn) {
  diagClearBtn.addEventListener("click", () => {
    if (diagBody) diagBody.innerHTML = '<tr><td colspan="7" style="opacity:0.4;">Cleared view (server log unchanged).</td></tr>';
    if (diagCount) diagCount.textContent = "cleared";
  });
}

if (diagAutoRefresh) {
  diagAutoRefresh.addEventListener("change", () => {
    if (diagAutoRefresh.checked) {
      loadTvDiag();
      // 30 s, and never while the tab is hidden: an admin panel left open in a
      // background tab used to poll all day.
      _diagAutoHandle = setInterval(() => {
        if (document.visibilityState === 'visible') loadTvDiag();
      }, 30000);
    } else {
      if (_diagAutoHandle) clearInterval(_diagAutoHandle);
      _diagAutoHandle = null;
    }
  });
}

if (tvHealthLoadBtn) {
  tvHealthLoadBtn.addEventListener("click", () => {
    _healthPanelLoaded = true;
    loadTvHealth();
  });
}

if (tvHealthClearBtn) {
  tvHealthClearBtn.addEventListener("click", () => {
    if (tvHealthBody) tvHealthBody.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">Cleared view (server log unchanged).</td></tr>';
    if (tvHealthCount) tvHealthCount.textContent = "cleared";
  });
}

if (tvHealthSort) {
  tvHealthSort.addEventListener("change", () => {
    if (_healthPanelLoaded) loadTvHealth();
  });
}

if (tvHealthPanel) {
  tvHealthPanel.addEventListener("toggle", () => {
    if (tvHealthPanel.open && !_healthPanelLoaded) {
      _healthPanelLoaded = true;
      loadTvHealth();
    }
  });
}

if (tvLiveStatusLoadBtn) {
  tvLiveStatusLoadBtn.addEventListener("click", () => {
    _liveStatusPanelLoaded = true;
    loadTvLiveStatus();
  });
}

if (tvLiveStatusClearBtn) {
  tvLiveStatusClearBtn.addEventListener("click", () => {
    if (tvLiveStatusCard) tvLiveStatusCard.innerHTML = "Cleared view (server log unchanged).";
    if (tvLiveStatusCount) tvLiveStatusCount.textContent = "cleared";
    if (tvLiveStatusSelect) tvLiveStatusSelect.innerHTML = '<option value="">No devices loaded yet</option>';
    _liveStatusRowsByDevice = new Map();
    _liveStatusEmailByUser = new Map();
  });
}

if (tvLiveStatusSelect) {
  tvLiveStatusSelect.addEventListener("change", () => {
    if (tvLiveStatusSelect.value) _renderLiveStatusCard(tvLiveStatusSelect.value);
  });
}

if (tvLiveStatusPanel) {
  tvLiveStatusPanel.addEventListener("toggle", () => {
    if (tvLiveStatusPanel.open && !_liveStatusPanelLoaded) {
      _liveStatusPanelLoaded = true;
      loadTvLiveStatus();
    }
  });

  // Unlike the other diagnostics subsections, this panel ships open by
  // default so status is visible without an extra click. The browser
  // "toggle" event is not guaranteed to fire for markup that is already
  // open at parse time, so trigger the first load explicitly.
  if (tvLiveStatusPanel.open && !_liveStatusPanelLoaded) {
    _liveStatusPanelLoaded = true;
    loadTvLiveStatus();
  }
}

if (publishDiagLoadBtn) {
  publishDiagLoadBtn.addEventListener("click", loadPublishDiag);
}

if (publishDiagClearBtn) {
  publishDiagClearBtn.addEventListener("click", () => {
    if (publishDiagBody) publishDiagBody.innerHTML = '<tr><td colspan="4" style="opacity:0.4;">Cleared view (server log unchanged).</td></tr>';
    if (publishDiagCount) publishDiagCount.textContent = "cleared";
  });
}

if (staleDiagLoadBtn) {
  staleDiagLoadBtn.addEventListener("click", () => {
    _stalePanelLoaded = true;
    loadTvStaleDiag();
  });
}

if (staleDiagClearBtn) {
  staleDiagClearBtn.addEventListener("click", () => {
    if (staleDiagBody) staleDiagBody.innerHTML = '<tr><td colspan="5" style="opacity:0.4;">Cleared view (server log unchanged).</td></tr>';
    if (staleDiagCount) staleDiagCount.textContent = "cleared";
    if (staleDiagSummary) staleDiagSummary.textContent = "Cleared summary view.";
  });
}

if (staleDiagPanel) {
  staleDiagPanel.addEventListener("toggle", () => {
    if (staleDiagPanel.open && !_stalePanelLoaded) {
      _stalePanelLoaded = true;
      loadTvStaleDiag();
    }
  });
}

if (repairDiagLoadBtn) {
  repairDiagLoadBtn.addEventListener("click", () => {
    _repairPanelLoaded = true;
    loadTvRepairDiag();
  });
}

if (repairDiagClearBtn) {
  repairDiagClearBtn.addEventListener("click", () => {
    if (repairDiagBody) repairDiagBody.innerHTML = '<tr><td colspan="5" style="opacity:0.4;">Cleared view (server log unchanged).</td></tr>';
    if (repairDiagCount) repairDiagCount.textContent = "cleared";
    if (repairDiagSummary) repairDiagSummary.textContent = "Cleared summary view.";
  });
}

if (repairDiagPanel) {
  repairDiagPanel.addEventListener("toggle", () => {
    if (repairDiagPanel.open && !_repairPanelLoaded) {
      _repairPanelLoaded = true;
      loadTvRepairDiag();
    }
  });
}
