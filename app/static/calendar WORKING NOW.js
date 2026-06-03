console.log("🔥 JS FILE LOADED");
console.log("🔐 TOKEN AT LOAD:", localStorage.getItem("token"));

function getTokenOrFail() {
  const token = localStorage.getItem("token");

  if (!token) {
    console.error("❌ NO TOKEN — redirecting to login");
    window.location.replace("/login");
    throw new Error("No token");
  }

  return token;
}

if (window.location.pathname.includes("calendar-ui")) {
  getTokenOrFail();
}

async function apiFetch(url, options = {}) {
  const authToken = getTokenOrFail();

  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + authToken,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    console.error("❌ 401 — token invalid or expired");
    localStorage.removeItem("token");
    window.location.replace("/login");
    throw new Error("Unauthorized");
  }

  return res;
}

/**************************************************************
 ✅ GLOBAL STATE
**************************************************************/
let calendar = null;
let lastGoodEvents = [];
let selectedDate = new Date();

/**************************************************************
 ✅ INIT
**************************************************************/
document.addEventListener("DOMContentLoaded", init);

async function init() {
  console.log("✅ calendar.js loaded");

  const calendarEl = document.getElementById("calendar");
  if (!calendarEl) return;

  let attempts = 0;

  while (!localStorage.getItem("token") && attempts < 10) {
    await new Promise(r => setTimeout(r, 200));
    attempts++;
  }

  if (!localStorage.getItem("token")) {
    window.location.replace("/login");
    return;
  }

  getTokenOrFail();

  initCalendar(calendarEl);
}

/**************************************************************
 ✅ SAFE DATE PARSER
**************************************************************/
function safeParseDate(dt) {
  if (!dt) return null;

  const parsed = new Date(dt);
  if (isNaN(parsed.getTime())) return null;

  return parsed;
}

/**************************************************************
 ✅ CALENDAR
**************************************************************/
function initCalendar(el) {
  calendar = new FullCalendar.Calendar(el, {

    initialView: "dayGridMonth",
    timeZone: "UTC",

    // ✅ ADD THIS LINE
    eventDisplay: "block",
    displayEventTime: true,


    // ✅ SHOW ALL EVENTS (critical)
    dayMaxEventRows: false,
    dayMaxEvents: true,

    events: async (fetchInfo, successCallback) => {
      try {
        const start = fetchInfo.startStr;
        const end = fetchInfo.endStr;

        const res = await apiFetch(
          `/calendar/unified?start=${start}&end=${end}`
        );

        const data = await res.json();

        const rawEvents = Array.isArray(data)
          ? data
          : data?.events || [];

        let mappedEvents = rawEvents.map(ev => {

          const safeStart = safeParseDate(ev.start);
          if (!safeStart || isNaN(safeStart.getTime())) {
            console.warn("❌ DROPPED EVENT:", ev);
            return null;
          }

          const safeEnd = safeParseDate(ev.end);

          const account = (ev.account_email || ev.account || "")
            .toLowerCase()
            .trim();

          // ✅ ✅ ✅ DEFINE COLOR HERE (THIS WAS MISSING / OUT OF SCOPE)
          let color = "#999";

          // ✅ DEFINE FIRST (NO DUPLICATES)
          let provider = (ev.source || "").toLowerCase().trim();

          if (provider === "outlook") provider = "microsoft";

          // ✅ APPLE NORMALIZATION
          if (
            provider.includes("apple") ||
            provider.includes("icloud") ||
            provider.includes("mac")
          ) {
            provider = "apple";
          }

          // ✅ NOW SAFE TO USE
          console.log("PROVIDER:", provider);

          // ✅ COLOR LOGIC
          if (provider === "google") color = "#34a853";
          if (provider === "microsoft") color = "#2563eb";
          if (provider === "apple") color = "#ef4444";

          const id =
            ev.external_id ||
            ev.id ||
            crypto.randomUUID();

          return {
            id,
            title: ev.title || ev.summary || "Untitled",
            start: safeStart,
            end: safeEnd || null,

            backgroundColor: color,
            borderColor: color,
            textColor: "#fff",

            // ✅ ✅ ✅ THIS IS THE MISSING PIECE 
            classNames: ["source-" + provider],

            extendedProps: {
              source: provider,
              account,
              account_key: `${provider}:${account}`
            }
          };


        }).filter(Boolean);

        
        // ✅ ✅ ✅ PUT THIS RIGHT HERE
        const dropped = rawEvents.length - mappedEvents.length;
        console.log("⚠️ DROPPED DURING MAPPING:", dropped);


        console.log("✅ TOTAL EVENTS (mapped):", mappedEvents.length);

        successCallback(mappedEvents);

        // ✅ ✅ ✅ PUT THIS RIGHT HERE
        setTimeout(() => {
          const stored = calendar.getEvents().length;

          console.log("✅ FINAL IN CALENDAR:", stored);
          console.log("✅ EXPECTED:", mappedEvents.length);

          const apple = calendar.getEvents().filter(e => e.extendedProps.source === "apple").length;
          console.log("🍎 FINAL APPLE:", apple);

        }, 500);

        lastGoodEvents = mappedEvents;

      } catch (err) {
        console.error("❌ Event load failed:", err);
        successCallback(lastGoodEvents);
      }
    },

    eventClick: (info) => {
      selectedDate = info.event.start;
      updateDayDetails(selectedDate);
    },

    dateClick: (info) => {
      selectedDate = info.date;
      updateDayDetails(selectedDate);
    },

    // ✅ ADD RIGHT HERE
    eventDidMount: function(info) {
      const provider = (info.event.extendedProps.source || "").toLowerCase();
      console.log("🎯 RENDER:", provider, info.event.title);

      if (provider === "apple") {
        info.el.style.backgroundColor = "#ef4444";
        info.el.style.borderColor = "#ef4444";
      }

      if (provider === "microsoft") {
        info.el.style.backgroundColor = "#2563eb";
        info.el.style.borderColor = "#2563eb";
      }

      if (provider === "google") {
        info.el.style.backgroundColor = "#34a853";
        info.el.style.borderColor = "#34a853";
      }

      info.el.style.color = "#fff";
    }
  });

  calendar.render();
}

/**************************************************************
 ✅ DAY VIEW
**************************************************************/
function updateDayDetails(date) {

  const listEl = document.getElementById("dayEventsList");
  if (!listEl || !calendar) return;

  const selected = new Date(date);
  selected.setHours(0,0,0,0);

  const events = calendar.getEvents().filter(ev => {
    if (!ev.start) return false;

    const d = new Date(ev.start);

    return (
      d.getFullYear() === selected.getFullYear() &&
      d.getMonth() === selected.getMonth() &&
      d.getDate() === selected.getDate()
    );
  });

  console.log("📅 DAY EVENTS:", events.length);

  listEl.innerHTML = "";

  if (events.length === 0) {
    listEl.innerHTML = "<li>No events</li>";
    return;
  }

  events.forEach(ev => {
    const li = document.createElement("li");
    li.textContent = ev.title;
    listEl.appendChild(li);
  });
}