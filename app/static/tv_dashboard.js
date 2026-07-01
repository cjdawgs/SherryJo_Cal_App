'use strict';

const TOKEN_KEY = 'tv_token';
// TV state remains backend-driven. Use low-frequency auto poll; interactions trigger immediate refresh.
const POLL_MS = 300000;
const LONG_PRESS_MS = 600;

const IS_KIOSK = Boolean(window.KIOSK_TOKEN);

const state = {
  token: null,
  selectedDate: null,
  currentView: 'day',
  focusedEventId: null,
  days: [],
  dayMap: {},
  eventsRequestInFlight: false,
  eventsRefreshQueued: false,
  pollHandle: null,
  clockHandle: null,
  longPressTimer: null,
  longPressTriggered: false,
  clickCount: 0,
  clickTimer: null,
  centerArrowMode: false,
  cursor: {
    x: 0,
    y: 0,
    visible: false,
  },
  debug: {
    visible: false,
    lines: [],
    maxLines: 12,
  },
  editor: null,
  focus: {
    region: 'main',
    monthIndex: 0,
    sidebarIndex: 0,
    itemIndex: 0,
  },
  monthDates: [],
  accountLegend: [],
};

let dom = {};

const TITLE_PRESETS = ['New Event', 'Meeting', 'Reminder', 'Appointment', 'Call'];
const DESC_PRESETS = ['', 'Updated from TV', 'Bring notes', 'Follow up needed'];
const STICKY_PRESETS = ['New sticky note', 'Action item', 'Priority', 'Reminder'];
const STICKY_COLORS = ['#F7E68A', '#F8C8DC', '#CDEEFF', '#D8F5C1'];

function cacheDom() {
  dom = {
    screenPair: document.getElementById('screen-pair'),
    screenDash: document.getElementById('screen-dashboard'),
    pairInput: document.getElementById('pair-code-input'),
    pairBtn: document.getElementById('pair-btn'),
    pairError: document.getElementById('pair-error'),
    tvMain: document.getElementById('tv-main'),
    dateHeader: document.getElementById('tv-date-header'),
    clock: document.getElementById('tv-clock'),
    statusEl: document.getElementById('tv-status'),
    lastUpdated: document.getElementById('tv-last-updated'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    cursor: document.getElementById('tv-virtual-cursor'),
    debugOverlay: document.getElementById('tv-debug-overlay'),
    debugList: document.getElementById('tv-debug-list'),
    accountLegend: document.getElementById('tv-account-legend'),
  };
}

function ensureStyles() {
  if (document.getElementById('tv-remote-style')) return;
  const style = document.createElement('style');
  style.id = 'tv-remote-style';
  style.textContent = `
  .tv-shell { display: grid; width: 100%; height: 100%; grid-template-columns: minmax(160px, 210px) minmax(0, 1fr) minmax(260px, 320px); gap: 12px; }
  .tv-shell.month { grid-template-columns: minmax(160px, 210px) minmax(0, 1fr); }
  .tv-main.tv-editor-active { background: rgba(228, 232, 239, 0.08); border: 1px solid rgba(198, 206, 220, 0.22); border-radius: 12px; box-shadow: inset 0 0 0 1px rgba(236, 241, 250, 0.12); }
  .tv-account-legend { display: flex; align-items: center; gap: 8px; min-height: 34px; padding: 6px 52px 4px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .tv-account-chip { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.02); font-size: 11px; color: rgba(240,240,245,0.82); letter-spacing: 0.3px; }
  .tv-account-dot { width: 8px; height: 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.45); flex-shrink: 0; }
  .tv-main-grid { min-width: 0; display: grid; gap: 10px; }
  .tv-main-grid.day { grid-template-columns: repeat(7, 1fr); }
  .tv-main-grid.week { grid-template-columns: repeat(7, 1fr); }
  .tv-main-grid.month { grid-template-columns: repeat(7, 1fr); grid-template-rows: repeat(6, minmax(0, 1fr)); }
  .tv-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; margin: 0 0 8px 0; }
  .tv-weekday-chip { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; text-align: center; padding: 6px 4px; font-size: 11px; letter-spacing: 1.1px; text-transform: uppercase; opacity: 0.85; }
  .tv-sidebar { border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 10px; display: flex; flex-direction: column; gap: 8px; background: rgba(255,255,255,0.02); overflow: hidden; }
  .tv-side-item { border: 1px solid rgba(255,255,255,0.09); border-radius: 10px; padding: 10px; font-size: 14px; color: rgba(240,240,245,0.9); }
  .tv-side-item.focused { border-color: #4f8cff; box-shadow: 0 0 0 2px rgba(79,140,255,0.22); transform: scale(1.02); }
  .tv-side-item:hover { border-color: rgba(255,255,255,0.24); }
  .tv-right-rail { border: 1px solid rgba(255,255,255,0.1); border-radius: 14px; padding: 10px; background: rgba(255,255,255,0.02); overflow: hidden; }
  .tv-right-title { font-size: 14px; font-weight: 700; margin: 0 0 8px 0; }
  .tv-right-subtitle { font-size: 12px; opacity: 0.75; margin: 10px 0 6px 0; font-weight: 600; }
  .tv-right-list { display: flex; flex-direction: column; gap: 6px; max-height: 37vh; overflow-y: auto; }
  .tv-right-item { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; padding: 6px 8px; background: rgba(255,255,255,0.02); }
  .tv-right-item-title { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-right-item-time { font-size: 11px; opacity: 0.72; }
  .tv-day-card, .tv-month-cell { border: 1px solid rgba(255,255,255,0.09); border-radius: 12px; background: rgba(255,255,255,0.03); padding: 10px; min-height: 0; display: flex; flex-direction: column; }
  .tv-day-card.selected { border-color: rgba(79,140,255,0.45); }
  .tv-day-head { font-size: 11px; letter-spacing: 1.5px; opacity: 0.75; text-transform: uppercase; margin-bottom: 8px; }
  .tv-day-num { font-size: 26px; font-weight: 700; line-height: 1; margin-bottom: 8px; }
  .tv-item-list { display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
  .tv-item { border: 1px solid rgba(255,255,255,0.08); border-radius: 10px; padding: 8px; background: rgba(255,255,255,0.02); }
  .tv-item.focused { border-color: #4f8cff; box-shadow: 0 0 0 2px rgba(79,140,255,0.2); }
  .tv-item:hover { border-color: rgba(255,255,255,0.24); }
  .tv-item.now { background: rgba(79,140,255,0.14); }
  .tv-item.next { background: rgba(255,159,10,0.11); }
  .tv-item-title { font-size: 16px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-item-sub { font-size: 12px; opacity: 0.78; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-month-cell { justify-content: flex-start; }
  .tv-month-cell.focused { border-color: #4f8cff; box-shadow: 0 0 0 2px rgba(79,140,255,0.2); transform: scale(1.01); }
  .tv-month-cell:hover { border-color: rgba(255,255,255,0.24); }
  .tv-month-date { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
  .tv-month-preview { font-size: 11px; opacity: 0.8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-editor { margin-top: 10px; border: 1px solid rgba(79,140,255,0.35); border-radius: 10px; padding: 10px; background: rgba(79,140,255,0.08); }
  .tv-editor-title { font-size: 12px; text-transform: uppercase; letter-spacing: 1.3px; opacity: 0.8; margin-bottom: 8px; }
  .tv-field { border: 1px solid rgba(255,255,255,0.09); border-radius: 8px; padding: 6px 8px; margin-bottom: 6px; }
  .tv-field.focused { border-color: #4f8cff; background: rgba(79,140,255,0.12); }
  .tv-field-name { font-size: 10px; opacity: 0.7; text-transform: uppercase; }
  .tv-field-value { font-size: 15px; font-weight: 600; margin-top: 2px; }
  .tv-empty { opacity: 0.65; font-style: italic; font-size: 13px; }
  .tv-hint-chip { font-size: 11px; opacity: 0.8; }
  #tv-virtual-cursor { position: fixed; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #4f8cff; box-shadow: 0 0 0 2px rgba(79,140,255,0.18); background: rgba(79,140,255,0.2); pointer-events: none; z-index: 999999; transform: translate(-50%, -50%); display: none; }
  #tv-debug-overlay { position: fixed; right: 12px; bottom: 52px; width: 420px; max-height: 50vh; overflow: hidden; background: rgba(9,12,20,0.92); border: 1px solid rgba(79,140,255,0.35); border-radius: 10px; box-shadow: 0 12px 26px rgba(0,0,0,0.45); z-index: 999998; color: #d7e6ff; display: none; }
  #tv-debug-overlay.visible { display: block; }
  .tv-debug-head { padding: 8px 10px; border-bottom: 1px solid rgba(79,140,255,0.22); font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: #8eb7ff; display: flex; justify-content: space-between; }
  #tv-debug-list { list-style: none; margin: 0; padding: 8px 10px; max-height: 40vh; overflow-y: auto; font-family: Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; }
  .tv-debug-row { white-space: pre-wrap; word-break: break-word; border-bottom: 1px dashed rgba(255,255,255,0.08); padding: 2px 0; }
  .tv-debug-row:last-child { border-bottom: 0; }
  `;
  document.head.appendChild(style);

  if (!document.getElementById('tv-virtual-cursor')) {
    const cursor = document.createElement('div');
    cursor.id = 'tv-virtual-cursor';
    document.body.appendChild(cursor);
  }

  if (!document.getElementById('tv-debug-overlay')) {
    const overlay = document.createElement('section');
    overlay.id = 'tv-debug-overlay';
    overlay.innerHTML = `
      <div class="tv-debug-head">
        <span>Remote Key Debug</span>
        <span>Mute = Toggle</span>
      </div>
      <ul id="tv-debug-list"></ul>
    `;
    document.body.appendChild(overlay);
  }

  dom.cursor = document.getElementById('tv-virtual-cursor');
  dom.debugOverlay = document.getElementById('tv-debug-overlay');
  dom.debugList = document.getElementById('tv-debug-list');

  ensureLegendRow();
}

function ensureLegendRow() {
  const dashboard = document.getElementById('screen-dashboard');
  if (!dashboard) return;
  let legend = document.getElementById('tv-account-legend');
  if (!legend) {
    legend = document.createElement('div');
    legend.id = 'tv-account-legend';
    legend.className = 'tv-account-legend';
    const header = dashboard.querySelector('.tv-header');
    if (header) dashboard.insertBefore(legend, header);
    else dashboard.prepend(legend);
  }
  dom.accountLegend = legend;
}

function transitionTo(screen) {
  if (!dom.screenPair || !dom.screenDash) return;
  if (screen === 'dashboard') {
    dom.screenPair.classList.add('hidden');
    dom.screenDash.classList.remove('hidden');
  } else {
    dom.screenDash.classList.add('hidden');
    dom.screenPair.classList.remove('hidden');
    if (dom.pairInput) setTimeout(() => dom.pairInput.focus(), 60);
  }
}

function init() {
  cacheDom();
  ensureStyles();

  if (dom.pairBtn) dom.pairBtn.addEventListener('click', handlePair);
  if (dom.pairInput) {
    dom.pairInput.addEventListener('input', handleCodeInput);
    dom.pairInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handlePair();
      }
    });
  }
  if (dom.disconnectBtn) dom.disconnectBtn.addEventListener('click', handleUnpair);

  if (dom.tvMain) {
    dom.tvMain.addEventListener('click', handleMainClick);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      refreshEvents();
    }
  });

  state.token = window.KIOSK_TOKEN || localStorage.getItem(TOKEN_KEY);
  if (state.token) {
    transitionTo('dashboard');
    bootstrapFromBackend();
  } else {
    transitionTo('pair');
  }
}

async function bootstrapFromBackend() {
  await fetchTvState();
  startPolling();
}

function startPolling() {
  stopAll();
  refreshEvents();
  state.pollHandle = setInterval(refreshEvents, POLL_MS);
  state.clockHandle = setInterval(tickClock, 1000);
  tickClock();
}

function stopAll() {
  if (state.pollHandle) clearInterval(state.pollHandle);
  if (state.clockHandle) clearInterval(state.clockHandle);
  state.pollHandle = null;
  state.clockHandle = null;
}

function tickClock() {
  if (dom.clock) {
    dom.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}

function handleCodeInput(e) {
  let v = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  if (v.length > 4) v = `${v.slice(0, 4)}-${v.slice(4)}`;
  e.target.value = v;
}

function setPairError(message) {
  if (!dom.pairError) return;
  dom.pairError.textContent = message || '';
  dom.pairError.style.display = message ? 'block' : 'none';
}

async function handlePair() {
  if (!dom.pairInput || !dom.pairBtn) return;
  const code = dom.pairInput.value.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    setPairError('Enter a valid pairing code (XXXX-XXXX).');
    return;
  }

  dom.pairBtn.disabled = true;
  setPairError('');
  try {
    const res = await fetch('/tv/pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairingCode: code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `Pairing failed (${res.status})`);

    state.token = data.token;
    localStorage.setItem(TOKEN_KEY, state.token);
    transitionTo('dashboard');
    await bootstrapFromBackend();
  } catch (err) {
    setPairError(err.message || 'Pairing failed.');
  } finally {
    dom.pairBtn.disabled = false;
  }
}

function handleUnpair() {
  stopAll();
  state.token = null;
  state.selectedDate = null;
  state.days = [];
  state.dayMap = {};
  state.editor = null;
  localStorage.removeItem(TOKEN_KEY);
  transitionTo('pair');
}

async function fetchTvState() {
  const res = await authFetch('/tv/state');
  if (!res) return;
  const data = await res.json().catch(() => ({}));
  state.selectedDate = data.selectedDate || null;
  state.currentView = data.currentView || 'day';
  state.focusedEventId = data.focusedEventId || null;
  if (!state.selectedDate) state.selectedDate = toISO(new Date());
}

async function refreshEvents() {
  if (document.hidden) {
    return;
  }

  if (state.eventsRequestInFlight) {
    state.eventsRefreshQueued = true;
    return;
  }

  state.eventsRequestInFlight = true;
  const res = await authFetch('/tv/events');
  try {
    if (!res) return;
    if (!res.ok) {
      renderFooterHint(`Data sync issue: /tv/events returned ${res.status}`);
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (data.selectedDate) state.selectedDate = data.selectedDate;
    if (data.currentView) state.currentView = data.currentView;
    state.days = data.days || [];
    state.dayMap = {};
    for (const day of state.days) state.dayMap[day.date] = day;
    syncFocusAfterData();
    render();
  } finally {
    state.eventsRequestInFlight = false;
    if (state.eventsRefreshQueued) {
      state.eventsRefreshQueued = false;
      refreshEvents();
    }
  }
}

async function authFetch(url, options = {}) {
  if (!state.token) return null;
  try {
    const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${state.token}` });
    const res = await fetch(url, Object.assign({}, options, { headers }));
    if (res.status === 401) {
      if (!IS_KIOSK) handleUnpair();
      return null;
    }
    return res;
  } catch (err) {
    const message = err && err.message ? err.message : 'Network request failed';
    renderFooterHint(`Network issue: ${message}`);
    return null;
  }
}

async function patchTvState(patch) {
  const res = await authFetch('/tv/state', {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res) return null;
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (data) {
    state.selectedDate = data.selectedDate || state.selectedDate;
    state.currentView = data.currentView || state.currentView;
    state.focusedEventId = data.focusedEventId || null;
  }
  return data;
}

function onKeyDown(e) {
  if (!state.token || !dom.screenDash || dom.screenDash.classList.contains('hidden')) return;

  if (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
    return;
  }

  const key = normalizeKey(e);
  logRemoteKey('down', e, key);

  if (isMuteKey(e, key)) {
    e.preventDefault();
    toggleDebugOverlay();
    return;
  }

  if (key === 'Enter') {
    if (!state.longPressTimer) {
      state.longPressTriggered = false;
      state.longPressTimer = setTimeout(() => {
        state.longPressTriggered = true;
        onLongPress();
      }, LONG_PRESS_MS);
    }
    e.preventDefault();
    return;
  }

  if (state.editor) {
    if (handleEditorKey(key)) e.preventDefault();
    return;
  }

  if (state.centerArrowMode && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
    e.preventDefault();
    moveCursorByArrow(key);
    return;
  }

  if (isBackKey(key)) {
    e.preventDefault();
    handleBack();
    return;
  }

  if (isVolumeForwardKey(key)) {
    e.preventDefault();
    focusNext();
    return;
  }

  if (isVolumeReverseKey(key)) {
    e.preventDefault();
    focusPrev();
    return;
  }

  if (isListKey(key)) {
    e.preventDefault();
    triggerStickyAction();
    return;
  }

  if (key.toLowerCase() === 'c') {
    e.preventDefault();
    shiftByView(1);
    return;
  }
  if (key.toLowerCase() === 'e') {
    e.preventDefault();
    shiftByView(-1);
    return;
  }
  if (key.toLowerCase() === 'd') {
    e.preventDefault();
    goToday();
    return;
  }
  if (key.toLowerCase() === 'f') {
    e.preventDefault();
    setView('day');
    return;
  }

  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
    e.preventDefault();
    handleArrow(key);
  }
}

function onKeyUp(e) {
  const key = normalizeKey(e);
  logRemoteKey('up', e, key);

  if (isMuteKey(e, key)) {
    e.preventDefault();
    return;
  }

  if (key !== 'Enter') return;

  if (state.editor) {
    if (state.longPressTimer) {
      clearTimeout(state.longPressTimer);
      state.longPressTimer = null;
    }
    if (!state.longPressTriggered) {
      const last = state.editor.fieldIndex === state.editor.fields.length - 1;
      if (last) {
        saveEditor();
      } else {
        state.editor.fieldIndex += 1;
        render();
      }
    }
    state.longPressTriggered = false;
    return;
  }

  if (state.longPressTimer) {
    clearTimeout(state.longPressTimer);
    state.longPressTimer = null;
  }
  if (state.longPressTriggered) {
    state.longPressTriggered = false;
    return;
  }

  state.clickCount += 1;
  if (state.clickTimer) clearTimeout(state.clickTimer);
  state.clickTimer = setTimeout(() => {
    const count = state.clickCount;
    state.clickCount = 0;
    if (count === 1) onSelect();
    else if (count === 2) onSecondarySelect();
    else if (count >= 3) {
      state.centerArrowMode = !state.centerArrowMode;
      setCursorVisible(state.centerArrowMode);
      renderFooterHint(`Arrow mode ${state.centerArrowMode ? 'enabled' : 'disabled'}`);
    }
  }, 260);
}

function normalizeKey(e) {
  const key = e.key || '';
  const code = e.code || '';
  const kc = typeof e.keyCode === 'number' ? e.keyCode : -1;

  if (key === 'ArrowLeft' || code === 'ArrowLeft' || kc === 37 || kc === 21 || key === 'Left') return 'ArrowLeft';
  if (key === 'ArrowRight' || code === 'ArrowRight' || kc === 39 || kc === 22 || key === 'Right') return 'ArrowRight';
  if (key === 'ArrowUp' || code === 'ArrowUp' || kc === 38 || kc === 19 || key === 'Up') return 'ArrowUp';
  if (key === 'ArrowDown' || code === 'ArrowDown' || kc === 40 || kc === 20 || key === 'Down') return 'ArrowDown';
  if (key === 'Enter' || code === 'Enter' || kc === 13 || kc === 23 || key === 'Select') return 'Enter';
  if (key === 'Escape' || kc === 27 || kc === 461) return 'Escape';
  if (key === 'Backspace' || kc === 8) return 'Backspace';
  if (key === 'ContextMenu' || code === 'ContextMenu' || kc === 93 || kc === 82) return 'ContextMenu';
  if (key === 'AudioVolumeUp' || code === 'AudioVolumeUp' || kc === 175) return 'AudioVolumeUp';
  if (key === 'AudioVolumeDown' || code === 'AudioVolumeDown' || kc === 174) return 'AudioVolumeDown';
  if (key === 'AudioVolumeMute' || key === 'VolumeMute' || key === 'Mute' || code === 'AudioVolumeMute' || kc === 173 || kc === 181 || kc === 449) return 'AudioVolumeMute';
  if (key === 'PageUp' || code === 'PageUp') return 'PageUp';
  if (key === 'PageDown' || code === 'PageDown') return 'PageDown';
  if (kc === 33) return 'PageUp';
  if (kc === 34) return 'PageDown';
  if (key === '+' || key === 'Add' || key === 'NumpadAdd' || code === 'NumpadAdd' || kc === 107) return '+';
  if (key === '-' || key === '_' || key === 'Subtract' || key === 'NumpadSubtract' || code === 'NumpadSubtract' || kc === 109) return '-';
  if (kc === 187) return '=';
  if (kc === 189) return '-';
  return key;
}

function isMuteKey(e, normalizedKey) {
  const raw = e.key || '';
  const code = e.code || '';
  const kc = typeof e.keyCode === 'number' ? e.keyCode : -1;
  return normalizedKey === 'AudioVolumeMute'
    || raw === 'AudioVolumeMute'
    || raw === 'VolumeMute'
    || raw === 'Mute'
    || code === 'AudioVolumeMute'
    || kc === 173
    || kc === 181
    || kc === 449;
}

function toggleDebugOverlay() {
  state.debug.visible = !state.debug.visible;
  if (!dom.debugOverlay) return;
  dom.debugOverlay.classList.toggle('visible', state.debug.visible);
  if (state.debug.visible) {
    renderDebugOverlay();
    renderFooterHint('Key debug overlay enabled (Mute to hide)');
  } else {
    renderFooterHint('Key debug overlay hidden (Mute to show)');
  }
}

function logRemoteKey(phase, e, normalizedKey) {
  const ts = new Date().toLocaleTimeString([], { hour12: false });
  const rawKey = String(e.key || '');
  const code = String(e.code || '');
  const kc = typeof e.keyCode === 'number' ? e.keyCode : -1;
  const line = `${ts} ${phase.toUpperCase()}  raw=${rawKey}  code=${code}  keyCode=${kc}  normalized=${normalizedKey}`;
  state.debug.lines.unshift(line);
  if (state.debug.lines.length > state.debug.maxLines) {
    state.debug.lines.length = state.debug.maxLines;
  }
  if (state.debug.visible) {
    renderDebugOverlay();
  }
}

function renderDebugOverlay() {
  if (!dom.debugList) return;
  if (!state.debug.lines.length) {
    dom.debugList.innerHTML = '<li class="tv-debug-row">Press arrows / select / mute here. The overlay will show raw key data.</li>';
    return;
  }
  dom.debugList.innerHTML = state.debug.lines
    .map(line => `<li class="tv-debug-row">${escapeHtml(line)}</li>`)
    .join('');
}

function setCursorVisible(visible) {
  if (!dom.cursor) return;
  state.cursor.visible = visible;
  dom.cursor.style.display = visible ? 'block' : 'none';
  if (visible && state.cursor.x === 0 && state.cursor.y === 0) {
    state.cursor.x = Math.floor(window.innerWidth / 2);
    state.cursor.y = Math.floor(window.innerHeight / 2);
  }
  if (visible) {
    dom.cursor.style.left = `${state.cursor.x}px`;
    dom.cursor.style.top = `${state.cursor.y}px`;
  }
}

function moveCursorByArrow(key) {
  const step = 40;
  if (key === 'ArrowLeft') state.cursor.x -= step;
  if (key === 'ArrowRight') state.cursor.x += step;
  if (key === 'ArrowUp') state.cursor.y -= step;
  if (key === 'ArrowDown') state.cursor.y += step;

  state.cursor.x = Math.max(12, Math.min(window.innerWidth - 12, state.cursor.x));
  state.cursor.y = Math.max(12, Math.min(window.innerHeight - 12, state.cursor.y));

  if (dom.cursor) {
    dom.cursor.style.left = `${state.cursor.x}px`;
    dom.cursor.style.top = `${state.cursor.y}px`;
  }
}

function onLongPress() {
  if (state.currentView === 'month') {
    createStickyAndEdit();
  } else {
    createEventAndEdit();
  }
}

function onSelect() {
  if (state.centerArrowMode && state.cursor.visible) {
    clickCursorTarget('left');
    return;
  }

  if (state.currentView === 'month' && state.focus.region === 'main') {
    const date = getFocusedMonthDate();
    if (!date) return;
    patchTvState({ selectedDate: date, currentView: 'day' }).then(() => refreshEvents());
    return;
  }

  if (state.focus.region === 'sidebar') {
    runSidebarAction(state.focus.sidebarIndex);
    return;
  }

  const item = getFocusedItem();
  if (item && item.type === 'event') enterEventEditor(item, 'update');
  if (item && item.type === 'sticky') enterStickyEditor(item, 'update');
}

function onSecondarySelect() {
  if (state.centerArrowMode && state.cursor.visible) {
    clickCursorTarget('right');
    return;
  }

  const item = getFocusedItem();
  if (!item) {
    triggerStickyAction();
    return;
  }
  if (item.type === 'sticky') enterStickyEditor(item, 'update');
  else enterEventEditor(item, 'update');
}

function handleBack() {
  if (state.editor) {
    state.editor = null;
    render();
    return;
  }
  if (state.focus.region === 'sidebar') {
    state.focus.region = 'main';
    render();
    return;
  }
  setView('day');
}

function isBackKey(key) { return key === 'Escape' || key === 'Backspace'; }
function isVolumeForwardKey(key) { return key === '+' || key === '=' || key === 'PageDown' || key === 'AudioVolumeUp'; }
function isVolumeReverseKey(key) { return key === '-' || key === '_' || key === 'PageUp' || key === 'AudioVolumeDown'; }
function isListKey(key) { return key === 'ContextMenu' || key === 'F2'; }

function handleArrow(key) {
  if (state.focus.region === 'sidebar') {
    if (key === 'ArrowRight') {
      state.focus.region = 'main';
    } else if (key === 'ArrowUp') {
      state.focus.sidebarIndex = Math.max(0, state.focus.sidebarIndex - 1);
    } else if (key === 'ArrowDown') {
      state.focus.sidebarIndex = Math.min(sidebarItems().length - 1, state.focus.sidebarIndex + 1);
    }
    render();
    return;
  }

  if (state.currentView === 'month') {
    handleMonthArrow(key);
    return;
  }

  if (state.currentView === 'week') {
    handleWeekArrow(key);
    return;
  }

  handleDayArrow(key);
}

function handleDayArrow(key) {
  if (key === 'ArrowLeft') shiftByView(-1);
  if (key === 'ArrowRight') shiftByView(1);
  if (key === 'ArrowUp') setView('week');
  if (key === 'ArrowDown') setView('month');
}

function handleWeekArrow(key) {
  if (key === 'ArrowLeft') shiftByView(-1);
  if (key === 'ArrowRight') shiftByView(1);
  if (key === 'ArrowUp') focusPrev();
  if (key === 'ArrowDown') setView('month');
}

function handleMonthArrow(key) {
  let idx = state.focus.monthIndex;
  if (key === 'ArrowLeft') {
    if (idx % 7 === 0) {
      state.focus.region = 'sidebar';
      render();
      return;
    }
    idx -= 1;
  }
  if (key === 'ArrowRight') idx += 1;
  if (key === 'ArrowUp') idx -= 7;
  if (key === 'ArrowDown') idx += 7;
  idx = Math.max(0, Math.min(41, idx));
  state.focus.monthIndex = idx;
  const date = getFocusedMonthDate();
  if (date) patchTvState({ selectedDate: date });
  render();
}

function shiftByView(direction) {
  const d = parseLocalDate(state.selectedDate || toISO(new Date()));
  let delta = 1;
  if (state.currentView === 'week') delta = 7;
  if (state.currentView === 'month') {
    d.setMonth(d.getMonth() + direction);
    patchTvState({ selectedDate: toISO(d) }).then(() => refreshEvents());
    return;
  }
  const next = offsetDate(d, direction * delta);
  patchTvState({ selectedDate: toISO(next) }).then(() => refreshEvents());
}

function goToday() {
  patchTvState({ selectedDate: toISO(new Date()) }).then(() => refreshEvents());
}

function setView(viewName) {
  patchTvState({ currentView: viewName }).then(() => refreshEvents());
}

function weekdayNames() {
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
}

function weekStartSunday(date) {
  return offsetDate(date, -date.getDay());
}

function buildWeekDates(anchorDate) {
  const start = weekStartSunday(anchorDate);
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    out.push(toISO(offsetDate(start, i)));
  }
  return out;
}

function buildMonthDates(anchorDate) {
  const firstOfMonth = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const start = weekStartSunday(firstOfMonth);
  const out = [];
  for (let i = 0; i < 42; i += 1) {
    out.push(toISO(offsetDate(start, i)));
  }
  return out;
}

function dayData(dateKey) {
  return state.dayMap[dateKey] || { date: dateKey, events: [], stickyNotes: [] };
}

function renderWeekdayHeader() {
  return `<div class="tv-weekdays">${weekdayNames().map(name => `<div class="tv-weekday-chip">${name}</div>`).join('')}</div>`;
}

function renderLeftSidebar() {
  const side = sidebarItems();
  return `<div class="tv-sidebar">${side.map((item, idx) => `<div class="tv-side-item ${state.focus.region === 'sidebar' && state.focus.sidebarIndex === idx ? 'focused' : ''}" data-tv-click="sidebar" data-sidebar-index="${idx}">${escapeHtml(item.label)}</div>`).join('')}<div class="tv-editor-anchor"></div></div>`;
}

function renderRightRail(selectedDateKey, weekDateKeys) {
  const selectedItems = itemsForDate(selectedDateKey).slice(0, 12);
  const weekEvents = weekDateKeys.flatMap(dateKey => (dayData(dateKey).events || []).map(ev => ({ dateKey, ev })));
  return `
    <aside class="tv-right-rail">
      <div class="tv-right-title">${escapeHtml(parseLocalDate(selectedDateKey).toLocaleDateString([], { weekday: 'long', month: 'short', day: '2-digit', year: 'numeric' }))}</div>
      <div class="tv-right-list">
        ${selectedItems.length ? selectedItems.map(item => {
          if (item.type === 'event') {
            const eventColor = normalizeHexColor(item.event.color) || '#8EA4C4';
            return `<div class="tv-right-item" style="background:${softColor(eventColor, 0.2)}; border-color:${softColor(eventColor, 0.52)}"><div class="tv-right-item-time">${escapeHtml(formatTime(item.event.start))}</div><div class="tv-right-item-title">${escapeHtml(item.event.title || 'Untitled')}</div></div>`;
          }
          return `<div class="tv-right-item"><div class="tv-right-item-time">Sticky</div><div class="tv-right-item-title">${escapeHtml(item.sticky.content || '')}</div></div>`;
        }).join('') : '<div class="tv-empty">No events or sticky notes</div>'}
      </div>
      <div class="tv-right-subtitle">This Week</div>
      <div class="tv-right-list">
        ${weekEvents.length ? weekEvents.slice(0, 12).map(row => {
          const eventColor = normalizeHexColor(row.ev.color) || '#8EA4C4';
          return `<div class="tv-right-item" style="background:${softColor(eventColor, 0.2)}; border-color:${softColor(eventColor, 0.52)}"><div class="tv-right-item-time">${escapeHtml(parseLocalDate(row.dateKey).toLocaleDateString([], { weekday: 'short' }))} ${escapeHtml(formatTime(row.ev.start))}</div><div class="tv-right-item-title">${escapeHtml(row.ev.title || 'Untitled')}</div></div>`;
        }).join('') : '<div class="tv-empty">No events this week</div>'}
      </div>
    </aside>`;
}

function sidebarItems() {
  return [
    { label: `Mini Calendar: ${state.selectedDate || 'n/a'}`, action: () => patchTvState({ selectedDate: state.selectedDate || toISO(new Date()) }).then(() => refreshEvents()) },
    { label: 'View: Day', action: () => setView('day') },
    { label: 'View: Week', action: () => setView('week') },
    { label: 'View: Month', action: () => setView('month') },
    { label: 'Quick: Create Event', action: () => createEventAndEdit() },
    { label: 'Quick: Create Sticky Note', action: () => createStickyAndEdit() },
    { label: 'Quick: Jump to Today', action: () => goToday() },
  ];
}

function runSidebarAction(index) {
  const items = sidebarItems();
  if (items[index]) items[index].action();
}

function focusNext() {
  if (state.currentView === 'month') {
    if (state.focus.region === 'sidebar') {
      state.focus.sidebarIndex = (state.focus.sidebarIndex + 1) % sidebarItems().length;
    } else {
      state.focus.monthIndex = (state.focus.monthIndex + 1) % 42;
      const date = getFocusedMonthDate();
      if (date) patchTvState({ selectedDate: date });
    }
    render();
    return;
  }
  const items = itemsForSelectedDate();
  if (!items.length) return;
  state.focus.itemIndex = (state.focus.itemIndex + 1) % items.length;
  syncFocusedEventWithState(items[state.focus.itemIndex]);
  render();
}

function focusPrev() {
  if (state.currentView === 'month') {
    if (state.focus.region === 'sidebar') {
      state.focus.sidebarIndex = (state.focus.sidebarIndex - 1 + sidebarItems().length) % sidebarItems().length;
    } else {
      state.focus.monthIndex = (state.focus.monthIndex - 1 + 42) % 42;
      const date = getFocusedMonthDate();
      if (date) patchTvState({ selectedDate: date });
    }
    render();
    return;
  }
  const items = itemsForSelectedDate();
  if (!items.length) return;
  state.focus.itemIndex = (state.focus.itemIndex - 1 + items.length) % items.length;
  syncFocusedEventWithState(items[state.focus.itemIndex]);
  render();
}

function triggerStickyAction() {
  const item = getFocusedItem();
  if (item && item.type === 'sticky') {
    enterStickyEditor(item, 'update');
  } else {
    createStickyAndEdit();
  }
}

function syncFocusAfterData() {
  if (state.currentView === 'month') {
    const dates = state.monthDates.length ? state.monthDates : buildMonthDates(parseLocalDate(state.selectedDate || toISO(new Date())));
    const idx = dates.indexOf(state.selectedDate);
    state.focus.monthIndex = idx >= 0 ? idx : 0;
    return;
  }
  const items = itemsForSelectedDate();
  if (!items.length) {
    state.focus.itemIndex = 0;
    return;
  }
  let idx = items.findIndex(it => it.type === 'event' && it.id === state.focusedEventId);
  if (idx < 0) idx = Math.min(state.focus.itemIndex, items.length - 1);
  state.focus.itemIndex = Math.max(0, idx);
  syncFocusedEventWithState(items[state.focus.itemIndex]);
}

function syncFocusedEventWithState(item) {
  if (!item || item.type !== 'event') return;
  if (item.id === state.focusedEventId) return;
  state.focusedEventId = item.id;
  patchTvState({ focusedEventId: item.id });
}

function getFocusedMonthDate() {
  const date = state.monthDates[state.focus.monthIndex];
  return date || null;
}

function itemsForDate(dateKey) {
  const day = state.dayMap[dateKey];
  if (!day) return [];
  const events = (day.events || []).map(ev => ({ type: 'event', id: ev.id, date: dateKey, event: ev }));
  const sticky = (day.stickyNotes || []).map((s, i) => ({ type: 'sticky', id: s.id || `sticky-${i}`, date: dateKey, sticky: s, index: i }));
  return [...events, ...sticky];
}

function itemsForSelectedDate() {
  return itemsForDate(state.selectedDate);
}

function getFocusedItem() {
  const items = itemsForSelectedDate();
  if (!items.length) return null;
  const idx = Math.max(0, Math.min(items.length - 1, state.focus.itemIndex));
  return items[idx];
}

function render() {
  syncAccountLegend();
  renderHeader();
  renderAccountLegend();
  renderMain();
  renderFooterHint();
}

function syncAccountLegend() {
  const map = new Map();
  for (const day of state.days) {
    for (const ev of (day.events || [])) {
      const source = ev.source || 'local';
      const account = ev.accountEmail || source;
      const key = `${source}|${account}`;
      if (!map.has(key)) {
        map.set(key, {
          source,
          account,
          color: normalizeHexColor(ev.color) || '#9AA3B2',
        });
      }
    }
  }
  state.accountLegend = Array.from(map.values());
}

function renderAccountLegend() {
  if (!dom.accountLegend) return;
  if (!state.accountLegend.length) {
    dom.accountLegend.innerHTML = '<div class="tv-account-chip">No account legend available</div>';
    return;
  }
  dom.accountLegend.innerHTML = state.accountLegend.map(item => {
    const bg = softColor(item.color, 0.2);
    const border = softColor(item.color, 0.55);
    return `<div class="tv-account-chip" style="background:${bg}; border-color:${border};"><span class="tv-account-dot" style="background:${item.color};"></span><span>${escapeHtml(item.source)}: ${escapeHtml(item.account)}</span></div>`;
  }).join('');
}

function renderHeader() {
  if (dom.dateHeader) {
    const d = parseLocalDate(state.selectedDate || toISO(new Date()));
    dom.dateHeader.textContent = `${state.currentView.toUpperCase()} • ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
  }
}

function renderMain() {
  if (!dom.tvMain) return;
  dom.tvMain.classList.toggle('tv-editor-active', Boolean(state.editor));
  if (state.currentView === 'month') {
    dom.tvMain.innerHTML = renderMonthView();
  } else if (state.currentView === 'week') {
    dom.tvMain.innerHTML = renderWeekView();
  } else {
    dom.tvMain.innerHTML = renderDayView();
  }
  if (state.editor) {
    const holder = dom.tvMain.querySelector('.tv-editor-anchor');
    if (holder) holder.innerHTML = renderEditor();
  }
}

function renderDayView() {
  const selected = parseLocalDate(state.selectedDate || toISO(new Date()));
  const weekDates = buildWeekDates(selected);
  return `
    <div class="tv-shell">
      ${renderLeftSidebar()}
      <div>
        ${renderWeekdayHeader()}
        <div class="tv-main-grid day">${weekDates.map(dateKey => renderDayCard(dayData(dateKey), dateKey === state.selectedDate)).join('')}</div>
      </div>
      ${renderRightRail(state.selectedDate, weekDates)}
    </div>`;
}

function renderWeekView() {
  const selected = parseLocalDate(state.selectedDate || toISO(new Date()));
  const weekDates = buildWeekDates(selected);
  return `
    <div class="tv-shell">
      ${renderLeftSidebar()}
      <div>
        ${renderWeekdayHeader()}
        <div class="tv-main-grid week">${weekDates.map(dateKey => renderDayCard(dayData(dateKey), dateKey === state.selectedDate)).join('')}</div>
      </div>
      ${renderRightRail(state.selectedDate, weekDates)}
    </div>`;
}

function renderMonthView() {
  state.monthDates = buildMonthDates(parseLocalDate(state.selectedDate || toISO(new Date())));
  return `
  <div class="tv-shell month">
    ${renderLeftSidebar()}
    <div>
      ${renderWeekdayHeader()}
      <div class="tv-main-grid month">
      ${state.monthDates.map((dateKey, idx) => renderMonthCell(dayData(dateKey), idx)).join('')}
      </div>
    </div>
  </div>`;
}

function renderDayCard(day, selected) {
  const date = parseLocalDate(day.date);
  const items = itemsForDate(day.date);
  const now = new Date();
  const cards = items.length
    ? items.map((item, idx) => {
        const focused = day.date === state.selectedDate && idx === state.focus.itemIndex && state.focus.region === 'main';
        if (item.type === 'event') {
          const ev = item.event;
          const eventColor = normalizeHexColor(ev.color) || '#8EA4C4';
          const bg = softColor(eventColor, eventIsNow(ev, now) ? 0.34 : 0.2);
          const border = softColor(eventColor, focused ? 0.7 : 0.5);
          return `<div class="tv-item ${focused ? 'focused' : ''} ${eventIsNow(ev, now) ? 'now' : ''} ${eventIsUpcoming(ev, now) ? 'next' : ''}" style="background:${bg}; border-color:${border}" data-tv-click="item" data-item-type="event" data-date="${escapeHtml(day.date)}" data-item-index="${idx}" data-event-id="${ev.id}"><div class="tv-item-title">${escapeHtml(ev.title || 'Untitled')}</div><div class="tv-item-sub">${escapeHtml(formatTime(ev.start))} - ${escapeHtml(formatTime(ev.end))}</div><div class="tv-item-sub">${escapeHtml(ev.description || '')}</div></div>`;
        }
        return `<div class="tv-item ${focused ? 'focused' : ''}" data-tv-click="item" data-item-type="sticky" data-date="${escapeHtml(day.date)}" data-item-index="${idx}"><div class="tv-item-title">Sticky Note</div><div class="tv-item-sub">${escapeHtml(item.sticky.content || '')}</div></div>`;
      }).join('')
    : `<div class="tv-empty">No events or sticky notes</div>`;

  return `<div class="tv-day-card ${selected ? 'selected' : ''}" data-tv-click="day" data-date="${escapeHtml(day.date)}"><div class="tv-day-head">${date.toLocaleDateString([], { weekday: 'long' })}</div><div class="tv-day-num">${date.getDate()}</div><div class="tv-item-list">${cards}</div><div class="tv-editor-anchor"></div></div>`;
}

function renderMonthCell(day, idx) {
  const date = parseLocalDate(day.date);
  const focused = state.focus.region === 'main' && state.focus.monthIndex === idx;
  const previewEvent = (day.events || [])[0];
  const previewSticky = (day.stickyNotes || [])[0];
  const preview = previewEvent ? previewEvent.title : (previewSticky ? previewSticky.content : '');
  return `<div class="tv-month-cell ${focused ? 'focused' : ''}" data-tv-click="month-cell" data-month-index="${idx}" data-date="${escapeHtml(day.date)}"><div class="tv-month-date">${date.getDate()}</div><div class="tv-month-preview">${escapeHtml(preview)}</div></div>`;
}

function renderEditor() {
  if (!state.editor) return '';
  const fieldsHtml = state.editor.fields.map((f, idx) => `<div class="tv-field ${idx === state.editor.fieldIndex ? 'focused' : ''}" data-tv-click="field" data-field-index="${idx}"><div class="tv-field-name">${escapeHtml(f.label)}</div><div class="tv-field-value">${escapeHtml(formatFieldValue(f.key, state.editor.data[f.key]))}</div></div>`).join('');
  return `<div class="tv-editor"><div class="tv-editor-title">Inline Editing</div>${fieldsHtml}<div class="tv-hint-chip">UP/DOWN field • LEFT/RIGHT change • SELECT save • ESC cancel</div></div>`;
}

function renderFooterHint(extra) {
  if (!dom.statusEl || !dom.lastUpdated) return;
  dom.statusEl.textContent = state.centerArrowMode ? 'Arrow Mode: ON' : 'Arrow Mode: OFF';
  dom.lastUpdated.textContent = extra || 'Single SELECT edit • Double SELECT context • Triple SELECT arrow mode • Long press create • +/- tab';
}

function enterEventEditor(item, mode) {
  const ev = item ? item.event : null;
  const start = ev ? ev.start : `${state.selectedDate}T09:00:00+00:00`;
  const end = ev ? ev.end : `${state.selectedDate}T10:00:00+00:00`;
  state.editor = {
    type: 'event',
    mode,
    eventId: ev ? ev.id : null,
    date: item ? item.date : state.selectedDate,
    fieldIndex: 0,
    fields: [
      { key: 'title', label: 'Title' },
      { key: 'start', label: 'Start Time' },
      { key: 'end', label: 'End Time' },
      { key: 'description', label: 'Description' },
    ],
    data: {
      title: ev ? (ev.title || 'New Event') : 'New Event',
      start,
      end,
      description: ev ? (ev.description || '') : '',
    },
  };
  render();
}

function enterStickyEditor(item, mode) {
  const sticky = item ? item.sticky : { content: 'New sticky note', color: STICKY_COLORS[0] };
  state.editor = {
    type: 'sticky',
    mode,
    stickyId: item ? item.id : null,
    stickyIndex: item ? item.index : null,
    date: item ? item.date : state.selectedDate,
    fieldIndex: 0,
    fields: [
      { key: 'content', label: 'Title' },
      { key: 'color', label: 'Color' },
      { key: 'description', label: 'Description' },
    ],
    data: {
      content: sticky.content || 'New sticky note',
      color: sticky.color || STICKY_COLORS[0],
      description: sticky.description || '',
    },
  };
  render();
}

function handleEditorKey(key) {
  if (!state.editor) return false;
  if (key === 'ArrowUp') {
    state.editor.fieldIndex = (state.editor.fieldIndex - 1 + state.editor.fields.length) % state.editor.fields.length;
    render();
    return true;
  }
  if (key === 'ArrowDown') {
    state.editor.fieldIndex = (state.editor.fieldIndex + 1) % state.editor.fields.length;
    render();
    return true;
  }
  if (key === 'ArrowLeft') {
    adjustEditorValue(-1);
    render();
    return true;
  }
  if (key === 'ArrowRight') {
    adjustEditorValue(1);
    render();
    return true;
  }
  if (key === 'Escape' || key === 'Backspace') {
    state.editor = null;
    render();
    return true;
  }
  return false;
}

function handleMainClick(e) {
  const t = e.target.closest('[data-tv-click]');
  if (!t) return;

  const role = t.getAttribute('data-tv-click');
  if (role === 'sidebar') {
    const idx = Number(t.getAttribute('data-sidebar-index') || 0);
    state.focus.region = 'sidebar';
    state.focus.sidebarIndex = idx;
    onSelect();
    return;
  }

  if (role === 'month-cell') {
    const idx = Number(t.getAttribute('data-month-index') || 0);
    const date = t.getAttribute('data-date');
    state.focus.region = 'main';
    state.focus.monthIndex = idx;
    if (date) {
      patchTvState({ selectedDate: date }).then(() => {
        onSelect();
      });
    }
    return;
  }

  if (role === 'day') {
    const date = t.getAttribute('data-date');
    if (date) {
      patchTvState({ selectedDate: date }).then(() => refreshEvents());
    }
    return;
  }

  if (role === 'item') {
    const date = t.getAttribute('data-date');
    const idx = Number(t.getAttribute('data-item-index') || 0);
    if (date) state.selectedDate = date;
    state.focus.region = 'main';
    state.focus.itemIndex = idx;
    render();
    onSelect();
    return;
  }

  if (role === 'field' && state.editor) {
    const idx = Number(t.getAttribute('data-field-index') || 0);
    state.editor.fieldIndex = idx;
    render();
  }
}

function clickCursorTarget(mode) {
  if (!state.cursor.visible) return;
  const el = document.elementFromPoint(state.cursor.x, state.cursor.y);
  if (!el) return;
  if (mode === 'right') {
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: state.cursor.x, clientY: state.cursor.y, button: 2 });
    el.dispatchEvent(ev);
    return;
  }
  const click = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: state.cursor.x, clientY: state.cursor.y, button: 0 });
  el.dispatchEvent(click);
}

function adjustEditorValue(direction) {
  const field = state.editor.fields[state.editor.fieldIndex].key;
  const data = state.editor.data;

  if (field === 'start' || field === 'end') {
    const d = parseDateTime(data[field]);
    d.setMinutes(d.getMinutes() + (15 * direction));
    data[field] = d.toISOString();
    return;
  }

  if (field === 'title') {
    data.title = cycleValue(TITLE_PRESETS, data.title, direction);
    return;
  }

  if (field === 'description') {
    data.description = cycleValue(DESC_PRESETS, data.description, direction);
    return;
  }

  if (field === 'content') {
    data.content = cycleValue(STICKY_PRESETS, data.content, direction);
    return;
  }

  if (field === 'color') {
    data.color = cycleValue(STICKY_COLORS, data.color, direction);
  }
}

function cycleValue(values, current, direction) {
  const i = values.indexOf(current);
  if (i < 0) return values[0];
  let next = i + direction;
  if (next < 0) next = values.length - 1;
  if (next >= values.length) next = 0;
  return values[next];
}

function createEventAndEdit() { enterEventEditor(null, 'create'); }
function createStickyAndEdit() { enterStickyEditor(null, 'create'); }

async function saveEditor() {
  if (!state.editor) return;

  if (state.editor.type === 'event') {
    const payload = {
      title: state.editor.data.title,
      description: state.editor.data.description,
      start: state.editor.data.start,
      end: state.editor.data.end,
      date: state.editor.date,
    };

    if (state.editor.mode === 'create') {
      await authFetch('/tv/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } else {
      await authFetch(`/tv/events/${state.editor.eventId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    }
  } else {
    const dateKey = state.editor.date || state.selectedDate;
    const day = state.dayMap[dateKey] || { stickyNotes: [] };
    const list = (day.stickyNotes || []).map(x => ({
      id: x.id,
      content: x.content,
      color: x.color,
      createdAt: x.createdAt,
      updatedAt: x.updatedAt,
    }));

    if (state.editor.mode === 'create') {
      list.push({
        id: `sticky-${Date.now()}`,
        content: state.editor.data.content,
        color: state.editor.data.color,
      });
    } else {
      const idx = list.findIndex(x => x.id === state.editor.stickyId);
      if (idx >= 0) {
        list[idx].content = state.editor.data.content;
        list[idx].color = state.editor.data.color;
      }
    }

    await authFetch(`/tv/date-sticky/${dateKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sticky_notes: list }),
    });
  }

  state.editor = null;
  await refreshEvents();
}

function parseDateTime(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return new Date();
  return d;
}

function formatFieldValue(key, value) {
  if (key === 'start' || key === 'end') return formatTime(value);
  return value || '';
}

function formatTime(iso) {
  const d = parseDateTime(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function parseLocalDate(str) {
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

function offsetDate(d, delta) {
  const n = new Date(d);
  n.setDate(n.getDate() + delta);
  return n;
}

function toISO(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function eventIsNow(ev, now) {
  const s = parseDateTime(ev.start);
  const e = parseDateTime(ev.end);
  return s <= now && now <= e;
}

function eventIsUpcoming(ev, now) {
  const s = parseDateTime(ev.start);
  return s > now;
}

function normalizeHexColor(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const raw = hex.trim().replace('#', '');
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return `#${raw.split('').map(ch => ch + ch).join('').toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{6}$/.test(raw)) {
    return `#${raw.toUpperCase()}`;
  }
  return null;
}

function hexToRgb(hex) {
  const n = normalizeHexColor(hex);
  if (!n) return null;
  return {
    r: parseInt(n.slice(1, 3), 16),
    g: parseInt(n.slice(3, 5), 16),
    b: parseInt(n.slice(5, 7), 16),
  };
}

function softColor(hex, alpha = 0.2) {
  const rgb = hexToRgb(hex);
  if (!rgb) return `rgba(142,164,196,${alpha})`;
  return `rgba(${rgb.r},${rgb.g},${rgb.b},${alpha})`;
}

function escapeHtml(val) {
  return String(val == null ? '' : val)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', init);
