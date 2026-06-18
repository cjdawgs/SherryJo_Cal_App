/**************************************************************
 * ✅ COLOR ENGINE (SINGLE SOURCE OF TRUTH)
 * ------------------------------------------------------------
 * RULES:
 * - RAW colors = identity (events, dots, badges)
 * - SOFT colors = UI (chips, previews)
 * - NEVER store softened colors
 **************************************************************/

/**************************************************************
 * ✅ BASE COLORS (PROVIDER LEVEL)
 **************************************************************/
const BASE_COLORS = {
  google: "#34a853",
  microsoft: "#2563eb",
  apple: "#ef4444",
  local: "#7ca3af",
  other: "#999"
};

/**************************************************************
 * ✅ NORMALIZATION
 **************************************************************/
function normalizeProvider(provider) {
  const p = (provider || "").toLowerCase();
  return p === "outlook" ? "microsoft" : p;
}

/**************************************************************
 * ✅ BASE PROVIDER COLOR
 **************************************************************/
function getBaseProviderColor(provider) {
  const normalized = normalizeProvider(provider);
  return BASE_COLORS[normalized] || BASE_COLORS.other;
}

/**************************************************************
 * ✅ USER COLOR STORAGE (RAW ONLY)
 **************************************************************/
const ACCOUNT_COLOR_STORAGE_KEY = "accountColorOverrides";

function loadColorOverrides() {
  try {
    const raw = localStorage.getItem(ACCOUNT_COLOR_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveColorOverrides(map) {
  localStorage.setItem(ACCOUNT_COLOR_STORAGE_KEY, JSON.stringify(map));
}

let accountColorOverrides = loadColorOverrides();

/**************************************************************
 * ✅ GENERATED ACCOUNT COLOR MAP
 **************************************************************/
let accountColorMap = {};

/**************************************************************
 * ✅ LIGHTEN ENGINE (LOW-LEVEL)
 **************************************************************/
function lightenColor(hex, percent) {
  const num = parseInt(hex.replace("#", ""), 16);

  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;

  r = Math.min(255, Math.floor(r + (255 - r) * percent));
  g = Math.min(255, Math.floor(g + (255 - g) * percent));
  b = Math.min(255, Math.floor(b + (255 - b) * percent));

  return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
}

function applySoftColor(raw) {
  return lightenColor(raw, 0.85);
}
// ✅ expose globally (matches your current architecture)
window.applySoftColor = applySoftColor;


/**************************************************************
 * ✅ COLOR NORMALIZATION (REMOVES HARSH / NEON)
 **************************************************************/
function normalizeColorHarmony(hex) {
  const num = parseInt(hex.replace("#", ""), 16);

  let r = (num >> 16) & 0xff;
  let g = (num >> 8) & 0xff;
  let b = num & 0xff;

  r = Math.min(220, Math.max(60, r));
  g = Math.min(220, Math.max(60, g));
  b = Math.min(220, Math.max(60, b));

  return "#" + [r, g, b].map(x => x.toString(16).padStart(2, "0")).join("");
}

/**************************************************************
 * ✅ SOFT COLOR ENGINE (UI ONLY)
 **************************************************************/
function getSoftColor(hex) {
  if (!hex) return "#999";
  const softened = lightenColor(hex, 0.65);
  return normalizeColorHarmony(softened);
}

/**************************************************************
 * ✅ RAW COLOR RESOLUTION (CORE ENGINE)
 **************************************************************/
function getColorByKey(key, provider) {
  if (!key) return "#999";

  if (accountColorOverrides[key]) {
    return accountColorOverrides[key];
  }

  if (accountColorMap[key]) {
    return accountColorMap[key];
  }

  const derivedProvider =
    provider ||
    (key && key.split(":")[0]);

  return getBaseProviderColor(derivedProvider);
}

/**************************************************************
 * ✅ EVENT COLOR (PUBLIC ENTRY POINT)
 **************************************************************/
function resolveEventColor(event) {
  const key = event?.extendedProps?.account_key;
  const provider = event?.extendedProps?.source;

  return getColorByKey(key, provider);
}

/**************************************************************
 * ✅ ACCOUNT COLOR GENERATION (SYSTEM COLORS)
 **************************************************************/
function getAccountColor(provider, index) {
  const base = getBaseProviderColor(provider);

  const percent = Math.min(0.35 + (index * 0.4), 0.85);

  return lightenColor(base, percent);
}

/**************************************************************
 * ✅ CONTRAST ENGINE (TEXT READABILITY)
 **************************************************************/
function getLuminance(hex) {
  const rgb = hex.replace("#", "").match(/.{2}/g)
    .map(x => parseInt(x, 16) / 255)
    .map(c =>
      c <= 0.03928
        ? c / 12.92
        : Math.pow((c + 0.055) / 1.055, 2.4)
    );

  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

function getBestTextColor(bgHex) {
  if (!bgHex) return "#000";

  const bgLum = getLuminance(bgHex);

  const whiteContrast = 1.05 / (bgLum + 0.05);
  const blackContrast = (bgLum + 0.05) / 0.05;

  return whiteContrast > blackContrast ? "#fff" : "#000";
}

/**************************************************************
 * ✅ ACCOUNT KEY HELPERS
 **************************************************************/
function normalizeAccountKey(key, provider, email) {
  if (key) return key;

  const p = (provider || "local").toLowerCase();
  const e = (email || "local").toLowerCase().trim();

  return `${p}:${e}`;
}

function isLocalEvent(key) {
  return key === "local:local";
}

/**************************************************************
 * ✅ SOFT ACCOUNT COLOR (UI WRAPPER)
 **************************************************************/
function getSoftAccountColor(key, provider) {
  const raw = getColorByKey(key, provider);
  return getSoftColor(raw);
}


/**************************************************************
 * ✅ SAVE HELPER (USED BY PICKER)
 **************************************************************/
function setAccountColor(key, rawColor) {
  accountColorOverrides[key] = rawColor;
  accountColorMap[key] = rawColor;
  saveColorOverrides(accountColorOverrides);
}


/**************************************************************
 * ✅ GLOBAL BRIDGE (calendar.js access)
 **************************************************************/
window.getColorByKey = getColorByKey;
window.getBestTextColor = getBestTextColor;
window.getSoftColor = getSoftColor;
window.getSoftAccountColor = getSoftAccountColor;
