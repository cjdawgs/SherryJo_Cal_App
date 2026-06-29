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
    const data = await apiRequest("/tv/generate-code", {
      method: "POST",
    });

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
