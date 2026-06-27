import { apiFetch, getAuthToken } from "/static/api.js";

function isDevHost() {
  const host = String(window.location.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".local");
}

function ensureBadgeStyles() {
  if (document.getElementById("dev-role-badge-style")) return;

  const style = document.createElement("style");
  style.id = "dev-role-badge-style";
  style.textContent = `
    .devRoleBadge {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.02em;
      color: #3f526f;
      background: #e8eef7;
      border: 1px solid #c3d1e6;
      border-radius: 999px;
      padding: 2px 7px;
      line-height: 1;
    }

    .devRoleBadge.hidden {
      display: none !important;
    }

    .devRoleBadgeFloating {
      position: fixed;
      top: 8px;
      right: 10px;
      z-index: 99999;
    }
  `;

  document.head.appendChild(style);
}

function ensureBadgeElement() {
  let badge = document.getElementById("devRoleBadge");
  if (badge) return badge;

  badge = document.createElement("span");
  badge.id = "devRoleBadge";
  badge.className = "devRoleBadge devRoleBadgeFloating hidden";
  document.body.appendChild(badge);
  return badge;
}

function setBadgeText(badge, text) {
  if (!badge) return;
  badge.textContent = text;
  badge.classList.remove("hidden");
}

async function hydrateDevRoleBadge() {
  if (!isDevHost()) return;

  ensureBadgeStyles();
  const badge = ensureBadgeElement();
  setBadgeText(badge, "DEV");

  const token = getAuthToken();
  if (!token) {
    setBadgeText(badge, "DEV GUEST");
    return;
  }

  try {
    const res = await apiFetch("/users/me", { method: "GET" });
    if (!res) {
      setBadgeText(badge, "DEV ?");
      return;
    }

    if (res.ok) {
      const me = await res.json();
      const role = String(me?.role || "user").toUpperCase();
      setBadgeText(badge, `DEV ${role}`);
      return;
    }

    if (res.status === 401 || res.status === 403) {
      setBadgeText(badge, "DEV GUEST");
      return;
    }

    setBadgeText(badge, "DEV ?");
  } catch (error) {
    console.warn("Unable to hydrate dev role badge", error);
    setBadgeText(badge, "DEV ?");
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", hydrateDevRoleBadge);
} else {
  hydrateDevRoleBadge();
}
