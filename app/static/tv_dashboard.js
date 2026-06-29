/**
 * tv_dashboard.js
 * ───────────────
 * Apple TV–style calendar dashboard.
 *
 * Two screens:
 *   1. Pairing   — enter XXXX-XXXX code, POST /tv/pair → store JWT
 *   2. Dashboard — poll GET /tv/events every 3s, render 3-day calendar view
 *
 * Architecture laws:
 *   - selectedDate NEVER defaults to today() — backend is the source of truth.
 *   - Token is stored in localStorage('tv_token'), separate from the web
 *     app's 'token' key so the two sessions never collide.
 *   - Every interval handle is tracked and cleared — no memory leaks.
 *   - DOM is diffed via a signature string — no full re-render on unchanged data.
 *   - A 401 response always triggers token clear + return to pairing screen.
 */

'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────

const TOKEN_KEY  = 'tv_token';
const POLL_MS    = 3000;
const MAX_ERRORS = 3;

/**
 * Kiosk mode: set by tv_kiosk.html via window.KIOSK_TOKEN before this module
 * loads. When truthy the pairing screen is never shown and a 401 triggers a
 * reconnect retry rather than a logout (kiosk tokens last 1 year).
 */
const IS_KIOSK = Boolean(window.KIOSK_TOKEN);

/** Default color per calendar source when event.color is null. */
const SOURCE_COLORS = {
  google:    '#4285F4',
  microsoft: '#0078D4',
  apple:     '#A2AAAD',
  local:     '#34C759',
};

// ─── Runtime state ────────────────────────────────────────────────────────────

const state = {
  token:        null,
  selectedDate: null,          // YYYY-MM-DD string from backend
  focusDate:    null,          // local cursor date used for TV-only selection
  days:         {},            // { [dateStr]: Event[] }
  connection:   'disconnected',// 'connected' | 'reconnecting' | 'disconnected'
  lastUpdated:  null,          // Date object
  errorCount:   0,
  pollHandle:   null,          // setInterval id
  clockHandle:  null,          // setInterval id
  statePatchInFlight: false,
};

// ─── Cached DOM refs ──────────────────────────────────────────────────────────

let dom = {};

function cacheDom() {
  dom = {
    screenPair:    document.getElementById('screen-pair'),
    screenDash:    document.getElementById('screen-dashboard'),
    pairInput:     document.getElementById('pair-code-input'),
    pairBtn:       document.getElementById('pair-btn'),
    pairError:     document.getElementById('pair-error'),
    tvMain:        document.getElementById('tv-main'),
    dateHeader:    document.getElementById('tv-date-header'),
    clock:         document.getElementById('tv-clock'),
    statusEl:      document.getElementById('tv-status'),
    lastUpdated:   document.getElementById('tv-last-updated'),
    disconnectBtn: document.getElementById('disconnect-btn'),
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────

function init() {
  cacheDom();

  dom.pairBtn.addEventListener('click', handlePair);
  dom.pairInput.addEventListener('input', handleCodeInput);
  dom.pairInput.addEventListener('keydown', e => { if (e.key === 'Enter') handlePair(); });
  dom.disconnectBtn.addEventListener('click', handleUnpair);
  window.addEventListener('keydown', handleRemoteKeyDown);

  // Kiosk token (injected via window.KIOSK_TOKEN in tv_kiosk.html) takes
  // priority; fall back to the interactive-pairing token in localStorage.
  state.token = window.KIOSK_TOKEN || localStorage.getItem(TOKEN_KEY);

  if (state.token) {
    transitionTo('dashboard');
    startPolling();
  } else {
    transitionTo('pair');
  }
}

// ─── Screen transitions ───────────────────────────────────────────────────────

function transitionTo(screen) {
  if (screen === 'dashboard') {
    dom.screenPair.classList.add('hidden');
    dom.screenDash.classList.remove('hidden');
  } else {
    dom.screenDash.classList.add('hidden');
    dom.screenPair.classList.remove('hidden');
    setTimeout(() => dom.pairInput.focus(), 60);
  }
}

// ─── Pairing ──────────────────────────────────────────────────────────────────

/** Auto-format input as XXXX-XXXX while the user types. */
function handleCodeInput(e) {
  let v = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  if (v.length > 4) v = v.slice(0, 4) + '-' + v.slice(4);
  e.target.value = v;
}

async function handlePair() {
  const code = dom.pairInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    setPairError('Enter a valid code in the format XXXX-XXXX.');
    return;
  }

  dom.pairBtn.disabled = true;
  dom.pairBtn.textContent = 'Connecting…';
  setPairError('');

  try {
    const res = await fetch('/tv/pair', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ pairingCode: code }),
    });

    const body = await res.json().catch(() => ({}));

    if (!res.ok) {
      throw new Error(body.detail || `Server error (${res.status})`);
    }

    state.token        = body.token;
    state.selectedDate = body.selectedDate || null;
    localStorage.setItem(TOKEN_KEY, body.token);

    transitionTo('dashboard');
    startPolling();

  } catch (err) {
    setPairError(err.message || 'Pairing failed. Please try again.');
  } finally {
    dom.pairBtn.disabled  = false;
    dom.pairBtn.textContent = 'Connect';
  }
}

function handleUnpair() {
  stopAll();
  state.token        = null;
  state.selectedDate = null;
  state.focusDate    = null;
  state.days         = {};
  state.connection   = 'disconnected';
  state.errorCount   = 0;
  localStorage.removeItem(TOKEN_KEY);
  transitionTo('pair');
}

function setPairError(msg) {
  dom.pairError.textContent    = msg;
  dom.pairError.style.display  = msg ? 'block' : 'none';
}

// ─── Polling lifecycle ────────────────────────────────────────────────────────

function startPolling() {
  stopAll();
  fetchAndRender();                                   // immediate first fetch
  state.pollHandle  = setInterval(fetchAndRender, POLL_MS);
  state.clockHandle = setInterval(tickClock, 1000);
  tickClock();
}

function stopAll() {
  if (state.pollHandle  !== null) { clearInterval(state.pollHandle);  state.pollHandle  = null; }
  if (state.clockHandle !== null) { clearInterval(state.clockHandle); state.clockHandle = null; }
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

async function fetchAndRender() {
  try {
    const res = await fetch('/tv/events', {
      headers: { Authorization: `Bearer ${state.token}` },
    });

    if (res.status === 401) {
      if (IS_KIOSK) {
        // Kiosk tokens last 1 year. A 401 most likely means the server
        // restarted. Stay on screen and keep retrying — never redirect.
        state.errorCount++;
        state.connection = 'reconnecting';
        renderStatus();
        return;
      }
      handleTokenExpired();
      return;
    }

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();

    state.errorCount   = 0;
    state.connection   = 'connected';
    state.selectedDate = data.selectedDate || null;
    if (state.selectedDate) {
      state.focusDate = state.selectedDate;
    }
    state.lastUpdated  = new Date();

    // Rebuild the date→events lookup from the API response
    state.days = {};
    for (const day of (data.days || [])) {
      state.days[day.date] = day.events || [];
    }

    renderDashboard();

  } catch (_err) {
    state.errorCount++;
    if (state.errorCount >= MAX_ERRORS) {
      state.connection = 'reconnecting';
      renderStatus();
    }
  }
}

function handleTokenExpired() {
  stopAll();
  state.token = null;
  localStorage.removeItem(TOKEN_KEY);
  transitionTo('pair');
  setPairError('Your session has expired. Please pair again.');
}

// ─── Remote-key controls (TV-only operation) ────────────────────────────────

function getAnchorDateForRemote() {
  if (state.selectedDate) return state.selectedDate;
  if (state.focusDate) return state.focusDate;
  return toISO(new Date());
}

async function patchTvState(patch) {
  const res = await fetch('/tv/state', {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${state.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(patch),
  });

  if (res.status === 401) {
    handleTokenExpired();
    return null;
  }
  if (!res.ok) {
    throw new Error(`State update failed (${res.status})`);
  }

  return await res.json().catch(() => null);
}

async function setSelectedDateFromRemote(targetDateStr) {
  if (!state.token || state.statePatchInFlight) return;

  state.statePatchInFlight = true;
  try {
    // Optimistic update so remote taps feel instant.
    state.selectedDate = targetDateStr;
    state.focusDate = targetDateStr;
    renderDashboard();

    const patched = await patchTvState({ selectedDate: targetDateStr });
    if (patched && patched.selectedDate) {
      state.selectedDate = patched.selectedDate;
      state.focusDate = patched.selectedDate;
      renderDashboard();
    }

    // Pull fresh events immediately after changing date.
    await fetchAndRender();
  } catch (_err) {
    state.connection = 'reconnecting';
    renderStatus();
  } finally {
    state.statePatchInFlight = false;
  }
}

function handleRemoteKeyDown(e) {
  if (!state.token || dom.screenDash.classList.contains('hidden')) return;

  const key = e.key;
  const isLeft = key === 'ArrowLeft';
  const isRight = key === 'ArrowRight';
  const isSelect = key === 'Enter' || key === ' ' || key === 'Spacebar';
  const isPlayPause = key === 'MediaPlayPause' || key.toLowerCase() === 'p';

  if (!(isLeft || isRight || isSelect || isPlayPause)) return;
  e.preventDefault();

  const anchor = parseLocalDate(getAnchorDateForRemote());

  if (isLeft) {
    const target = toISO(offsetDate(anchor, -1));
    setSelectedDateFromRemote(target);
    return;
  }

  if (isRight) {
    const target = toISO(offsetDate(anchor, 1));
    setSelectedDateFromRemote(target);
    return;
  }

  if (isSelect || isPlayPause) {
    const target = toISO(new Date());
    setSelectedDateFromRemote(target);
  }
}

// ─── Dashboard rendering ──────────────────────────────────────────────────────

function renderDashboard() {
  renderDateHeader();
  renderColumns();
  renderStatus();
}

function renderDateHeader() {
  if (!state.selectedDate) {
    dom.dateHeader.textContent = '';
    return;
  }
  const d = parseLocalDate(state.selectedDate);
  dom.dateHeader.textContent = d.toLocaleDateString([], {
    weekday: 'long',
    month:   'long',
    day:     'numeric',
    year:    'numeric',
  }).toUpperCase();
}

function renderColumns() {
  const main = dom.tvMain;

  // ── No date selected → waiting screen ────────────────────────
  if (!state.selectedDate) {
    if (main.dataset.view !== 'waiting') {
      main.dataset.view = 'waiting';
      main.innerHTML = `
        <div class="tv-waiting">
          <div class="tv-waiting-icon">📅</div>
          <div class="tv-waiting-title">Waiting for date selection</div>
          <div class="tv-waiting-sub">
            Use remote Left/Right to choose date.<br>
            Press Select or Play/Pause to jump to today.
          </div>
        </div>`;
    }
    return;
  }

  // ── Connection lost before first successful fetch ─────────────
  if (state.connection === 'reconnecting' && !Object.keys(state.days).length) {
    if (main.dataset.view !== 'reconnecting') {
      main.dataset.view = 'reconnecting';
      main.innerHTML = `
        <div class="tv-reconnecting">
          <div class="tv-reconnecting-label">◌ Reconnecting…</div>
        </div>`;
    }
    return;
  }

  // ── 3-day column view ─────────────────────────────────────────
  const anchor    = parseLocalDate(state.selectedDate);
  const prevDay   = offsetDate(anchor, -1);
  const nextDay   = offsetDate(anchor,  1);

  const cols = [
    { dateStr: toISO(prevDay),          isSelected: false },
    { dateStr: state.selectedDate,      isSelected: true  },
    { dateStr: toISO(nextDay),          isSelected: false },
  ];

  // Diff: skip full DOM rebuild if nothing changed
  const sig = cols.map(c =>
    c.dateStr + '=' + (state.days[c.dateStr] || []).map(e => e.id).join(',')
  ).join('|');

  if (main.dataset.sig === sig && main.dataset.view === 'columns') return;
  main.dataset.sig  = sig;
  main.dataset.view = 'columns';
  main.innerHTML    = cols.map(col => buildDayColumn(col)).join('');
}

function buildDayColumn({ dateStr, isSelected }) {
  const d      = parseLocalDate(dateStr);
  const events = state.days[dateStr] || [];
  const now    = new Date();

  const weekday  = d.toLocaleDateString([], { weekday: 'long' }).toUpperCase();
  const dayNum   = d.getDate();
  const monthStr = d.toLocaleDateString([], { month: 'long', year: 'numeric' });

  // First upcoming event index (badges: "Now" / "Next")
  const nowIdx  = events.findIndex(ev => eventIsNow(ev, now));
  const nextIdx = events.findIndex(ev => eventIsUpcoming(ev, now));

  const cards = events.length === 0
    ? '<div class="tv-no-events">No events scheduled</div>'
    : events.map((ev, i) =>
        buildEventCard(ev, i === nowIdx && nowIdx !== -1, i === nextIdx && nextIdx !== -1 && nowIdx === -1)
      ).join('');

  const selectedPill = isSelected
    ? '<div class="tv-selected-pill">Selected</div>'
    : '';

  return `
    <div class="tv-day-col${isSelected ? ' tv-day-selected' : ''}">
      <div class="tv-col-accent"></div>
      <div class="tv-day-header">
        <div class="tv-day-weekday">${weekday}</div>
        <div class="tv-day-num">${dayNum}</div>
        <div class="tv-day-month">${monthStr}</div>
        ${selectedPill}
      </div>
      <div class="tv-events-list">${cards}</div>
    </div>`;
}

function buildEventCard(ev, evIsNow, evIsNext) {
  const color       = ev.color || SOURCE_COLORS[ev.source] || SOURCE_COLORS.local;
  const timeStart   = fmtTime(ev.start);
  const timeEnd     = fmtTime(ev.end);
  const timeDisplay = timeStart && timeEnd ? `${timeStart} – ${timeEnd}` : timeStart;

  const badge = evIsNow
    ? '<span class="ev-badge ev-badge-now">Now</span>'
    : evIsNext
      ? '<span class="ev-badge ev-badge-next">Next</span>'
      : '';

  const descHtml = ev.description
    ? `<div class="ev-desc">${esc(ev.description.slice(0, 100))}${ev.description.length > 100 ? '…' : ''}</div>`
    : '';

  return `
    <div class="tv-event-card${evIsNow ? ' ev-now' : ''}${evIsNext ? ' ev-next' : ''}"
         style="--ev-color:${color}">
      <div class="ev-color-bar"></div>
      <div class="ev-body">
        <div class="ev-time-row">
          <span class="ev-time">${esc(timeDisplay)}</span>${badge}
        </div>
        <div class="ev-title">${esc(ev.title || 'Untitled')}</div>
        ${descHtml}
        <div class="ev-source">${esc(ev.source || 'local')}</div>
      </div>
    </div>`;
}

function renderStatus() {
  const cfg = {
    connected:    { cls: 'status-ok',   icon: '●', label: 'Connected'     },
    reconnecting: { cls: 'status-warn', icon: '◌', label: 'Reconnecting…' },
    disconnected: { cls: 'status-err',  icon: '○', label: 'Disconnected'  },
  };
  const { cls, icon, label } = cfg[state.connection] || cfg.disconnected;
  dom.statusEl.innerHTML     = `<span class="${cls}">${icon} ${label}</span>`;
  const updatedText = state.lastUpdated
    ? `Last updated ${state.lastUpdated.toLocaleTimeString()}`
    : '';
  const remoteHint = '◀ ▶ change day  •  Select/Play = today';
  dom.lastUpdated.textContent = `${updatedText}${updatedText ? '  •  ' : ''}${remoteHint}`;
}

// ─── Clock ────────────────────────────────────────────────────────────────────

function tickClock() {
  dom.clock.textContent = new Date().toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

// ─── Date/time helpers ────────────────────────────────────────────────────────

/**
 * Parse a YYYY-MM-DD string as a LOCAL date (not UTC).
 * Using `new Date("YYYY-MM-DD")` would give midnight UTC → wrong local date.
 */
function parseLocalDate(str) {
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function offsetDate(d, delta) {
  const r = new Date(d);
  r.setDate(r.getDate() + delta);
  return r;
}

function toISO(d) {
  const y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/**
 * Parse an event ISO timestamp.
 * Naive strings (no Z / offset) are treated as UTC to match backend behaviour
 * (backend marks naive datetimes as UTC before returning them).
 */
function parseEventTime(iso) {
  if (!iso) return null;
  const isZoned = iso.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(iso);
  const d = new Date(isZoned ? iso : iso + 'Z');
  return isNaN(d.getTime()) ? null : d;
}

function fmtTime(iso) {
  const d = parseEventTime(iso);
  return d ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
}

function eventIsNow(ev, now) {
  const s = parseEventTime(ev.start);
  const e = parseEventTime(ev.end);
  return Boolean(s && e && s <= now && now <= e);
}

function eventIsUpcoming(ev, now) {
  const s = parseEventTime(ev.start);
  return Boolean(s && s > now);
}

// ─── Security util ────────────────────────────────────────────────────────────

/** HTML-escape a value before injecting into innerHTML. */
function esc(val) {
  return String(val == null ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
