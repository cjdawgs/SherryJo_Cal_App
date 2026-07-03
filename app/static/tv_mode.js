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

const tvDialog        = document.getElementById("tvModeDialog");
const tvCodeDisplay   = document.getElementById("tvPairingCodeDisplay");
const tvExpiryDisplay = document.getElementById("tvPairingExpiry");
const tvStatus        = document.getElementById("tvPairingStatus");
const enableBtn       = document.getElementById("enableTVModeBtn");
const closeBtn        = document.getElementById("closeTVDialog");
const regenerateBtn   = document.getElementById("regenerateTVCode");

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

const kioskDialog      = document.getElementById("kioskUrlDialog");
const kioskUrlDisplay  = document.getElementById("kioskUrlDisplay");
const kioskUrlStatus   = document.getElementById("kioskUrlStatus");
const generateKioskBtn = document.getElementById("generateKioskUrlBtn");
const closeKioskBtn    = document.getElementById("closeKioskDialog");
const copyKioskBtn     = document.getElementById("copyKioskUrlBtn");
const regenKioskBtn    = document.getElementById("regenerateKioskBtn");

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

const sleepToggleBtn   = document.getElementById("tvSleepToggleBtn");
const sleepTimeoutSel  = document.getElementById("tvSleepTimeout");
const sleepAdminStatus = document.getElementById("tvSleepAdminStatus");

let _sleepGuardEnabled        = true;
let _sleepGuardTimeoutMinutes = 0;

function applySleepGuardUI(enabled, timeoutMinutes) {
  _sleepGuardEnabled        = enabled;
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

const diagLoadBtn      = document.getElementById("tvDiagLoadBtn");
const diagClearBtn     = document.getElementById("tvDiagClearBtn");
const diagAutoRefresh  = document.getElementById("tvDiagAutoRefresh");
const diagBody         = document.getElementById("tvDiagBody");
const diagCount        = document.getElementById("tvDiagCount");
let   _diagAutoHandle  = null;

function _fmtDiagTime(isoStr) {
  if (!isoStr) return "—";
  try {
    return new Date(isoStr).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return isoStr; }
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
      diagBody.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">No events captured yet.</td></tr>';
      return;
    }
    diagBody.innerHTML = entries.map(e => `
      <tr>
        <td>${_fmtDiagTime(e.ts_server)}</td>
        <td>${e.elapsed_min != null ? e.elapsed_min + "m" : "—"}</td>
        <td style="font-weight:700;color:${e.event.includes("freeze") || e.event.includes("hide") || e.event.includes("unload") ? "#ff9500" : e.event.includes("gap") ? "#ff453a" : "#e0e0f0"};">${e.event}</td>
        <td style="opacity:0.8;">${e.details || "—"}</td>
        <td>${e.visibility || "—"}</td>
        <td>${e.guard_enabled === true ? "✓" : e.guard_enabled === false ? "✗" : "—"}</td>
      </tr>
    `).join("");
  } catch (err) {
    if (diagCount) diagCount.textContent = `Error: ${err.message}`;
  }
}

if (diagLoadBtn) {
  diagLoadBtn.addEventListener("click", loadTvDiag);
}

if (diagClearBtn) {
  diagClearBtn.addEventListener("click", () => {
    if (diagBody) diagBody.innerHTML = '<tr><td colspan="6" style="opacity:0.4;">Cleared view (server log unchanged).</td></tr>';
    if (diagCount) diagCount.textContent = "cleared";
  });
}

if (diagAutoRefresh) {
  diagAutoRefresh.addEventListener("change", () => {
    if (diagAutoRefresh.checked) {
      loadTvDiag();
      _diagAutoHandle = setInterval(loadTvDiag, 10000);
    } else {
      if (_diagAutoHandle) clearInterval(_diagAutoHandle);
      _diagAutoHandle = null;
    }
  });
}
