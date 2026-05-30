console.log("🔥 JS FILE LOADED");

/**************************************************************
 * ✅ AUTH GUARD (RUNS IMMEDIATELY)
 **************************************************************/
const token = localStorage.getItem("token");

if (!window.location.pathname.includes("calendar-ui")) {
  // Not our page → ignore
} else if (!token) {
  window.location.replace("/login");
  throw new Error("No token — blocking execution");
}


/**************************************************************
 * ✅ CENTRALIZED API FETCH
 **************************************************************/
async function apiFetch(url, options = {}) {
  const token = localStorage.getItem("token");

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + token,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    console.warn("🔐 Session expired → logging out");
    logout();
    throw new Error("Unauthorized");
  }

  return res;
}


/**************************************************************
 * ✅ GLOBAL STATE
 **************************************************************/
let calendar = null;
let editingEventId = null;
let editingNoteId = null;
let lastGoodEvents = [];

// ✅ Track selected day
let selectedDate = new Date();

// ✅ NEW: account filter
let activeAccountFilter = null;
/**************************************************************
 * ✅ INIT APP
 **************************************************************/
document.addEventListener("DOMContentLoaded", init);

function init() {
  console.log("✅ calendar.js loaded");

  const calendarEl = document.getElementById("calendar");
  if (!calendarEl) {
    console.warn("Missing #calendar element");
    return;
  }
  handleOAuthRedirect();
  initCalendar(calendarEl);
  bindUIEvents();
  // ✅ Initialize view to today
  updateDayDetails(selectedDate);
  updateWeekView();
  highlightSelectedDay(selectedDate);
}


/**************************************************************
 * ✅ HANDLE OAuth RETURN (?connected=)
 **************************************************************/
function handleOAuthRedirect() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");

  if (connected) {
    console.log("✅ Connected:", connected);

    syncNow();

    // Clean URL
    window.history.replaceState({}, document.title, "/calendar-ui");
  }
}


/**************************************************************
 * ✅ INIT FULLCALENDAR
 **************************************************************/
function initCalendar(el) {

  calendar = new FullCalendar.Calendar(el, {

    initialView: "dayGridMonth",

    /**************************************************
     * LOAD EVENTS + ACCOUNTS
     **************************************************/
    events: async (fetchInfo, successCallback, failureCallback) => {
      try {
        const token = localStorage.getItem("token");
        const res = await apiFetch(`/calendar/unified?token=${token}`);


        if (!res.ok) {
          throw new Error("API failed: " + res.status);
        }

        const data = await res.json();
        console.log("✅ API response:", data);

        // ✅ Robust + defensive mapping
        const events = Array.isArray(data?.events)
          ? data.events

              // ✅ STEP A: REMOVE BAD EVENTS
              .filter(ev => ev.start)

              // ✅ STEP B: APPLY ACCOUNT FILTER (NEW)
              .filter(ev => {

                // ✅ show everything if no filter selected
                if (!activeAccountFilter) return true;

                const email = ev.account || "";
                const key = `${ev.source}:${email}`;

                return key === activeAccountFilter;
              })

              // ✅ STEP C: MAP (UNCHANGED LOGIC)
              .map(ev => {
                const safeStart = new Date(ev.start);
                if (isNaN(safeStart)) return null;
                
                const safeEnd = ev.end ? new Date(ev.end) : null;

                return {
                  id: ev.id,
                  title: ev.title || "Untitled",

                  start: safeStart.toISOString(),
                  end: safeEnd ? safeEnd.toISOString() : null,

                  backgroundColor: ev.color || "#999",
                  borderColor: ev.color || "#999",

                  extendedProps: {
                    source: ev.source,
                    account: ev.account,
                    conflict: !!ev.conflict,
                    notes: ev.notes || []
                  }
                };
              
              })
              .filter(Boolean)   // ✅ ← ADD THIS LINE

          : [];
        // ✅ SAFE accounts
        renderAccounts?.(data?.accounts || []);

        console.log("✅ ACCOUNTS:", data.accounts);
        // ✅ SAVE GOOD EVENTS
        lastGoodEvents = events;
        
        successCallback(events);

        } catch (err) {
          console.error("❌ Event load failed:", err);

          // ✅ DO NOT CLEAR CALENDAR — USE LAST GOOD DATA
          if (lastGoodEvents.length > 0) {
            console.warn("⚠️ Using cached events");
            successCallback(lastGoodEvents);
          } else {
            failureCallback([]);
          }
        }
    },


    // ✅ ✅ ✅ PUT IT RIGHT HERE (IMPORTANT)
    eventsSet: () => {
      console.log("✅ eventsSet fired");
      updateWeekView();
    },

    eventDidMount: (info) => {
      // ✅ SHOW RED BORDER IF CONFLICT
      if (info.event.extendedProps.conflict) {
        info.el.style.border = "2px solid red";
      }

      // ✅ TOOLTIP
      info.el.title =
        info.event.extendedProps.source + " | " +
        (info.event.extendedProps.account || "");
    },

    /**************************************************
     * CLICK EVENT
     **************************************************/
    // ✅ CLICK DAY → CREATE + UPDATE SIDEBAR
    dateClick: (info) => {

      // ✅ SAVE selected date (VERY IMPORTANT)
      selectedDate = info.date;

      // ✅ ONLY update UI (no modal)
      updateDayDetails(info.date);
      updateWeekView();

      // ✅ store selected date for highlight
      highlightSelectedDay(info.date);

      // ✅ NEW: scroll week panel to this day
      setTimeout(() => {
        scrollWeekToDate(info.date);
      }, 50); // slight delay ensures DOM is ready
    },

    /**************************************************
     * ✅ DOUBLE CLICK HANDLER (SAFE)
     **************************************************/
    dayCellDidMount: function (info) {

      let clickTimer = null;

      info.el.addEventListener("click", () => {
        if (clickTimer) {
          // ✅ DOUBLE CLICK detected
          clearTimeout(clickTimer);
          clickTimer = null;

          openCreateModal(info.date); // ONLY here!

        } else {
          // ✅ WAIT to see if second click happens
          clickTimer = setTimeout(() => {
            clickTimer = null;
          }, 250);
        }
      });

    },


    // ✅ CLICK EVENT → EDIT + UPDATE SIDEBAR
    eventClick: (info) => {
      openCreateModal(null, info.event);

      // ✅ use event date to update sidebar
      if (info.event.start) {
        // ✅ SAVE selected date here too
        selectedDate = info.event.start;

        updateDayDetails(info.event.start);

        // ✅ keep sidebar + scroll aligned
        setTimeout(() => {
          scrollWeekToDate(info.event.start);
        }, 50);
      }
      updateWeekView();
    },


    /**************************************************
     * DRAG → UPDATE BACKEND
     **************************************************/
    eventDrop: async (info) => {
      try {
        await apiFetch(`/calendar/event/${info.event.id}`, {
          method: "PUT",
          body: JSON.stringify({
            start_time: info.event.start.toISOString(),
            end_time: info.event.end?.toISOString()
          })
        });
      } catch (err) {
        console.error("❌ Drag update failed:", err);
      }
    },

    /**************************************************
     * NOTES UI
     **************************************************/
    eventContent: (arg) => {
      const notes = arg.event.extendedProps.notes || [];

      const wrap = document.createElement("div");

      const title = document.createElement("div");
      title.textContent = arg.event.title;
      wrap.appendChild(title);

      notes.forEach(note => {
        const icon = document.createElement("span");
        icon.textContent = "📝";
        icon.title = stripHtml(note.content);

        icon.onclick = (e) => {
          e.stopPropagation();
          editNote(arg.event.id, note.id);
        };

        wrap.appendChild(icon);
      });

      return { domNodes: [wrap] };
    }
  });

  calendar.render();
}

/**************************************************************
 * ✅ ACCOUNT DISPLAY (HIDDEN IF EMPTY)
 **************************************************************/
function renderAccounts(accounts) {
  const el = document.getElementById("accounts");
  if (!el) return;

  if (!accounts || accounts.length === 0) {
    el.classList.add("hidden");
    return;
  }

  el.classList.remove("hidden");


  el.innerHTML = accounts.map(acc => {
    const icon = acc.provider === "google" ? "🟢" : "🔵";
    const email = acc.account_email || acc.email || "UNKNOWN";

    return `
      <div 
        style="
          margin: 4px 0;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
        "
        onclick="setAccountFilter('${acc.provider}:${email}')"
          style="
            margin:4px 0;
            cursor:pointer;
            padding:4px;
            border-radius:4px;
            background:${
              activeAccountFilter === `${acc.provider}:${email}`
                ? '#e8f0fe'
                : 'transparent'
            };
          "
      >
        ${icon}
        <span style="color:#333;">${email}</span>
      </div>
    `;
  }).join("");
} //✅ ← THIS WAS MISSING

  /**************************************************************
   * ✅ ACCOUNT FILTER HANDLER
   **************************************************************/
  function setAccountFilter(filterKey) {

    console.log("🎯 Filter selected:", filterKey);

    // ✅ toggle behavior
    if (activeAccountFilter === filterKey) {
      activeAccountFilter = null; // unselect
      console.log("✅ Filter cleared");
    } else {
      activeAccountFilter = filterKey;
    }

    // ✅ reload calendar data
    calendar.refetchEvents();
  }


//✅ ✅ DAY DETAILS FUNCTION
function updateDayDetails(date) {

  const titleEl = document.getElementById("selectedDateTitle");
  const listEl = document.getElementById("dayEventsList");

  if (!titleEl || !listEl || !calendar) return;

  const selectedDate = date.toISOString().split("T")[0];

  // ✅ Softer, cleaner header
  titleEl.innerHTML = `
    <div style="
      font-size:15px;
      font-weight:600;
      color:#333;
      margin-bottom:6px;
    ">
      ${date.toDateString()}
    </div>
  `;

  let events = calendar.getEvents().filter(ev =>
    ev.startStr.startsWith(selectedDate)
  );

  events.sort((a, b) => new Date(a.start) - new Date(b.start));

  listEl.innerHTML = "";

  if (events.length === 0) {
    listEl.innerHTML = `<li style="color:#888;">No events</li>`;
    return;
  }

  events.forEach(ev => {

    const li = document.createElement("li");

    const time = ev.start
      ? new Date(ev.start).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : "";

    li.innerHTML = `
      <div style="
        display:flex;
        align-items:center;
        gap:6px;
        margin-bottom:6px;
        font-size:13px;
        cursor:pointer;
        transition: background 0.15s ease;
        padding:2px 4px;
        border-radius:4px;
      ">
        <span style="
          width:4px;
          height:14px;
          background:${ev.backgroundColor};
        "></span>

        <span style="color:#555;">${time}</span>
        ${ev.title}
      </div>
    `;
    li.onmouseenter = () => {
      li.firstChild.style.background = "#f5f7fa";
    };

    li.onmouseleave = () => {
      li.firstChild.style.background = "transparent";
    };


    // ✅ CLICK → open edit modal
    li.onclick = () => {
      openCreateModal(null, ev);

      // ✅ scroll into view smoothly
      li.scrollIntoView({
        behavior: "smooth",
        block: "nearest"
      });
    };


    // ✅ HOVER PREVIEW
    li.title = ev.title;

    listEl.appendChild(li);
  });
}

//✅ ✅ WEEK VIEW FUNCTION
function updateWeekView() {

  const container = document.getElementById("weekView");
  if (!container || !calendar) return;

  const events = calendar.getEvents();

  // ✅ USE selected date OR fallback to today
  const baseDate = selectedDate || new Date();

  const start = new Date(baseDate);
  start.setDate(baseDate.getDate() - baseDate.getDay());

  const end = new Date(start);
  end.setDate(start.getDate() + 7);

  let weekEvents = events.filter(ev => {
    if (!ev.start) return false;

    const evDate = new Date(ev.start);
    const evDay = evDate.toISOString().split("T")[0];

    const startDay = start.toISOString().split("T")[0];
    const endDay = end.toISOString().split("T")[0];

    return evDay >= startDay && evDay < endDay;
  });

  container.innerHTML = "";

  if (weekEvents.length === 0) {
    container.innerHTML = `<div style="color:#888;">No events this week</div>`;
    return;
  }

  weekEvents.sort((a, b) => new Date(a.start) - new Date(b.start));

  let currentDay = "";

  weekEvents.forEach(ev => {

    const evDate = new Date(ev.start);
    const dayLabel = evDate.toDateString();

    // ✅ Better section header (lighter + separated)
    if (dayLabel !== currentDay) {
      currentDay = dayLabel;


      const dayDiv = document.createElement("div");
      // ✅ tag for auto-scroll targeting
      dayDiv.setAttribute("data-day", evDate.toISOString().split("T")[0]);
      dayDiv.innerHTML = `
        <div style="
          margin-top:12px;
          margin-bottom:4px;
          font-size:13px;
          font-weight:600;
          color:#444;
          border-top:1px solid #ddd;
          padding-top:6px;
        ">
          ${dayLabel}
        </div>
      `;

      container.appendChild(dayDiv);
    }

    const time = ev.start
      ? evDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : "";

    const row = document.createElement("div");
    row.onmouseenter = () => {
      row.firstChild.style.background = "#f5f7fa";
    };

    row.onmouseleave = () => {
      row.firstChild.style.background = "transparent";
    };



    row.innerHTML = `
        <div style="
          display:flex;
          align-items:center;
          gap:6px;
          margin-left:10px;
          margin-bottom:4px;
          font-size:13px;
          cursor:pointer;
          transition: background 0.15s ease;
          padding:2px 4px;
          border-radius:4px;
        ">

          <span style="
            width:4px;
            height:12px;
            background:${ev.backgroundColor};
          "></span>

          <span style="color:#555;">${time}</span>
          ${ev.title}

        </div>
      `;



    // ✅ CLICK → OPEN MODAL
    row.onclick = () => {
      openCreateModal(null, ev);

      // ✅ scroll selected item into view
      row.scrollIntoView({
        behavior: "smooth",
        block: "nearest"
      });
    };

    // ✅ HOVER TOOLTIP
    row.title = ev.title;

    container.appendChild(row);
  });
}


/**************************************************************
 * ✅ OAUTH BUTTONS
 **************************************************************/
function connectGoogle() {
  window.location.href =
    `/auth/google/login?token=${encodeURIComponent(token)}`;
}


function connectOutlook() {
  window.location.href =
    `/ms/login?token=${encodeURIComponent(token)}`;
}



/**************************************************************
 * ✅ SYNC
 **************************************************************/
async function syncNow() {
  try {
    await apiFetch("/calendar/sync", { method: "POST" });

    alert("✅ Sync complete");

    calendar.refetchEvents();

  } catch (err) {
    console.error("❌ Sync failed:", err);
  }
}


/**************************************************************
 * ✅ CREATE / EDIT EVENT MODAL
 **************************************************************/
function openCreateModal(date = null, event = null) {
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
  document.getElementById("eventTitle").value = "";

  // ✅ CURRENT TIME
  const now = new Date();

  // ✅ DEFAULT DATE = TODAY
  const todayStr = now.toISOString().split("T")[0];
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
    editingEventId = event.id;

    document.getElementById("eventTitle").value = event.title;

    if (event.start) {
      const d = new Date(event.start);
      document.getElementById("eventDate").value =
        d.toISOString().split("T")[0];
      document.getElementById("eventStart").value =
        d.toTimeString().slice(0, 5);
    }

    if (event.end) {
      const d = new Date(event.end);
      document.getElementById("eventEnd").value =
        d.toTimeString().slice(0, 5);
    }
  }

  // ✅ If clicking a day → PRE-FILL DATE
  if (date && !event) {
    document.getElementById("eventDate").value =
      date.toISOString().split("T")[0];
  }

  // ✅ AUTO-FOCUS TITLE INPUT
  document.getElementById("eventTitle")?.focus();

}


function closeCreateModal() {
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
async function saveEvent() {
  const title = document.getElementById("eventTitle").value;
  const date = document.getElementById("eventDate").value;
  const start = document.getElementById("eventStart").value;
  const end = document.getElementById("eventEnd").value;

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

  try {
    if (editingEventId) {
      // ✅ UPDATE
      await apiFetch(`/calendar/event/${editingEventId}`, {
        method: "PUT",
        body: JSON.stringify({
          title,
          start_time: startISO,
          end_time: endISO
        })
      });
    } else {
      // ✅ CREATE
      await apiFetch("/calendar/event", {
        method: "POST",
        body: JSON.stringify({
          title,
          start_time: startISO,
          end_time: endISO
        })
      });
    }

    closeCreateModal();
    calendar.refetchEvents();

  } catch (err) {
    console.error("❌ Save failed:", err);
  }
}

/**************************************************************
 * ✅ DELETE EVENT (CREATE OR UPDATE)
 **************************************************************/
async function deleteEvent() {
  if (!editingEventId) return;

  const confirmDelete = confirm("Delete this event?");
  if (!confirmDelete) return;

  try {
    await apiFetch(`/calendar/event/${editingEventId}`, {
      method: "DELETE"
    });


    closeCreateModal();
    calendar.refetchEvents();

  } catch (err) {
    console.error("❌ Delete failed:", err);
  }
}

/**************************************************************
 * ✅ LOGOUT
 **************************************************************/
function logout() {
  localStorage.removeItem("token");
  window.location.href = "/login";
}


/**************************************************************
 * ✅ HELPERS
 **************************************************************/

//✅ HIGHLIGHT SELECTED DAY
function highlightSelectedDay(date) {

  document.querySelectorAll(".fc-daygrid-day").forEach(el => {
    el.style.backgroundColor = "";
    el.style.transition = "background 0.2s ease";
  });

  const dateStr = date.toISOString().split("T")[0];

  const el = document.querySelector(`[data-date="${dateStr}"]`);

  if (el) {
    el.style.backgroundColor = "#e8f0fe";
    el.style.borderRadius = "4px";
  }
}

/**************************************************************
 * ✅ AUTO SCROLL WEEK VIEW TO SELECTED DAY
 **************************************************************/
function scrollWeekToDate(date) {

  const dateStr = date.toISOString().split("T")[0];

  const el = document.querySelector(`[data-day="${dateStr}"]`);

  if (el) {
    el.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });
  }
}


function getColor(source) {
  if (source === "google") return "blue";
  if (source === "microsoft") return "green";
  return "gray";
}

function stripHtml(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent || "";
}


/**************************************************************
 * ✅ NOTES
 **************************************************************/
function editNote(eventId, noteId = null) {
  editingEventId = eventId;
  editingNoteId = noteId;
  document.getElementById("noteEditorModal")?.classList.remove("hidden");
}

async function saveNoteEditor() {
  const content = document.getElementById("editor").innerHTML;

  await apiFetch("/events/note", {
    method: "POST",
    body: JSON.stringify({
      event_id: editingEventId,
      note_id: editingNoteId,
      content
    })
  });

  document.getElementById("noteEditorModal")?.classList.add("hidden");

  calendar.refetchEvents();
}


/**************************************************************
 * ✅ UI BUTTON BINDINGS
 **************************************************************/
function bindUIEvents() {

  // ✅ Create button
  const createBtn = document.getElementById("createBtn");
  console.log("createBtn:", createBtn);

  if (createBtn) {
    createBtn.addEventListener("click", () => {
      console.log("🔥 CREATE BUTTON CLICKED");
      openCreateModal();
    });
  }

  // ✅ OAuth buttons
  document.getElementById("googleBtn")
    ?.addEventListener("click", connectGoogle);

  document.getElementById("outlookBtn")
    ?.addEventListener("click", connectOutlook);

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

  //✅ Press Enter → Save
  document.getElementById("createEventModal")
    ?.addEventListener("keydown", (e) => {

      if (e.key === "Enter") {
        e.preventDefault();

        // avoid weird behavior in future textareas
        if (e.target.tagName.toLowerCase() === "textarea") return;

        saveEvent();
      }
    });

}

/**************************************************************
 * ✅ KEYBOARD SHORTCUTS
 **************************************************************/
document.addEventListener("keydown", (e) => {

  // ✅ ESC = CLOSE MODAL
  if (e.key === "Escape") {
    closeCreateModal();
  }

  // ✅ N = CREATE NEW EVENT
  if (e.key.toLowerCase() === "n") {
    openCreateModal();
  }

});
