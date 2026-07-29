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

function applySleepGuardUI(enabled, timeoutMinutes) {
  _sleepGuardEnabled = enabled;
  _sleepGuardTimeoutMinutes = timeoutMinutes;
  if (sleepToggleBtn) {
    sleepToggleBtn.textContent = enabled ? "Disable" : "Enable";
    sleepToggleBtn.style.opacity = enabled ? "1" : "0.6";
  }
  if (sleepTimeoutSel) {
    sleepTimeoutSel.value = String(timeoutMinutes);
    sleepTimeoutSel.disabled = !enabled;
  }
  if (sleepAdminStatus) {
    if (!enabled) {
      sleepAdminStatus.textContent = "Off";
    } else if (timeoutMinutes === 0) {
      sleepAdminStatus.textContent = "Active — never times out";
    } else {
      sleepAdminStatus.textContent = `Active — stops after ${timeoutMinutes} min`;
    }
  }
}

async function patchSleepGuard(enabled, timeoutMinutes) {
  try {
    await apiRequest("/tv/state", {
      method: "PATCH",
      body: { sleepGuardEnabled: enabled, sleepGuardTimeoutMinutes: timeoutMinutes },
    });
    applySleepGuardUI(enabled, timeoutMinutes);
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
    patchSleepGuard(_sleepGuardEnabled, Number(sleepTimeoutSel.value));
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
let _diagAutoHandle = null;
let _stalePanelLoaded = false;
let _repairPanelLoaded = false;

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
