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
    const data = await apiRequest("POST", "/tv/generate-kiosk-token");
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
