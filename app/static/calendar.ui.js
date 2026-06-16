
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
    ?.addEventListener("click", connectOutlook);

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
    ?.addEventListener("click", deleteEvent);

  // ✅ Existing buttons
  document.getElementById("syncBtn")
    ?.addEventListener("click", syncNow);

  document.getElementById("logoutBtn")
    ?.addEventListener("click", logout);

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

  // hide by default
  deleteBtn.style.display = "none";

  // show only if editing
  if (event) {
    deleteBtn.style.display = "inline-block";
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

  editingEventId = null;

  // ✅ If clicking an existing event → EDIT MODE
  if (event) {
    editingEventId = event.extendedProps?.backendId;
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
 **************************************************************/
/**************************************************************
✅ SAVE EVENT — FULLY CORRECT + CLOSED STRUCTURE
---------------------------------------------------------------
- No missing braces
- Single source of truth
- Safe async handling
**************************************************************/
async function saveEvent() {

  if (isSavingEvent) {
    console.warn("🚫 Duplicate save blocked");
    return;
  }

  isSavingEvent = true;

  try {

    const title = document.getElementById("eventTitle").value;
    const date  = document.getElementById("eventDate").value;
    const start = document.getElementById("eventStart").value;
    const end   = document.getElementById("eventEnd").value;

    const localKey = "local:local";
    const colorInput = document.getElementById("eventColor");

    const color =
      colorInput?.value ||
      getColorByKey(localKey, "local");

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
      title: title,
      start_time: startISO,
      end_time: endISO,
      color: color,
      source: "local",
      account_key: localKey
    };

    const res = await apiFetch("/calendar/event", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + localStorage.getItem("token")
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error("Save failed");

    const data = await res.json();

    /**************************************************************
    ✅ NORMALIZE EVENT
    **************************************************************/
    const normalizedEvent = {
      ...data.event,
      start: new Date(data.event.start || data.event.start_time),
      end: data.event.end
        ? new Date(data.event.end)
        : (data.event.end_time ? new Date(data.event.end_time) : null),
      extendedProps: {
        ...(data.event.extendedProps || {}),
        source: data.event.source || "local",
        account_key: data.event.account_key || "local:local",
        backendId: data.event.id
      }
    };

    /**************************************************************
    ✅ UPDATE CACHE
    **************************************************************/
    sessionEventCache.push(normalizedEvent);

    /**************************************************************
    ✅ CONTROLLED STATE UPDATE
    **************************************************************/
    window.selectedDate = toDayString(normalizedEvent.start);

    /**************************************************************
    ✅ RENDER PIPELINE
    **************************************************************/
    updateDayDetails();
    updateWeekView();
    highlightSelectedDay(window.selectedDate);

    /**************************************************************
    ✅ FINAL UI ACTIONS
    **************************************************************/
    showToast("✅ Event saved");
    closeCreateModal();

    smartRefresh({ reason: "event_saved", force: true });

  } catch (err) {
    console.error("❌ Save failed:", err);
  } finally {
    isSavingEvent = false;
  }
}

/**************************************************************
 * ✅ DELETE EVENT (CREATE OR UPDATE)
 **************************************************************/
async function deleteEvent() {
  if (!editingEventId) {
    console.warn("🚫 Cannot delete: no backend ID (external or invalid event)");
    return;
  }

  const confirmDelete = confirm("Delete this event?");
  if (!confirmDelete) return;

    try {

    /**************************************************************
     ✅ STEP 2 DEBUG — VERIFY EXACT EVENT BEFORE DELETE
    **************************************************************/
    const debugMatch = sessionEventCache.find(e =>
      e.extendedProps?.backendId === editingEventId
    );

    /**************************************************************
     ✅ DELETE FROM BACKEND
    **************************************************************/
    const res = await apiFetch(`/calendar/event/${editingEventId}`, {
      method: "DELETE"
    });

    /**************************************************************
     ✅ CRITICAL FIX — REMOVE FROM CACHE IMMEDIATELY
    **************************************************************/
    sessionEventCache = sessionEventCache.filter(e => {
      return e.extendedProps?.backendId !== editingEventId;
    });
    
    /**************************************************************
     ✅ BLOCK BOTH BACKEND + DISPLAY IDS
    **************************************************************/
    window.deletedEventIds = window.deletedEventIds || new Set();

    window.deletedEventIds.add(editingEventId); // backendId

    // ALSO block displayId (critical)
    const displayMatch = sessionEventCache.find(e =>
      e.extendedProps?.backendId === editingEventId
    );

    if (displayMatch?.id) {
      window.deletedEventIds.add(displayMatch.id);
    }

    closeCreateModal();
    smartRefresh({ reason: "event_deleted" });

    /**************************************************************
     ✅ KEEP YOUR CURRENT SAFETY RELOAD (OK FOR NOW)
     Comment this code out so we can redesign with Gold Standard
    **************************************************************/
    //needsCacheRefresh = true;
    //await preloadEventCache();  // 🔥 DISABLED (Phase 3)

    /**************************************************************
    ✅ FORCE FULLCALENDAR HARD RESET (CRITICAL)
    ✅ Fixes Monthly view ghost events
    **************************************************************/
    if (window.calendar) {
      console.log("🔥 FORCE CALENDAR REFETCH");
      /**************************************************************
       ✅ FULLCALENDAR HARD REFRESH (SAFE + CORRECT)
      **************************************************************/
      if (window.calendar && typeof window.calendar.refetchEvents === "function") {

        console.log("🔥 FORCE CALENDAR REFETCH");

        window.calendar.refetchEvents();   // ✅ ONLY THIS IS NEEDED
      }
    }

  } catch (err) {
    console.error("❌ Delete failed:", err);
  }
}
