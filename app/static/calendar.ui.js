import { getActiveRangeLabel, toDayString } from "/static/core.js";
import { connectGoogle, connectMicrosoft, connectApple } from "/static/account_connections.js";
import { renderRangePill } from "/static/calendar.fullcalendar.js";
import {
  createEventSaveCommand,
  createEventDeleteCommand,
  createStickySaveCommand,
  createStickyDeleteCommand,
  createDateStickySaveCommand
} from "/static/undo_redo.js";

window.isModalOpen = false;

const modalState = {
  type: "event",
  stickyScope: "event",
  dateStickyKey: null,
  eventId: null,
  eventRef: null,
  stickyNotes: [],
  stickyIndex: 0,
  publishTargetKeys: [],
  initialSnapshot: null,
  initialEventContentSnapshot: null,
  publishAttemptConsumed: false,
  publishAttemptState: "idle"
};

let isSavingEvent = false;
let isSavingSticky = false;
let isPublishingEvent = false;
let activeRichEditorId = null;
let modalWindowControlsReady = false;
let modalResizeReady = false;

const PUBLISHABLE_PROVIDERS = new Set(["google", "microsoft"]);
const MODAL_VIEWPORT_GUTTER = 14;
const DEFAULT_EVENT_COLOR = "#4F8EF7";
const TAG_COLOR_STORAGE_KEY = "sj_event_tag_color_settings_v1";
const EVENT_COLOR_ENABLED_STORAGE_KEY = "sj_event_color_enabled_v1";
let tagColorSettingsCache = loadJsonMap(TAG_COLOR_STORAGE_KEY);
let tagColorSettingsReady = false;
let tagColorSettingsServerAvailable = false;

function clampModalValue(value, min, max) {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

function getModalResizeLimits(frame, rect = null) {
  const styles = window.getComputedStyle(frame);
  const parsedMinWidth = Number.parseFloat(styles.minWidth);
  const parsedMinHeight = Number.parseFloat(styles.minHeight);
  const minWidth = Number.isFinite(parsedMinWidth) && parsedMinWidth > 0 ? parsedMinWidth : 320;
  const minHeight = Number.isFinite(parsedMinHeight) && parsedMinHeight > 0 ? parsedMinHeight : 300;
  const left = rect ? rect.left : frame.getBoundingClientRect().left;
  const top = rect ? rect.top : frame.getBoundingClientRect().top;

  return {
    minWidth,
    minHeight,
    maxWidth: Math.max(minWidth, window.innerWidth - left - MODAL_VIEWPORT_GUTTER),
    maxHeight: Math.max(minHeight, window.innerHeight - top - MODAL_VIEWPORT_GUTTER),
    maxLeft: Math.max(MODAL_VIEWPORT_GUTTER, window.innerWidth - minWidth - MODAL_VIEWPORT_GUTTER),
    maxTop: Math.max(MODAL_VIEWPORT_GUTTER, window.innerHeight - minHeight - MODAL_VIEWPORT_GUTTER)
  };
}

function constrainModalToViewport(frame) {
  if (!frame || !frame.classList.contains("modalUserResized")) return;
  const rect = frame.getBoundingClientRect();
  const limits = getModalResizeLimits(frame, rect);
  const left = clampModalValue(rect.left, MODAL_VIEWPORT_GUTTER, limits.maxLeft);
  const top = clampModalValue(rect.top, MODAL_VIEWPORT_GUTTER, limits.maxTop);
  const maxWidth = Math.max(limits.minWidth, window.innerWidth - left - MODAL_VIEWPORT_GUTTER);
  const maxHeight = Math.max(limits.minHeight, window.innerHeight - top - MODAL_VIEWPORT_GUTTER);

  frame.style.left = `${left}px`;
  frame.style.top = `${top}px`;
  frame.style.width = `${clampModalValue(rect.width, limits.minWidth, maxWidth)}px`;
  frame.style.height = `${clampModalValue(rect.height, limits.minHeight, maxHeight)}px`;
}

function installModalResizeHandle(frame) {
  if (!frame || frame.querySelector(".modalResizeHandle")) return;

  const handle = document.createElement("div");
  handle.className = "modalResizeHandle";
  handle.setAttribute("role", "presentation");
  handle.title = "Resize window";
  frame.appendChild(handle);

  handle.addEventListener("pointerdown", (event) => {
    if (frame.classList.contains("windowFrameMinimized") || frame.classList.contains("windowFrameMaximized")) return;
    event.preventDefault();
    event.stopPropagation();

    const startRect = frame.getBoundingClientRect();
    const limits = getModalResizeLimits(frame, startRect);
    const startX = event.clientX;
    const startY = event.clientY;

    frame.classList.add("modalUserResized");
    frame.style.left = `${startRect.left}px`;
    frame.style.top = `${startRect.top}px`;
    frame.style.width = `${startRect.width}px`;
    frame.style.height = `${startRect.height}px`;
    document.body.classList.add("modalResizing");
    handle.setPointerCapture?.(event.pointerId);

    const onPointerMove = (moveEvent) => {
      const nextWidth = clampModalValue(startRect.width + moveEvent.clientX - startX, limits.minWidth, limits.maxWidth);
      const nextHeight = clampModalValue(startRect.height + moveEvent.clientY - startY, limits.minHeight, limits.maxHeight);
      frame.style.width = `${nextWidth}px`;
      frame.style.height = `${nextHeight}px`;
    };

    const onPointerUp = (upEvent) => {
      document.body.classList.remove("modalResizing");
      constrainModalToViewport(frame);
      if (handle.hasPointerCapture?.(upEvent.pointerId)) {
        handle.releasePointerCapture(upEvent.pointerId);
      }
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerUp, { once: true });
  });
}

function normalizeColorValue(value, fallback = DEFAULT_EVENT_COLOR) {
  const color = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color : fallback;
}

function normalizeTagLabel(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function normalizeTagKey(value) {
  return normalizeTagLabel(value).toLowerCase();
}

function parseTagsValue(value) {
  return String(value || "")
    .split(",")
    .map(normalizeTagLabel)
    .filter(Boolean);
}

function loadJsonMap(storageKey) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function saveJsonMap(storageKey, value) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(value || {}));
  } catch (err) {
    console.warn("Unable to save calendar color settings", err);
  }
}

function loadTagColorSettings() {
  return tagColorSettingsCache;
}

function saveTagColorSettings(settings) {
  tagColorSettingsCache = settings || {};
  saveJsonMap(TAG_COLOR_STORAGE_KEY, tagColorSettingsCache);
}

async function loadTagColorSettingsFromServer() {
  if (tagColorSettingsReady) return tagColorSettingsCache;
  try {
    const res = await apiFetch("/calendar/tag-colors");
    if (!res || !res.ok) throw new Error("Tag color settings unavailable");
    const data = await res.json();
    tagColorSettingsServerAvailable = true;
    tagColorSettingsReady = true;
    saveTagColorSettings(data.settings || {});
  } catch (err) {
    tagColorSettingsReady = true;
    tagColorSettingsServerAvailable = false;
    console.warn("Tag color settings API unavailable; using local fallback", err);
  }
  refreshTagDatalist();
  renderTagColorRows();
  refreshCalendarEventColors();
  return tagColorSettingsCache;
}

async function persistTagColorSettings(settings) {
  saveTagColorSettings(settings);
  if (!tagColorSettingsServerAvailable) return;
  try {
    const res = await apiFetch("/calendar/tag-colors", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings })
    });
    if (!res || !res.ok) throw new Error("Tag color save failed");
    const data = await res.json();
    saveTagColorSettings(data.settings || settings);
  } catch (err) {
    console.warn("Tag color settings save failed; retained local fallback", err);
    window.showToast?.("Tag color settings saved locally only", "warning");
  }
}

function isEventColorEnabled(eventRef = null) {
  if (!eventRef) return false;
  if (eventRef?.extendedProps && "eventColorEnabled" in eventRef.extendedProps) {
    return eventRef.extendedProps.eventColorEnabled === true;
  }
  if ("color_enabled" in eventRef) return eventRef.color_enabled === true;
  const backendId = eventRef?.extendedProps?.backendId || eventRef?.id || null;
  return backendId != null && loadJsonMap(EVENT_COLOR_ENABLED_STORAGE_KEY)[String(backendId)] === true;
}

function getKnownTagLabels() {
  const labels = new Map();
  Object.values(loadTagColorSettings()).forEach((entry) => {
    const label = normalizeTagLabel(entry?.label);
    if (label) labels.set(normalizeTagKey(label), label);
  });
  (window.sessionEventCache || []).forEach((eventRef) => {
    const tags = eventRef?.extendedProps?.tags || eventRef?.tags || [];
    (Array.isArray(tags) ? tags : parseTagsValue(tags)).forEach((tag) => {
      labels.set(normalizeTagKey(tag), normalizeTagLabel(tag));
    });
  });
  return [...labels.values()].sort((a, b) => a.localeCompare(b));
}

function ensureTagsInRegistry(tags) {
  const settings = loadTagColorSettings();
  let changed = false;
  tags.forEach((tag) => {
    const label = normalizeTagLabel(tag);
    const key = normalizeTagKey(label);
    if (!key || settings[key]) return;
    settings[key] = { label, color: DEFAULT_EVENT_COLOR, enabled: false };
    changed = true;
  });
  if (changed) persistTagColorSettings(settings);
  return settings;
}

function refreshTagDatalist() {
  const list = document.getElementById("eventTagOptions");
  if (!list) return;
  list.innerHTML = getKnownTagLabels()
    .map((label) => `<option value="${escapeHtml(label)}"></option>`)
    .join("");
}

function refreshCalendarEventColors() {
  window.calendar?.refetchEvents?.();
  window.updateDayDetails?.();
  window.updateWeekView?.();
}

function syncEventColorControl() {
  const enabled = document.getElementById("eventColorEnabled");
  const color = document.getElementById("eventColor");
  if (!enabled || !color) return;
  color.disabled = !enabled.checked;
  color.classList.toggle("colorInputDisabled", !enabled.checked);
}

function getCurrentModalTags() {
  return parseTagsValue(document.getElementById("eventTags")?.value || "");
}

function getEnabledTagEntriesForCurrentEvent(settings = loadTagColorSettings()) {
  return getCurrentModalTags()
    .map((tag) => {
      const key = normalizeTagKey(tag);
      const entry = settings[key];
      return entry?.enabled ? { key, entry } : null;
    })
    .filter(Boolean);
}

function setEventColorControlValue(color, enabled = true) {
  const enabledInput = document.getElementById("eventColorEnabled");
  const colorInput = document.getElementById("eventColor");
  if (enabledInput) enabledInput.checked = enabled;
  if (colorInput) colorInput.value = normalizeColorValue(color);
  syncEventColorControl();
}

function syncEventColorToPrimaryEnabledTag() {
  const enabledTags = getEnabledTagEntriesForCurrentEvent();
  if (!enabledTags.length) return;
  setEventColorControlValue(enabledTags[0].entry.color, true);
}

function syncCurrentTagColorInputs(settings = loadTagColorSettings()) {
  document.querySelectorAll(".tagColorRow[data-tag-key]").forEach((row) => {
    const entry = settings[row.dataset.tagKey];
    const colorInput = row.querySelector("[data-tag-color]");
    const enabledInput = row.querySelector("[data-tag-color-enabled]");
    if (!entry || !colorInput || !enabledInput) return;
    enabledInput.checked = entry.enabled === true;
    colorInput.disabled = !entry.enabled;
    colorInput.value = normalizeColorValue(entry.color);
  });
}

function previewEventColorOnEnabledTagInputs(nextColor) {
  const normalized = normalizeColorValue(nextColor);
  getEnabledTagEntriesForCurrentEvent().forEach(({ key }) => {
    const row = document.querySelector(`.tagColorRow[data-tag-key="${CSS.escape(key)}"]`);
    const colorInput = row?.querySelector?.("[data-tag-color]");
    if (colorInput) colorInput.value = normalized;
  });
}

function buildColorChip(color) {
  const normalized = normalizeColorValue(color);
  return `
    <span class="tagColorConfirmChip">
      <span class="tagColorConfirmSwatch" style="background:${escapeHtml(normalized)}"></span>
      <code>${escapeHtml(normalized)}</code>
    </span>
  `;
}

function confirmTagColorChange({ labelText, currentColors, nextColor }) {
  const normalizedNext = normalizeColorValue(nextColor);
  const currentList = [...new Set((currentColors || []).map((color) => normalizeColorValue(color)))];

  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "tagColorConfirmOverlay";
    overlay.innerHTML = `
      <div class="tagColorConfirmDialog" role="dialog" aria-modal="true" aria-labelledby="tagColorConfirmTitle">
        <button type="button" class="tagColorConfirmClose" data-confirm-action="cancel" aria-label="Cancel color change">×</button>
        <h3 id="tagColorConfirmTitle">Change Tag Color?</h3>
        <p>Changing <strong>${escapeHtml(labelText)}</strong> updates the render color for all events with the same tag.</p>
        <div class="tagColorConfirmRows">
          <div><span>Current</span><div>${currentList.map(buildColorChip).join("")}</div></div>
          <div><span>New</span><div>${buildColorChip(normalizedNext)}</div></div>
        </div>
        <div class="tagColorConfirmActions">
          <button type="button" class="secondaryBtn" data-confirm-action="cancel">Cancel</button>
          <button type="button" class="primaryBtn" data-confirm-action="ok">Change Color</button>
        </div>
      </div>
    `;

    const onKeyDown = (event) => {
      if (event.key === "Escape") finish(false);
    };

    const finish = (ok) => {
      overlay.remove();
      document.removeEventListener("keydown", onKeyDown);
      resolve(ok);
    };

    overlay.addEventListener("click", (event) => {
      const action = event.target?.closest?.("[data-confirm-action]")?.dataset.confirmAction;
      if (action === "ok") finish(true);
      if (action === "cancel" || event.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKeyDown);
    document.body.appendChild(overlay);
    overlay.querySelector("[data-confirm-action='ok']")?.focus();
  });
}

async function applyEventColorToEnabledTags(nextColor) {
  const settings = loadTagColorSettings();
  const enabledTags = getEnabledTagEntriesForCurrentEvent(settings);
  if (!enabledTags.length) return true;

  const normalized = normalizeColorValue(nextColor);
  const changing = enabledTags.filter(({ entry }) => normalizeColorValue(entry.color).toLowerCase() !== normalized.toLowerCase());
  if (!changing.length) return true;

  const labels = changing.map(({ entry, key }) => entry.label || key).join(", ");
  const currentColors = changing.map(({ entry }) => normalizeColorValue(entry.color));
  const ok = await confirmTagColorChange({ labelText: labels, currentColors, nextColor: normalized });
  if (!ok) {
    syncEventColorToPrimaryEnabledTag();
    return false;
  }

  changing.forEach(({ entry }) => {
    entry.color = normalized;
  });
  persistTagColorSettings(settings);
  syncCurrentTagColorInputs(settings);
  refreshCalendarEventColors();
  return true;
}

function renderTagColorRows() {
  const holder = document.getElementById("eventTagColorRows");
  const tagsInput = document.getElementById("eventTags");
  if (!holder || !tagsInput) return;

  const tags = parseTagsValue(tagsInput.value);
  const settings = ensureTagsInRegistry(tags);
  refreshTagDatalist();

  holder.innerHTML = tags.map((tag) => {
    const key = normalizeTagKey(tag);
    const entry = settings[key] || { label: tag, color: DEFAULT_EVENT_COLOR, enabled: false };
    return `
      <div class="tagColorRow" data-tag-key="${escapeHtml(key)}">
        <span class="tagColorName">${escapeHtml(entry.label || tag)}</span>
        <label class="inlineToggle"><input type="checkbox" data-tag-color-enabled ${entry.enabled ? "checked" : ""} /> Color</label>
        <input type="color" data-tag-color value="${escapeHtml(normalizeColorValue(entry.color))}" ${entry.enabled ? "" : "disabled"} />
      </div>
    `;
  }).join("");
  syncEventColorToPrimaryEnabledTag();
}

function resolveEventRenderColor(eventLike = null, accountColor = "#4285f4") {
  const settings = loadTagColorSettings();
  const rawTags = eventLike?.extendedProps?.tags || eventLike?.tags || [];
  const tags = Array.isArray(rawTags) ? rawTags : parseTagsValue(rawTags);
  for (const tag of tags) {
    const entry = settings[normalizeTagKey(tag)];
    if (entry?.enabled) return normalizeColorValue(entry.color, accountColor);
  }

  if (isEventColorEnabled(eventLike)) {
    const eventColor = eventLike?.extendedProps?.eventColor || eventLike?.color || null;
    if (eventColor) return normalizeColorValue(eventColor, accountColor);
  }

  return normalizeColorValue(accountColor, "#4285f4");
}

window.resolveEventRenderColor = resolveEventRenderColor;

function resetWindowFrame(frame) {
  if (!frame) return;
  frame.classList.remove("windowFrameMinimized", "windowFrameMaximized");
  frame.querySelectorAll(".windowControlBtn[data-window-action='maximize']").forEach((btn) => {
    btn.setAttribute("aria-label", "Maximize window");
    btn.title = "Maximize";
    btn.textContent = "□";
  });
}

function closeWindowFrame(frame) {
  if (!frame) return;
  if (frame.id === "createEventModal") {
    closeCreateModal();
    return;
  }
  if (frame.id === "publishConfirmDialog") {
    closePublishConfirmationDialog();
    return;
  }
  frame.classList.remove("show");
}

function toggleWindowMinimized(frame) {
  if (!frame) return;
  const minimized = frame.classList.toggle("windowFrameMinimized");
  if (minimized) frame.classList.remove("windowFrameMaximized");
}

function toggleWindowMaximized(frame, button) {
  if (!frame) return;
  const maximized = frame.classList.toggle("windowFrameMaximized");
  if (maximized) frame.classList.remove("windowFrameMinimized");
  if (button) {
    button.setAttribute("aria-label", maximized ? "Restore window" : "Maximize window");
    button.title = maximized ? "Restore" : "Maximize";
    button.textContent = maximized ? "❐" : "□";
  }
}

function installWindowControls(frame, header) {
  if (!frame || !header || header.querySelector(".windowControls")) return;
  frame.classList.add("windowFrame");
  header.classList.add("windowHeaderWithControls");
  const controls = document.createElement("div");
  controls.className = "windowControls";
  controls.innerHTML = `
    <button type="button" class="windowControlBtn" data-window-action="minimize" aria-label="Minimize window" title="Minimize">−</button>
    <button type="button" class="windowControlBtn" data-window-action="maximize" aria-label="Maximize window" title="Maximize">□</button>
    <button type="button" class="windowControlBtn close" data-window-action="close" aria-label="Close window" title="Close">×</button>
  `;
  header.appendChild(controls);
}

function initModalWindowControls() {
  if (modalWindowControlsReady) return;
  modalWindowControlsReady = true;

  const createEventModal = document.getElementById("createEventModal");
  installWindowControls(createEventModal, document.querySelector("#createEventModal .modalHeader"));
  installModalResizeHandle(createEventModal);
  installWindowControls(document.getElementById("publishConfirmDialog"), document.querySelector("#publishConfirmDialog .publishConfirmHeader"));

  if (!modalResizeReady) {
    modalResizeReady = true;
    window.addEventListener("resize", () => constrainModalToViewport(document.getElementById("createEventModal")));
  }

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(".windowControlBtn[data-window-action]");
    if (!button) return;

    const frame = button.closest(".windowFrame");
    const action = button.dataset.windowAction;
    if (!frame || !action) return;

    event.preventDefault();
    event.stopPropagation();

    if (action === "minimize") toggleWindowMinimized(frame);
    if (action === "maximize") toggleWindowMaximized(frame, button);
    if (action === "close") closeWindowFrame(frame);
  });
}

function normalizeAccountKey(provider, email) {
  return `${String(provider || "local").toLowerCase().trim()}:${String(email || "local").toLowerCase().trim()}`;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getConnectedCalendarAccounts() {
  return Array.isArray(window.connectedCalendarAccounts) ? window.connectedCalendarAccounts : [];
}

function getEventExternalIds(eventRef = null) {
  return {
    ...(eventRef?.external_ids || {}),
    ...(eventRef?.extendedProps?.external_ids || {}),
  };
}

function normalizeEventTitleForLinking(eventRef = null) {
  return String(eventRef?.title || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function parseEventDateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isAllDayLikeWindow(start, end) {
  if (!start || !end) return false;
  if (start.getHours() !== 0 || start.getMinutes() !== 0) return false;
  if (end.getHours() !== 0 || end.getMinutes() !== 0) return false;
  const span = end.getTime() - start.getTime();
  return span >= 0 && span <= 24 * 60 * 60 * 1000;
}

function eventLinkSignature(eventRef = null) {
  const title = normalizeEventTitleForLinking(eventRef);
  if (!title) return "";

  const start = parseEventDateValue(eventRef?.start || eventRef?.start_time);
  const end = parseEventDateValue(eventRef?.end || eventRef?.end_time);
  if (!start) return `title:${title}`;

  if (isAllDayLikeWindow(start, end)) {
    return `all-day:${title}:${toDayString(start)}`;
  }

  const startKey = new Date(start);
  startKey.setSeconds(0, 0);
  const endKey = end ? new Date(end) : null;
  if (endKey) endKey.setSeconds(0, 0);

  return `timed:${title}:${startKey.toISOString()}:${endKey ? endKey.toISOString() : ""}`;
}

function getLinkedKeysFromSiblingDuplicates(eventRef = null) {
  const targetSig = eventLinkSignature(eventRef);
  if (!targetSig) return new Set();

  const linked = new Set();
  const cache = Array.isArray(window.sessionEventCache) ? window.sessionEventCache : [];

  cache.forEach((candidate) => {
    if (!candidate) return;
    if (eventLinkSignature(candidate) !== targetSig) return;

    const key = String(candidate?.extendedProps?.account_key || candidate?.account_key || "").toLowerCase();
    if (key && key !== "local:local") linked.add(key);

    Object.keys(candidate?.external_ids || {}).forEach((externalKey) => {
      if (!externalKey || !externalKey.includes(":")) return;
      const [provider, email] = externalKey.split(":", 2);
      linked.add(normalizeAccountKey(provider, email));
    });

    Object.keys(candidate?.extendedProps?.external_ids || {}).forEach((externalKey) => {
      if (!externalKey || !externalKey.includes(":")) return;
      const [provider, email] = externalKey.split(":", 2);
      linked.add(normalizeAccountKey(provider, email));
    });
  });

  return linked;
}

function getExistingLinkedAccountKeys(eventRef = null) {
  const linked = new Set();
  Object.keys(getEventExternalIds(eventRef)).forEach((key) => {
    if (!key || typeof key !== "string" || !key.includes(":")) return;
    const [provider, email] = key.split(":", 2);
    linked.add(normalizeAccountKey(provider, email));
  });

  const currentKey = eventRef?.extendedProps?.account_key || eventRef?.account_key || "";
  if (currentKey && currentKey !== "local:local") linked.add(currentKey.toLowerCase());

  getLinkedKeysFromSiblingDuplicates(eventRef).forEach((key) => linked.add(key));

  return linked;
}

function buildModalAccountRows() {
  const linkedKeys = getExistingLinkedAccountKeys(modalState.eventRef);
  const shouldUpdateLinked = shouldUpdateLinkedPublishTargets();
  const connected = getConnectedCalendarAccounts();

  return connected
    .map((account) => {
      const provider = String(account?.provider || "").toLowerCase().trim();
      const email = String(account?.account_email || "").toLowerCase().trim();
      const key = normalizeAccountKey(provider, email);
      const linked = linkedKeys.has(key);
      const publishable = PUBLISHABLE_PROVIDERS.has(provider);
      return {
        key,
        provider,
        email,
        label: `${provider}: ${email}`,
        status: account?.status || "unknown",
        publishable,
        linked,
        actionable: publishable && (!linked || shouldUpdateLinked),
        disabled: !publishable || (linked && !shouldUpdateLinked),
        lockedLinked: linked && publishable && !shouldUpdateLinked,
      };
    })
    .sort((a, b) => {
      if (a.linked !== b.linked) return a.linked ? -1 : 1;
      if (a.publishable !== b.publishable) return a.publishable ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
}

function seedPublishTargetsFromEvent(eventRef = null) {
  modalState.publishTargetKeys = shouldUpdateLinkedPublishTargets(eventRef)
    ? [...getExistingLinkedAccountKeys(eventRef)]
    : [];
  modalState.publishAttemptConsumed = false;
  modalState.publishAttemptState = "idle";
}

function getEventContentSnapshot() {
  if (modalState.type === "sticky") {
    return JSON.stringify({
      type: "sticky",
      scope: modalState.stickyScope,
      dateKey: modalState.dateStickyKey,
      eventId: modalState.eventId,
      stickyNotes: modalState.stickyNotes.map((note) => ({
        content: String(note?.content || ""),
        color: String(note?.color || "#F7E68A")
      }))
    });
  }

  return JSON.stringify({
    type: "event",
    eventId: modalState.eventId,
    title: (document.getElementById("eventTitle")?.value || "").trim(),
    date: document.getElementById("eventDate")?.value || "",
    start: document.getElementById("eventStart")?.value || "",
    end: document.getElementById("eventEnd")?.value || "",
    description: getEditorHtml("eventDescriptionEditor"),
    tags: (document.getElementById("eventTags")?.value || "").trim(),
    color: document.getElementById("eventColor")?.value || "",
    colorEnabled: document.getElementById("eventColorEnabled")?.checked === true
  });
}

function eventContentHasUnsavedEdits() {
  if (!window.isModalOpen || !modalState.initialEventContentSnapshot) return false;
  return getEventContentSnapshot() !== modalState.initialEventContentSnapshot;
}

function eventHasPendingPublishUpdates(eventRef = modalState.eventRef) {
  const eventId = Number(modalState.eventId || eventRef?.extendedProps?.backendId || eventRef?.id);
  if (!Number.isFinite(eventId)) return false;

  const changes = [...(window.pendingPublishChanges?.values?.() || [])];
  return changes.some((change) => Number(change?.eventId) === eventId && change?.localOnly !== true);
}

function shouldUpdateLinkedPublishTargets(eventRef = modalState.eventRef) {
  return eventContentHasUnsavedEdits() || eventHasPendingPublishUpdates(eventRef);
}

function getSelectedPublishTargetKeys() {
  return [...new Set((modalState.publishTargetKeys || []).map((key) => String(key || "").toLowerCase()).filter(Boolean))];
}

function setSelectedPublishTargetKeys(keys) {
  modalState.publishTargetKeys = [...new Set((keys || []).map((key) => String(key || "").toLowerCase()).filter(Boolean))];
}

function collectSelectedKeysFromContainer(container) {
  if (!container) return [];
  return [...container.querySelectorAll('input[data-publish-account-key]:checked:not(:disabled)')].map((input) => String(input.value || "").toLowerCase());
}

function getPublishTargetSummary() {
  const rows = buildModalAccountRows();
  const selected = new Set(getSelectedPublishTargetKeys());
  return rows.filter((row) => selected.has(row.key));
}

function getActionablePublishTargetSummary() {
  return getPublishTargetSummary().filter((row) => row.publishable && row.actionable);
}

function getLockedLinkedPublishRows() {
  return buildModalAccountRows().filter((row) => row.lockedLinked);
}

function renderAccountSelectionChecklist(containerId, options = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  const rows = buildModalAccountRows();
  const selected = new Set(getSelectedPublishTargetKeys());
  const mode = options.mode || "editor";

  if (!rows.length) {
    container.innerHTML = '<div class="accountPublishEmpty">Connect calendar accounts to publish this event across calendars.</div>';
    return;
  }

  container.innerHTML = rows.map((row) => {
    const checked = (selected.has(row.key) || row.linked) ? "checked" : "";
    const disabled = row.disabled ? "disabled" : "";
    const badge = row.lockedLinked ? "Up to date" : (row.linked ? "Linked" : (row.publishable ? "Available" : "View only"));
    const hint = row.disabled
      ? (row.lockedLinked
        ? "Already published here. This row is locked until the event has edits that need republishing."
        : "Apple visibility is shown here, but direct publish to Apple is not supported in this build.")
      : (row.linked ? "Already linked to this event." : "Create or update this event on this calendar when published.");
    return `
      <label class="accountPublishRow ${row.linked ? "is-linked" : ""} ${row.disabled ? "is-disabled" : ""} ${row.lockedLinked ? "is-locked-linked" : ""}">
        <input type="checkbox" data-publish-account-key="1" value="${escapeHtml(row.key)}" ${checked} ${disabled} />
        <span class="accountPublishMeta">
          <span class="accountPublishLabel">${escapeHtml(row.label)}</span>
          <span class="accountPublishHint">${escapeHtml(hint)}</span>
        </span>
        <span class="accountPublishBadge ${row.linked ? "is-linked" : ""} ${row.disabled ? "is-disabled" : ""} ${row.lockedLinked ? "is-locked-linked" : ""}">${escapeHtml(badge)}</span>
      </label>`;
  }).join("");

  container.dataset.mode = mode;
}

function syncPublishSelectionStateFrom(container) {
  const picked = collectSelectedKeysFromContainer(container);
  setSelectedPublishTargetKeys(picked);
  modalState.publishAttemptConsumed = false;
  modalState.publishAttemptState = "idle";
  renderEventPublishControls();
  renderPublishConfirmationContents();
}

function renderConfirmPublishButtonState(options = {}) {
  const confirmBtn = document.getElementById("confirmPublishEventBtn");
  if (!confirmBtn) return;

  const actionableCount = getActionablePublishTargetSummary().length;
  const canPublish = actionableCount > 0 && !modalState.publishAttemptConsumed;
  const transientState = options.state || modalState.publishAttemptState || "idle";

  confirmBtn.classList.remove("publishBtnIdle", "publishBtnActive", "publishBtnSuccess", "publishBtnError", "is-publishing");

  if (isPublishingEvent) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Publishing...";
    confirmBtn.classList.add("publishBtnActive", "is-publishing");
    return;
  }

  if (transientState === "success") {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Publish Succeeded";
    confirmBtn.classList.add("publishBtnSuccess");
    return;
  }

  if (transientState === "error") {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Publish Failed";
    confirmBtn.classList.add("publishBtnError");
    return;
  }

  confirmBtn.disabled = !canPublish;
  confirmBtn.textContent = "Confirm Publish";
  confirmBtn.classList.add(canPublish ? "publishBtnActive" : "publishBtnIdle");
}

function renderEventPublishControls() {
  renderAccountSelectionChecklist("eventPublishTargets", { mode: "editor" });

  const selectedCount = getActionablePublishTargetSummary().length;
  const lockedLinkedCount = getLockedLinkedPublishRows().length;
  const info = document.getElementById("eventPublishSelectionInfo");
  const publishBtn = document.getElementById("publishEventBtn");
  if (info) {
    if (selectedCount > 0) {
      info.textContent = `${selectedCount} calendar${selectedCount === 1 ? "" : "s"} selected for one-event publish`;
    } else if (lockedLinkedCount > 0) {
      info.textContent = `${lockedLinkedCount} already-published calendar${lockedLinkedCount === 1 ? " is" : "s are"} up to date. Select a new calendar or edit this event to publish more changes.`;
    } else {
      info.textContent = "Select one or more publish-capable calendars to export this event.";
    }
  }
  if (publishBtn) {
    publishBtn.disabled = selectedCount === 0 || isPublishingEvent;
    publishBtn.textContent = isPublishingEvent ? "Publishing…" : "Publish This Event";
  }
}

function openPublishConfirmationDialog() {
  const dialog = document.getElementById("publishConfirmDialog");
  const overlay = document.getElementById("publishConfirmOverlay");
  if (!dialog || !overlay) return;
  initModalWindowControls();
  resetWindowFrame(dialog);
  renderPublishConfirmationContents();
  overlay.classList.add("show");
  dialog.classList.add("show");
}

function closePublishConfirmationDialog() {
  resetWindowFrame(document.getElementById("publishConfirmDialog"));
  document.getElementById("publishConfirmOverlay")?.classList.remove("show");
  document.getElementById("publishConfirmDialog")?.classList.remove("show");
}

function renderPublishConfirmationContents() {
  renderAccountSelectionChecklist("publishConfirmTargets", { mode: "confirm" });

  const summary = document.getElementById("publishConfirmSummary");
  renderConfirmPublishButtonState();
  if (!summary) return;

  const selectedRows = getPublishTargetSummary();
  const actionable = selectedRows.filter((row) => row.publishable && row.actionable);
  const linkedUpdates = actionable.filter((row) => row.linked).length;
  const newPublishes = actionable.filter((row) => !row.linked).length;
  const lockedLinkedCount = getLockedLinkedPublishRows().length;

  if (!actionable.length) {
    summary.textContent = lockedLinkedCount > 0
      ? "This event is already up to date on its linked calendars. Select a new calendar or make another event edit before confirming."
      : "Choose at least one publish-capable calendar before confirming.";
    return;
  }

  const parts = [];
  if (linkedUpdates > 0) {
    parts.push(`${linkedUpdates} linked calendar${linkedUpdates === 1 ? " copy will" : " copies will"} be updated`);
  }
  if (newPublishes > 0) {
    parts.push(`${newPublishes} newly selected calendar${newPublishes === 1 ? " will" : "s will"} get a new copy`);
  }
  if (lockedLinkedCount > 0 && linkedUpdates === 0) {
    parts.push(`${lockedLinkedCount} already-linked calendar${lockedLinkedCount === 1 ? " is" : "s are"} unchanged and will not be republished`);
  }
  summary.textContent = `Confirm publish: ${parts.join("; ")}.`;
}

function buildPublishFailureMessage(data, selectedKeys = []) {
  const results = Array.isArray(data?.account_results) ? data.account_results : [];
  const targeted = selectedKeys.length
    ? results.filter((item) => selectedKeys.includes(String(item?.target_key || "").toLowerCase()))
    : results;
  const failed = targeted.filter((item) => item && item.ok !== true && item.message);
  if (failed.length) {
    return failed.map((item) => item.message).join("; ");
  }

  const warnings = Array.isArray(data?.warnings) ? data.warnings.filter(Boolean) : [];
  if (warnings.length) {
    return warnings.join("; ");
  }

  return "No calendars were updated.";
}

function buildPublishRemediationHtml(message, selectedRows = []) {
  const lower = String(message || "").toLowerCase();
  const selectedMicrosoft = (selectedRows || []).find((row) => row && row.provider === "microsoft");
  const accountParam = encodeURIComponent(selectedMicrosoft?.email || "");
  const remediationHref = selectedMicrosoft
    ? `/accounts/ui?remedy_provider=microsoft&remedy_account=${accountParam}&remedy_action=verify_access`
    : "/accounts/ui";

  if (lower.includes("erroraccessdenied") || lower.includes("access is denied") || lower.includes("forbidden")) {
    const accountLabel = selectedMicrosoft ? `microsoft:${selectedMicrosoft.email}` : "microsoft account";
    return `
      <div style="margin-top:8px; font-size:12px; line-height:1.45; color:#7f1d1d;">
        Resolution path: <a href="${remediationHref}" style="font-weight:600;">Open Account Manager</a>,
        click <strong>Verify Access</strong> for <strong>${escapeHtml(accountLabel)}</strong>.
        If write access is still denied, click <strong>Reconnect</strong>, complete Microsoft consent,
        return here, then publish again.
      </div>`;
  }

  if (lower.includes("no valid token") || lower.includes("expired") || lower.includes("invalid")) {
    const accountLabel = selectedMicrosoft ? `microsoft:${selectedMicrosoft.email}` : "the account";
    return `
      <div style="margin-top:8px; font-size:12px; line-height:1.45; color:#7f1d1d;">
        Resolution path: Reconnect <strong>${escapeHtml(accountLabel)}</strong> in
        <a href="${remediationHref}" style="font-weight:600;">Account Manager</a>, then retry publish.
      </div>`;
  }

  return "";
}

const DATE_STICKY_STORAGE_KEY = "sj_date_sticky_notes_v1";
let dateStickyMap = {};
let dateStickyStoreReady = false;

function loadDateStickyMap() {
  try {
    const raw = localStorage.getItem(DATE_STICKY_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function persistLocalDateStickyMap() {
  try {
    localStorage.setItem(DATE_STICKY_STORAGE_KEY, JSON.stringify(dateStickyMap));
  } catch {
    // localStorage quota errors are ignored to avoid breaking save UX.
  }
}

async function loadDateStickyMapFromServer() {
  const res = await apiFetch("/calendar/date-sticky");
  if (!res || !res.ok) throw new Error("Failed to load date sticky notes");

  const data = await res.json();
  const items = Array.isArray(data?.items) ? data.items : [];

  const next = {};
  items.forEach((item) => {
    const key = String(item?.date || "").trim();
    if (!key) return;
    const notes = normalize_sticky_notes_frontend(item?.sticky_notes || item?.stickyNotes || []);
    if (notes.length) next[key] = notes;
  });

  dateStickyMap = next;
}

async function upsertDateStickyServer(dateKey, notes) {
  const res = await apiFetch(`/calendar/date-sticky/${encodeURIComponent(dateKey)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sticky_notes: notes })
  });
  if (!res || !res.ok) throw new Error("Failed to save date sticky notes");
  return res.json();
}

async function migrateLocalDateStickiesIfNeeded() {
  const localMap = loadDateStickyMap();
  const keys = Object.keys(localMap || {});
  if (!keys.length) return;

  let migratedAny = false;
  for (const dateKey of keys) {
    const localNotes = normalize_sticky_notes_frontend(localMap[dateKey] || []);
    if (!localNotes.length) continue;
    if ((dateStickyMap[dateKey] || []).length) continue;

    await upsertDateStickyServer(dateKey, localNotes);
    dateStickyMap[dateKey] = localNotes;
    migratedAny = true;
  }

  if (migratedAny) {
    persistLocalDateStickyMap();
  }
}

async function initDateStickyStore() {
  if (dateStickyStoreReady) return;

  try {
    await loadDateStickyMapFromServer();
    await migrateLocalDateStickiesIfNeeded();
    dateStickyStoreReady = true;
  } catch (err) {
    console.warn("⚠️ Date sticky API unavailable; using local fallback", err);
    dateStickyMap = loadDateStickyMap();
    dateStickyStoreReady = true;
  }
}

function getDateStickyNotes(dateKey) {
  if (!dateKey) return [];
  const notes = dateStickyMap[dateKey];
  if (!Array.isArray(notes)) return [];
  return normalize_sticky_notes_frontend(notes);
}

function normalize_sticky_notes_frontend(notes) {
  return notes
    .map((n) => {
      if (!n || typeof n !== "object") return null;
      const content = String(n.content || "").trim();
      if (!content) return null;
      return {
        content,
        color: String(n.color || "#F7E68A"),
        createdAt: n.createdAt || new Date().toISOString(),
        updatedAt: n.updatedAt || new Date().toISOString()
      };
    })
    .filter(Boolean);
}

async function setDateStickyNotes(dateKey, notes) {
  if (!dateKey) return;
  const normalized = normalize_sticky_notes_frontend(notes || []);

  try {
    await upsertDateStickyServer(dateKey, normalized);
    if (normalized.length) {
      dateStickyMap[dateKey] = normalized;
    } else {
      delete dateStickyMap[dateKey];
    }
  } catch (err) {
    console.error("❌ Failed to persist date sticky notes", err);
    window.showToast?.("❌ Date sticky save failed", "error");
    return false;
  }

  persistLocalDateStickyMap();
  return true;
}

function getDateStickyCount(dateKey) {
  return getDateStickyNotes(dateKey).length;
}

function buildDateStickyTooltip(dateKey) {
  const notes = getDateStickyNotes(dateKey);
  const count = notes.length;
  if (!count) {
    return "Open date sticky note";
  }

  const first = String(notes[0]?.content || "")
    .replace(/\s+/g, " ")
    .trim();
  const preview = first.length > 80 ? `${first.slice(0, 80)}...` : first;
  const countText = count === 1 ? "1 sticky note" : `${count} sticky notes`;

  return `${countText}\n${preview || "(empty)"}`;
}

function refreshStickyVisuals() {
  window.updateDayDetails?.();
  window.updateWeekView?.();
  window.renderVisibleDateStickyIcons?.();
  if (window.selectedDate && typeof window.highlightSelectedDay === "function") {
    window.highlightSelectedDay(window.selectedDate);
  }
  if (window.calendar) {
    window.calendar.refetchEvents();
  }
}

function applyRangeTooltips() {
  document.querySelectorAll(".range-btn").forEach((btn) => {
    if (!btn.dataset.range) return;

    const days = parseInt(btn.dataset.range, 10);
    if (!days) return;

    const preview = getActiveRangeLabel(days);
    if (!preview?.label) return;

    btn.title = `Range: ${preview.label}\nStart: ${preview.start.toLocaleDateString()}\nEnd: ${preview.end.toLocaleDateString()}`;
  });
}

function parseSticky(eventRef) {
  const sticky = eventRef?.extendedProps?.stickyNote || eventRef?.sticky_note || null;
  if (!sticky || typeof sticky !== "object") {
    return { content: "", color: "#F7E68A", createdAt: null, updatedAt: null };
  }
  return {
    content: String(sticky.content || ""),
    color: String(sticky.color || "#F7E68A"),
    createdAt: sticky.createdAt || null,
    updatedAt: sticky.updatedAt || null
  };
}

function getEditorElement(editorId) {
  return document.getElementById(editorId);
}

function getEditorHtml(editorId) {
  const el = getEditorElement(editorId);
  if (!el) return "";
  return String(el.innerHTML || "").trim();
}

function getEditorPlainText(editorId) {
  const el = getEditorElement(editorId);
  if (!el) return "";
  return String(el.textContent || "").trim();
}

function setEditorHtml(editorId, html) {
  const el = getEditorElement(editorId);
  if (!el) return;
  el.innerHTML = html || "";
}

function hasMeaningfulContent(editorId) {
  return getEditorPlainText(editorId).length > 0;
}

function focusEditor(editorId) {
  const el = getEditorElement(editorId);
  if (el) {
    el.focus();
    activeRichEditorId = editorId;
  }
}

function execEditorCommand(editorId, cmd, value = null) {
  const el = getEditorElement(editorId);
  if (!el) return;

  el.focus();
  activeRichEditorId = editorId;

  if (value == null) {
    document.execCommand(cmd, false);
  } else {
    document.execCommand(cmd, false, value);
  }
}

function hideEditorContextMenu() {
  const menu = document.getElementById("editorContextMenu");
  if (!menu) return;
  menu.classList.remove("visible");
  menu.setAttribute("aria-hidden", "true");
}

function showEditorContextMenu(x, y, editorId) {
  const menu = document.getElementById("editorContextMenu");
  if (!menu) return;

  activeRichEditorId = editorId;
  menu.classList.add("visible");
  menu.setAttribute("aria-hidden", "false");

  const menuW = menu.offsetWidth || 180;
  const menuH = menu.offsetHeight || 190;
  const left = Math.min(x, window.innerWidth - menuW - 8);
  const top = Math.min(y, window.innerHeight - menuH - 8);

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function initRichEditorSystem() {
  const toolbars = document.querySelectorAll(".richToolbar[data-editor]");

  toolbars.forEach((toolbar) => {
    const editorId = toolbar.getAttribute("data-editor");
    if (!editorId) return;

    const editorEl = getEditorElement(editorId);
    if (!editorEl || editorEl.dataset.toolbarBound === "1") return;

    editorEl.dataset.toolbarBound = "1";

    editorEl.addEventListener("focus", () => {
      activeRichEditorId = editorId;
    });

    editorEl.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showEditorContextMenu(e.clientX, e.clientY, editorId);
    });

    toolbar.querySelectorAll(".rt-btn[data-cmd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const cmd = btn.getAttribute("data-cmd");
        if (!cmd) return;
        execEditorCommand(editorId, cmd);
      });
    });

    const fontSel = toolbar.querySelector(".rt-font");
    if (fontSel) {
      fontSel.addEventListener("change", () => {
        execEditorCommand(editorId, "fontName", fontSel.value);
      });
    }

    const sizeSel = toolbar.querySelector(".rt-size");
    if (sizeSel) {
      sizeSel.addEventListener("change", () => {
        execEditorCommand(editorId, "fontSize", sizeSel.value);
      });
    }

    const colorInput = toolbar.querySelector(".rt-color");
    if (colorInput) {
      colorInput.addEventListener("input", () => {
        execEditorCommand(editorId, "foreColor", colorInput.value);
      });
    }
  });

  const menu = document.getElementById("editorContextMenu");
  if (menu && menu.dataset.bound !== "1") {
    menu.dataset.bound = "1";

    menu.querySelectorAll("[data-ctx-cmd]").forEach((item) => {
      item.classList.add("editorContextItem");
      item.addEventListener("click", () => {
        const cmd = item.getAttribute("data-ctx-cmd");
        if (!cmd || !activeRichEditorId) return;
        execEditorCommand(activeRichEditorId, cmd);
        hideEditorContextMenu();
      });
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest("#editorContextMenu")) {
        hideEditorContextMenu();
      }
    });
  }

  document.querySelectorAll("[contenteditable='true']").forEach((el) => {
    if (el.dataset.ctxBound === "1") return;
    el.dataset.ctxBound = "1";

    el.addEventListener("focus", () => {
      if (el.id) activeRichEditorId = el.id;
    });

    el.addEventListener("contextmenu", (e) => {
      if (!el.id) return;
      e.preventDefault();
      e.stopPropagation();
      showEditorContextMenu(e.clientX, e.clientY, el.id);
    });
  });
}

function parseStickyNotes(eventRef) {
  const arr = eventRef?.extendedProps?.stickyNotes || eventRef?.sticky_notes || [];
  if (Array.isArray(arr) && arr.length) {
    return arr
      .map((s) => parseSticky({ extendedProps: { stickyNote: s } }))
      .filter((s) => String(s.content || "").trim());
  }

  const legacy = parseSticky(eventRef);
  if (String(legacy.content || "").trim()) return [legacy];
  return [];
}

function getCurrentSticky() {
  if (!modalState.stickyNotes.length) {
    return { content: "", color: "#F7E68A", createdAt: null, updatedAt: null };
  }
  const idx = Math.max(0, Math.min(modalState.stickyIndex, modalState.stickyNotes.length - 1));
  return modalState.stickyNotes[idx];
}

function renderStickyTabs() {
  const wrap = document.getElementById("stickyNotesList");
  if (!wrap) return;
  wrap.innerHTML = "";

  modalState.stickyNotes.forEach((note, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `stickyNoteTab${idx === modalState.stickyIndex ? " active" : ""}`;
    btn.textContent = `Sticky ${idx + 1}`;
    btn.addEventListener("click", () => {
      saveCurrentStickyIntoState();
      modalState.stickyIndex = idx;
      hydrateStickyEditorFromState();
    });
    wrap.appendChild(btn);
  });

  refreshStickyActionButtons();
}

function refreshStickyActionButtons() {
  const deleteStickyBtn = document.getElementById("deleteStickyBtn");
  if (!deleteStickyBtn) return;

  const canDeleteSticky = modalState.type === "sticky" && modalState.stickyNotes.length > 0;
  deleteStickyBtn.style.display = canDeleteSticky ? "inline-flex" : "none";
}

function saveCurrentStickyIntoState() {
  const current = getCurrentSticky();
  const content = getEditorHtml("eventStickyContentEditor");
  const hasContent = hasMeaningfulContent("eventStickyContentEditor");
  const color = document.getElementById("eventStickyColor")?.value || "#F7E68A";

  if (!hasContent && !String(current.content || "").trim()) return;

  const nowIso = new Date().toISOString();
  const next = {
    content,
    color,
    createdAt: current.createdAt || nowIso,
    updatedAt: nowIso
  };

  if (!modalState.stickyNotes.length) {
    modalState.stickyNotes.push(next);
    modalState.stickyIndex = 0;
  } else {
    modalState.stickyNotes[modalState.stickyIndex] = next;
  }
}

function hydrateStickyEditorFromState() {
  const sticky = getCurrentSticky();
  const stickyColor = document.getElementById("eventStickyColor");

  setEditorHtml("eventStickyContentEditor", sticky.content || "");
  if (stickyColor) stickyColor.value = sticky.color || "#F7E68A";
  setStickyPaperColor(sticky.color || "#F7E68A");
  renderStickyTabs();
}

function setStickyPaperColor(color) {
  const paper = document.getElementById("stickyPaper");
  if (paper) paper.style.setProperty("--sticky-note-color", color || "#F7E68A");
}

function formatMetaDate(value) {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleString();
}

function setModalType(type) {
  const modal = document.getElementById("createEventModal");
  if (!modal) return;

  modalState.type = type === "sticky" ? "sticky" : "event";
  modal.dataset.modalType = modalState.type;

  const title = document.getElementById("modalTitleText");
  const subtitle = document.getElementById("modalSubtitleText");
  const saveBtn = document.getElementById("saveEventBtn");
  const deleteBtn = document.getElementById("deleteEventBtn");
  const deleteStickyBtn = document.getElementById("deleteStickyBtn");
  const toStickyBtn = document.getElementById("openStickyFromEventBtn");
  const toEventBtn = document.getElementById("stickyBackToEventBtn");

  if (title) {
    title.textContent = modalState.type === "sticky"
      ? (modalState.stickyScope === "date" ? "Date Sticky Note" : "Sticky Note")
      : (modalState.eventId ? "Edit Event" : "Create Event");
  }
  if (subtitle) {
    subtitle.textContent = modalState.type === "sticky"
      ? (modalState.stickyScope === "date"
        ? "Sticky notes attached to a calendar date across all views."
        : "Sticky editor uses note-paper visuals to differentiate from event details.")
      : "Structured event editor with schedule, notes, tags, and sticky metadata.";
  }
  if (saveBtn) saveBtn.textContent = modalState.type === "sticky" ? "Save Sticky" : "Save Event";
  if (deleteBtn) deleteBtn.style.display = modalState.type === "event" && modalState.eventId ? "inline-flex" : "none";
  if (deleteStickyBtn) {
    const canDeleteSticky = modalState.type === "sticky" && modalState.stickyNotes.length > 0;
    deleteStickyBtn.style.display = canDeleteSticky ? "inline-flex" : "none";
  }
  if (toStickyBtn) toStickyBtn.style.display = modalState.type === "event" && modalState.eventId ? "inline-flex" : "none";
  if (toEventBtn) toEventBtn.style.display = modalState.type === "sticky" && modalState.stickyScope === "event" && modalState.eventId ? "inline-flex" : "none";
  refreshSaveButtonState();
}

function refreshSaveButtonState() {
  const saveBtn = document.getElementById("saveEventBtn");
  if (!saveBtn) return;

  if (modalState.type !== "event") {
    saveBtn.disabled = false;
    saveBtn.title = "Save this sticky note.";
    return;
  }

  const hasEdits = eventContentHasUnsavedEdits();
  saveBtn.disabled = !hasEdits || isSavingEvent;
  saveBtn.title = hasEdits
    ? "Save event changes."
    : "No event changes yet. Edit any field to enable Save.";
}

function fillModalFields(date = null, eventRef = null) {
  const now = new Date();
  const baseDate = date || eventRef?.start || now;

  const title = document.getElementById("eventTitle");
  const dateInput = document.getElementById("eventDate");
  const startInput = document.getElementById("eventStart");
  const endInput = document.getElementById("eventEnd");
  const desc = document.getElementById("eventDescriptionEditor");
  const tags = document.getElementById("eventTags");
  const color = document.getElementById("eventColor");
  const colorEnabled = document.getElementById("eventColorEnabled");
  const stickyContent = document.getElementById("eventStickyContentEditor");
  const stickyColor = document.getElementById("eventStickyColor");
  const created = document.getElementById("eventMetaCreated");
  const updated = document.getElementById("eventMetaUpdated");
  const source = document.getElementById("eventMetaSource");

  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(now.getHours() + (now.getMinutes() > 0 ? 1 : 0));
  const defaultEnd = new Date(nextHour);
  defaultEnd.setHours(nextHour.getHours() + 1);

  if (title) title.value = eventRef?.title || "";
  if (dateInput) dateInput.value = toDayString(baseDate);
  if (startInput) startInput.value = eventRef?.start ? new Date(eventRef.start).toTimeString().slice(0, 5) : nextHour.toTimeString().slice(0, 5);
  if (endInput) endInput.value = eventRef?.end ? new Date(eventRef.end).toTimeString().slice(0, 5) : defaultEnd.toTimeString().slice(0, 5);
  if (desc) desc.innerHTML = eventRef?.extendedProps?.description || eventRef?.description || "";

  if (tags) {
    const rawTags = eventRef?.extendedProps?.tags || eventRef?.tags || [];
    tags.value = Array.isArray(rawTags) ? rawTags.join(", ") : String(rawTags || "");
  }

  if (color) color.value = normalizeColorValue(eventRef?.extendedProps?.eventColor || eventRef?.color || DEFAULT_EVENT_COLOR);
  if (colorEnabled) colorEnabled.checked = isEventColorEnabled(eventRef);
  syncEventColorControl();
  renderTagColorRows();

  modalState.stickyNotes = parseStickyNotes(eventRef);
  modalState.stickyIndex = 0;

  const sticky = getCurrentSticky();
  if (stickyContent) stickyContent.innerHTML = sticky.content;
  if (stickyColor) stickyColor.value = sticky.color;
  setStickyPaperColor(sticky.color);
  renderStickyTabs();

  if (created) created.textContent = formatMetaDate(eventRef?.extendedProps?.createdAt || eventRef?.created_at || null);
  if (updated) updated.textContent = formatMetaDate(eventRef?.extendedProps?.updatedAt || eventRef?.updated_at || null);
  if (source) source.textContent = eventRef?.extendedProps?.source || eventRef?.source || "local";

  seedPublishTargetsFromEvent(eventRef);
  renderEventPublishControls();
}

function getModalEditSnapshot() {
  if (modalState.type === "sticky") {
    saveCurrentStickyIntoState();
    return JSON.stringify({
      type: "sticky",
      scope: modalState.stickyScope,
      dateKey: modalState.dateStickyKey,
      eventId: modalState.eventId,
      stickyNotes: modalState.stickyNotes.map((note) => ({
        content: String(note?.content || ""),
        color: String(note?.color || "#F7E68A")
      }))
    });
  }

  return JSON.stringify({
    type: "event",
    eventId: modalState.eventId,
    title: (document.getElementById("eventTitle")?.value || "").trim(),
    date: document.getElementById("eventDate")?.value || "",
    start: document.getElementById("eventStart")?.value || "",
    end: document.getElementById("eventEnd")?.value || "",
    description: getEditorHtml("eventDescriptionEditor"),
    tags: (document.getElementById("eventTags")?.value || "").trim(),
    color: document.getElementById("eventColor")?.value || "",
    colorEnabled: document.getElementById("eventColorEnabled")?.checked === true,
    publishTargets: getSelectedPublishTargetKeys()
  });
}

function markModalCleanSnapshot() {
  modalState.initialSnapshot = getModalEditSnapshot();
  modalState.initialEventContentSnapshot = getEventContentSnapshot();
  refreshSaveButtonState();
}

function modalHasUnsavedEdits() {
  if (!window.isModalOpen || !modalState.initialSnapshot) return false;
  return getModalEditSnapshot() !== modalState.initialSnapshot;
}

function closeUnsavedEditGuard() {
  document.getElementById("unsavedEditGuardOverlay")?.remove();
}

function openUnsavedEditGuard() {
  if (document.getElementById("unsavedEditGuardOverlay")) return;

  const overlay = document.createElement("div");
  overlay.id = "unsavedEditGuardOverlay";
  overlay.className = "unsavedEditGuardOverlay";
  const subject = modalState.type === "sticky" ? "sticky note" : "event";
  overlay.innerHTML = `
    <div class="unsavedEditGuardDialog" role="dialog" aria-modal="true" aria-labelledby="unsavedEditGuardTitle">
      <h3 id="unsavedEditGuardTitle">Unsaved ${subject} edits</h3>
      <p>You have changes that have not been saved yet.</p>
      <div class="unsavedEditGuardActions">
        <button type="button" data-unsaved-action="discard">Cancel</button>
        <button type="button" data-unsaved-action="resume">Resume edit</button>
        <button type="button" data-unsaved-action="save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.querySelector('[data-unsaved-action="discard"]')?.addEventListener("click", () => {
    closeUnsavedEditGuard();
    closeCreateModal({ force: true });
  });
  overlay.querySelector('[data-unsaved-action="resume"]')?.addEventListener("click", closeUnsavedEditGuard);
  overlay.querySelector('[data-unsaved-action="save"]')?.addEventListener("click", async () => {
    closeUnsavedEditGuard();
    await saveEvent();
  });
}

function openModal(type = "event", date = null, eventRef = null) {
  const modal = document.getElementById("createEventModal");
  if (!modal) return;

  initModalWindowControls();
  resetWindowFrame(modal);
  constrainModalToViewport(modal);

  window.isModalOpen = true;
  modalState.eventRef = eventRef || null;
  modalState.eventId = eventRef?.extendedProps?.backendId || eventRef?.id || null;
  modalState.stickyScope = "event";
  modalState.dateStickyKey = null;
  window.editingEventId = modalState.eventId;
  modalState.publishTargetKeys = [];
  modalState.publishAttemptConsumed = false;
  modalState.publishAttemptState = "idle";

  fillModalFields(date, eventRef);
  setModalType(type);

  modal.classList.add("show");
  document.getElementById("modalOverlay")?.classList.add("show");
  markModalCleanSnapshot();

  if (type === "sticky") {
    focusEditor("eventStickyContentEditor");
  } else {
    document.getElementById("eventTitle")?.focus();
  }
}

function openCreateModal(date = null, event = null) {
  openModal("event", date, event);
}

function openStickyModal(event = null, stickyIndex = 0) {
  openModal("sticky", null, event || modalState.eventRef);
  if (Number.isInteger(stickyIndex) && stickyIndex >= 0 && modalState.stickyNotes.length) {
    modalState.stickyIndex = Math.min(stickyIndex, modalState.stickyNotes.length - 1);
    hydrateStickyEditorFromState();
  }
}

function openDateStickyModal(dateInput = null, stickyIndex = 0) {
  const dateKey = typeof dateInput === "string"
    ? dateInput
    : (dateInput ? toDayString(dateInput) : (window.selectedDate || toDayString(new Date())));

  modalState.type = "sticky";
  modalState.stickyScope = "date";
  modalState.dateStickyKey = dateKey;
  modalState.eventRef = null;
  modalState.eventId = null;
  window.editingEventId = null;

  const modal = document.getElementById("createEventModal");
  if (!modal) return;
  initModalWindowControls();
  resetWindowFrame(modal);
  constrainModalToViewport(modal);
  window.isModalOpen = true;

  fillModalFields(new Date(`${dateKey}T12:00:00`), null);
  modalState.stickyNotes = getDateStickyNotes(dateKey);
  modalState.stickyIndex = Number.isInteger(stickyIndex) && stickyIndex >= 0
    ? Math.min(stickyIndex, Math.max(0, modalState.stickyNotes.length - 1))
    : 0;
  hydrateStickyEditorFromState();

  setModalType("sticky");
  modal.classList.add("show");
  document.getElementById("modalOverlay")?.classList.add("show");
  markModalCleanSnapshot();
  focusEditor("eventStickyContentEditor");
}

function openStickyModalForNew(event = null) {
  openStickyModal(event);
  const hasContent = modalState.stickyNotes.some((n) => String(n.content || "").trim());
  if (hasContent) {
    saveCurrentStickyIntoState();
    modalState.stickyNotes.push({
      content: "",
      color: "#F7E68A",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    modalState.stickyIndex = modalState.stickyNotes.length - 1;
    hydrateStickyEditorFromState();
  }
  focusEditor("eventStickyContentEditor");
  markModalCleanSnapshot();
}

function closeCreateModal(options = {}) {
  if (!options.force && modalHasUnsavedEdits()) {
    openUnsavedEditGuard();
    return false;
  }

  window.isModalOpen = false;
  modalState.initialSnapshot = null;
  modalState.initialEventContentSnapshot = null;
  closeUnsavedEditGuard();
  closePublishConfirmationDialog();
  resetWindowFrame(document.getElementById("createEventModal"));
  document.getElementById("createEventModal")?.classList.remove("show");
  document.getElementById("modalOverlay")?.classList.remove("show");
  return true;
}

function normalizeEventForCache(eventData, fallback = null) {
  const ext = eventData?.extendedProps || {};
  const startVal = eventData?.start || eventData?.start_time || fallback?.start;
  const endVal = eventData?.end || eventData?.end_time || fallback?.end;

  const stickyNotes = ext.stickyNotes || eventData?.sticky_notes || fallback?.extendedProps?.stickyNotes || [];
  const stickyNote = ext.stickyNote || eventData?.sticky_note || stickyNotes?.[0] || fallback?.extendedProps?.stickyNote || null;

  return {
    id: eventData?.external_id || eventData?.id || fallback?.id,
    external_ids: eventData?.external_ids || ext.external_ids || fallback?.external_ids || fallback?.extendedProps?.external_ids || {},
    title: eventData?.title || fallback?.title || "Untitled",
    start: startVal ? new Date(startVal) : null,
    end: endVal ? new Date(endVal) : null,
    color: eventData?.color || fallback?.color || null,
    color_enabled: eventData?.color_enabled === true || ext.eventColorEnabled === true || fallback?.color_enabled === true || fallback?.extendedProps?.eventColorEnabled === true,
    extendedProps: {
      backendId: eventData?.id || ext.backendId || fallback?.extendedProps?.backendId || null,
      source: ext.source || eventData?.source || fallback?.extendedProps?.source || "local",
      account: ext.account || eventData?.account_email || fallback?.extendedProps?.account || "local",
      account_key: ext.account_key || eventData?.account_key || fallback?.extendedProps?.account_key || "local:local",
      external_ids: ext.external_ids || eventData?.external_ids || fallback?.extendedProps?.external_ids || {},
      description: ext.description || eventData?.description || fallback?.extendedProps?.description || "",
      tags: ext.tags || eventData?.tags || fallback?.extendedProps?.tags || [],
      eventColor: ext.eventColor || eventData?.color || fallback?.extendedProps?.eventColor || "#4F8EF7",
      eventColorEnabled: eventData?.color_enabled === true || ext.eventColorEnabled === true || fallback?.color_enabled === true || fallback?.extendedProps?.eventColorEnabled === true,
      stickyNote,
      stickyNotes,
      createdAt: ext.createdAt || eventData?.created_at || fallback?.extendedProps?.createdAt || null,
      updatedAt: ext.updatedAt || eventData?.updated_at || fallback?.extendedProps?.updatedAt || null
    }
  };
}

function upsertCacheEvent(nextEvent) {
  const cache = window.sessionEventCache || [];
  const backendId = nextEvent?.extendedProps?.backendId;

  let index = -1;
  if (backendId != null) {
    index = cache.findIndex((e) => String(e?.extendedProps?.backendId) === String(backendId));
  }
  if (index < 0 && nextEvent?.id != null) {
    index = cache.findIndex((e) => String(e?.id) === String(nextEvent.id));
  }

  if (index >= 0) {
    cache[index] = { ...cache[index], ...nextEvent, extendedProps: { ...cache[index].extendedProps, ...nextEvent.extendedProps } };
  } else {
    cache.push(nextEvent);
  }

  window.sessionEventCache = cache;
}

function buildEventPayload() {
  const title = (document.getElementById("eventTitle")?.value || "").trim();
  const date = document.getElementById("eventDate")?.value || "";
  const start = document.getElementById("eventStart")?.value || "";
  const end = document.getElementById("eventEnd")?.value || "";

  if (!title || !date) {
    alert("Title and date are required");
    return null;
  }

  const description = getEditorHtml("eventDescriptionEditor");
  const tags = (document.getElementById("eventTags")?.value || "").split(",").map((s) => s.trim()).filter(Boolean);
  const eventColorEnabled = document.getElementById("eventColorEnabled")?.checked === true;
  const eventColor = eventColorEnabled ? normalizeColorValue(document.getElementById("eventColor")?.value) : null;
  ensureTagsInRegistry(tags);

  saveCurrentStickyIntoState();
  const sticky_notes = modalState.stickyNotes.filter((n) => String(n.content || "").trim());
  const sticky_note = sticky_notes[0] || null;

  const source = modalState.eventRef?.extendedProps?.source || "local";
  const accountEmail = modalState.eventRef?.extendedProps?.account || "local";

  return {
    title,
    description,
    start_time: start ? new Date(`${date}T${start}`).toISOString() : new Date(`${date}T00:00`).toISOString(),
    end_time: end ? new Date(`${date}T${end}`).toISOString() : null,
    color: eventColor,
    color_enabled: eventColorEnabled,
    tags,
    sticky_notes,
    sticky_note,
    source,
    account_email: accountEmail
  };
}

async function saveStickyOnly() {
  if (isSavingSticky) return;

  if (modalState.stickyScope === "date") {
    saveCurrentStickyIntoState();
    const sticky_notes = modalState.stickyNotes.filter((n) => String(n.content || "").trim());
    const dateKey = modalState.dateStickyKey;
    const previousStickies = dateStickyMap[dateKey] ? JSON.parse(JSON.stringify(dateStickyMap[dateKey])) : [];

    isSavingSticky = true;
    try {
      // Create undo/redo command for date sticky
      const command = {
        label: "Save date sticky note",
        execute: async () => {
          const res = await apiFetch(`/calendar/date-sticky/${encodeURIComponent(dateKey)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sticky_notes })
          });
          if (!res || !res.ok) throw new Error("Save failed");
          return res.json();
        },
        undo: async () => {
          const res = await apiFetch(`/calendar/date-sticky/${encodeURIComponent(dateKey)}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sticky_notes: previousStickies })
          });
          if (!res || !res.ok) throw new Error("Restore failed");
          return res.json();
        }
      };

      await command.execute();
      dateStickyMap[dateKey] = sticky_notes;
      persistLocalDateStickyMap();

      // Register to undo/redo history (already executed)
      await window.undoRedoManager.registerExecuted(command);

      closeCreateModal({ force: true });
      refreshStickyVisuals();
      window.trackPendingPublishChange?.({
        key: `sticky-date:${dateKey}`,
        category: "sticky Note",
        summary: `Date sticky note saved for ${dateKey}`,
        dateKey,
        localOnly: true
      });
      window.showToast?.("📝 Date sticky note saved");
      updateUndoRedoButtonStates();
    } catch (err) {
      console.error("❌ Date sticky save failed", err);
      window.showToast?.("❌ Date sticky save failed", "error");
    } finally {
      isSavingSticky = false;
    }
    return;
  }

  if (!modalState.eventId) {
    saveCurrentStickyIntoState();
    renderStickyTabs();
    window.showToast?.("📝 Sticky note added to the event draft");
    return;
  }

  saveCurrentStickyIntoState();
  const sticky_notes = modalState.stickyNotes.filter((n) => String(n.content || "").trim());
  const sticky_note = sticky_notes[0] || null;
  const previousStickies = modalState.eventRef?.extendedProps?.sticky_notes ? JSON.parse(JSON.stringify(modalState.eventRef.extendedProps.sticky_notes)) : [];

  isSavingSticky = true;
  try {
    // Create undo/redo command for event sticky
    const command = {
      label: "Save sticky note",
      execute: async () => {
        const res = await apiFetch(`/calendar/event/${modalState.eventId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sticky_note, sticky_notes })
        });
        if (!res || !res.ok) throw new Error("Sticky save failed");
        return res.json();
      },
      undo: async () => {
        const res = await apiFetch(`/calendar/event/${modalState.eventId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sticky_notes: previousStickies })
        });
        if (!res || !res.ok) throw new Error("Restore failed");
        return res.json();
      }
    };

    const data = await command.execute();
    const nextEvent = normalizeEventForCache(data.event, modalState.eventRef);
    modalState.eventRef = nextEvent;
    upsertCacheEvent(nextEvent);
    const stickySavedId = nextEvent.extendedProps?.backendId ?? modalState.eventId;
    window.trackModifiedEvent?.(stickySavedId, {
      category: "sticky Note",
      summary: `Sticky note updated: ${nextEvent.title || "Untitled event"}`
    });

    // Register to undo/redo history (already executed)
    await window.undoRedoManager.registerExecuted(command);

    window.updateDayDetails?.();
    window.updateWeekView?.();
    closeCreateModal({ force: true });
    window.showToast?.("📝 Sticky note saved");
    window.smartRefresh?.({ reason: "sticky_saved", force: true });
    updateUndoRedoButtonStates();
  } catch (err) {
    console.error("❌ Sticky save failed", err);
    window.showToast?.("❌ Sticky save failed", "error");
  } finally {
    isSavingSticky = false;
  }
}

async function persistEventRecord({ closeAfterSave = false, showSuccessToast = false } = {}) {
  if (isSavingEvent) return null;
  const payload = buildEventPayload();
  if (!payload) return null;

  const isEdit = !!modalState.eventId;
  const previousEvent = isEdit ? JSON.parse(JSON.stringify(modalState.eventRef)) : null;

  isSavingEvent = true;
  try {
    const command = {
      label: isEdit ? "Edit event" : "Create event",
      execute: async () => {
        const res = await apiFetch(isEdit ? `/calendar/event/${modalState.eventId}` : "/calendar/event", {
          method: isEdit ? "PUT" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res || !res.ok) throw new Error("Save failed");
        return res.json();
      },
      undo: async () => {
        if (!isEdit && modalState.eventId) {
          const res = await apiFetch(`/calendar/event/${modalState.eventId}`, { method: "DELETE" });
          if (!res || !res.ok) throw new Error("Delete failed");
        } else if (previousEvent && isEdit && modalState.eventId) {
          const res = await apiFetch(`/calendar/event/${modalState.eventId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(previousEvent)
          });
          if (!res || !res.ok) throw new Error("Restore failed");
          return res.json();
        }
      }
    };

    const data = await command.execute();
    const nextEvent = normalizeEventForCache(data.event, modalState.eventRef);
    modalState.eventRef = nextEvent;
    modalState.eventId = nextEvent.extendedProps?.backendId || modalState.eventId;

    if (!isEdit) {
      command.undo_eventId = modalState.eventId;
    }

    await window.undoRedoManager.registerExecuted(command);

    upsertCacheEvent(nextEvent);

    const savedId = nextEvent.extendedProps?.backendId ?? modalState.eventId;
    window.trackModifiedEvent?.(savedId, {
      category: "event",
      summary: `${isEdit ? "Event updated" : "Event created"}: ${nextEvent.title || "Untitled event"}`
    });

    if (nextEvent.start) {
      window.selectedDate = toDayString(nextEvent.start);
      window.highlightSelectedDay?.(window.selectedDate);
    }

    const mergedPublishTargets = new Set(getSelectedPublishTargetKeys());
    if (shouldUpdateLinkedPublishTargets(nextEvent)) {
      getExistingLinkedAccountKeys(nextEvent).forEach((key) => mergedPublishTargets.add(key));
    }
    setSelectedPublishTargetKeys([...mergedPublishTargets]);
    renderEventPublishControls();

    window.updateDayDetails?.();
    window.updateWeekView?.();
    window.smartRefresh?.({ reason: "event_saved", force: true });
    updateUndoRedoButtonStates();

    if (closeAfterSave) {
      closeCreateModal({ force: true });
    } else {
      markModalCleanSnapshot();
    }
    if (showSuccessToast) {
      window.showToast?.("✅ Event saved");
    }

    return nextEvent;
  } catch (err) {
    console.error("❌ Save failed", err);
    window.showToast?.("❌ Save failed", "error");
    return null;
  } finally {
    isSavingEvent = false;
    refreshSaveButtonState();
  }
}

async function saveEvent() {
  if (modalState.type === "sticky") {
    await saveStickyOnly();
    return;
  }

  const nextEvent = await persistEventRecord({ closeAfterSave: true, showSuccessToast: true });
  if (!nextEvent) return;
}

async function publishCurrentEvent() {
  if (modalState.type === "sticky") return;

  const needsSaveBeforePublish = !modalState.eventId || eventContentHasUnsavedEdits();
  const nextEvent = needsSaveBeforePublish
    ? await persistEventRecord({ closeAfterSave: false, showSuccessToast: false })
    : modalState.eventRef;
  if (needsSaveBeforePublish && !nextEvent) return;

  const selectedRows = getActionablePublishTargetSummary();
  if (!selectedRows.length) {
    window.showToast?.("Select at least one Google or Microsoft calendar", "error");
    return;
  }

  modalState.publishAttemptConsumed = false;
  modalState.publishAttemptState = "idle";
  openPublishConfirmationDialog();
}

async function confirmPublishCurrentEvent() {
  const eventId = modalState.eventId || modalState.eventRef?.extendedProps?.backendId;
  if (!eventId || isPublishingEvent) return;

  const selectedRows = getActionablePublishTargetSummary();
  const selectedKeys = selectedRows.map((row) => row.key);

  if (!selectedKeys.length) {
    window.showToast?.("Select at least one Google or Microsoft calendar", "error");
    return;
  }

  isPublishingEvent = true;
  renderEventPublishControls();
  renderConfirmPublishButtonState();

  try {
    const res = await apiFetch("/calendar/publish", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event_ids: [eventId],
        publish_targets: { [String(eventId)]: selectedKeys }
      })
    });
    if (!res) return;

    const raw = await res.text();
    const data = raw ? JSON.parse(raw) : {};
    if (!res.ok || String(data?.status || "").toLowerCase() === "error") {
      throw new Error(data?.message || `Publish failed (${res.status})`);
    }

    const touched = data.affected_accounts || [];
    const warnings = data.warnings || [];
    const published = Number(data.published || 0);
    const created = Number(data.created || 0);
    const failureMessage = buildPublishFailureMessage(data, selectedKeys.map((key) => String(key).toLowerCase()));

    if (published === 0 && created === 0) {
      throw new Error(failureMessage);
    }

    if (modalState.eventId != null) {
      window.sessionModifiedEventIds?.delete?.(Number(modalState.eventId));
    }
    window.removePendingPublishChangesForEventIds?.([eventId]);

    await window.preloadEventCache?.({ silent: true });
    window.smartRefresh?.({ reason: "single_event_publish", force: true });

    modalState.publishAttemptState = "success";
    modalState.publishAttemptConsumed = true;
    renderConfirmPublishButtonState({ state: "success" });

    await new Promise((resolve) => window.setTimeout(resolve, 700));

    closePublishConfirmationDialog();
    closeCreateModal({ force: true });

    if (warnings.length) {
      const firstWarning = String(warnings[0] || "").trim();
      const warningSuffix = firstWarning ? `: ${firstWarning}` : "";
      window.showToast?.(`⚠️ Published ${published} event${published === 1 ? "" : "s"}; ${warnings.length} warning${warnings.length === 1 ? "" : "s"}${warningSuffix}`, "error");
    } else {
      window.showToast?.(`✅ Published event to ${touched.length || selectedKeys.length} calendar${(touched.length || selectedKeys.length) === 1 ? "" : "s"} (${created} new link${created === 1 ? "" : "s"})`);
    }
  } catch (err) {
    console.error("❌ Single-event publish failed", err);
    const message = String(err?.message || "").trim();
    const remediationHtml = buildPublishRemediationHtml(message, selectedRows);
    modalState.publishAttemptState = "error";
    modalState.publishAttemptConsumed = true;
    renderConfirmPublishButtonState({ state: "error" });
    const summary = document.getElementById("publishConfirmSummary");
    if (summary) {
      if (remediationHtml) {
        summary.innerHTML = `${message ? `Publish failed: ${escapeHtml(message)}` : "Publish failed."}${remediationHtml}`;
      } else {
        summary.textContent = message ? `Publish failed: ${message}` : "Publish failed.";
      }
    }
    window.showToast?.(`❌ Publish failed${message ? `: ${message}` : ""}${remediationHtml ? " — see resolution path in the publish panel" : ""}`, "error");
    window.setTimeout(() => {
      if (!isPublishingEvent) {
        modalState.publishAttemptState = "idle";
        renderConfirmPublishButtonState();
      }
    }, 900);
  } finally {
    isPublishingEvent = false;
    renderEventPublishControls();
    renderConfirmPublishButtonState();
  }
}

async function deleteEvent() {
  const eventId = modalState.eventId || window.editingEventId;
  if (!eventId) return;
  if (!confirm("Delete this event?")) return;

  // Capture the event before deletion for undo
  const eventToDelete = window.sessionEventCache?.find((ev) => {
    return String(ev?.extendedProps?.backendId) === String(eventId) || String(ev?.id) === String(eventId);
  });

  const previousEvent = eventToDelete ? JSON.parse(JSON.stringify(eventToDelete)) : null;
  window.trackDeletedProviderEvent?.(eventToDelete);

  try {
    // Create undo/redo command
    const command = {
      label: "Delete event",
      execute: async () => {
        const res = await apiFetch(`/calendar/event/${eventId}`, { method: "DELETE" });
        if (!res || !res.ok) throw new Error("Delete failed");
      },
      undo: async () => {
        if (previousEvent) {
          // Extract the title, dates, times, and notes from previous event
          const restorePayload = {
            title: previousEvent.title || "",
            date: previousEvent.start ? toDayString(previousEvent.start) : new Date().toISOString().split("T")[0],
            start_time: previousEvent.start ? new Date(previousEvent.start).toTimeString().slice(0, 5) : "",
            end_time: previousEvent.end ? new Date(previousEvent.end).toTimeString().slice(0, 5) : "",
            description: previousEvent.extendedProps?.description || "",
            tags: previousEvent.extendedProps?.tags || "",
            sticky_notes: previousEvent.extendedProps?.sticky_notes || []
          };

          const res = await apiFetch("/calendar/event", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(restorePayload)
          });
          if (!res || !res.ok) throw new Error("Restore failed");
          return res.json();
        }
      }
    };

    // Execute delete
    await command.execute();

    window.sessionEventCache = (window.sessionEventCache || []).filter((ev) => {
      return String(ev?.extendedProps?.backendId) !== String(eventId) && String(ev?.id) !== String(eventId);
    });

    // Register to undo/redo history (already executed)
    await window.undoRedoManager.registerExecuted(command);

    closeCreateModal({ force: true });
    window.showToast?.("🗑 Event deleted");
    window.smartRefresh?.({ reason: "event_deleted", force: true });
    updateUndoRedoButtonStates();
  } catch (err) {
    console.error("❌ Delete failed", err);
    window.showToast?.("❌ Delete failed", "error");
  }
}

/**
 * Update undo/redo button states based on manager state
 */
function updateUndoRedoButtonStates() {
  const state = window.undoRedoManager.getState();
  const undoBtn = document.getElementById("undoBtn");
  const redoBtn = document.getElementById("redoBtn");

  if (undoBtn) {
    undoBtn.disabled = !state.canUndo;
    undoBtn.title = `${state.undoLabel} (Ctrl+Z)`;
  }
  if (redoBtn) {
    redoBtn.disabled = !state.canRedo;
    redoBtn.title = `${state.redoLabel} (Ctrl+Y)`;
  }
}

function bindUIEvents() {
  document.getElementById("createBtn")?.addEventListener("click", () => {
    if (window.isModalOpen) return;
    openCreateModal();
  });

  const accountsBtn = document.getElementById("accountsBtn");
  const gearMenuShell = document.getElementById("gearMenuShell");
  const manageAccountsMenuBtn = document.getElementById("manageAccountsMenuBtn");
  const adminMenuBtn = document.getElementById("adminMenuBtn");
  const manageAccountsQuickBtn = document.getElementById("manageAccountsQuickBtn");
  const adminQuickBtn = document.getElementById("adminQuickBtn");

  accountsBtn?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    gearMenuShell?.classList.toggle("open");
    accountsBtn.setAttribute("aria-expanded", gearMenuShell?.classList.contains("open") ? "true" : "false");
  });

  manageAccountsMenuBtn?.addEventListener("click", () => {
    gearMenuShell?.classList.remove("open");
    window.location.href = "/accounts/ui";
  });

  manageAccountsQuickBtn?.addEventListener("click", () => {
    gearMenuShell?.classList.remove("open");
    window.location.href = "/accounts/ui";
  });

  adminMenuBtn?.addEventListener("click", () => {
    gearMenuShell?.classList.remove("open");
    window.location.href = "/admin/ui";
  });

  adminQuickBtn?.addEventListener("click", () => {
    gearMenuShell?.classList.remove("open");
    window.location.href = "/admin/ui";
  });

  document.addEventListener("click", (event) => {
    if (!gearMenuShell) return;
    if (!gearMenuShell.contains(event.target)) {
      gearMenuShell.classList.remove("open");
      accountsBtn?.setAttribute("aria-expanded", "false");
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      gearMenuShell?.classList.remove("open");
      accountsBtn?.setAttribute("aria-expanded", "false");
      if (window.isModalOpen) {
        closeCreateModal();
      }
    }
  });

  if (adminMenuBtn) {
    adminMenuBtn.classList.add("hidden");
    adminQuickBtn?.classList.add("hidden");

    apiFetch("/users/me")
      .then(async (res) => {
        if (!res || !res.ok) return;
        const me = await res.json();
        if (String(me?.role || "").toLowerCase() === "admin") {
          adminMenuBtn.classList.remove("hidden");
          adminQuickBtn?.classList.remove("hidden");
        }
      })
      .catch((error) => {
        console.warn("Unable to resolve user role for admin hover menu", error);
      });
  }

  document.getElementById("googleBtn")?.addEventListener("click", connectGoogle);
  document.getElementById("outlookBtn")?.addEventListener("click", connectMicrosoft);
  document.getElementById("appleBtn")?.addEventListener("click", connectApple);

  document.getElementById("addTaskBtn")?.addEventListener("click", addTask);

  refreshTagDatalist();
  loadTagColorSettingsFromServer();
  document.getElementById("eventColorEnabled")?.addEventListener("change", async () => {
    syncEventColorControl();
    if (document.getElementById("eventColorEnabled")?.checked) {
      previewEventColorOnEnabledTagInputs(document.getElementById("eventColor")?.value || DEFAULT_EVENT_COLOR);
      await applyEventColorToEnabledTags(document.getElementById("eventColor")?.value || DEFAULT_EVENT_COLOR);
    }
  });
  document.getElementById("eventColor")?.addEventListener("input", (event) => {
    previewEventColorOnEnabledTagInputs(event.target.value);
  });
  document.getElementById("eventColor")?.addEventListener("change", async (event) => {
    await applyEventColorToEnabledTags(event.target.value);
  });
  document.getElementById("eventTags")?.addEventListener("input", renderTagColorRows);
  document.getElementById("eventTagColorRows")?.addEventListener("input", (event) => {
    if (!event.target?.matches?.("[data-tag-color]")) return;
    const row = event.target.closest?.(".tagColorRow[data-tag-key]");
    const enabledInput = row?.querySelector?.("[data-tag-color-enabled]");
    if (enabledInput?.checked) {
      setEventColorControlValue(event.target.value, true);
    }
  });
  document.getElementById("eventTagColorRows")?.addEventListener("change", async (event) => {
    const row = event.target?.closest?.(".tagColorRow[data-tag-key]");
    if (!row) return;

    const key = row.dataset.tagKey;
    const settings = loadTagColorSettings();
    const entry = settings[key] || { label: row.querySelector(".tagColorName")?.textContent || key, color: DEFAULT_EVENT_COLOR, enabled: false };
    const enabledInput = row.querySelector("[data-tag-color-enabled]");
    const colorInput = row.querySelector("[data-tag-color]");

    if (event.target.matches("[data-tag-color-enabled]")) {
      entry.enabled = enabledInput.checked;
      if (entry.enabled) {
        const eventColor = normalizeColorValue(document.getElementById("eventColor")?.value || entry.color);
        entry.color = eventColor;
        colorInput.value = eventColor;
        setEventColorControlValue(eventColor, true);
      }
      colorInput.disabled = !entry.enabled;
      settings[key] = entry;
      persistTagColorSettings(settings);
      refreshCalendarEventColors();
      return;
    }

    if (event.target.matches("[data-tag-color]")) {
      const previousColor = normalizeColorValue(entry.color);
      const nextColor = normalizeColorValue(colorInput.value);
      if (entry.enabled && previousColor.toLowerCase() !== nextColor.toLowerCase()) {
        const ok = await confirmTagColorChange({
          labelText: entry.label || key,
          currentColors: [previousColor],
          nextColor
        });
        if (!ok) {
          colorInput.value = previousColor;
          return;
        }
      }
      entry.color = nextColor;
      settings[key] = entry;
      persistTagColorSettings(settings);
      if (entry.enabled) {
        setEventColorControlValue(nextColor, true);
      }
      refreshCalendarEventColors();
    }
  });

  document.getElementById("saveEventBtn")?.addEventListener("click", saveEvent);
  document.getElementById("publishEventBtn")?.addEventListener("click", publishCurrentEvent);
  document.getElementById("cancelEventBtn")?.addEventListener("click", closeCreateModal);
  document.getElementById("deleteEventBtn")?.addEventListener("click", deleteEvent);
  document.getElementById("modalOverlay")?.addEventListener("click", closeCreateModal);
  document.getElementById("publishConfirmOverlay")?.addEventListener("click", closePublishConfirmationDialog);
  document.getElementById("cancelPublishConfirmBtn")?.addEventListener("click", closePublishConfirmationDialog);
  document.getElementById("confirmPublishEventBtn")?.addEventListener("click", confirmPublishCurrentEvent);

  const eventModal = document.getElementById("createEventModal");
  eventModal?.addEventListener("input", (event) => {
    if (event.target?.matches?.('input[data-publish-account-key]')) return;
    refreshSaveButtonState();
  });
  eventModal?.addEventListener("change", (event) => {
    if (event.target?.matches?.('input[data-publish-account-key]')) return;
    refreshSaveButtonState();
  });

  document.getElementById("eventPublishTargets")?.addEventListener("change", (event) => {
    if (!event.target?.matches?.('input[data-publish-account-key]')) return;
    syncPublishSelectionStateFrom(event.currentTarget);
    refreshSaveButtonState();
  });

  document.getElementById("publishConfirmTargets")?.addEventListener("change", (event) => {
    if (!event.target?.matches?.('input[data-publish-account-key]')) return;
    syncPublishSelectionStateFrom(event.currentTarget);
  });

  document.getElementById("openStickyFromEventBtn")?.addEventListener("click", () => {
    openStickyModal(modalState.eventRef);
  });

  document.getElementById("stickyBackToEventBtn")?.addEventListener("click", () => {
    openCreateModal(null, modalState.eventRef);
  });

  document.getElementById("deleteStickyBtn")?.addEventListener("click", async () => {
    await deleteSelectedStickyInModal();
  });

  document.getElementById("eventStickyColor")?.addEventListener("input", (e) => {
    setStickyPaperColor(e.target.value);
    saveCurrentStickyIntoState();
    renderStickyTabs();
  });

  document.getElementById("eventStickyContentEditor")?.addEventListener("input", () => {
    saveCurrentStickyIntoState();
    renderStickyTabs();
  });

  document.getElementById("eventDescriptionEditor")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showEditorContextMenu(e.clientX, e.clientY, "eventDescriptionEditor");
  });

  document.getElementById("eventStickyContentEditor")?.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    showEditorContextMenu(e.clientX, e.clientY, "eventStickyContentEditor");
  });

  document.getElementById("addStickyNoteBtn")?.addEventListener("click", () => {
    saveCurrentStickyIntoState();
    modalState.stickyNotes.push({
      content: "",
      color: "#F7E68A",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    modalState.stickyIndex = modalState.stickyNotes.length - 1;
    hydrateStickyEditorFromState();
    focusEditor("eventStickyContentEditor");
  });

  document.getElementById("eventStart")?.addEventListener("change", () => {
    const startVal = document.getElementById("eventStart")?.value;
    const endInput = document.getElementById("eventEnd");
    if (!startVal || !endInput) return;

    if (!endInput.value || endInput.value <= startVal) {
      const [hour, minute] = startVal.split(":").map((n) => parseInt(n, 10));
      const endDate = new Date();
      endDate.setHours((hour || 0) + 1);
      endDate.setMinutes(minute || 0);
      endInput.value = endDate.toTimeString().slice(0, 5);
    }
  });

  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const days = parseInt(btn.dataset.range, 10);
      if (!days) return;

      window.currentRangeDays = days;
      applyRangeTooltips();
      window.calendar?.refetchEvents();
      window.smartRefresh?.({ reason: "range_change" });
      renderRangePill();
    });
  });

  document.getElementById("syncBtn")?.addEventListener("click", async () => {
    if (typeof window.syncNow === "function") await window.syncNow();
  });

  document.getElementById("publishBtn")?.addEventListener("click", (event) => {
    event.preventDefault();
    if (typeof window.openPublishReviewMenuForButton === "function") {
      window.openPublishReviewMenuForButton();
    }
  });

  document.getElementById("publishBtn")?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    if (typeof window.openPublishReviewMenu === "function") {
      window.openPublishReviewMenu(event.clientX, event.clientY);
    }
  });

  document.getElementById("dedupBtn")?.addEventListener("click", () => {
    if (typeof window.toggleDedup === "function") window.toggleDedup();
  });

  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    if (typeof window.logout === "function") window.logout();
  });

  // ✅ UNDO/REDO BUTTON LISTENERS
  document.getElementById("undoBtn")?.addEventListener("click", async () => {
    await window.undoRedoManager.undo();
    updateUndoRedoButtonStates();
  });

  document.getElementById("redoBtn")?.addEventListener("click", async () => {
    await window.undoRedoManager.redo();
    updateUndoRedoButtonStates();
  });

  // Listen for undo/redo state changes
  window.undoRedoManager.onChange(updateUndoRedoButtonStates);

  initRichEditorSystem();
}

window.initDateStickyStore = initDateStickyStore;
window.openStickyModal = openStickyModal;
window.openStickyModalForNew = openStickyModalForNew;
window.openDateStickyModal = openDateStickyModal;
window.normalizeEventForCache = normalizeEventForCache;
window.upsertCacheEvent = upsertCacheEvent;

window.getDateStickyNotes = (dateKey) => getDateStickyNotes(dateKey);
window.getDateStickyCount = (dateKey) => getDateStickyCount(dateKey);
window.getDateStickyTooltip = (dateKey) => buildDateStickyTooltip(dateKey);
window.getAllDateStickyCounts = () => {
  const out = {};
  Object.keys(dateStickyMap || {}).forEach((dateKey) => {
    out[dateKey] = normalize_sticky_notes_frontend(dateStickyMap[dateKey]).length;
  });
  return out;
};

function ensureStickyChooserModal() {
  let modal = document.getElementById("stickyChooserModal");
  if (modal) return modal;

  modal = document.createElement("div");
  modal.id = "stickyChooserModal";
  modal.className = "stickyChooserModal";
  modal.innerHTML = `
    <div class="stickyChooserDialog" role="dialog" aria-modal="true" aria-labelledby="stickyChooserTitle">
      <div id="stickyChooserTitle" class="stickyChooserTitle"></div>
      <div id="stickyChooserSubtitle" class="stickyChooserSubtitle"></div>
      <div id="stickyChooserList" class="stickyChooserList"></div>
      <div id="stickyChooserActions" class="stickyChooserActions"></div>
    </div>
  `;
  document.body.appendChild(modal);
  return modal;
}

function closeStickyChooserModal() {
  const modal = document.getElementById("stickyChooserModal");
  if (!modal) return;

  if (modal._keyHandler) {
    document.removeEventListener("keydown", modal._keyHandler, true);
    modal._keyHandler = null;
  }

  modal.classList.remove("show");
}

function openStickyChooserModal({ title, subtitle = "", items = [], actions = [] }) {
  return new Promise((resolve) => {
    const modal = ensureStickyChooserModal();
    const titleEl = document.getElementById("stickyChooserTitle");
    const subtitleEl = document.getElementById("stickyChooserSubtitle");
    const listEl = document.getElementById("stickyChooserList");
    const actionsEl = document.getElementById("stickyChooserActions");

    if (!titleEl || !subtitleEl || !listEl || !actionsEl) {
      resolve(null);
      return;
    }

    titleEl.textContent = title || "Choose Sticky";
    subtitleEl.textContent = subtitle || "";
    listEl.innerHTML = "";
    actionsEl.innerHTML = "";

    const choose = (value) => {
      closeStickyChooserModal();
      resolve(value);
    };

    items.forEach((item, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stickyChooserItem";
      btn.innerHTML = `<span class="stickyChooserIndex">${idx + 1}</span><span>${item}</span>`;
      btn.addEventListener("click", () => {
        choose(idx);
      });
      listEl.appendChild(btn);
    });

    actions.forEach((act) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `stickyChooserAction ${act.variant || "secondary"}`;
      btn.textContent = act.label;
      btn.addEventListener("click", () => {
        choose(act.value);
      });
      actionsEl.appendChild(btn);
    });

    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        choose(null);
      }
    }, { once: true });

    const focusable = Array.from(
      modal.querySelectorAll(".stickyChooserItem, .stickyChooserAction")
    );

    let activeIdx = 0;
    const focusAt = (idx) => {
      if (!focusable.length) return;
      activeIdx = ((idx % focusable.length) + focusable.length) % focusable.length;
      focusable[activeIdx].focus();
    };

    if (modal._keyHandler) {
      document.removeEventListener("keydown", modal._keyHandler, true);
      modal._keyHandler = null;
    }

    modal._keyHandler = (e) => {
      if (!modal.classList.contains("show")) return;
      if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        choose(null);
        return;
      }

      if (!focusable.length) {
        if (e.key === "Enter") choose(null);
        return;
      }

      if (e.key === "ArrowDown") {
        focusAt(activeIdx + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        focusAt(activeIdx - 1);
        return;
      }

      if (e.key === "Enter") {
        focusable[activeIdx].click();
      }
    };

    document.addEventListener("keydown", modal._keyHandler, true);

    modal.classList.add("show");

    if (focusable.length) {
      focusAt(0);
    }
  });
}

async function chooseStickyIndex(notes, actionWord = "select") {
  if (!Array.isArray(notes) || !notes.length) return null;
  if (notes.length === 1) return 0;

  const items = notes.map((n) => {
    const preview = String(n.content || "").replace(/\s+/g, " ").trim();
    return preview.length > 80 ? `${preview.slice(0, 80)}...` : preview;
  });

  const selection = await openStickyChooserModal({
    title: `Choose sticky to ${actionWord}`,
    subtitle: `${notes.length} sticky notes available`,
    items,
    actions: [{ label: "Cancel", value: null, variant: "secondary" }]
  });

  if (selection == null || selection < 0 || selection >= notes.length) return null;
  return selection;
}

async function chooseStickyMoveSelection(notes, sourceLabel = "source") {
  if (!Array.isArray(notes) || !notes.length) {
    return { mode: "none", indices: [] };
  }
  if (notes.length === 1) {
    return { mode: "single", indices: [0] };
  }

  const indices = await chooseStickyIndices(notes, sourceLabel);
  if (!indices || !indices.length) {
    return { mode: "cancel", indices: [] };
  }

  if (indices.length === notes.length) {
    return { mode: "all", indices };
  }
  if (indices.length === 1) {
    return { mode: "single", indices };
  }
  return { mode: "subset", indices };
}

async function chooseStickyIndices(notes, sourceLabel = "source") {
  if (!Array.isArray(notes) || !notes.length) return [];
  if (notes.length === 1) return [0];

  return new Promise((resolve) => {
    const modal = ensureStickyChooserModal();
    const titleEl = document.getElementById("stickyChooserTitle");
    const subtitleEl = document.getElementById("stickyChooserSubtitle");
    const listEl = document.getElementById("stickyChooserList");
    const actionsEl = document.getElementById("stickyChooserActions");

    if (!titleEl || !subtitleEl || !listEl || !actionsEl) {
      resolve([]);
      return;
    }

    titleEl.textContent = `Select sticky notes from ${sourceLabel}`;
    subtitleEl.textContent = "Choose any combination to move (for example 2 of 3)";
    listEl.innerHTML = "";
    actionsEl.innerHTML = "";

    const selected = new Set(notes.map((_, idx) => idx));
    const itemButtons = [];

    const renderItemState = (btn, idx) => {
      const isSelected = selected.has(idx);
      btn.classList.toggle("selected", isSelected);
      btn.setAttribute("aria-pressed", isSelected ? "true" : "false");
      const marker = btn.querySelector(".stickyChooserSelectMarker");
      if (marker) marker.textContent = isSelected ? "☑" : "☐";
    };

    notes.forEach((n, idx) => {
      const preview = String(n.content || "").replace(/\s+/g, " ").trim();
      const text = preview.length > 90 ? `${preview.slice(0, 90)}...` : preview;

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "stickyChooserItem stickyChooserSelectable selected";
      btn.innerHTML = `
        <span class="stickyChooserSelectMarker">☑</span>
        <span class="stickyChooserIndex">${idx + 1}</span>
        <span>${text || "(empty)"}</span>
      `;
      btn.addEventListener("click", () => {
        if (selected.has(idx)) {
          selected.delete(idx);
        } else {
          selected.add(idx);
        }
        renderItemState(btn, idx);
      });

      listEl.appendChild(btn);
      itemButtons.push(btn);
    });

    const choose = (indices) => {
      closeStickyChooserModal();
      resolve(indices);
    };

    const mkAction = (label, handler, variant = "secondary") => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `stickyChooserAction ${variant}`;
      btn.textContent = label;
      btn.addEventListener("click", handler);
      actionsEl.appendChild(btn);
      return btn;
    };

    const selectAllBtn = mkAction("Select All", () => {
      notes.forEach((_, idx) => selected.add(idx));
      itemButtons.forEach((btn, idx) => renderItemState(btn, idx));
    });

    const moveSelectedBtn = mkAction("Move Selected", () => {
      const indices = Array.from(selected).sort((a, b) => a - b);
      choose(indices);
    }, "primary");

    const moveAllBtn = mkAction("Move All", () => {
      choose(notes.map((_, idx) => idx));
    }, "danger");

    const cancelBtn = mkAction("Cancel", () => choose([]), "secondary");

    modal.addEventListener("click", (e) => {
      if (e.target === modal) choose([]);
    }, { once: true });

    const focusable = [
      ...itemButtons,
      selectAllBtn,
      moveSelectedBtn,
      moveAllBtn,
      cancelBtn
    ].filter(Boolean);

    let activeIdx = 0;
    const focusAt = (idx) => {
      if (!focusable.length) return;
      activeIdx = ((idx % focusable.length) + focusable.length) % focusable.length;
      focusable[activeIdx].focus();
    };

    if (modal._keyHandler) {
      document.removeEventListener("keydown", modal._keyHandler, true);
      modal._keyHandler = null;
    }

    modal._keyHandler = (e) => {
      if (!modal.classList.contains("show")) return;
      if (!["ArrowDown", "ArrowUp", "Enter", "Escape", " "].includes(e.key)) return;

      e.preventDefault();
      e.stopPropagation();

      if (e.key === "Escape") {
        choose([]);
        return;
      }

      if (!focusable.length) {
        if (e.key === "Enter") choose([]);
        return;
      }

      if (e.key === "ArrowDown") {
        focusAt(activeIdx + 1);
        return;
      }
      if (e.key === "ArrowUp") {
        focusAt(activeIdx - 1);
        return;
      }

      if (e.key === "Enter" || e.key === " ") {
        focusable[activeIdx].click();
      }
    };

    document.addEventListener("keydown", modal._keyHandler, true);

    modal.classList.add("show");
    if (focusable.length) focusAt(0);
  });
}

window.editEventStickyNote = async (eventRef) => {
  const notes = parseStickyNotes(eventRef);
  if (!notes.length) {
    window.showToast?.("No sticky notes to edit", "error");
    return;
  }
  const idx = await chooseStickyIndex(notes, "edit");
  if (idx == null) return;
  openStickyModal(eventRef, idx);
};

window.editDateStickyNote = async (dateKey) => {
  const notes = getDateStickyNotes(dateKey);
  if (!notes.length) {
    window.showToast?.("No date sticky notes to edit", "error");
    return;
  }
  const idx = await chooseStickyIndex(notes, "edit");
  if (idx == null) return;
  openDateStickyModal(dateKey, idx);
};

window.moveEventStickyToDate = async (eventRef, targetDateKey) => {
  if (!eventRef || !targetDateKey) return false;

  const backendId = eventRef?.extendedProps?.backendId || eventRef?.id;
  if (!backendId) {
    window.showToast?.("Sticky move failed: missing event id", "error");
    return false;
  }

  const eventNotes = parseStickyNotes(eventRef);
  if (!eventNotes.length) {
    window.showToast?.("No event sticky notes to move", "error");
    return false;
  }

  const selection = await chooseStickyMoveSelection(eventNotes, "event");
  if (selection.mode === "cancel" || selection.mode === "none") return false;

  const indexSet = new Set(selection.indices);
  const movedItems = eventNotes.filter((_, idx) => indexSet.has(idx));
  const remainingEventNotes = eventNotes.filter((_, idx) => !indexSet.has(idx));
  const targetDateNotes = getDateStickyNotes(targetDateKey);
  const nowIso = new Date().toISOString();

  // Capture state before move for undo
  const previousEventNotes = JSON.parse(JSON.stringify(eventNotes));
  const previousDateNotes = JSON.parse(JSON.stringify(targetDateNotes));

  movedItems.forEach((moved) => {
    targetDateNotes.push({
      ...moved,
      updatedAt: nowIso
    });
  });

  try {
    // Create undo/redo command
    const command = {
      label: "Move sticky to date",
      execute: async () => {
        const res = await apiFetch(`/calendar/event/${backendId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sticky_notes: remainingEventNotes,
            sticky_note: remainingEventNotes[0] || null
          })
        });
        if (!res || !res.ok) throw new Error("event sticky update failed");
        return res.json();
      },
      undo: async () => {
        // Restore original sticky notes to event and date
        const [resEvent, resDate] = await Promise.all([
          apiFetch(`/calendar/event/${backendId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sticky_notes: previousEventNotes,
              sticky_note: previousEventNotes[0] || null
            })
          }),
          upsertDateStickyServer(targetDateKey, previousDateNotes)
        ]);
        if (!resEvent?.ok) throw new Error("event restore failed");
        return resEvent.json();
      }
    };

    // Execute
    const data = await command.execute();
    const nextEvent = normalizeEventForCache(data.event, eventRef);
    upsertCacheEvent(nextEvent);

    // Update date stickies in memory
    dateStickyMap[targetDateKey] = targetDateNotes;
    persistLocalDateStickyMap();

    // Register to undo/redo history
    await window.undoRedoManager.registerExecuted(command);

    refreshStickyVisuals();
    const label = movedItems.length > 1 ? `${movedItems.length} stickies moved to date` : "🗒 Sticky moved to date";
    window.showToast?.(label);
    updateUndoRedoButtonStates();
    return true;
  } catch (err) {
    console.error("❌ move event sticky to date failed", err);
    window.showToast?.("❌ Sticky move failed", "error");
    return false;
  }
};

window.moveEventStickyToEvent = async (sourceEventRef, targetEventRef) => {
  const sourceId = sourceEventRef?.extendedProps?.backendId || sourceEventRef?.id;
  const targetId = targetEventRef?.extendedProps?.backendId || targetEventRef?.id;
  if (!sourceId || !targetId) {
    window.showToast?.("Sticky move failed: missing event id", "error");
    return false;
  }

  const sourceNotes = parseStickyNotes(sourceEventRef);
  if (!sourceNotes.length) {
    window.showToast?.("No sticky notes to move", "error");
    return false;
  }

  const selection = await chooseStickyMoveSelection(sourceNotes, "event");
  if (selection.mode === "cancel" || selection.mode === "none") return false;

  const indexSet = new Set(selection.indices);
  const movedItems = sourceNotes.filter((_, idx) => indexSet.has(idx));
  const remainingSourceNotes = sourceNotes.filter((_, idx) => !indexSet.has(idx));
  const targetNotes = parseStickyNotes(targetEventRef);
  const nowIso = new Date().toISOString();

  // Capture state before move for undo
  const previousSourceNotes = JSON.parse(JSON.stringify(sourceNotes));
  const previousTargetNotes = JSON.parse(JSON.stringify(targetNotes));

  movedItems.forEach((n) => targetNotes.push({ ...n, updatedAt: nowIso }));

  try {
    // Create undo/redo command
    const command = {
      label: "Move sticky to event",
      execute: async () => {
        const [resSource, resTarget] = await Promise.all([
          apiFetch(`/calendar/event/${sourceId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sticky_notes: remainingSourceNotes, sticky_note: remainingSourceNotes[0] || null })
          }),
          apiFetch(`/calendar/event/${targetId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sticky_notes: targetNotes, sticky_note: targetNotes[0] || null })
          })
        ]);
        if (!resSource?.ok || !resTarget?.ok) throw new Error("move failed");
        return Promise.all([resSource.json(), resTarget.json()]);
      },
      undo: async () => {
        // Restore previous sticky notes to both events
        const [resSource, resTarget] = await Promise.all([
          apiFetch(`/calendar/event/${sourceId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sticky_notes: previousSourceNotes, sticky_note: previousSourceNotes[0] || null })
          }),
          apiFetch(`/calendar/event/${targetId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sticky_notes: previousTargetNotes, sticky_note: previousTargetNotes[0] || null })
          })
        ]);
        if (!resSource?.ok || !resTarget?.ok) throw new Error("restore failed");
        return Promise.all([resSource.json(), resTarget.json()]);
      }
    };

    // Execute
    const [dSrc, dTgt] = await command.execute();
    upsertCacheEvent(normalizeEventForCache(dSrc.event, sourceEventRef));
    upsertCacheEvent(normalizeEventForCache(dTgt.event, targetEventRef));

    // Register to undo/redo history
    await window.undoRedoManager.registerExecuted(command);

    refreshStickyVisuals();
    const label = movedItems.length > 1 ? `${movedItems.length} stickies moved to event` : "🗒 Sticky moved to event";
    window.showToast?.(label);
    updateUndoRedoButtonStates();
    return true;
  } catch (err) {
    console.error("❌ move event sticky to event failed", err);
    window.showToast?.("❌ Sticky move failed", "error");
    return false;
  }
};

window.moveDateStickyToEvent = async (sourceDateKey, eventRef) => {
  if (!sourceDateKey || !eventRef) return false;

  const backendId = eventRef?.extendedProps?.backendId || eventRef?.id;
  if (!backendId) {
    window.showToast?.("Sticky move failed: missing event id", "error");
    return false;
  }

  const dateNotes = getDateStickyNotes(sourceDateKey);
  if (!dateNotes.length) {
    window.showToast?.("No date sticky notes to move", "error");
    return false;
  }

  const selection = await chooseStickyMoveSelection(dateNotes, "date");
  if (selection.mode === "cancel" || selection.mode === "none") return false;

  const indexSet = new Set(selection.indices);
  const movedItems = dateNotes.filter((_, idx) => indexSet.has(idx));
  const remainingDateNotes = dateNotes.filter((_, idx) => !indexSet.has(idx));

  const eventNotes = parseStickyNotes(eventRef);
  const nowIso = new Date().toISOString();

  // Capture state before move for undo
  const previousDateNotes = JSON.parse(JSON.stringify(dateNotes));
  const previousEventNotes = JSON.parse(JSON.stringify(eventNotes));

  movedItems.forEach((moved) => {
    eventNotes.push({
      ...moved,
      updatedAt: nowIso
    });
  });

  try {
    // Create undo/redo command
    const command = {
      label: "Move sticky to event",
      execute: async () => {
        const res = await apiFetch(`/calendar/event/${backendId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sticky_notes: eventNotes,
            sticky_note: eventNotes[0] || null
          })
        });
        if (!res || !res.ok) throw new Error("event sticky update failed");
        return res.json();
      },
      undo: async () => {
        // Restore previous sticky notes to both date and event
        const [resEvent, resDate] = await Promise.all([
          apiFetch(`/calendar/event/${backendId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sticky_notes: previousEventNotes,
              sticky_note: previousEventNotes[0] || null
            })
          }),
          upsertDateStickyServer(sourceDateKey, previousDateNotes)
        ]);
        if (!resEvent?.ok) throw new Error("restore failed");
        return resEvent.json();
      }
    };

    // Execute
    const data = await command.execute();
    const nextEvent = normalizeEventForCache(data.event, eventRef);
    upsertCacheEvent(nextEvent);

    // Update date stickies in memory
    dateStickyMap[sourceDateKey] = remainingDateNotes;
    persistLocalDateStickyMap();

    // Register to undo/redo history
    await window.undoRedoManager.registerExecuted(command);

    refreshStickyVisuals();
    const label = movedItems.length > 1 ? `${movedItems.length} stickies moved to event` : "🗒 Sticky moved to event";
    window.showToast?.(label);
    updateUndoRedoButtonStates();
    return true;
  } catch (err) {
    console.error("❌ move date sticky to event failed", err);
    window.showToast?.("❌ Sticky move failed", "error");
    return false;
  }
};

window.moveDateStickyToDate = async (sourceDateKey, targetDateKey) => {
  if (!sourceDateKey || !targetDateKey) return false;
  if (sourceDateKey === targetDateKey) return false;

  const sourceNotes = getDateStickyNotes(sourceDateKey);
  if (!sourceNotes.length) {
    window.showToast?.("No date sticky notes to move", "error");
    return false;
  }

  const selection = await chooseStickyMoveSelection(sourceNotes, "date");
  if (selection.mode === "cancel" || selection.mode === "none") return false;

  const indexSet = new Set(selection.indices);
  const movedItems = sourceNotes.filter((_, idx) => indexSet.has(idx));
  const remainingSourceNotes = sourceNotes.filter((_, idx) => !indexSet.has(idx));
  const targetNotes = getDateStickyNotes(targetDateKey);
  const nowIso = new Date().toISOString();

  const previousSourceNotes = JSON.parse(JSON.stringify(sourceNotes));
  const previousTargetNotes = JSON.parse(JSON.stringify(targetNotes));

  movedItems.forEach((moved) => {
    targetNotes.push({
      ...moved,
      updatedAt: nowIso
    });
  });

  try {
    const command = {
      label: "Move date sticky",
      execute: async () => {
        await Promise.all([
          upsertDateStickyServer(sourceDateKey, remainingSourceNotes),
          upsertDateStickyServer(targetDateKey, targetNotes)
        ]);
        return true;
      },
      undo: async () => {
        await Promise.all([
          upsertDateStickyServer(sourceDateKey, previousSourceNotes),
          upsertDateStickyServer(targetDateKey, previousTargetNotes)
        ]);
        return true;
      }
    };

    await command.execute();

    if (remainingSourceNotes.length) {
      dateStickyMap[sourceDateKey] = remainingSourceNotes;
    } else {
      delete dateStickyMap[sourceDateKey];
    }
    dateStickyMap[targetDateKey] = targetNotes;
    persistLocalDateStickyMap();

    await window.undoRedoManager.registerExecuted(command);

    refreshStickyVisuals();
    const label = movedItems.length > 1 ? `${movedItems.length} stickies moved to date` : "🗒 Sticky moved to date";
    window.showToast?.(label);
    updateUndoRedoButtonStates();
    return true;
  } catch (err) {
    console.error("❌ move date sticky to date failed", err);
    window.showToast?.("❌ Sticky move failed", "error");
    return false;
  }
};

async function deleteSelectedStickyInModal() {
  if (modalState.type !== "sticky") return;

  saveCurrentStickyIntoState();
  const notes = [...modalState.stickyNotes];
  if (!notes.length) {
    window.showToast?.("No sticky notes to delete", "error");
    return;
  }

  const idx = Math.max(0, Math.min(modalState.stickyIndex, notes.length - 1));
  const remaining = notes.filter((_, i) => i !== idx);

  if (modalState.stickyScope === "date") {
    const ok = await setDateStickyNotes(modalState.dateStickyKey, remaining);
    if (!ok) return;

    modalState.stickyNotes = remaining;
    modalState.stickyIndex = Math.max(0, Math.min(idx, remaining.length - 1));
    hydrateStickyEditorFromState();
    refreshStickyVisuals();
    window.trackPendingPublishChange?.({
      key: `sticky-date:${modalState.dateStickyKey}`,
      category: "sticky Note",
      summary: `Date sticky note deleted for ${modalState.dateStickyKey}`,
      dateKey: modalState.dateStickyKey,
      localOnly: true
    });
    window.showToast?.("🗒 Date sticky note deleted");
    return;
  }

  if (!modalState.eventId) {
    window.showToast?.("Sticky delete failed: missing event id", "error");
    return;
  }

  try {
    const res = await apiFetch(`/calendar/event/${modalState.eventId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sticky_notes: remaining,
        sticky_note: remaining[0] || null
      })
    });
    if (!res || !res.ok) throw new Error("delete sticky failed");

    const data = await res.json();
    const nextEvent = normalizeEventForCache(data.event, modalState.eventRef);
    modalState.eventRef = nextEvent;
    modalState.stickyNotes = parseStickyNotes(nextEvent);
    modalState.stickyIndex = Math.max(0, Math.min(idx, modalState.stickyNotes.length - 1));
    upsertCacheEvent(nextEvent);
    const stickyDeleteId = nextEvent.extendedProps?.backendId ?? modalState.eventId;
    window.trackModifiedEvent?.(stickyDeleteId, {
      category: "sticky Note",
      summary: `Sticky note deleted: ${nextEvent.title || "Untitled event"}`
    });

    hydrateStickyEditorFromState();
    refreshStickyVisuals();
    window.showToast?.("🗒 Sticky note deleted");
  } catch (err) {
    console.error("❌ Sticky delete failed", err);
    window.showToast?.("❌ Sticky delete failed", "error");
  }
}

window.deleteEventStickyNote = async (eventRef) => {
  if (!eventRef) return;

  const backendId = eventRef?.extendedProps?.backendId || eventRef?.id;
  if (!backendId) {
    window.showToast?.("Sticky delete failed: missing event id", "error");
    return;
  }

  const notes = parseStickyNotes(eventRef);
  if (!notes.length) {
    window.showToast?.("No sticky notes to delete", "error");
    return;
  }

  const removeIndex = await chooseStickyIndex(notes, "delete");
  if (removeIndex == null) return;

  const remaining = notes.filter((_, idx) => idx !== removeIndex);
  try {
    const res = await apiFetch(`/calendar/event/${backendId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sticky_notes: remaining, sticky_note: remaining[0] || null })
    });
    if (!res || !res.ok) throw new Error("delete sticky failed");

    const data = await res.json();
    const nextEvent = normalizeEventForCache(data.event, eventRef);
    upsertCacheEvent(nextEvent);
    const stickyDeleteId = nextEvent.extendedProps?.backendId || backendId;
    window.trackModifiedEvent?.(stickyDeleteId, {
      category: "sticky Note",
      summary: `Sticky note deleted: ${nextEvent.title || eventRef.title || "Untitled event"}`
    });
    refreshStickyVisuals();
    window.showToast?.("🗒 Sticky note deleted");
  } catch (err) {
    console.error("❌ Sticky delete failed", err);
    window.showToast?.("❌ Sticky delete failed", "error");
  }
};

window.deleteDateStickyNote = async (dateKey) => {
  const notes = getDateStickyNotes(dateKey);
  if (!notes.length) {
    window.showToast?.("No date sticky notes to delete", "error");
    return;
  }

  const removeIndex = await chooseStickyIndex(notes, "delete");
  if (removeIndex == null) return;

  const remaining = notes.filter((_, idx) => idx !== removeIndex);
  const ok = await setDateStickyNotes(dateKey, remaining);
  if (!ok) return;
  window.trackPendingPublishChange?.({
    key: `sticky-date:${dateKey}`,
    category: "sticky Note",
    summary: `Date sticky note deleted for ${dateKey}`,
    dateKey,
    localOnly: true
  });
  refreshStickyVisuals();
  window.showToast?.("🗒 Date sticky note deleted");
};

window.deleteEvent = deleteEvent;

export {
  initDateStickyStore,
  applyRangeTooltips,
  bindUIEvents,
  openCreateModal,
  openStickyModal,
  closeCreateModal,
  saveEvent,
  deleteEvent
};