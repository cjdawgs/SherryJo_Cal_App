import { getActiveRangeLabel, toDayString } from "./core.js";
import { connectGoogle, connectMicrosoft, connectApple } from "./account_connections.js";
import { renderRangePill } from "./calendar.fullcalendar.js";

window.isModalOpen = false;

const modalState = {
  type: "event",
  stickyScope: "event",
  dateStickyKey: null,
  eventId: null,
  eventRef: null,
  stickyNotes: [],
  stickyIndex: 0
};

let isSavingEvent = false;
let isSavingSticky = false;
let activeRichEditorId = null;

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
  if (toStickyBtn) toStickyBtn.style.display = modalState.type === "event" && modalState.eventId ? "inline-flex" : "none";
  if (toEventBtn) toEventBtn.style.display = modalState.type === "sticky" && modalState.stickyScope === "event" && modalState.eventId ? "inline-flex" : "none";
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

  if (color) color.value = eventRef?.extendedProps?.eventColor || eventRef?.color || "#4F8EF7";

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
}

function openModal(type = "event", date = null, eventRef = null) {
  const modal = document.getElementById("createEventModal");
  if (!modal) return;

  window.isModalOpen = true;
  modalState.eventRef = eventRef || null;
  modalState.eventId = eventRef?.extendedProps?.backendId || eventRef?.id || null;
  modalState.stickyScope = "event";
  modalState.dateStickyKey = null;
  window.editingEventId = modalState.eventId;

  fillModalFields(date, eventRef);
  setModalType(type);

  modal.classList.add("show");
  document.getElementById("modalOverlay")?.classList.add("show");

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
}

function closeCreateModal() {
  window.isModalOpen = false;
  document.getElementById("createEventModal")?.classList.remove("show");
  document.getElementById("modalOverlay")?.classList.remove("show");
}

function normalizeEventForCache(eventData, fallback = null) {
  const ext = eventData?.extendedProps || {};
  const startVal = eventData?.start || eventData?.start_time || fallback?.start;
  const endVal = eventData?.end || eventData?.end_time || fallback?.end;

  const stickyNotes = ext.stickyNotes || eventData?.sticky_notes || fallback?.extendedProps?.stickyNotes || [];
  const stickyNote = ext.stickyNote || eventData?.sticky_note || stickyNotes?.[0] || fallback?.extendedProps?.stickyNote || null;

  return {
    id: eventData?.external_id || eventData?.id || fallback?.id,
    title: eventData?.title || fallback?.title || "Untitled",
    start: startVal ? new Date(startVal) : null,
    end: endVal ? new Date(endVal) : null,
    color: eventData?.color || fallback?.color || null,
    extendedProps: {
      backendId: eventData?.id || ext.backendId || fallback?.extendedProps?.backendId || null,
      source: ext.source || eventData?.source || fallback?.extendedProps?.source || "local",
      account: ext.account || eventData?.account_email || fallback?.extendedProps?.account || "local",
      account_key: ext.account_key || eventData?.account_key || fallback?.extendedProps?.account_key || "local:local",
      description: ext.description || eventData?.description || fallback?.extendedProps?.description || "",
      tags: ext.tags || eventData?.tags || fallback?.extendedProps?.tags || [],
      eventColor: ext.eventColor || eventData?.color || fallback?.extendedProps?.eventColor || "#4F8EF7",
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
  const eventColor = document.getElementById("eventColor")?.value || "#4F8EF7";

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
    const ok = await setDateStickyNotes(modalState.dateStickyKey, sticky_notes);
    if (!ok) return;
    closeCreateModal();
    refreshStickyVisuals();
    window.showToast?.("📝 Date sticky note saved");
    return;
  }

  if (!modalState.eventId) {
    window.showToast?.("Create the event first, then add sticky note", "error");
    return;
  }

  saveCurrentStickyIntoState();
  const sticky_notes = modalState.stickyNotes.filter((n) => String(n.content || "").trim());
  const sticky_note = sticky_notes[0] || null;

  isSavingSticky = true;
  try {
    const res = await apiFetch(`/calendar/event/${modalState.eventId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sticky_note, sticky_notes })
    });
    if (!res || !res.ok) throw new Error("Sticky save failed");

    const data = await res.json();
    const nextEvent = normalizeEventForCache(data.event, modalState.eventRef);
    modalState.eventRef = nextEvent;
    upsertCacheEvent(nextEvent);

    window.updateDayDetails?.();
    window.updateWeekView?.();
    closeCreateModal();
    window.showToast?.("📝 Sticky note saved");
    window.smartRefresh?.({ reason: "sticky_saved", force: true });
  } catch (err) {
    console.error("❌ Sticky save failed", err);
    window.showToast?.("❌ Sticky save failed", "error");
  } finally {
    isSavingSticky = false;
  }
}

async function saveEvent() {
  if (modalState.type === "sticky") {
    await saveStickyOnly();
    return;
  }

  if (isSavingEvent) return;
  const payload = buildEventPayload();
  if (!payload) return;

  isSavingEvent = true;
  try {
    const isEdit = !!modalState.eventId;
    const res = await apiFetch(isEdit ? `/calendar/event/${modalState.eventId}` : "/calendar/event", {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    if (!res || !res.ok) throw new Error("Save failed");

    const data = await res.json();
    const nextEvent = normalizeEventForCache(data.event, modalState.eventRef);
    modalState.eventRef = nextEvent;
    modalState.eventId = nextEvent.extendedProps?.backendId || modalState.eventId;
    upsertCacheEvent(nextEvent);

    if (nextEvent.start) {
      window.selectedDate = toDayString(nextEvent.start);
      window.highlightSelectedDay?.(window.selectedDate);
    }

    window.updateDayDetails?.();
    window.updateWeekView?.();
    closeCreateModal();
    window.showToast?.("✅ Event saved");
    window.smartRefresh?.({ reason: "event_saved", force: true });
  } catch (err) {
    console.error("❌ Save failed", err);
    window.showToast?.("❌ Save failed", "error");
  } finally {
    isSavingEvent = false;
  }
}

async function deleteEvent() {
  const eventId = modalState.eventId || window.editingEventId;
  if (!eventId) return;
  if (!confirm("Delete this event?")) return;

  try {
    const res = await apiFetch(`/calendar/event/${eventId}`, { method: "DELETE" });
    if (!res || !res.ok) throw new Error("Delete failed");

    window.sessionEventCache = (window.sessionEventCache || []).filter((ev) => {
      return String(ev?.extendedProps?.backendId) !== String(eventId) && String(ev?.id) !== String(eventId);
    });

    closeCreateModal();
    window.showToast?.("🗑 Event deleted");
    window.smartRefresh?.({ reason: "event_deleted", force: true });
  } catch (err) {
    console.error("❌ Delete failed", err);
    window.showToast?.("❌ Delete failed", "error");
  }
}

function bindUIEvents() {
  document.getElementById("createBtn")?.addEventListener("click", () => {
    if (window.isModalOpen) return;
    openCreateModal();
  });

  document.getElementById("accountsBtn")?.addEventListener("click", () => {
    window.location.href = "/accounts/ui";
  });

  document.getElementById("googleBtn")?.addEventListener("click", connectGoogle);
  document.getElementById("outlookBtn")?.addEventListener("click", connectMicrosoft);
  document.getElementById("appleBtn")?.addEventListener("click", connectApple);

  document.getElementById("addTaskBtn")?.addEventListener("click", addTask);

  document.getElementById("saveEventBtn")?.addEventListener("click", saveEvent);
  document.getElementById("cancelEventBtn")?.addEventListener("click", closeCreateModal);
  document.getElementById("deleteEventBtn")?.addEventListener("click", deleteEvent);
  document.getElementById("modalOverlay")?.addEventListener("click", closeCreateModal);

  document.getElementById("openStickyFromEventBtn")?.addEventListener("click", () => {
    openStickyModal(modalState.eventRef);
  });

  document.getElementById("stickyBackToEventBtn")?.addEventListener("click", () => {
    openCreateModal(null, modalState.eventRef);
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

  document.getElementById("logoutBtn")?.addEventListener("click", () => {
    if (typeof window.logout === "function") window.logout();
  });

  initRichEditorSystem();
}

window.initDateStickyStore = initDateStickyStore;
window.openStickyModal = openStickyModal;
window.openStickyModalForNew = openStickyModalForNew;
window.openDateStickyModal = openDateStickyModal;

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

  const choice = await openStickyChooserModal({
    title: `Move sticky notes from ${sourceLabel}`,
    subtitle: "Choose move mode",
    items: [],
    actions: [
      { label: "Choose One", value: "one", variant: "primary" },
      { label: "Move All", value: "all", variant: "danger" },
      { label: "Cancel", value: null, variant: "secondary" }
    ]
  });

  if (choice == null) {
    return { mode: "cancel", indices: [] };
  }

  if (choice === "all") {
    return { mode: "all", indices: notes.map((_, idx) => idx) };
  }

  const idx = await chooseStickyIndex(notes, "move");
  if (idx == null) {
    return { mode: "cancel", indices: [] };
  }

  return { mode: "single", indices: [idx] };
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
  movedItems.forEach((moved) => {
    targetDateNotes.push({
      ...moved,
      updatedAt: nowIso
    });
  });

  try {
    const res = await apiFetch(`/calendar/event/${backendId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sticky_notes: remainingEventNotes,
        sticky_note: remainingEventNotes[0] || null
      })
    });
    if (!res || !res.ok) throw new Error("event sticky update failed");

    const data = await res.json();
    const nextEvent = normalizeEventForCache(data.event, eventRef);
    upsertCacheEvent(nextEvent);

    const ok = await setDateStickyNotes(targetDateKey, targetDateNotes);
    if (!ok) return false;

    refreshStickyVisuals();
    const label = movedItems.length > 1 ? `${movedItems.length} stickies moved to date` : "🗒 Sticky moved to date";
    window.showToast?.(label);
    return true;
  } catch (err) {
    console.error("❌ move event sticky to date failed", err);
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
  movedItems.forEach((moved) => {
    eventNotes.push({
      ...moved,
      updatedAt: nowIso
    });
  });

  try {
    const res = await apiFetch(`/calendar/event/${backendId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sticky_notes: eventNotes,
        sticky_note: eventNotes[0] || null
      })
    });
    if (!res || !res.ok) throw new Error("event sticky update failed");

    const data = await res.json();
    const nextEvent = normalizeEventForCache(data.event, eventRef);
    upsertCacheEvent(nextEvent);

    const ok = await setDateStickyNotes(sourceDateKey, remainingDateNotes);
    if (!ok) return false;

    refreshStickyVisuals();
    const label = movedItems.length > 1 ? `${movedItems.length} stickies moved to event` : "🗒 Sticky moved to event";
    window.showToast?.(label);
    return true;
  } catch (err) {
    console.error("❌ move date sticky to event failed", err);
    window.showToast?.("❌ Sticky move failed", "error");
    return false;
  }
};

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