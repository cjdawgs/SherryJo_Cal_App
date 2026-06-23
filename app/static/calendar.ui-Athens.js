import { getActiveRangeLabel, toDayString } from "./core.js";
import { connectGoogle, connectMicrosoft, connectApple } from "./account_connections.js";
import { renderRangePill, highlightSelectedDay } from "./calendar.fullcalendar.js";
// ✅ apiFetch is the central authenticated fetch helper defined in api.js.
//    api.js also sets window.apiFetch, but importing directly is cleaner and
//    avoids the module strict-mode bare-name lookup that causes ReferenceError.
import { apiFetch } from "./api.js";

/**************************************************************
 * ✅ GLOBAL STATE
 **************************************************************/
window.isModalOpen = false;
let isSavingEvent = false;

/**************************************************************
✅ RANGE TOOLTIP ENGINE (UI LAYER ONLY)
- NO logic duplication
- Uses core range engine (single source of truth)
✅ RANGE TOOLTIPS (NUMERIC SAFE VERSION)
**************************************************************/
function applyRangeTooltips() {

  document.querySelectorAll(".range-btn").forEach(btn => {

    // ✅ skip custom (no range)
    if (!btn.dataset.range) return;

    const days = parseInt(btn.dataset.range);
    if (!days) return;

    const preview = getActiveRangeLabel(days);

    if (preview?.label) {
      btn.title = `Range: ${preview.label}
Start: ${preview.start.toLocaleDateString()}
End: ${preview.end.toLocaleDateString()}`;
    }

  });

}


/**************************************************************
 * ✅ UI BUTTON BINDINGS
 **************************************************************/
function bindUIEvents() {

  // ✅ Create button
  const createBtn = document.getElementById("createBtn");

  if (createBtn) {
    createBtn.addEventListener("click", (e) => {

      // ✅ BLOCK if modal already open
      if (window.isModalOpen) {
        console.warn("🚫 Modal reopen HARD BLOCKED");
        return;
      }

      // ✅ SET IMMEDIATELY BEFORE ANY UI CHANGES
      window.isModalOpen = true;
      openCreateModal();
    });
  }

  /**************************************************************
   * ✅ OPEN ACCOUNTS UI (SUBTLE NAV)
   **************************************************************/
  document.getElementById("accountsBtn")
    ?.addEventListener("click", () => {

      window.location.href = "/accounts/ui";
    });

  // ✅ OAuth buttons
  document.getElementById("googleBtn")
    ?.addEventListener("click", connectGoogle);

  document.getElementById("outlookBtn")
    ?.addEventListener("click", connectMicrosoft);

  document.getElementById("appleBtn")
    ?.addEventListener("click", connectApple);    

  // ✅ Task button
  document.getElementById("addTaskBtn")
    ?.addEventListener("click", addTask);

  // ✅ Modal buttons
  document.getElementById("saveEventBtn")
    ?.addEventListener("click", saveEvent);

  document.getElementById("cancelEventBtn")
    ?.addEventListener("click", closeCreateModal);

  document.getElementById("deleteEventBtn")
  ?.addEventListener("click", () => {
    if (typeof window.deleteEvent === "function") {
      window.deleteEvent();
    } else {
      console.error("❌ deleteEvent not ready");
    }
  });

  // ✅ Existing buttons
  document.getElementById("syncBtn")
    ?.addEventListener("click", async () => {
      if (typeof window.syncNow === "function") {
        await window.syncNow();
      } else {
        console.error("❌ syncNow not ready");
      }
    });
  document.getElementById("logoutBtn")
    ?.addEventListener("click", () => {
      if (typeof window.logout === "function") {
        window.logout();
      } else {
        console.error("❌ logout not ready");
      }
    });


  // ✅ Make sure endDate is always after startDate and is deafulted to StartDate plus 1 hr
  document.getElementById("eventStart")
    ?.addEventListener("change", () => {
      const startVal = document.getElementById("eventStart").value;
      if (!startVal) return;

      const [hour, minute] = startVal.split(":").map(Number);

      const endDate = new Date();
      endDate.setHours(hour + 1);
      endDate.setMinutes(minute || 0);

      document.getElementById("eventEnd").value =
        endDate.toTimeString().slice(0, 5);
    });

  
  /**************************************************************
  ✅ RANGE BUTTON ENGINE (FULL REPLACEMENT — SINGLE SOURCE)
  - Updates:
    • currentRangeDays
    • label (UI)
    • tooltips
    • triggers refresh
  ✅ RANGE BUTTON ENGINE (FINAL — SINGLE SOURCE)
  **************************************************************/
  document.querySelectorAll(".range-btn").forEach(btn => {

    btn.addEventListener("click", () => {

      const days = parseInt(btn.dataset.range);
      if (!days) return;

      console.log("✅ RANGE SELECTED:", days);

      currentRangeDays = days;
      window.currentRangeDays = days;


      const { label } = getActiveRangeLabel(days);

      const labelEl = document.getElementById("activeRangeLabel");
      if (labelEl) {
        labelEl.textContent = label;
      }

      applyRangeTooltips();

      // ✅ ✅ ✅ THIS WAS CORRECT — KEEP IT
      const cal = window.calendar;
      if (cal && sessionEventCache.length) {

        // ✅ DO NOT MOVE CALENDAR ANYMORE
        // Keep current visible month intact

        const cal = window.calendar;
        if (cal) {

          // ✅ Force refresh only (no position change)
          cal.refetchEvents();

          console.log("✅ RANGE UPDATED (NO NAV):", days);
        }
        cal.refetchEvents();

        console.log("✅ CAL MOVED:", days);
      }

      smartRefresh({ reason: "range_change" });

      renderRangePill(); // ✅ force UI update immediately

    });

  });

}

/**************************************************************
 * ✅ CREATE / EDIT EVENT MODAL
 **************************************************************/
function openCreateModal(date = null, event = null) {
  window.isModalOpen = true;
  const modal = document.getElementById("createEventModal");
  if (!modal) return;


  const deleteBtn = document.getElementById("deleteEventBtn");

  // ✅ Reset: hide delete button for new events
  if (deleteBtn) deleteBtn.style.display = "none";

  // ✅ Reset editingEventId — also sync to window for cross-module access
  editingEventId = null;
  window.editingEventId = null;

  // ✅ show only if editing
  if (event) {
    if (deleteBtn) deleteBtn.style.display = "inline-block";
  }

  modal.style.opacity = "0";
  modal.classList.add("show");
  setTimeout(() => {
    modal.style.opacity = "1";
  }, 10);

  document.getElementById("modalOverlay")?.classList.add("show");

  // ✅ RESET FORM
  const titleInput = document.getElementById("eventTitle");

  // ✅ ONLY reset if truly new open
  if (titleInput && !titleInput.value) {
    titleInput.value = "";
  }

  // ✅ CURRENT TIME
  const now = new Date();

  // ✅ DEFAULT DATE = TODAY
  const todayStr = toDayString(now);
  document.getElementById("eventDate").value = todayStr;

  // ✅ NEXT FULL HOUR
  const nextHour = new Date(now);

  if (now.getMinutes() === 0) {
    nextHour.setHours(now.getHours());
  } else {
    nextHour.setHours(now.getHours() + 1);
  }

  nextHour.setMinutes(0);
  nextHour.setSeconds(0);

  // ✅ END = +1 HOUR
  const endHour = new Date(nextHour);
  endHour.setHours(endHour.getHours() + 1);

  // ✅ FORMAT HH:MM
  const formatTime = (d) => d.toTimeString().slice(0, 5);

  // ✅ SET DEFAULT TIMES
  document.getElementById("eventStart").value = formatTime(nextHour);
  document.getElementById("eventEnd").value = formatTime(endHour);

  // editingEventId is already cleared above (near deleteBtn reset)

  // ✅ If clicking an existing event → EDIT MODE
  if (event) {
    editingEventId = event.extendedProps?.backendId;
    // ✅ Sync to window so calendar.js deleteEvent reads the same value
    window.editingEventId = editingEventId;
    console.log("🧠 MODAL EVENT FULL:", event);
    console.log("🧠 backendId:", event.extendedProps?.backendId);
    console.log("🧠 event.id:", event.id);
        
    document.getElementById("eventTitle").value = event.title;

    if (event.start) {
      const d = event.start;
      document.getElementById("eventDate").value =
        toDayString(d);
      document.getElementById("eventStart").value =
        d.toTimeString().slice(0, 5);
    }

    if (event.end) {
      const d = event.end;
      document.getElementById("eventEnd").value =
        d.toTimeString().slice(0, 5);
    }
  }

  // ✅ If clicking a day → PRE-FILL DATE
  if (date && !event) {
    document.getElementById("eventDate").value =
      toDayString(date);
  }

  // ✅ AUTO-FOCUS TITLE INPUT
  document.getElementById("eventTitle")?.focus();

}


function closeCreateModal() {
  window.isModalOpen = false;
  const modal = document.getElementById("createEventModal");

  if (modal) {
    modal.style.opacity = "0";
  }
  document.getElementById("createEventModal")
    ?.classList.remove("show");

  document.getElementById("modalOverlay")
    ?.classList.remove("show");
}


/**************************************************************
 * ✅ SAVE EVENT (CREATE OR UPDATE)
 *
 * FLOW:
 *   - If window.editingEventId is set  → PUT  /calendar/event/{id}  (edit)
 *   - Otherwise                         → POST /calendar/event       (create)
 *
 * Both paths:
 *   1. Persist to backend
 *   2. Update window.sessionEventCache immediately (no full reload)
 *   3. Re-render sidebar + FullCalendar
 **************************************************************/
async function saveEvent() {

  console.log("SAVE EVENT TRIGGERED", { editingId: window.editingEventId });

  if (isSavingEvent) {
    console.warn("🚫 Duplicate save blocked");
    return;
  }

  isSavingEvent = true;

  try {

    const title = document.getElementById("eventTitle").value.trim();
    const date  = document.getElementById("eventDate").value;
    const start = document.getElementById("eventStart").value;
    const end   = document.getElementById("eventEnd").value;

    if (!title || !date) {
      alert("Title and date required");
      return;
    }

    const startISO = start
      ? new Date(`${date}T${start}`).toISOString()
      : new Date(`${date}T00:00`).toISOString();

    const endISO = end
      ? new Date(`${date}T${end}`).toISOString()
      : null;

    const payload = {
      title,
      start_time: startISO,
      end_time:   endISO,
      source:     "local",
      account_key: "local:local",
    };

    // ✅ Decide CREATE vs UPDATE
    const isEdit = Boolean(window.editingEventId);
    const url    = isEdit
      ? `/calendar/event/${window.editingEventId}`
      : "/calendar/event";
    const method = isEdit ? "PUT" : "POST";

    console.log(`SAVE EVENT → ${method} ${url}`, payload);

    const res = await apiFetch(url, { method, body: payload });

    if (!res) {
      throw new Error("No response from server");
    }
    if (!res.ok) {
      const errText = await res.text().catch(() => res.status);
      throw new Error(`Save failed (${res.status}): ${errText}`);
    }

    const data = await res.json();
    console.log("SAVE EVENT RESPONSE:", data);

    const ev = data.event;
    if (!ev) throw new Error("Server response missing event object");

    /***********************************************************
     * ✅ BUILD NORMALIZED EVENT (matches sessionEventCache shape)
     ***********************************************************/
    const normalizedEvent = {
      id:    String(ev.id),
      title: ev.title,
      start: new Date(ev.start || ev.start_time),
      end:   ev.end ? new Date(ev.end) : (ev.end_time ? new Date(ev.end_time) : null),
      extendedProps: {
        ...(ev.extendedProps || {}),
        source:      ev.source       || "local",
        account_key: ev.account_key  || "local:local",
        account:     ev.account      || "local",
        backendId:   ev.id,
      },
    };

    /***********************************************************
     * ✅ UPDATE WINDOW.SESSIONEVENTCACHE (single source of truth)
     ***********************************************************/
    if (!Array.isArray(window.sessionEventCache)) {
      window.sessionEventCache = [];
    }

    if (isEdit) {
      // Replace existing entry in-place
      const idx = window.sessionEventCache.findIndex(
        e => String(e.id) === String(ev.id) ||
             e.extendedProps?.backendId === ev.id
      );
      if (idx !== -1) {
        window.sessionEventCache[idx] = normalizedEvent;
      } else {
        window.sessionEventCache.push(normalizedEvent);
      }
    } else {
      window.sessionEventCache.push(normalizedEvent);
    }

    /***********************************************************
     * ✅ UPDATE SIDEBAR
     ***********************************************************/
    window.selectedDate = toDayString(normalizedEvent.start);
    window.updateDayDetails?.();
    window.updateWeekView?.();
    highlightSelectedDay(window.selectedDate);

    /***********************************************************
     * ✅ FINAL UI
     ***********************************************************/
    window.showToast?.(`✅ Event ${isEdit ? "updated" : "saved"}`);
    closeCreateModal();

    // Force FullCalendar to re-read from the updated cache
    window.smartRefresh?.({ reason: "event_saved", force: true });

  } catch (err) {
    console.error("❌ Save failed:", err);
    window.showToast?.("❌ Save failed: " + err.message, "error");
    alert("❌ Save failed: " + err.message);
  } finally {
    isSavingEvent = false;
  }
}

/**************************************************************
 * ✅ DELETE EVENT (calendar.ui.js version)
 * NOTE: window.deleteEvent is set in calendar.js and is what the
 *       delete button actually calls.  This version is kept as
 *       fallback — it delegates to window.deleteEvent if available.
 **************************************************************/
async function deleteEvent() {
  // Prefer the calendar.js version which has apiFetch + smartRefresh in scope
  if (typeof window.deleteEvent === "function" && window.deleteEvent !== deleteEvent) {
    return window.deleteEvent();
  }

  const targetId = window.editingEventId;
  if (!targetId) {
    console.warn("🚫 Cannot delete: no editingEventId");
    return;
  }

  if (!confirm("Delete this event?")) return;

  try {
    const res = await apiFetch(`/calendar/event/${targetId}`, {
      method: "DELETE"
    });

    if (!res || !res.ok) {
      console.error("❌ Delete failed", res?.status);
      window.showToast?.("❌ Delete failed", "error");
      return;
    }

    // ✅ Remove from cache
    if (Array.isArray(window.sessionEventCache)) {
      window.sessionEventCache = window.sessionEventCache.filter(
        e => e.extendedProps?.backendId !== targetId &&
             String(e.id) !== String(targetId)
      );
    }

    window.deletedEventIds = window.deletedEventIds || new Set();
    window.deletedEventIds.add(targetId);
    window.editingEventId = null;

    closeCreateModal();
    window.showToast?.("🗑 Event deleted");
    window.smartRefresh?.({ reason: "event_deleted", force: true });

  } catch (err) {
    console.error("❌ Delete error:", err);
    window.showToast?.("❌ Delete error: " + err.message, "error");
  }
}

// Export UI functions for the main entrypoint
export {
  applyRangeTooltips,
  bindUIEvents,
  openCreateModal,
  closeCreateModal,
  saveEvent,
  deleteEvent
};
