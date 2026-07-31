import { createTvZoomEngine } from './tv_zoom_engine.js';

const TOKEN_KEY = 'tv_token';
// TV state remains backend-driven. Poll often enough for a wall display while
// lifecycle recovery handles FireOS/Silk timer suspension.
const POLL_MS = 600000;
const TV_FETCH_TIMEOUT_MS = 12000;
const AUTO_REFRESH_FAILURE_BACKOFF_MS = 60000;
const MIN_SYNC_VISUAL_MS = 500;
const LONG_PRESS_MS = 600;
const DEFAULT_ZOOM_LEVEL = 100;
const DATE_AUTO_ADVANCE_DEBOUNCE_MS = 5000;
const INPUT_MODE_STORAGE_KEY = 'tv_input_mode';
const REMOTE_CAPABILITIES_STORAGE_KEY = 'tv_remote_capabilities_v1';
const REMOTE_ACTION_ECHO_MS = 1400;
const UPDATE_RELOAD_DELAY_MS = 9000;
const VIEW_PAYLOAD_CACHE_LIMIT = 24;
const DAY_WINDOW_CACHE_LIMIT = 140;
const TV_VIEW_NAMES = new Set(['day', '3-day', 'week', 'month']);

const IS_KIOSK = Boolean(window.KIOSK_TOKEN);
const CLIENT_APP_VERSION = String(window.TV_APP_VERSION || 'dev-local');

function createDefaultRemoteCapabilities() {
  return {
    arrows: false,
    select: false,
    back: false,
    list: false,
    volume: false,
    media: false,
    channel: false,
    mute: false,
  };
}

// tvDiag is assigned after state is initialised (below).
// Declaring it here with let means wakeLock/antiSleep callbacks can safely
// reference it at runtime without a temporal-dead-zone crash.
let tvDiag = null;
let zoomEngine = null;

// ─── Screen Wake Lock Manager ────────────────────────────────────────────────
// Prevents FireOS / Amazon Silk from sleeping the browser after 20-30 minutes
// of no physical user input.  All state is encapsulated in this singleton so
// there are no global sentinel references that could leak.
//
// Browser support:  Chrome 84+, Edge 86+, Amazon Silk (Chromium engine).
// Graceful degradation: unsupported browsers receive a console note and no error.
//
// Diagnostics: inspect window.__WAKE_LOCK_ACTIVE__ from remote devtools.
const wakeLock = (() => {
  let _sentinel = null;

  async function request() {
    if (!('wakeLock' in navigator)) {
      console.log('[WakeLock] Not supported on this browser — skipping.');
      return;
    }
    // If we already hold a live sentinel, nothing to do.
    try {
      console.log('[WakeLock] Status: Requested');
      _sentinel = await navigator.wakeLock.request('screen');
      window.__WAKE_LOCK_ACTIVE__ = true;
      console.log('[WakeLock] Status: Active');

      // The OS/browser releases the lock automatically when the tab is hidden,
      // the screen turns off, or a network glitch causes a reload.
      // Bind once per sentinel acquisition so we never stack listeners.
      _sentinel.addEventListener('release', () => {
        console.log('[WakeLock] Status: Released by OS/Browser — scheduling re-acquisition');
        _sentinel = null;
        window.__WAKE_LOCK_ACTIVE__ = false;
        if (tvDiag) tvDiag.log('wake_lock_released', `vis=${document.visibilityState}`);
        // Re-acquire only when the document is still visible; if it's hidden the
        // visibilitychange listener will re-acquire when it comes back.
        if (document.visibilityState === 'visible') {
          setTimeout(request, 1000);
        }
      }, { once: true });

    } catch (err) {
      // NotAllowedError is normal (page not visible, low-power mode, etc.)
      _sentinel = null;
      window.__WAKE_LOCK_ACTIVE__ = false;
      console.log(`[WakeLock] Error: ${err.name} - ${err.message}`);
    }
  }

  // Called whenever the page regains visibility.
  async function reacquire() {
    if (!_sentinel || _sentinel.released) {
      _sentinel = null;
      await request();
    }
  }

  // Called on clean application teardown (unpair / logout).
  function release() {
    if (_sentinel && !_sentinel.released) {
      _sentinel.release().catch(() => { });
    }
    _sentinel = null;
    window.__WAKE_LOCK_ACTIVE__ = false;
    console.log('[WakeLock] Status: Explicitly released');
  }

  return { request, reacquire, release };
})();

// ─── Three-Layer Anti-Sleep Engine ───────────────────────────────────────────
// FireOS ignores navigator.wakeLock alone because it has OS-level sleep that
// supersedes browser APIs when no physical input is detected.
//
// Layer 1: Screen Wake Lock API (already above)
// Layer 2: Hidden 1×1 canvas with requestAnimationFrame — keeps the GPU
//   renderer active every frame.  FireOS treats active rendering as display
//   activity and resets its inactivity counter.
// Layer 3: Synthetic mousemove event every 20 s — explicitly resets the
//   FireOS/Android user-activity watchdog timer.
//
// All three together reliably prevent the 20-30 min sleep on Amazon Silk.
const antiSleep = (() => {
  let _rafHandle = null;
  let _evtHandle = null;
  let _tick = 0;
  let _lastRafTs = null;
  let _gapCb = null;

  // ── Layer 2: Hidden canvas (rAF loop keeps GPU renderer active) ──────────
  const _canvas = document.createElement('canvas');
  _canvas.width = 2;   // 2×2 so captureStream has real pixels
  _canvas.height = 2;
  Object.assign(_canvas.style, {
    position: 'fixed', bottom: '0', right: '0',
    width: '1px', height: '1px',
    opacity: '0.002',
    pointerEvents: 'none',
    zIndex: '-9999',
  });
  const _ctx = _canvas.getContext('2d');

  // ── Layer 4: canvas.captureStream() → <video> playback ───────────────────
  // Registers the page as "actively playing media" with the Android media
  // framework. FireOS explicitly exempts media-playing apps from sleep.
  // This is the most reliable FireOS fix — the OS-level power manager checks
  // for media sessions, not browser wake locks.
  let _videoEl = null;

  function _startVideoStream() {
    if (_videoEl && !_videoEl.paused) return;
    try {
      if (!_videoEl) {
        const stream = _canvas.captureStream(1); // 1 fps — negligible CPU
        _videoEl = document.createElement('video');
        _videoEl.srcObject = stream;
        _videoEl.muted = true;
        _videoEl.loop = true;
        _videoEl.playsInline = true;
        _videoEl.setAttribute('playsinline', '');
        Object.assign(_videoEl.style, {
          position: 'fixed', bottom: '0', right: '0',
          width: '1px', height: '1px',
          opacity: '0.001',
          pointerEvents: 'none',
          zIndex: '-9998',
        });
      }
      if (!document.body.contains(_videoEl)) document.body.appendChild(_videoEl);
      _videoEl.play()
        .then(() => console.log('[AntiSleep] Layer 4 video stream: playing (media-exempt)'))
        .catch(err => console.log('[AntiSleep] Layer 4 video stream: play() failed —', err.message));
    } catch (err) {
      console.log('[AntiSleep] Layer 4 video stream: not available —', err.message);
    }
  }

  function _stopVideoStream() {
    if (_videoEl) {
      try { _videoEl.pause(); } catch { }
      if (document.body.contains(_videoEl)) document.body.removeChild(_videoEl);
      _videoEl = null;
    }
  }

  // ── Layer 5: Web Audio silent oscillator ─────────────────────────────────
  // Keeps Android audio manager showing the app as active. Uses ultrasonic
  // frequency (20 kHz) at near-zero gain — completely inaudible.
  // Requires a prior user gesture; gracefully skipped in kiosk mode.
  let _audioCtx = null;
  let _audioOsc = null;

  function _startAudio() {
    if (_audioCtx && _audioCtx.state !== 'closed') return;
    try {
      _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      _audioOsc = _audioCtx.createOscillator();
      const gain = _audioCtx.createGain();
      gain.gain.setValueAtTime(0.00001, _audioCtx.currentTime);      // inaudible
      _audioOsc.frequency.setValueAtTime(20000, _audioCtx.currentTime); // 20 kHz
      _audioOsc.connect(gain);
      gain.connect(_audioCtx.destination);
      _audioOsc.start();
      console.log('[AntiSleep] Layer 5 Web Audio: started (20 kHz ultrasonic, gain=0.00001)');
    } catch (err) {
      console.log('[AntiSleep] Layer 5 Web Audio: not available —', err.message);
    }
  }

  function _stopAudio() {
    try { if (_audioOsc) _audioOsc.stop(); } catch { }
    try { if (_audioCtx) _audioCtx.close(); } catch { }
    _audioOsc = null;
    _audioCtx = null;
  }

  function _rafLoop(ts) {
    if (_lastRafTs !== null && _gapCb && (ts - _lastRafTs) > 2000) _gapCb(ts - _lastRafTs);
    _lastRafTs = ts;
    _tick = (_tick + 1) & 255;
    _ctx.clearRect(0, 0, 2, 2);
    _ctx.fillStyle = `rgba(0,0,0,${0.001 + (_tick % 2) * 0.001})`;
    _ctx.fillRect(0, 0, 2, 2);
    _rafHandle = requestAnimationFrame(_rafLoop);
  }

  function start() {
    if (!document.body.contains(_canvas)) document.body.appendChild(_canvas);
    if (!_rafHandle) {
      _lastRafTs = null;
      requestAnimationFrame(_rafLoop);
      console.log('[AntiSleep] Layer 2 rAF canvas: started');
    }
    if (!_evtHandle) {
      _evtHandle = setInterval(() => {
        if (document.visibilityState === 'visible') {
          document.dispatchEvent(new MouseEvent('mousemove', {
            bubbles: true, cancelable: true, clientX: 1, clientY: 1,
          }));
          document.dispatchEvent(new PointerEvent('pointermove', {
            bubbles: true, cancelable: true, clientX: 1, clientY: 1, isPrimary: true,
          }));
        }
      }, 8000);  // 8 s — resets FireOS activity watchdog more aggressively than 20 s
      console.log('[AntiSleep] Layer 3 synthetic events: started (8s)');
    }
    _startVideoStream();   // Layer 4 — primary FireOS fix
    _startAudio();         // Layer 5 — audio manager backup
    window.__ANTI_SLEEP_ACTIVE__ = true;
    window.__ANTI_SLEEP_LAYERS__ = 'WakeLock+rAF+SyntheticEvents+VideoStream+WebAudio';
  }

  function stop() {
    if (_rafHandle) { cancelAnimationFrame(_rafHandle); _rafHandle = null; }
    if (_evtHandle) { clearInterval(_evtHandle); _evtHandle = null; }
    if (document.body.contains(_canvas)) document.body.removeChild(_canvas);
    _stopVideoStream();
    _stopAudio();
    window.__ANTI_SLEEP_ACTIVE__ = false;
    console.log('[AntiSleep] all 5 layers stopped');
  }

  // Called after a visibility hidden→visible transition to force the video
  // element back into play().  Browsers always pause <video> when a tab goes
  // hidden, killing our Layer-4 media-exempt status on FireOS.  Explicit
  // restart is required; antiSleep.start() alone does not always re-trigger it.
  function restartVideo() {
    if (_videoEl) {
      _videoEl.play()
        .then(() => console.log('[AntiSleep] Layer 4 video: restarted after visibility restore'))
        .catch(err => console.log('[AntiSleep] Layer 4 video restart failed:', err.message));
    } else {
      _startVideoStream();  // element was removed — create fresh
    }
  }

  function isVideoActive() {
    return !!(_videoEl && !_videoEl.paused && !_videoEl.ended);
  }

  function setRafGapCb(fn) { _gapCb = fn; }

  return { start, stop, setRafGapCb, restartVideo, isVideoActive };
})();

// ─────────────────────────────────────────────────────────────────────────────

const state = {
  token: null,
  selectedDate: null,
  currentView: 'day',
  focusedEventId: null,
  userEmail: null,
  userRole: null,
  days: [],
  dayMap: {},
  eventsRequestInFlight: false,
  eventsRefreshQueued: false,
  queuedRefreshForce: false,
  lastEventsFetchAt: 0,
  lastEventsEtag: '',
  lastDataSignature: '',
  lastDataSnapshotIndex: null,
  staleMode: false,
  lastStaleReason: '',
  syncInProgress: false,
  syncVisualStartedAt: 0,
  autoRefreshBackoffUntil: 0,
  syncStatusTone: null,
  syncStatusUntil: 0,
  syncStatusTimer: null,
  syncStatusMessage: '',
  pollHandle: null,
  clockHandle: null,
  heartbeatHandle: null,       // 60-second diagnostic heartbeat
  sessionStartAt: null,        // set by startPolling()
  sleepGuardEnabled: true,     // read from /tv/state
  sleepGuardTimeoutMinutes: 0, // 0 = never timeout
  longPressTimer: null,
  longPressTriggered: false,
  clickCount: 0,
  clickTimer: null,
  zoomLevel: DEFAULT_ZOOM_LEVEL,
  defaultZoomLevel: DEFAULT_ZOOM_LEVEL,
  zoomHold: {
    key: null,
    timer: null,
    triggered: false,
  },
  dateAutoAdvanceInFlight: false,
  lastDateAutoAdvanceAt: 0,
  lastObservedDayKey: null,
  inputMode: 'nav',
  cursor: {
    x: 0,
    y: 0,
    visible: false,
  },
  remoteCapabilities: createDefaultRemoteCapabilities(),
  remoteActionTimer: null,
  clientAppVersion: CLIENT_APP_VERSION,
  serverAppVersion: CLIENT_APP_VERSION,
  updatePending: false,
  updateReloadTimer: null,
  authStatus: IS_KIOSK ? 'kiosk' : 'unpaired',
  lastAuthIssue: '',
  lastAuthFetchError: null,
  debug: {
    visible: false,
    lines: [],
    maxLines: 12,
  },
  editor: null,
  editorDirty: false,
  daySectionState: {
    allDay: true,
    freeTime: true,
    sticky: true,
  },
  monthDetailOpen: false,
  utilityPanel: null,
  adminUsers: [],
  history: {
    past: [],
    future: [],
  },
  focus: {
    region: 'main',
    monthIndex: 0,
    sidebarIndex: 0,
    itemIndex: 0,
  },
  monthDates: [],
  monthDatesAnchorKey: '',
  accountLegend: [],
  serverAccounts: [],
  accountColorMap: {},
  accountEmailColorMap: {},
  selectedAccountKeys: [],
  accountChipPressTimer: null,
  accountChipPressFired: false,
  accountChipClickTimer: null,
  accountChipClickCount: 0,
  viewPayloadCache: {},
  viewPayloadCacheOrder: [],
  dayWindowCache: {},
  dayWindowCacheOrder: [],
  cachedAccounts: [],
  cachedAccountsAt: 0,
  legendSourceDays: null,
  legendSourceAccounts: null,
  renderEventsCache: {},
  renderItemsCache: {},
  selectedDatePatchTimer: null,
  selectedDatePatchValue: '',
};

let dom = {};

// ─── TV Diagnostic Logger ────────────────────────────────────────────────────
// Assigned here so all subsequent code (including wakeLock/antiSleep callbacks
// that run at runtime) can call tvDiag.log safely.
//
// Each entry is stored to:
//   1. An in-memory ring buffer (shown on TV in real-time)
//   2. localStorage('tv_diag') — survives the tab being backgrounded
//   3. POST /tv/diag via fetch keepalive — written to Supabase/Postgres,
//      queryable from any device over the network (Admin → TV Diagnostics)
//
// device_id is a stable UUID stored in localStorage('tv_device_id').
// It is created once on first load and never changes, so every entry in the
// DB can be filtered by device regardless of IP or session.

// Generate or retrieve a stable per-device UUID.
const TV_DEVICE_ID = (() => {
  const KEY = 'tv_device_id';
  let id = localStorage.getItem(KEY);
  if (!id) {
    // crypto.randomUUID() is available on all modern browsers incl. Silk/FireOS
    id = (typeof crypto !== 'undefined' && crypto.randomUUID)
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    try { localStorage.setItem(KEY, id); } catch { }
  }
  return id;
})();
tvDiag = (() => {
  const MAX = 60;
  const _buf = [];

  // Beacons are batched: a kiosk runs for weeks, so one request per event
  // turns routine telemetry into the busiest endpoint in the app.
  // High-signal events flush immediately; the rest ride the next flush.
  const FLUSH_MS = 300000;
  const IMMEDIATE_EVENTS = new Set([
    'session_start', 'raf_gap', 'page_freeze', 'pagehide', 'beforeunload',
    'wake_lock_released',
  ]);
  let _pending = [];

  function _elapsed() {
    if (!state.sessionStartAt) return '—';
    return `${Math.floor((Date.now() - state.sessionStartAt) / 60000)}m`;
  }

  function log(event, details = '') {
    const entry = {
      t: new Date().toISOString(),
      ms: Date.now(),
      event,
      details: String(details).slice(0, 200),
      guard: state.sleepGuardEnabled,
      timeout: state.sleepGuardTimeoutMinutes,
      elapsed: _elapsed(),
      vis: document.visibilityState,
    };
    _buf.push(entry);
    if (_buf.length > MAX) _buf.shift();

    // Persist last 20 entries to localStorage (survives backgrounding)
    try { localStorage.setItem('tv_diag', JSON.stringify(_buf.slice(-20))); } catch { }

    // Silk console — visible in remote developer tools
    console.log(`[TVDiag] ${entry.event} | ${entry.details} | elapsed=${entry.elapsed} vis=${entry.vis}`);

    // On-screen footer line
    _renderDiagLine(entry);

    // Beacon to server (fire-and-forget, keepalive survives page unload)
    _beacon(entry);
  }

  function _renderDiagLine(entry) {
    const el = dom.diagLine;
    if (!el) return;
    const ts = new Date(entry.ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = `[${ts}] ${entry.event}${entry.details ? ' \u00b7 ' + entry.details : ''}`;
  }

  function _beacon(entry) {
    _pending.push({
      event: entry.event,
      details: entry.details,
      ts: entry.t,
      sessionElapsedMin: state.sessionStartAt ? Math.floor((Date.now() - state.sessionStartAt) / 60000) : null,
      visibilityState: entry.vis,
      guardEnabled: entry.guard,
      guardTimeout: entry.timeout,
      device_id: TV_DEVICE_ID,
    });
    if (_pending.length >= 50 || IMMEDIATE_EVENTS.has(entry.event)) flush();
  }

  function flush() {
    if (!_pending.length) return;
    const token = state.token || (IS_KIOSK ? window.KIOSK_TOKEN : null);
    if (!token) return;
    const entries = _pending;
    _pending = [];
    fetch('/tv/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ entries }),
      keepalive: true,   // delivers even when page is unloading
    }).catch(() => { });  // never block on diagnostics
  }

  setInterval(flush, FLUSH_MS);
  window.addEventListener('pagehide', flush);

  function getLog() { return [..._buf]; }

  return { log, getLog, flush };
})();

// Wire the RAF frame-gap callback now that tvDiag is ready
antiSleep.setRafGapCb((deltaMs) => {
  tvDiag.log('raf_gap', `${Math.round(deltaMs / 1000)}s gap \u2014 OS may be throttling renderer`);
  if (deltaMs >= POLL_MS && state.token && document.visibilityState === 'visible') {
    refreshEvents();
  }
});

// ─────────────────────────────────────────────────────────────────────────────

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
    pairAutoBtn: document.getElementById('pair-auto-btn'),
    pairStatus: document.getElementById('pair-status'),
    pairError: document.getElementById('pair-error'),
    tvMain: document.getElementById('tv-main'),
    dateHeader: document.getElementById('tv-date-header'),
    clock: document.getElementById('tv-clock'),
    statusEl: document.getElementById('tv-status'),
    lastUpdated: document.getElementById('tv-last-updated'),
    disconnectBtn: document.getElementById('disconnect-btn'),
    headerRight: document.querySelector('.tv-header-right'),
    headerUserEmail: document.getElementById('tv-user-email'),
    headerBackBtn: document.getElementById('tv-header-back-btn'),
    headerExitBtn: document.getElementById('tv-header-exit-btn'),
    cursor: document.getElementById('tv-virtual-cursor'),
    debugOverlay: document.getElementById('tv-debug-overlay'),
    debugList: document.getElementById('tv-debug-list'),
    accountLegend: document.getElementById('tv-account-legend'),
    sleepStatus: document.getElementById('tv-sleep-status'),
    diagLine: document.getElementById('tv-diag-line'),
    remoteActionEcho: document.getElementById('tv-remote-action-echo'),
  };
}

function isNavMode() { return state.inputMode === 'nav'; }
function isCursorMode() { return state.inputMode === 'cursor'; }
function isLockedMode() { return state.inputMode === 'locked'; }

function persistInputMode() {
  try { localStorage.setItem(INPUT_MODE_STORAGE_KEY, state.inputMode); } catch { }
}

function hydrateInputMode() {
  let stored = null;
  try { stored = localStorage.getItem(INPUT_MODE_STORAGE_KEY); } catch { }
  if (stored === 'nav' || stored === 'cursor' || stored === 'locked') {
    state.inputMode = stored;
  }
}

function persistRemoteCapabilities() {
  try {
    localStorage.setItem(REMOTE_CAPABILITIES_STORAGE_KEY, JSON.stringify(state.remoteCapabilities));
  } catch { }
}

function hydrateRemoteCapabilities() {
  try {
    const raw = localStorage.getItem(REMOTE_CAPABILITIES_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    state.remoteCapabilities = {
      ...createDefaultRemoteCapabilities(),
      arrows: Boolean(parsed.arrows),
      select: Boolean(parsed.select),
      back: Boolean(parsed.back),
      list: Boolean(parsed.list),
      volume: Boolean(parsed.volume),
      media: Boolean(parsed.media),
      channel: Boolean(parsed.channel),
      mute: Boolean(parsed.mute),
    };
  } catch { }
}

function markRemoteCapability(normalizedKey, e) {
  if (!normalizedKey) return;
  let changed = false;
  const caps = state.remoteCapabilities;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(normalizedKey) && !caps.arrows) {
    caps.arrows = true;
    changed = true;
  }
  if (normalizedKey === 'Enter' && !caps.select) {
    caps.select = true;
    changed = true;
  }
  if (isBackKey(normalizedKey) && !caps.back) {
    caps.back = true;
    changed = true;
  }
  if (isListKey(normalizedKey) && !caps.list) {
    caps.list = true;
    changed = true;
  }
  if (isVolumeForwardKey(normalizedKey) || isVolumeReverseKey(normalizedKey)) {
    if (!caps.volume) {
      caps.volume = true;
      changed = true;
    }
  }
  if (normalizedKey === 'MediaFastForward' || normalizedKey === 'MediaRewind') {
    if (!caps.media) {
      caps.media = true;
      changed = true;
    }
  }
  if (normalizedKey === 'ChannelUp' || normalizedKey === 'ChannelDown') {
    if (!caps.channel) {
      caps.channel = true;
      changed = true;
    }
  }
  if (isMuteKey(e, normalizedKey) && !caps.mute) {
    caps.mute = true;
    changed = true;
  }
  if (changed) persistRemoteCapabilities();
}

function showRemoteAction(message) {
  if (!message || !dom.remoteActionEcho) return;
  dom.remoteActionEcho.textContent = message;
  dom.remoteActionEcho.classList.add('visible');
  if (state.remoteActionTimer) clearTimeout(state.remoteActionTimer);
  state.remoteActionTimer = setTimeout(() => {
    if (dom.remoteActionEcho) dom.remoteActionEcho.classList.remove('visible');
    state.remoteActionTimer = null;
  }, REMOTE_ACTION_ECHO_MS);
}

function buildDynamicRemoteHelpText() {
  if (isLockedMode()) {
    return 'Mode locked • Triple SELECT unlock • Settings to change mode';
  }
  const caps = state.remoteCapabilities;
  const hints = [];
  if (caps.arrows) hints.push('Arrows navigate');
  if (caps.select) {
    hints.push('SELECT open');
    hints.push('Long SELECT create');
    hints.push('Triple SELECT mode');
  }
  if (caps.back) hints.push('BACK close');
  if (caps.list) hints.push('MENU sticky');
  if (caps.volume) hints.push('+/- hold zoom');
  else if (caps.media) hints.push('FF/REW hold zoom');
  else if (caps.channel) hints.push('CH+/- hold zoom');
  else hints.push('Zoom from Settings');
  return hints.length ? hints.join(' • ') : 'Press remote keys to detect available controls';
}

function setInputMode(nextMode, options = {}) {
  const normalized = (nextMode === 'cursor' || nextMode === 'locked') ? nextMode : 'nav';
  if (state.inputMode === normalized && !options.force) return;
  state.inputMode = normalized;
  setCursorVisible(normalized === 'cursor');
  persistInputMode();
  if (tvDiag) tvDiag.log('input_mode_set', normalized);
  showRemoteAction(`Mode ${normalized.toUpperCase()}`);
  if (options.announce !== false) renderFooterHint(`Mode ${normalized.toUpperCase()}`);
  render();
}

function normalizeAppVersion(value) {
  const text = String(value || '').trim();
  return text || '';
}

function scheduleUpdateReload(nextVersion) {
  const serverVersion = normalizeAppVersion(nextVersion);
  const localVersion = normalizeAppVersion(state.clientAppVersion);
  if (!serverVersion || serverVersion === localVersion) return;

  state.serverAppVersion = serverVersion;
  if (state.updatePending) return;

  state.updatePending = true;
  const seconds = Math.ceil(UPDATE_RELOAD_DELAY_MS / 1000);
  renderFooterHint(`Update available (${serverVersion.slice(0, 12)}). Reloading in ${seconds}s`);
  showRemoteAction('Update Reload');
  if (tvDiag) tvDiag.log('app_update_detected', `${localVersion} -> ${serverVersion}`);

  if (state.updateReloadTimer) clearTimeout(state.updateReloadTimer);
  state.updateReloadTimer = setTimeout(() => {
    window.location.reload();
  }, UPDATE_RELOAD_DELAY_MS);
}

function processServerVersionSignal(res, data = null) {
  const headerVersion = normalizeAppVersion(res && res.headers ? res.headers.get('X-TV-App-Version') : '');
  const bodyVersion = normalizeAppVersion(data && data.appVersion ? data.appVersion : '');
  const signal = headerVersion || bodyVersion;
  if (!signal) return;
  state.serverAppVersion = signal;
  scheduleUpdateReload(signal);
}

function toggleCursorMode() {
  const nextMode = isCursorMode() ? 'nav' : 'cursor';
  setInputMode(nextMode);
}

function toggleLockMode() {
  if (isLockedMode()) setInputMode('nav');
  else setInputMode('locked');
}

function ensureStyles() {
  if (document.getElementById('tv-remote-style')) return;
  const style = document.createElement('style');
  style.id = 'tv-remote-style';
  style.textContent = `
  .tv-main {
    --tv-accent: #1a73e8;
    --tv-accent-strong: #2563eb;
    --tv-text: rgba(233, 240, 250, 0.95);
    --tv-text-soft: rgba(168, 185, 208, 0.92);
    --tv-panel: rgba(21, 31, 48, 0.66);
    --tv-panel-soft: rgba(29, 43, 66, 0.42);
  }
  .tv-shell { display: grid; width: 100%; height: 100%; grid-template-columns: minmax(120px, 150px) minmax(0, 1fr) minmax(260px, 320px); gap: 10px; }
  .tv-shell.month { grid-template-columns: minmax(120px, 150px) minmax(0, 1fr); }
  .tv-shell.month.has-popout { grid-template-columns: minmax(120px, 150px) minmax(0, 1fr) minmax(320px, 0.86fr); align-items: start; }
  .tv-header-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; width: 260px; }
  .tv-main { padding: 14px 52px 14px; gap: 14px; }
  .tv-user-email { font-size: 11px; line-height: 1.1; color: var(--tv-text-soft); font-weight: 600; letter-spacing: 0.2px; max-width: 360px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: auto; }
  .tv-header-actions { display: inline-flex; gap: 5px; }
  .tv-header-btn { border: 1px solid rgba(201,219,244,0.26); border-radius: 8px; padding: 4px 10px; font-size: 12px; color: var(--tv-text); background: var(--tv-panel-soft); }
  .tv-header-btn.warn { border-color: rgba(255,159,10,0.45); color: #ffd9a0; background: rgba(255,159,10,0.14); }
  .tv-sidebar-actions { display: flex; flex-direction: column; gap: 8px; margin-top: 2px; }
  .tv-side-btn { width: 100%; min-height: 32px; border: 1px solid rgba(201,219,244,0.16); border-radius: 10px; padding: 7px 10px; font-size: 12px; color: var(--tv-text); background: rgba(17,28,44,0.34); text-align: left; transition: transform 120ms ease, border-color 180ms ease, background 180ms ease, box-shadow 180ms ease, opacity 180ms ease; }
  .tv-side-btn:hover { border-color: rgba(255,255,255,0.24); }
  .tv-side-btn.focused { border-color: var(--tv-accent); background: rgba(26,115,232,0.22); box-shadow: 0 0 0 2px rgba(26,115,232,0.24); transform: translateY(-1px); }
  .tv-side-btn:disabled { opacity: 0.45; cursor: not-allowed; }
  .tv-side-btn.primary { background: rgba(26,115,232,0.16); border-color: rgba(26,115,232,0.44); }
  .tv-side-btn.warn { border-color: rgba(255,159,10,0.45); color: #ffd9a0; background: rgba(255,159,10,0.14); }
  .tv-history-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .tv-sidebar-divider { height: 1px; background: rgba(255,255,255,0.06); margin: 2px 0; }
  .tv-sidebar-footer { display: flex; flex-direction: column; gap: 8px; }
  .tv-main.tv-editor-active { background: rgba(228, 232, 239, 0.08); border: 1px solid rgba(198, 206, 220, 0.22); border-radius: 12px; box-shadow: inset 0 0 0 1px rgba(236, 241, 250, 0.12); }
  .tv-account-legend { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-height: 30px; max-height: 64px; overflow-y: auto; padding: 4px 52px 4px; border-bottom: 1px solid rgba(255,255,255,0.06); background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01)); }
  .tv-account-spacer { flex: 1 1 auto; min-width: 16px; }
  .tv-account-chip { display: inline-flex; align-items: center; gap: 8px; padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(201,219,244,0.22); background: var(--tv-panel-soft); font-size: 11px; color: var(--tv-text-soft); letter-spacing: 0.3px; backdrop-filter: blur(2px); transition: transform 120ms ease, border-color 180ms ease, background 180ms ease, opacity 180ms ease; }
  .tv-account-chip.active { color: var(--tv-text); border-color: rgba(201,219,244,0.38); }
  .tv-account-chip.inactive { opacity: 0.42; filter: grayscale(0.8); }
  .tv-account-chip.user-email-chip { margin-left: auto; border-style: dashed; background: rgba(255,255,255,0.03); color: rgba(168, 185, 208, 0.92); border-color: rgba(201,219,244,0.2); }
  .tv-account-chip:hover { transform: translateY(-1px); border-color: rgba(201,219,244,0.35); }
  .tv-account-legend.syncing .tv-account-chip { animation: tv-sync-chip-pulse 1.1s ease-in-out infinite; }
  .tv-account-legend.syncing .tv-account-chip { border-color: rgba(26,115,232,0.46); box-shadow: 0 0 0 1px rgba(26,115,232,0.12), 0 0 14px rgba(26,115,232,0.14); }
  @keyframes tv-sync-chip-pulse { 0% { opacity: 0.62; transform: translateY(0); } 50% { opacity: 1; transform: translateY(-1px); } 100% { opacity: 0.62; transform: translateY(0); } }
  .tv-account-dot { width: 8px; height: 8px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.45); flex-shrink: 0; }
  .tv-main-grid { min-width: 0; display: grid; gap: 8px; }
  .tv-main-grid.day { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tv-main-grid.week { grid-template-columns: repeat(7, minmax(0, 1fr)); }
  .tv-main-grid.month { grid-template-columns: repeat(7, minmax(0, 1fr)); grid-template-rows: repeat(6, minmax(108px, 1fr)); }
  .tv-main-center { min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .tv-controls { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin: 0 0 3px 0; padding: 1px 0 2px; border-bottom: 1px solid rgba(255,255,255,0.06); }
  .tv-controls-group { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .tv-btn { border: 1px solid rgba(201,219,244,0.24); border-radius: 9px; padding: 7px 10px; font-size: 12px; color: var(--tv-text); background: var(--tv-panel-soft); min-height: 32px; transition: transform 120ms ease, border-color 200ms ease, background 200ms ease, box-shadow 200ms ease; }
  .tv-btn:hover { border-color: rgba(255,255,255,0.28); background: rgba(255,255,255,0.065); }
  .tv-btn.primary { border-color: rgba(26,115,232,0.58); color: #e8f1ff; background: rgba(26,115,232,0.24); }
  .tv-btn.warn { border-color: rgba(255,159,10,0.45); color: #ffd9a0; background: rgba(255,159,10,0.14); }
  .tv-btn.ghost { opacity: 0.86; }
  .tv-btn.view { padding: 6px 9px; font-size: 11px; letter-spacing: 0.5px; text-transform: uppercase; }
  .tv-btn.view.active { border-color: rgba(26,115,232,0.68); color: #e8f1ff; background: rgba(26,115,232,0.28); box-shadow: 0 0 0 2px rgba(26,115,232,0.2); }
  .tv-btn.active { border-color: rgba(26,115,232,0.6); color: #e8f1ff; background: rgba(26,115,232,0.2); }
  .tv-weekdays { display: grid; grid-template-columns: repeat(7, 1fr); gap: 10px; margin: 0 0 8px 0; }
  .tv-weekday-chip { border: 1px solid rgba(255,255,255,0.08); border-radius: 8px; text-align: center; padding: 6px 4px; font-size: 11px; letter-spacing: 1.1px; text-transform: uppercase; opacity: 0.85; }
  .tv-sidebar { border: 1px solid rgba(201,219,244,0.18); border-radius: 14px; padding: 10px; display: flex; flex-direction: column; gap: 8px; background: linear-gradient(180deg, rgba(45,63,92,0.45), rgba(29,43,66,0.32)); overflow: hidden; }
  .tv-sidebar-title { font-size: 10px; letter-spacing: 1.2px; text-transform: uppercase; opacity: 0.7; margin-bottom: 2px; }
  .tv-sidebar-date { font-size: 13px; font-weight: 700; margin-bottom: 6px; color: var(--tv-text); }
  .tv-side-item { border: 1px solid rgba(201,219,244,0.16); border-radius: 10px; padding: 8px 9px; font-size: 12px; color: var(--tv-text-soft); background: rgba(17,28,44,0.34); transition: transform 120ms ease, border-color 180ms ease, background 180ms ease, box-shadow 180ms ease; }
  .tv-side-item.focused { border-color: var(--tv-accent); box-shadow: 0 0 0 2px rgba(26,115,232,0.26); transform: translateY(-1px) scale(1.015); background: rgba(26,115,232,0.15); color: var(--tv-text); }
  .tv-side-item:hover { border-color: rgba(255,255,255,0.24); }
  .tv-right-rail { border: 1px solid rgba(201,219,244,0.18); border-radius: 14px; padding: 10px; background: linear-gradient(180deg, rgba(45,63,92,0.44), rgba(29,43,66,0.32)); overflow: hidden; }
  .tv-right-rail.month-popout { align-self: start; min-height: 74vh; max-height: 74vh; }
  .tv-right-title { font-size: 14px; font-weight: 700; margin: 0 0 8px 0; }
  .tv-right-subtitle { font-size: 11px; opacity: 0.78; margin: 12px 0 6px 0; font-weight: 700; letter-spacing: 0.9px; text-transform: uppercase; }
  .tv-right-list { display: flex; flex-direction: column; gap: 6px; max-height: 37vh; overflow-y: auto; }
  .tv-right-item { position: relative; border: 1px solid rgba(220,234,255,0.34); border-radius: 8px; padding: 6px 8px; background: rgba(20,35,54,0.82); transition: transform 120ms ease, border-color 180ms ease; }
  .tv-right-item:hover { transform: translateY(-1px); border-color: rgba(201,219,244,0.3); }
  .tv-right-item-title { font-size: 12px; font-weight: 700; color: rgba(236, 244, 255, 0.98); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-right-item-time { font-size: 11px; color: rgba(212, 226, 244, 0.96); opacity: 1; }
  .tv-right-rail.editor-cover { display: flex; flex-direction: column; }
  .tv-right-rail.editor-cover .tv-right-editor-anchor { margin-top: 6px; flex: 1; overflow-y: auto; }
  .tv-day-card, .tv-month-cell { border: 1px solid rgba(201,219,244,0.16); border-radius: 12px; background: rgba(13,24,38,0.44); padding: 10px; min-height: 0; display: flex; flex-direction: column; transition: transform 120ms ease, border-color 180ms ease, box-shadow 180ms ease, background 180ms ease; }
  .tv-day-card.selected { border-color: rgba(26,115,232,0.52); box-shadow: 0 0 0 2px rgba(26,115,232,0.16); }
  .tv-day-head { font-size: 11px; letter-spacing: 1.5px; opacity: 0.75; text-transform: uppercase; margin-bottom: 8px; }
  .tv-day-num { font-size: 26px; font-weight: 700; line-height: 1; margin-bottom: 8px; }
  .tv-item-list { display: flex; flex-direction: column; gap: 8px; overflow: hidden; }
  .tv-main.tv-view-three-day .tv-day-card { min-height: 0; }
  .tv-main.tv-view-three-day .tv-item-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-content: start; overflow-y: auto; }
  .tv-main.tv-view-three-day .tv-day-card.selected .tv-item-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tv-main.tv-view-three-day .tv-day-card.context-day .tv-item-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  /* Lock day-view card column density across all TV widths. */
  @media (max-width: 9999px) {
    .tv-main.tv-view-three-day .tv-day-card.selected .tv-item-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .tv-main.tv-view-three-day .tv-day-card.context-day .tv-item-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  .tv-main.tv-view-three-day .tv-day-card.context-day { opacity: 0.84; background: rgba(11, 20, 33, 0.34); }
  .tv-main.tv-view-three-day .tv-day-card.context-day .tv-day-num { opacity: 0.85; }
  .tv-main.tv-view-three-day .tv-day-card.context-day .tv-item { opacity: 0.74; }
  .tv-main.tv-view-three-day .tv-day-card.context-day .tv-item-title { font-size: 14px; font-weight: 500; color: rgba(198, 213, 232, 0.9); }
  .tv-main.tv-view-three-day .tv-day-card.context-day .tv-item-sub { font-size: 11px; color: rgba(168, 184, 206, 0.82); }
  .tv-main.tv-view-day .tv-single-day-pane { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .tv-main.tv-view-day .tv-single-day-summary { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; padding: 10px 12px; border: 1px solid rgba(201,219,244,0.16); border-radius: 12px; background: rgba(13,24,38,0.44); }
  .tv-main.tv-view-day .tv-single-day-title { font-size: 18px; font-weight: 800; letter-spacing: 0.4px; text-transform: uppercase; }
  .tv-main.tv-view-day .tv-single-day-subtitle { font-size: 12px; color: var(--tv-text-soft); margin-top: 2px; }
  .tv-main.tv-view-day .tv-single-day-pills { display: flex; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .tv-main.tv-view-day .tv-single-day-grid { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr); gap: 8px; align-items: start; }
  .tv-main.tv-view-day .tv-day-section { border: 1px solid rgba(201,219,244,0.16); border-radius: 12px; background: rgba(13,24,38,0.44); padding: 10px; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .tv-main.tv-view-day .tv-day-section-wide { grid-column: 1 / -1; }
  .tv-main.tv-view-day .tv-day-section-head { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }
  .tv-main.tv-view-day .tv-day-section-title { font-size: 13px; font-weight: 800; letter-spacing: 1px; text-transform: uppercase; }
  .tv-main.tv-view-day .tv-day-section-meta { font-size: 11px; color: var(--tv-text-soft); text-align: right; }
  .tv-main.tv-view-day .tv-day-section-toggle { border: 1px solid rgba(201,219,244,0.22); border-radius: 7px; padding: 3px 8px; font-size: 10px; letter-spacing: 0.6px; text-transform: uppercase; color: var(--tv-text-soft); background: rgba(17,28,44,0.34); cursor: pointer; }
  .tv-main.tv-view-day .tv-day-section-toggle:hover { border-color: rgba(255,255,255,0.32); color: var(--tv-text); }
  .tv-main.tv-view-day .tv-day-section-body { display: flex; flex-direction: column; gap: 8px; }
  .tv-main.tv-view-day .tv-day-section.collapsed .tv-day-section-body { display: none; }
  .tv-main.tv-view-day .tv-day-subsection { margin-top: 2px; padding-top: 8px; background: rgba(17,28,44,0.28); border-color: rgba(201,219,244,0.12); }
  .tv-main.tv-view-day .tv-day-subsection .tv-day-section-list { max-height: 11vh; }
  .tv-main.tv-view-day .tv-day-timed-grid { display: grid; grid-template-columns: repeat(var(--timed-columns, 1), minmax(0, 1fr)); gap: 8px; align-items: start; }
  .tv-main.tv-view-day .tv-day-timed-grid > .tv-day-event-card { min-width: 0; height: 100%; }
  .tv-main.tv-view-day .tv-day-timed-grid > .tv-empty { grid-column: 1 / -1; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense { gap: 6px; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense > .tv-day-event-card { padding: 6px 8px; border-radius: 9px; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense > .tv-day-event-card .tv-item-title { font-size: 14px; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense > .tv-day-event-card .tv-item-sub { font-size: 11px; margin-top: 1px; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense-4 { gap: 5px; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense-4 > .tv-day-event-card { padding: 5px 7px; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense-4 > .tv-day-event-card .tv-item-title { font-size: 13px; }
  .tv-main.tv-view-day .tv-day-timed-grid.dense-4 > .tv-day-event-card .tv-item-sub:nth-of-type(3) { display: none; }
  .tv-main.tv-view-day .tv-day-section-list { display: flex; flex-direction: column; gap: 8px; max-height: 26vh; overflow-y: auto; }
  .tv-main.tv-view-day .tv-day-event-card { position: relative; border: 1px solid rgba(201,219,244,0.16); border-radius: 10px; padding: 8px 10px 8px 10px; background: rgba(12,22,35,0.46); }
  .tv-main.tv-view-day .tv-day-event-card .tv-item-title { font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-main.tv-view-day .tv-day-event-card .tv-item-sub { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-main.tv-view-day .tv-day-event-card.free { background: rgba(17,28,44,0.32); }
  .tv-main.tv-view-day .tv-day-event-card.sticky { background: rgba(255,226,106,0.14); }
  .tv-item { position: relative; border: 1px solid rgba(201,219,244,0.14); border-radius: 10px; padding: 8px; background: rgba(12,22,35,0.46); transition: transform 120ms ease, border-color 180ms ease, box-shadow 180ms ease; }
  .tv-item.focused { border-color: var(--tv-accent); box-shadow: 0 0 0 2px rgba(26,115,232,0.24); transform: translateY(-1px); }
  .tv-item:hover { border-color: rgba(255,255,255,0.24); }
  .tv-item.now { background: rgba(26,115,232,0.18); }
  .tv-item.next { background: rgba(255,159,10,0.11); }
  .tv-item-title { font-size: 16px; font-weight: 600; color: var(--tv-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-item-sub { font-size: 12px; color: var(--tv-text-soft); opacity: 0.95; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tv-month-cell { justify-content: flex-start; }
  .tv-month-cell.outside { opacity: 0.52; background: rgba(255,255,255,0.015); }
  .tv-month-cell.selected { border-color: rgba(26,115,232,0.52); }
  .tv-month-cell.focused { border-color: var(--tv-accent); box-shadow: 0 0 0 2px rgba(26,115,232,0.24); transform: translateY(-1px) scale(1.01); }
  .tv-month-cell:hover { border-color: rgba(255,255,255,0.24); }
  .tv-month-cell, .tv-day-card { position: relative; min-width: 0; overflow: hidden; }
  .tv-sticky-indicator { position: absolute; top: 4px; right: 4px; z-index: 4; width: 16px; height: 16px; border-radius: 3px; border: 1px solid rgba(255,255,255,0.28); background: rgba(255,255,255,0.12) center/contain no-repeat url('/static/icons/sticky-note-mini.svg'); box-shadow: 0 1px 5px rgba(0,0,0,0.35); display: inline-flex; align-items: center; justify-content: center; }
  .tv-sticky-indicator::before,
  .tv-sticky-indicator::after { content: none; }
  .tv-inline-sticky-badge { position: static; width: 16px; height: 16px; border-radius: 3px; margin-left: 6px; vertical-align: middle; }
  .tv-inline-sticky-badge::before { content: none; }
  .tv-month-sticky-indicator { top: 6px; right: 6px; width: 18px; height: 18px; border-radius: 4px; font-size: 9px; font-weight: 800; color: rgba(48,34,0,0.95); }
  .tv-month-sticky-indicator::before,
  .tv-month-sticky-indicator::after { content: none; }
  .tv-month-date { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
  .tv-month-count { font-size: 10px; opacity: 0.68; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.8px; }
  .tv-month-preview-list { display: flex; flex-direction: column; gap: 3px; margin-top: 2px; }
  .tv-month-preview { position: relative; border: 1px solid rgba(201,219,244,0.22); border-radius: 7px; padding: 2px 5px; font-size: 10px; opacity: 0.96; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2; }
  .tv-month-preview-time { opacity: 0.92; margin-right: 4px; font-weight: 700; }
  .tv-month-preview-title { opacity: 0.96; }
  .tv-inline-sticky { display: inline-flex; align-items: center; justify-content: center; width: 13px; height: 13px; border-radius: 2px; margin-left: 4px; border: 1px solid rgba(255,255,255,0.24); background: rgba(255,255,255,0.12) center/contain no-repeat url('/static/icons/sticky-note-mini.svg'); color: transparent; font-size: 0; }
  .tv-editor { margin-top: 10px; border: 1px solid rgba(79,140,255,0.35); border-radius: 10px; padding: 10px; background: rgba(79,140,255,0.08); }
  .tv-editor-title { font-size: 12px; text-transform: uppercase; letter-spacing: 1.3px; opacity: 0.8; margin-bottom: 8px; }
  .tv-field { border: 1px solid rgba(255,255,255,0.09); border-radius: 8px; padding: 6px 8px; margin-bottom: 6px; }
  .tv-field.focused { border-color: var(--tv-accent); background: rgba(26,115,232,0.2); }
  .tv-field-name { font-size: 10px; opacity: 0.7; text-transform: uppercase; }
  .tv-field-value { font-size: 15px; font-weight: 600; margin-top: 2px; }
  .tv-empty { opacity: 0.65; font-style: italic; font-size: 13px; }
  .tv-hint-chip { font-size: 11px; opacity: 0.8; }
  .tv-sync-ok { color: rgba(130, 191, 148, 0.88); }
  .tv-sync-fail { color: rgba(197, 120, 120, 0.88); }
  .tv-last-updated.tv-sync-ok,
  .tv-last-updated.tv-sync-fail {
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-weight: 700;
    letter-spacing: 0.3px;
    background: rgba(255,255,255,0.04);
  }
  .tv-last-updated.tv-sync-ok { border-color: rgba(130, 191, 148, 0.28); background: rgba(130, 191, 148, 0.12); }
  .tv-last-updated.tv-sync-fail { border-color: rgba(197, 120, 120, 0.28); background: rgba(197, 120, 120, 0.12); }
  .tv-last-updated.syncing {
    color: rgba(154, 196, 255, 0.96);
    padding: 2px 8px;
    border-radius: 999px;
    border: 1px solid rgba(85, 150, 255, 0.46);
    background: rgba(85, 150, 255, 0.14);
    font-weight: 700;
    letter-spacing: 0.3px;
    animation: tv-sync-working-pulse 0.9s ease-in-out infinite;
  }
  @keyframes tv-sync-working-pulse {
    0% { opacity: 0.64; }
    50% { opacity: 1; }
    100% { opacity: 0.64; }
  }
  .tv-status-chip { font-size: 11px; letter-spacing: 0.35px; text-transform: uppercase; color: rgba(218, 230, 244, 0.84); }
  .tv-status-chip.subtle { color: rgba(168, 185, 208, 0.74); }
  .tv-status-sep { color: rgba(168, 185, 208, 0.62); margin: 0 4px; }
  #tv-remote-action-echo { position: fixed; left: 50%; bottom: 8.5vh; transform: translateX(-50%); z-index: 7500; pointer-events: none; font-size: 12px; letter-spacing: 0.45px; text-transform: uppercase; color: rgba(206, 222, 240, 0.82); background: rgba(0, 0, 0, 0.34); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 999px; padding: 4px 11px; opacity: 0; transition: opacity 170ms ease; }
  #tv-remote-action-echo.visible { opacity: 1; }
  #tv-virtual-cursor { position: fixed; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #4f8cff; box-shadow: 0 0 0 2px rgba(79,140,255,0.18); background: rgba(79,140,255,0.2); pointer-events: none; z-index: 999999; transform: translate(-50%, -50%); display: none; }
  #tv-debug-overlay { position: fixed; right: 12px; bottom: 52px; width: 420px; max-height: 50vh; overflow: hidden; background: rgba(9,12,20,0.92); border: 1px solid rgba(79,140,255,0.35); border-radius: 10px; box-shadow: 0 12px 26px rgba(0,0,0,0.45); z-index: 999998; color: #d7e6ff; display: none; }
  #tv-debug-overlay.visible { display: block; }
  .tv-debug-head { padding: 8px 10px; border-bottom: 1px solid rgba(79,140,255,0.22); font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: #8eb7ff; display: flex; justify-content: space-between; }
  #tv-debug-list { list-style: none; margin: 0; padding: 8px 10px; max-height: 40vh; overflow-y: auto; font-family: Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; }
  .tv-debug-row { white-space: pre-wrap; word-break: break-word; border-bottom: 1px dashed rgba(255,255,255,0.08); padding: 2px 0; }
  .tv-debug-row:last-child { border-bottom: 0; }

  /* Broadcast typography scaling by view */
  .tv-main.tv-view-three-day .tv-day-num { font-size: 32px; }
  .tv-main.tv-view-three-day .tv-item-title { font-size: 18px; font-weight: 700; letter-spacing: 0.18px; }
  .tv-main.tv-view-three-day .tv-item-sub { font-size: 12px; }

  .tv-main.tv-view-day .tv-item-title { font-size: 15px; font-weight: 700; letter-spacing: 0.18px; }
  .tv-main.tv-view-day .tv-item-sub { font-size: 12px; }

  .tv-main.tv-view-week .tv-day-num { font-size: 27px; }
  .tv-main.tv-view-week .tv-item-title { font-size: 15px; }
  .tv-main.tv-view-week .tv-item-sub { font-size: 11px; }

  .tv-main.tv-view-month .tv-month-date { font-size: 20px; }
  .tv-main.tv-view-month .tv-month-count { font-size: 10px; }
  .tv-main.tv-view-month .tv-month-preview { font-size: 10px; }

  @media (prefers-reduced-motion: reduce) {
    .tv-account-chip,
    .tv-btn,
    .tv-side-item,
    .tv-right-item,
    .tv-day-card,
    .tv-month-cell,
    .tv-item {
      transition: none;
    }
  }
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

  if (!document.getElementById('tv-remote-action-echo')) {
    const echo = document.createElement('div');
    echo.id = 'tv-remote-action-echo';
    document.body.appendChild(echo);
  }

  dom.cursor = document.getElementById('tv-virtual-cursor');
  dom.debugOverlay = document.getElementById('tv-debug-overlay');
  dom.debugList = document.getElementById('tv-debug-list');
  dom.remoteActionEcho = document.getElementById('tv-remote-action-echo');

  ensureLegendRow();
  ensureHeaderActions();
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

function ensureHeaderActions() {
  if (!dom.headerRight) return;
  const email = document.getElementById('tv-user-email');
  if (email && email.parentElement) email.parentElement.removeChild(email);
  dom.headerUserEmail = null;
  let actions = document.getElementById('tv-header-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.id = 'tv-header-actions';
    actions.className = 'tv-header-actions';
    actions.innerHTML = `
      <button id="tv-header-back-btn" class="tv-header-btn" type="button">Back</button>
      <button id="tv-header-exit-btn" class="tv-header-btn warn" type="button">Exit</button>
    `;
    if (dom.disconnectBtn && dom.disconnectBtn.parentElement === dom.headerRight) {
      dom.headerRight.insertBefore(actions, dom.disconnectBtn);
    } else {
      dom.headerRight.appendChild(actions);
    }
  }
  dom.headerBackBtn = document.getElementById('tv-header-back-btn');
  dom.headerExitBtn = document.getElementById('tv-header-exit-btn');
  if (dom.disconnectBtn) {
    dom.disconnectBtn.classList.remove('tv-unpair-btn');
    dom.disconnectBtn.classList.add('tv-header-btn', 'warn');
    if (actions && dom.disconnectBtn.parentElement !== actions) {
      actions.prepend(dom.disconnectBtn);
    }
  }
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

async function init() {
  cacheDom();
  ensureStyles();
  hydrateInputMode();
  hydrateRemoteCapabilities();
  setCursorVisible(state.inputMode === 'cursor');
  initZoomEngine();

  if (dom.pairBtn) dom.pairBtn.addEventListener('click', handlePair);
  if (dom.pairAutoBtn) dom.pairAutoBtn.addEventListener('click', async () => {
    if (dom.pairAutoBtn.disabled) return;
    dom.pairAutoBtn.disabled = true;
    setPairStatus('Trying the secure same-network shortcut…');
    const paired = await attemptLanAutoPair();
    if (paired) {
      setPairStatus('Secure auto-connect succeeded.');
      transitionTo('dashboard');
      await bootstrapFromBackend();
      return;
    }
    setPairStatus('Auto-connect unavailable here. Enter the code from Admin.');
    dom.pairAutoBtn.disabled = false;
  });
  if (dom.pairInput) {
    dom.pairInput.addEventListener('input', handleCodeInput);
    dom.pairInput.addEventListener('change', handleCodeInput);
    dom.pairInput.addEventListener('blur', handleCodeInput);
    dom.pairInput.addEventListener('keyup', handleCodeInput);
    dom.pairInput.addEventListener('paste', (e) => {
      e.preventDefault();
      const pasted = e.clipboardData?.getData('text') || window.clipboardData?.getData('Text') || '';
      syncPairInputValue(pasted, { sourceEvent: 'paste' });
    });
    dom.pairInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handlePair();
        return;
      }
      window.setTimeout(() => syncPairInputValue(dom.pairInput.value, { sourceEvent: 'keydown' }), 0);
    });
  }
  if (dom.disconnectBtn) dom.disconnectBtn.addEventListener('click', handleLogoutClick);
  if (dom.headerBackBtn) dom.headerBackBtn.addEventListener('click', goBackAction);
  if (dom.headerExitBtn) dom.headerExitBtn.addEventListener('click', exitTvAction);

  if (dom.tvMain) {
    dom.tvMain.addEventListener('click', handleMainClick);
  }
  if (dom.accountLegend) {
    dom.accountLegend.addEventListener('click', onAccountLegendClick);
    dom.accountLegend.addEventListener('mousedown', onAccountLegendPointerDown);
    dom.accountLegend.addEventListener('mouseup', onAccountLegendPointerUp);
    dom.accountLegend.addEventListener('mouseleave', onAccountLegendPointerUp);
    dom.accountLegend.addEventListener('touchstart', onAccountLegendPointerDown, { passive: true });
    dom.accountLegend.addEventListener('touchend', onAccountLegendPointerUp);
    dom.accountLegend.addEventListener('touchcancel', onAccountLegendPointerUp);
  }

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);

  // ── Lifecycle event instrumentation ────────────────────────────────────────
  // All events are logged through tvDiag (ring buffer → localStorage → server)
  // so we can diagnose exactly what FireOS does when the screen goes dark.

  document.addEventListener('visibilitychange', () => {
    const vis = document.visibilityState;
    if (tvDiag) tvDiag.log('visibilitychange', vis);
    if (document.hidden) {
      clearRemoteHoldState();
      return;
    }
    if (!document.hidden) {
      refreshEvents();
      // Re-acquire wake lock — the OS always releases it when the tab hides.
      if (state.token) wakeLock.reacquire();
      if (state.sleepGuardEnabled !== false) {
        antiSleep.start();
        // Browser ALWAYS pauses <video> when the tab goes hidden, killing our
        // Layer-4 media-exempt status. Force a fresh play() immediately.
        antiSleep.restartVideo();
      }
    }
  });

  // window blur / focus — fires when focus shifts (e.g., FireOS overlay opens)
  window.addEventListener('blur', () => {
    clearRemoteHoldState();
    if (tvDiag) tvDiag.log('window_blur', `vis=${document.visibilityState}`);
  });
  window.addEventListener('focus', () => {
    if (tvDiag) tvDiag.log('window_focus', `vis=${document.visibilityState}`);
    if (state.token && document.visibilityState === 'visible') {
      refreshEvents();
      wakeLock.reacquire();
      if (state.sleepGuardEnabled !== false) { antiSleep.start(); antiSleep.restartVideo(); }
    }
  });

  // pagehide / pageshow — fires on navigation and bfcache restore
  window.addEventListener('pagehide', (e) => {
    clearRemoteHoldState();
    if (tvDiag) tvDiag.log('pagehide', `persisted=${e.persisted}`);
  });
  window.addEventListener('pageshow', (e) => {
    if (tvDiag) tvDiag.log('pageshow', `persisted=${e.persisted}`);
    if (state.token && document.visibilityState === 'visible') {
      refreshEvents();
      wakeLock.reacquire();
      if (state.sleepGuardEnabled !== false) { antiSleep.start(); antiSleep.restartVideo(); }
    }
  });

  // Page Lifecycle API (Chromium 68+ / Amazon Silk)
  // 'freeze' fires when the browser decides to freeze the page (CPU saving).
  // This is the last chance to log before the page stops executing.
  document.addEventListener('freeze', () => {
    clearRemoteHoldState();
    if (tvDiag) tvDiag.log('page_freeze', 'browser froze the page');
  });
  document.addEventListener('resume', () => {
    if (tvDiag) tvDiag.log('page_resume', 'page resumed from frozen state');
    if (state.token) { refreshEvents(); wakeLock.reacquire(); if (state.sleepGuardEnabled !== false) { antiSleep.start(); antiSleep.restartVideo(); } }
  });

  window.addEventListener('online', () => {
    if (state.token) refreshEvents();
  });

  // beforeunload — last sync opportunity before page is torn down
  window.addEventListener('beforeunload', () => { if (tvDiag) tvDiag.log('beforeunload', 'page unloading'); });
  // ────────────────────────────────────────────────────────────────────────────

  state.token = window.KIOSK_TOKEN || localStorage.getItem(TOKEN_KEY);
  if (!state.token && !IS_KIOSK) {
    await attemptLanAutoPair();
  }
  state.authStatus = IS_KIOSK ? 'kiosk' : (state.token ? 'paired' : 'unpaired');
  state.lastAuthIssue = '';

  window.addEventListener('storage', (e) => {
    if (e.key !== TOKEN_KEY) return;
    if (IS_KIOSK) return;
    if (!state.token) return;
    if (e.newValue !== null) return;
    if (tvDiag) {
      tvDiag.log('token_storage_removed', 'localStorage token removed in another tab/session');
      tvDiag.flush();
    }
    state.authStatus = 'invalid';
    state.lastAuthIssue = 'storage-cleared';
    handleUnpair('storage_token_removed');
  });

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

async function attemptLanAutoPair() {
  try {
    const res = await fetch('/tv/auto-pair', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res || !res.ok) return false;

    const data = await res.json().catch(() => ({}));
    if (!data?.token) return false;

    state.token = data.token;
    state.authStatus = IS_KIOSK ? 'kiosk' : 'paired';
    state.lastAuthIssue = '';
    localStorage.setItem(TOKEN_KEY, state.token);
    if (tvDiag) tvDiag.log('lan_auto_pair_success', 'TV token bootstrapped from local network context');
    return true;
  } catch {
    return false;
  }
}

function startPolling() {
  stopAll();
  state.sessionStartAt = Date.now();
  state.lastObservedDayKey = toISO(new Date());
  if (!state.selectedDate) state.selectedDate = toISO(new Date());
  render();
  if (tvDiag) tvDiag.log('session_start', `guard=${state.sleepGuardEnabled} timeout=${state.sleepGuardTimeoutMinutes}min`);
  refreshEvents(true);
  state.pollHandle = setInterval(refreshEvents, POLL_MS);
  state.clockHandle = setInterval(tickClock, 1000);
  // Heartbeat confirms the guard is alive between visible events. Every 15 min
  // proves that just as well as every minute at a fraction of the traffic.
  state.heartbeatHandle = setInterval(() => {
    if (tvDiag) tvDiag.log('heartbeat',
      `elapsed=${Math.floor((Date.now() - state.sessionStartAt) / 60000)}m` +
      ` guard=${state.sleepGuardEnabled}` +
      ` timeout=${state.sleepGuardTimeoutMinutes}` +
      ` rafActive=${window.__ANTI_SLEEP_ACTIVE__}` +
      ` wakeLock=${window.__WAKE_LOCK_ACTIVE__}` +
      ` videoActive=${antiSleep.isVideoActive()}`);
  }, 900000);
  tickClock();
  // Layer 1: Screen Wake Lock API
  wakeLock.request();
  // Layers 2+3: rAF canvas loop + synthetic events (main FireOS defense)
  if (state.sleepGuardEnabled !== false) antiSleep.start();
}

function stopAll() {
  if (state.pollHandle) clearInterval(state.pollHandle);
  if (state.clockHandle) clearInterval(state.clockHandle);
  if (state.heartbeatHandle) clearInterval(state.heartbeatHandle);
  state.pollHandle = null;
  state.clockHandle = null;
  state.heartbeatHandle = null;
  clearRemoteHoldState();
  // Release wake lock on clean teardown (unpair / logout).
  wakeLock.release();
  antiSleep.stop();
}

function tickClock() {
  if (dom.clock) {
    dom.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  maybeAutoAdvanceSelectedDate();
  renderSleepStatus();
  enforceSleepTimeout();
}

function maybeAutoAdvanceSelectedDate() {
  if (!state.token) return;

  const todayKey = toISO(new Date());
  if (!state.lastObservedDayKey) {
    state.lastObservedDayKey = todayKey;
    return;
  }

  // Preserve user-selected navigation date during the day.
  // Only reset to the new current day when the local day actually rolls over.
  if (state.lastObservedDayKey === todayKey) return;
  state.lastObservedDayKey = todayKey;

  if (!state.selectedDate || state.dateAutoAdvanceInFlight) return;

  const now = Date.now();
  if ((now - state.lastDateAutoAdvanceAt) < DATE_AUTO_ADVANCE_DEBOUNCE_MS) return;
  if (state.selectedDate === todayKey) return;

  const previousDate = state.selectedDate;
  state.dateAutoAdvanceInFlight = true;
  state.lastDateAutoAdvanceAt = now;
  state.selectedDate = todayKey;
  state.focusedEventId = null;
  state.monthDetailOpen = false;
  render();

  if (tvDiag) tvDiag.log('selected_date_midnight_rollover', `${previousDate} -> ${todayKey}`);

  patchTvState({ selectedDate: todayKey, focusedEventId: null }, { recordHistory: false })
    .finally(() => {
      state.dateAutoAdvanceInFlight = false;
      refreshEvents(true);
    });
}

// Renders the sleep guard counter in the TV footer bottom-right.
function renderSleepStatus() {
  const el = dom.sleepStatus;
  if (!el) return;

  if (state.sleepGuardEnabled === false) {
    el.textContent = '\u25CB sleep guard off';
    return;
  }
  if (!state.sessionStartAt) {
    el.textContent = '';
    return;
  }

  const totalSecs = Math.floor((Date.now() - state.sessionStartAt) / 1000);
  const hours = Math.floor(totalSecs / 3600);
  const mins = Math.floor((totalSecs % 3600) / 60);
  const elapsed = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

  if (state.sleepGuardTimeoutMinutes > 0) {
    const remaining = state.sleepGuardTimeoutMinutes - Math.floor(totalSecs / 60);
    if (remaining <= 0) {
      el.textContent = `\u25CB session ended (${elapsed})`;
    } else {
      el.textContent = `\u25CF ${elapsed} awake \u00B7 ${remaining}m left`;
    }
  } else {
    el.textContent = `\u25CF ${elapsed} awake`;
  }
}

// Stops anti-sleep when the configured session timeout is reached.
function enforceSleepTimeout() {
  if (!state.sleepGuardEnabled || !state.sleepGuardTimeoutMinutes || !state.sessionStartAt) return;
  const elapsedMins = (Date.now() - state.sessionStartAt) / 60000;
  if (elapsedMins >= state.sleepGuardTimeoutMinutes) {
    // Timeout reached — release prevention but keep polling & clock running
    antiSleep.stop();
    wakeLock.release();
  }
}

function handleCodeInput(e) {
  syncPairInputValue(e?.target?.value, { sourceEvent: e?.type || 'input' });
}

function normalizePairingCode(raw) {
  const compact = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  if (compact.length !== 8) return '';
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function syncPairInputValue(rawValue, options = {}) {
  if (!dom.pairInput) return '';
  let v = String(rawValue || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  if (v.length > 4) v = `${v.slice(0, 4)}-${v.slice(4)}`;
  dom.pairInput.value = v;
  if (v.length === 9) {
    const canAutoSubmit = dom.pairBtn && !dom.pairBtn.disabled;
    if (canAutoSubmit && options.sourceEvent !== 'keyup') {
      setPairStatus('Code detected. Connecting…');
      void handlePair();
    }
  } else {
    setPairStatus('');
  }
  return v;
}

function setPairError(message) {
  if (!dom.pairError) return;
  dom.pairError.textContent = message || '';
  dom.pairError.style.display = message ? 'block' : 'none';
}

function setPairStatus(message) {
  if (!dom.pairStatus) return;
  dom.pairStatus.textContent = message || '';
}

function applySyncVisualState() {
  if (dom.accountLegend) {
    dom.accountLegend.classList.toggle('syncing', Boolean(state.syncInProgress));
  }
  if (dom.lastUpdated) {
    dom.lastUpdated.classList.toggle('syncing', Boolean(state.syncInProgress));
  }
}

function setSyncStatus(ok, message) {
  state.syncStatusTone = ok ? 'ok' : 'fail';
  state.syncStatusMessage = message || (ok ? 'Sync Succeed' : 'Sync Failed');
  state.syncStatusUntil = Date.now() + 30000;
  if (state.syncStatusTimer) clearTimeout(state.syncStatusTimer);
  state.syncStatusTimer = setTimeout(() => {
    state.syncStatusTone = null;
    state.syncStatusUntil = 0;
    state.syncStatusMessage = '';
    renderFooterHint();
  }, 30000);
  renderFooterHint();
}

function closeEditor(force = false) {
  if (!state.editor) return;
  if (!force && state.editorDirty) return;
  state.editor = null;
  state.editorDirty = false;
  render();
}

function closeUtilityPanel() {
  state.utilityPanel = null;
  state.adminUsers = [];
}

function openManageAccountsPanel() {
  state.monthDetailOpen = false;
  state.utilityPanel = 'accounts';
  render();
}

function openSettingsPanel() {
  state.monthDetailOpen = false;
  state.utilityPanel = 'settings';
  render();
}

async function openAdminDashboardPanel() {
  state.monthDetailOpen = false;
  state.utilityPanel = 'admin';
  const res = await authFetch('/users');
  if (res && res.ok) {
    state.adminUsers = await res.json().catch(() => []);
  } else {
    state.adminUsers = [];
  }
  render();
}

async function handlePair() {
  if (!dom.pairInput || !dom.pairBtn) return;
  if (dom.pairBtn.disabled) return;
  const code = normalizePairingCode(dom.pairInput.value);
  dom.pairInput.value = code;
  if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    setPairError('Enter a valid pairing code (XXXX-XXXX).');
    return;
  }

  dom.pairBtn.disabled = true;
  if (dom.pairAutoBtn) dom.pairAutoBtn.disabled = true;
  setPairStatus('Connecting securely…');
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
    state.authStatus = IS_KIOSK ? 'kiosk' : 'paired';
    state.lastAuthIssue = '';
    localStorage.setItem(TOKEN_KEY, state.token);
    transitionTo('dashboard');
    await bootstrapFromBackend();
  } catch (err) {
    setPairError(err.message || 'Pairing failed.');
    setPairStatus('');
  } finally {
    dom.pairBtn.disabled = false;
    if (dom.pairAutoBtn) dom.pairAutoBtn.disabled = false;
  }
}

function handleUnpair(reason = 'user_unpair_requested') {
  if (tvDiag && state.token) {
    tvDiag.log(reason, `mode=${IS_KIOSK ? 'kiosk' : 'paired'} vis=${document.visibilityState}`);
    tvDiag.flush();
  }
  stopAll();
  state.token = null;
  if (reason === 'token_invalid_401' || reason === 'storage_token_removed') {
    state.authStatus = 'invalid';
  } else {
    state.authStatus = 'unpaired';
  }
  state.selectedDate = null;
  state.days = [];
  state.dayMap = {};
  state.editor = null;
  state.editorDirty = false;
  state.monthDetailOpen = false;
  state.syncInProgress = false;
  state.autoRefreshBackoffUntil = 0;
  if (state.syncStatusTimer) clearTimeout(state.syncStatusTimer);
  state.syncStatusTimer = null;
  state.syncStatusTone = null;
  state.syncStatusUntil = 0;
  state.serverAccounts = [];
  state.accountLegend = [];
  state.accountColorMap = {};
  state.accountEmailColorMap = {};
  state.selectedAccountKeys = [];
  state.accountChipPressFired = false;
  if (state.accountChipPressTimer) clearTimeout(state.accountChipPressTimer);
  if (state.accountChipClickTimer) clearTimeout(state.accountChipClickTimer);
  state.accountChipPressTimer = null;
  state.accountChipClickTimer = null;
  state.accountChipClickCount = 0;
  state.viewPayloadCache = {};
  state.viewPayloadCacheOrder = [];
  state.dayWindowCache = {};
  state.dayWindowCacheOrder = [];
  state.cachedAccounts = [];
  state.cachedAccountsAt = 0;
  state.legendSourceDays = null;
  state.legendSourceAccounts = null;
  state.renderEventsCache = {};
  state.renderItemsCache = {};
  if (state.selectedDatePatchTimer) clearTimeout(state.selectedDatePatchTimer);
  state.selectedDatePatchTimer = null;
  state.selectedDatePatchValue = '';
  state.lastObservedDayKey = null;
  closeUtilityPanel();
  state.userEmail = null;
  state.userRole = null;
  state.history.past = [];
  state.history.future = [];
  localStorage.removeItem(TOKEN_KEY);
  transitionTo('pair');
}

function handleLogoutClick() {
  const message = 'Log out from this TV and return to pairing?\n\nThis disconnects only this TV session. Your account data stays intact.';
  const confirmed = typeof window !== 'undefined' && typeof window.confirm === 'function'
    ? window.confirm(message)
    : true;
  if (!confirmed) return;
  handleUnpair('user_logout_requested');
}

async function fetchTvState() {
  const res = await authFetch('/tv/state');
  if (!res) {
    if (!state.selectedDate) state.selectedDate = toISO(new Date());
    return;
  }
  const data = await res.json().catch(() => ({}));
  processServerVersionSignal(res, data);
  state.selectedDate = data.selectedDate || null;
  state.currentView = data.currentView || 'day';
  state.focusedEventId = data.focusedEventId || null;
  state.userEmail = data.currentUserEmail || state.userEmail || null;
  state.userRole = data.currentUserRole || state.userRole || null;
  // Sleep guard settings (default to guard enabled, no timeout)
  state.sleepGuardEnabled = data.sleepGuardEnabled !== undefined ? data.sleepGuardEnabled : true;
  state.sleepGuardTimeoutMinutes = data.sleepGuardTimeoutMinutes || 0;
  if (!state.selectedDate) {
    const fallbackDate = toISO(new Date());
    const patched = await patchTvState({ selectedDate: fallbackDate }, { recordHistory: false });
    state.selectedDate = (patched && patched.selectedDate) || fallbackDate;
  }
}

async function refreshEvents(force = false, options = {}) {
  const manualSync = Boolean(options && options.showSync);
  const stateOverride = options && options.stateOverride ? options.stateOverride : null;
  const highPriorityRefresh = Boolean(manualSync || stateOverride);
  const automatedRefresh = !manualSync && !stateOverride && !force;
  const requestSelectedDate = String((stateOverride && stateOverride.selectedDate) || state.selectedDate || '');
  const requestCurrentView = String((stateOverride && stateOverride.currentView) || state.currentView || 'day');
  if (document.hidden && !force) {
    return;
  }

  const nowMs = Date.now();
  if (automatedRefresh && state.autoRefreshBackoffUntil && nowMs < state.autoRefreshBackoffUntil) {
    return;
  }
  if (!force && state.lastEventsFetchAt && (nowMs - state.lastEventsFetchAt) < POLL_MS) {
    return;
  }

  if (state.eventsRequestInFlight) {
    state.eventsRefreshQueued = true;
    // Only preserve forced follow-up fetches for explicit user sync or state-change refreshes.
    state.queuedRefreshForce = state.queuedRefreshForce || highPriorityRefresh;
    return;
  }

  state.eventsRequestInFlight = true;
  state.syncInProgress = true;
  state.syncVisualStartedAt = Date.now();
  applySyncVisualState();
  renderFooterHint();
  const eventsRequestHeaders = state.lastEventsEtag ? { 'If-None-Match': state.lastEventsEtag } : {};
  const eventsUrl = buildEventsRequestUrl(stateOverride);
  let res = await authFetch(eventsUrl, {
    cache: 'no-store',
    timeoutMs: TV_FETCH_TIMEOUT_MS,
    headers: eventsRequestHeaders,
    suppressNetworkHint: true,
  });

  if (manualSync && !res && state.lastAuthFetchError && state.lastAuthFetchError.isTimeout) {
    if (tvDiag) tvDiag.log('tv_events_timeout_retry', `retrying /tv/events after timeout (${state.lastAuthFetchError.message})`);
    res = await authFetch(eventsUrl, {
      cache: 'no-store',
      timeoutMs: TV_FETCH_TIMEOUT_MS + 5000,
      headers: eventsRequestHeaders,
      suppressNetworkHint: true,
    });
  }

  try {
    if (!res) {
      state.lastEventsFetchAt = Date.now();
      if (automatedRefresh) state.autoRefreshBackoffUntil = Date.now() + AUTO_REFRESH_FAILURE_BACKOFF_MS;
      const networkMessage = state.lastAuthFetchError && state.lastAuthFetchError.message
        ? state.lastAuthFetchError.message
        : 'Network request failed';
      if (state.lastAuthFetchError && state.lastAuthFetchError.isTimeout) {
        setSyncStatus(false, 'Sync delayed - keeping last known data');
      } else {
        setSyncStatus(false, 'Sync Failed');
      }
      renderFooterHint(`Network issue: ${networkMessage}`);
      if (!state.days.length) render();
      return;
    }

    processServerVersionSignal(res);

    if (res.status === 304) {
      state.lastEventsFetchAt = Date.now();
      state.autoRefreshBackoffUntil = 0;
      if (!state.days.length) {
        const hydrated = hydrateFromViewCache(state.currentView, state.selectedDate);
        if (hydrated) render();
      }
      setSyncStatus(true, 'Sync Succeed - No changes detected');
      return;
    }

    const responseEtag = res.headers.get('ETag');
    if (responseEtag) {
      state.lastEventsEtag = responseEtag;
    }

    if (!res.ok) {
      state.lastEventsFetchAt = Date.now();
      if (automatedRefresh) state.autoRefreshBackoffUntil = Date.now() + AUTO_REFRESH_FAILURE_BACKOFF_MS;
      renderFooterHint(`Data sync issue: /tv/events returned ${res.status}`);
      setSyncStatus(false, 'Sync Failed');
      return;
    }

    const data = await res.json().catch(() => ({}));
    processServerVersionSignal(res, data);
    state.lastEventsFetchAt = Date.now();
    state.autoRefreshBackoffUntil = 0;
    const staleData = Boolean(data.staleData);
    const incomingDays = normalizeTvDays(data.days);
    const responseSelectedDate = String(data.selectedDate || requestSelectedDate || state.selectedDate || '');
    const responseCurrentView = String(data.currentView || requestCurrentView || state.currentView || 'day');
    const responseAccounts = Array.isArray(data.accounts) ? data.accounts : [];

    // If the user moved to a different date/view while this request was in flight,
    // treat this response as stale for the active viewport and cache it only.
    if (!stateOverride) {
      const viewportChangedSinceRequest = String(state.selectedDate || '') !== requestSelectedDate
        || String(state.currentView || 'day') !== requestCurrentView;
      if (viewportChangedSinceRequest) {
        if (!staleData && incomingDays.length) {
          rememberViewPayload(responseCurrentView, responseSelectedDate, incomingDays, responseAccounts);
        }
        if (tvDiag) {
          tvDiag.log(
            'tv_events_discarded_stale_view',
            `requested=${requestCurrentView}:${requestSelectedDate} active=${state.currentView}:${state.selectedDate}`,
          );
        }
        return;
      }
    }

    const previousSelectedDate = state.selectedDate;
    const previousCurrentView = state.currentView;
    const wasStaleMode = state.staleMode;
    const previousSignature = state.lastDataSignature;
    let dataChanged = false;
    let staleTransitionChanged = false;

    if (stateOverride && responseSelectedDate) state.selectedDate = responseSelectedDate;
    if (stateOverride && responseCurrentView) state.currentView = responseCurrentView;

    let acceptedDays = false;
    if (!staleData) {
      state.days = incomingDays;
      state.serverAccounts = responseAccounts;
      state.legendSourceDays = null;
      state.legendSourceAccounts = null;
      state.dayMap = {};
      for (const day of state.days) state.dayMap[day.date] = day;
      acceptedDays = true;
    } else if (!state.days.length && incomingDays.length) {
      // First usable payload after startup can still be accepted even when marked stale.
      state.days = incomingDays;
      state.serverAccounts = responseAccounts;
      state.legendSourceDays = null;
      state.legendSourceAccounts = null;
      state.dayMap = {};
      for (const day of state.days) state.dayMap[day.date] = day;
      acceptedDays = true;
    }

    if (!staleData && acceptedDays) {
      const nextIndex = buildTvSnapshotIndex(state.days);
      const nextSignature = buildTvSnapshotSignature(nextIndex);
      dataChanged = previousSignature !== nextSignature;

      if (!previousSignature) {
        const initialCount = Object.keys(nextIndex).length;
        if (initialCount > 0 && tvDiag) {
          tvDiag.log('tv_data_loaded', `items=${initialCount}`);
        }
      } else if (dataChanged && tvDiag) {
        const delta = computeTvSnapshotDelta(state.lastDataSnapshotIndex, nextIndex);
        const totalDelta = delta.added + delta.updated + delta.deleted;
        if (totalDelta > 0) {
          tvDiag.log('tv_data_delta', `added=${delta.added} updated=${delta.updated} deleted=${delta.deleted}`);
        }
      }

      state.lastDataSnapshotIndex = nextIndex;
      state.lastDataSignature = nextSignature;
      rememberViewPayload(
        responseCurrentView || state.currentView,
        responseSelectedDate || state.selectedDate,
        state.days,
        state.serverAccounts,
      );
    }

    if (staleData) {
      const staleReason = String(data.staleReason || 'temporary backend refresh issue');
      if (!state.staleMode || state.lastStaleReason !== staleReason) {
        if (tvDiag) tvDiag.log('stale_snapshot_used', staleReason);
      }
      state.staleMode = true;
      state.lastStaleReason = staleReason;
      staleTransitionChanged = !wasStaleMode;
      renderFooterHint(`Using last known events (${staleReason}). Data was not cleared.`);
    } else {
      state.staleMode = false;
      state.lastStaleReason = '';
      if (wasStaleMode && tvDiag) {
        tvDiag.log('stale_snapshot_recovered', 'fresh /tv/events payload restored');
      }
      staleTransitionChanged = wasStaleMode;
    }

    const summary = data.summary || {};
    const eventCount = Number(summary.eventCount || 0);
    const stickyCount = Number(summary.stickyCount || 0);
    const totalItems = eventCount + stickyCount;
    const viewStateChanged = state.selectedDate !== previousSelectedDate || state.currentView !== previousCurrentView;
    syncFocusAfterData();

    if (force || viewStateChanged || dataChanged || staleTransitionChanged) {
      render();
    }

    if (staleData) {
      setSyncStatus(false, "Sync delayed - keeping last known data");
    } else if (totalItems > 0) {
      setSyncStatus(true, 'Sync Succeed');
    } else {
      setSyncStatus(true, 'Sync Succeed - No data in current view window');
    }
  } finally {
    state.eventsRequestInFlight = false;
    if (state.syncInProgress) {
      const elapsed = Date.now() - (state.syncVisualStartedAt || Date.now());
      if (elapsed < MIN_SYNC_VISUAL_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_SYNC_VISUAL_MS - elapsed));
      }
      state.syncInProgress = false;
      state.syncVisualStartedAt = 0;
      applySyncVisualState();
      renderFooterHint();
    }
    if (state.eventsRefreshQueued) {
      const queuedForce = state.queuedRefreshForce;
      state.eventsRefreshQueued = false;
      state.queuedRefreshForce = false;
      refreshEvents(queuedForce);
    }
  }
}

async function authFetch(url, options = {}) {
  if (!state.token) return null;
  let timeoutHandle = null;
  try {
    const timeoutMs = Number(options.timeoutMs || TV_FETCH_TIMEOUT_MS);
    const requestOptions = Object.assign({}, options);
    delete requestOptions.timeoutMs;
    const suppressNetworkHint = Boolean(requestOptions.suppressNetworkHint);
    delete requestOptions.suppressNetworkHint;

    const headers = Object.assign({}, options.headers || {}, { Authorization: `Bearer ${state.token}` });
    const fetchPromise = fetch(url, Object.assign({}, requestOptions, { headers }));
    const timeoutPromise = new Promise((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    const res = await Promise.race([fetchPromise, timeoutPromise]);
    state.lastAuthFetchError = null;
    if (res.status === 401) {
      if (IS_KIOSK) {
        state.authStatus = 'invalid';
        state.lastAuthIssue = 'kiosk-401';
        if (tvDiag && state.token) {
          tvDiag.log('kiosk_token_invalid_401', `url=${url}`);
          tvDiag.flush();
        }
        renderFooterHint('Kiosk token invalid/expired. Regenerate kiosk URL from Admin.');
      } else {
        state.authStatus = 'invalid';
        state.lastAuthIssue = '401';
        handleUnpair('token_invalid_401');
      }
      return null;
    }
    return res;
  } catch (err) {
    const message = err && err.message ? err.message : 'Network request failed';
    state.lastAuthFetchError = {
      message,
      isTimeout: /timed out/i.test(String(message)),
      url,
      at: Date.now(),
    };
    if (!options.suppressNetworkHint) {
      renderFooterHint(`Network issue: ${message}`);
    }
    return null;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

function snapshotTvState() {
  return {
    selectedDate: state.selectedDate,
    currentView: state.currentView,
    focusedEventId: state.focusedEventId,
    monthDetailOpen: state.monthDetailOpen,
    focus: {
      region: state.focus.region,
      monthIndex: state.focus.monthIndex,
      sidebarIndex: state.focus.sidebarIndex,
      itemIndex: state.focus.itemIndex,
    },
  };
}

function applyTvSnapshot(snapshot) {
  if (!snapshot) return;
  if (snapshot.selectedDate) state.selectedDate = snapshot.selectedDate;
  if (snapshot.currentView) state.currentView = snapshot.currentView;
  state.focusedEventId = snapshot.focusedEventId || null;
  state.monthDetailOpen = Boolean(snapshot.monthDetailOpen);
  if (snapshot.focus) {
    state.focus.region = snapshot.focus.region || state.focus.region;
    if (typeof snapshot.focus.monthIndex === 'number') state.focus.monthIndex = snapshot.focus.monthIndex;
    if (typeof snapshot.focus.sidebarIndex === 'number') state.focus.sidebarIndex = snapshot.focus.sidebarIndex;
    if (typeof snapshot.focus.itemIndex === 'number') state.focus.itemIndex = snapshot.focus.itemIndex;
  }
}

function pushHistorySnapshot(snapshot) {
  if (!snapshot) return;
  state.history.past.push(snapshot);
  if (state.history.past.length > 25) state.history.past.shift();
  state.history.future = [];
}

async function patchTvState(patch, options = {}) {
  const recordHistory = options.recordHistory !== false;
  const shouldRecord = recordHistory && (Object.prototype.hasOwnProperty.call(patch, 'selectedDate') || Object.prototype.hasOwnProperty.call(patch, 'currentView') || Object.prototype.hasOwnProperty.call(patch, 'focusedEventId'));
  const before = shouldRecord ? snapshotTvState() : null;
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
    state.userEmail = data.currentUserEmail || state.userEmail || null;
    state.userRole = data.currentUserRole || state.userRole || null;
    if (before) pushHistorySnapshot(before);
  }
  return data;
}

async function undoTvState() {
  const snapshot = state.history.past.pop();
  if (!snapshot) return;
  state.history.future.push(snapshotTvState());
  applyTvSnapshot(snapshot);
  await patchTvState({
    selectedDate: state.selectedDate,
    currentView: state.currentView,
    focusedEventId: state.focusedEventId,
  }, { recordHistory: false });
  render();
  await refreshEvents(true);
}

async function redoTvState() {
  const snapshot = state.history.future.pop();
  if (!snapshot) return;
  state.history.past.push(snapshotTvState());
  applyTvSnapshot(snapshot);
  await patchTvState({
    selectedDate: state.selectedDate,
    currentView: state.currentView,
    focusedEventId: state.focusedEventId,
  }, { recordHistory: false });
  render();
  await refreshEvents(true);
}

function onKeyDown(e) {
  if (!state.token || !dom.screenDash || dom.screenDash.classList.contains('hidden')) return;

  if (e.repeat && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'ArrowUp' && e.key !== 'ArrowDown') {
    return;
  }

  const key = normalizeKey(e);
  logRemoteKey('down', e, key);
  markRemoteCapability(key, e);

  if (isMuteKey(e, key)) {
    e.preventDefault();
    toggleDebugOverlay();
    return;
  }

  if (key.toLowerCase() === 'r') {
    e.preventDefault();
    if (isLockedMode()) setInputMode('nav');
    else toggleCursorMode();
    return;
  }

  if (isLockedMode()) {
    if (key === 'Enter') {
      e.preventDefault();
      showRemoteAction('Locked');
      return;
    }
    if (isBackKey(key)) {
      e.preventDefault();
      showRemoteAction('Locked');
      return;
    }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key) || isVolumeForwardKey(key) || isVolumeReverseKey(key) || isListKey(key)) {
      e.preventDefault();
      showRemoteAction('Locked');
      return;
    }
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

  if (isCursorMode() && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
    e.preventDefault();
    moveCursorByArrow(key);
    return;
  }

  if (isVolumeForwardKey(key) || isVolumeReverseKey(key)) {
    e.preventDefault();
    handleZoomHoldKeyDown(key);
    return;
  }

  if (isBackKey(key)) {
    e.preventDefault();
    handleBack();
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
    setView('day', { applyHomeZoom: true });
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

  if (handleZoomHoldKeyUp(key)) {
    e.preventDefault();
    return;
  }

  if (isLockedMode()) {
    if (key !== 'Enter') return;
    state.clickCount += 1;
    if (state.clickTimer) clearTimeout(state.clickTimer);
    state.clickTimer = setTimeout(() => {
      const count = state.clickCount;
      state.clickCount = 0;
      if (count >= 3) {
        setInputMode('nav');
      } else {
        showRemoteAction('Locked');
      }
    }, 260);
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
    if (count === 1 && resetZoom()) return;
    if (count === 1) onSelect();
    else if (count === 2) onSecondarySelect();
    else if (count >= 3) {
      toggleCursorMode();
    }
  }, 260);
}

function applyZoom() {
  syncZoomState();
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
  if (key === 'MediaFastForward' || code === 'MediaFastForward' || kc === 228) return 'MediaFastForward';
  if (key === 'MediaRewind' || code === 'MediaRewind' || kc === 227) return 'MediaRewind';
  if (key === 'ChannelUp' || code === 'ChannelUp' || kc === 427) return 'ChannelUp';
  if (key === 'ChannelDown' || code === 'ChannelDown' || kc === 428) return 'ChannelDown';
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
  showRemoteAction(`Cursor ${key.replace('Arrow', '')}`);
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
  showRemoteAction('Long Select Create');
  if (state.currentView === 'month') {
    createStickyAndEdit();
  } else {
    createEventAndEdit();
  }
}

function onSelect() {
  showRemoteAction('Select');
  if (isCursorMode() && state.cursor.visible) {
    clickCursorTarget('left');
    return;
  }

  if (state.currentView === 'month' && state.focus.region === 'main') {
    const date = getFocusedMonthDate();
    if (!date) return;
    const hadDayData = Boolean(state.dayMap && state.dayMap[date]);
    state.selectedDate = date;
    syncFocusAfterData();
    state.monthDetailOpen = true;
    render();
    patchTvState({ selectedDate: date }, { recordHistory: true }).catch(() => null);
    if (!hadDayData) {
      refreshEvents(true, { stateOverride: { selectedDate: date, currentView: state.currentView } });
    }
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
  showRemoteAction('Double Select');
  if (isCursorMode() && state.cursor.visible) {
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
  showRemoteAction('Back');
  if (state.editor) {
    state.editor = null;
    state.editorDirty = false;
    render();
    return;
  }
  if (state.currentView === 'month' && state.monthDetailOpen) {
    state.monthDetailOpen = false;
    render();
    return;
  }
  if (state.focus.region === 'sidebar') {
    state.focus.region = 'main';
    render();
    return;
  }
  setView('day', { applyHomeZoom: true });
}

function isBackKey(key) { return key === 'Escape' || key === 'Backspace'; }
function isVolumeForwardKey(key) {
  return key === '+' || key === '=' || key === 'PageDown' || key === 'AudioVolumeUp' || key === 'MediaFastForward' || key === 'ChannelUp';
}
function isVolumeReverseKey(key) {
  return key === '-' || key === '_' || key === 'PageUp' || key === 'AudioVolumeDown' || key === 'MediaRewind' || key === 'ChannelDown';
}
function isListKey(key) { return key === 'ContextMenu' || key === 'F2'; }

function handleArrow(key) {
  showRemoteAction(`Nav ${key.replace('Arrow', '')}`);
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
  if (date) {
    state.selectedDate = date;
    queueSelectedDatePatch(date);
  }
  render();
}

function shiftByView(direction) {
  closeEditor(true);
  const d = parseLocalDate(state.selectedDate || toISO(new Date()));
  let delta = 1;
  if (state.currentView === 'week') delta = 7;
  if (state.currentView === 'month') {
    d.setMonth(d.getMonth() + direction);
    state.selectedDate = toISO(d);
    state.monthDetailOpen = false;
    const hydrated = hydrateFromViewCache(state.currentView, state.selectedDate)
      || hydrateFromDayWindowCache(state.currentView, state.selectedDate);
    render();
    patchTvState({ selectedDate: toISO(d) }, { recordHistory: true }).catch(() => null);
    if (!hydrated) {
      refreshEvents(true, { stateOverride: { selectedDate: toISO(d), currentView: state.currentView } });
    }
    return;
  }
  const next = offsetDate(d, direction * delta);
  state.selectedDate = toISO(next);
  const hydrated = hydrateFromViewCache(state.currentView, state.selectedDate)
    || hydrateFromDayWindowCache(state.currentView, state.selectedDate);
  render();
  patchTvState({ selectedDate: toISO(next) }, { recordHistory: true }).catch(() => null);
  if (!hydrated) {
    refreshEvents(true, { stateOverride: { selectedDate: toISO(next), currentView: state.currentView } });
  }
}

function goToday() {
  closeEditor(true);
  state.monthDetailOpen = false;
  state.selectedDate = toISO(new Date());
  const hydrated = hydrateFromViewCache(state.currentView, state.selectedDate)
    || hydrateFromDayWindowCache(state.currentView, state.selectedDate);
  render();
  patchTvState({ selectedDate: toISO(new Date()) }, { recordHistory: true }).catch(() => null);
  if (!hydrated) {
    refreshEvents(true, { stateOverride: { selectedDate: state.selectedDate, currentView: state.currentView } });
  }
}

function setView(viewName, options = {}) {
  closeEditor(true);
  if (viewName === 'day' && options.applyHomeZoom) {
    applyHomeZoomPreference();
  }
  state.currentView = viewName;
  if (viewName === 'day') {
    state.daySectionState = {
      allDay: true,
      freeTime: true,
      sticky: true,
    };
  }
  if (viewName !== 'month') state.monthDetailOpen = false;
  const hydrated = hydrateFromViewCache(viewName, state.selectedDate)
    || hydrateFromDayWindowCache(viewName, state.selectedDate);
  render();
  patchTvState({ currentView: viewName }, { recordHistory: true }).catch(() => null);
  if (!hydrated) {
    refreshEvents(true, { stateOverride: { selectedDate: state.selectedDate, currentView: viewName } });
  }
}

function goBackAction() {
  handleBack();
}

function exitTvAction() {
  handleUnpair();
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

function buildThreeDayDates(anchorDate) {
  return [
    toISO(offsetDate(anchorDate, -1)),
    toISO(anchorDate),
    toISO(offsetDate(anchorDate, 1)),
  ];
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

function buildViewCacheKey(viewName, selectedDate) {
  const view = String(viewName || state.currentView || 'day');
  const date = String(selectedDate || state.selectedDate || '');
  return `${view}|${date}`;
}

function expectedDatesForView(viewName, selectedDate) {
  const anchor = parseLocalDate(selectedDate || state.selectedDate || toISO(new Date()));
  const view = String(viewName || state.currentView || 'day');
  if (view === 'month') return buildMonthDates(anchor);
  if (view === 'week') return buildWeekDates(anchor);
  if (view === '3-day') return buildThreeDayDates(anchor);
  return [toISO(anchor)];
}

function cacheDayWindow(days, accounts, cachedAt = Date.now()) {
  if (!Array.isArray(days) || !days.length) return;
  for (const day of days) {
    const dateKey = String(day?.date || '').trim();
    if (!dateKey) continue;
    state.dayWindowCache[dateKey] = { day, cachedAt };
    state.dayWindowCacheOrder = state.dayWindowCacheOrder.filter((entry) => entry !== dateKey);
    state.dayWindowCacheOrder.push(dateKey);
  }
  while (state.dayWindowCacheOrder.length > DAY_WINDOW_CACHE_LIMIT) {
    const staleKey = state.dayWindowCacheOrder.shift();
    if (staleKey) delete state.dayWindowCache[staleKey];
  }
  state.cachedAccounts = Array.isArray(accounts) ? accounts : [];
  state.cachedAccountsAt = cachedAt;
}

function hydrateFromDayWindowCache(viewName, selectedDate) {
  const neededDates = expectedDatesForView(viewName, selectedDate);
  if (!neededDates.length) return false;
  const now = Date.now();
  const maxAgeMs = POLL_MS;
  const days = [];
  for (const dateKey of neededDates) {
    const entry = state.dayWindowCache[dateKey];
    if (!entry || !entry.day) return false;
    if (now - Number(entry.cachedAt || 0) > maxAgeMs) return false;
    days.push(entry.day);
  }

  state.days = days;
  if (Array.isArray(state.cachedAccounts) && now - Number(state.cachedAccountsAt || 0) <= maxAgeMs) {
    state.serverAccounts = state.cachedAccounts;
  }
  state.legendSourceDays = null;
  state.legendSourceAccounts = null;
  state.dayMap = {};
  for (const day of state.days) {
    if (day && day.date) state.dayMap[day.date] = day;
  }
  return true;
}

function rememberViewPayload(viewName, selectedDate, days, accounts) {
  const key = buildViewCacheKey(viewName, selectedDate);
  const cachedAt = Date.now();
  state.viewPayloadCache[key] = {
    days: Array.isArray(days) ? days : [],
    accounts: Array.isArray(accounts) ? accounts : [],
    cachedAt,
  };
  cacheDayWindow(days, accounts, cachedAt);
  state.viewPayloadCacheOrder = state.viewPayloadCacheOrder.filter((entryKey) => entryKey !== key);
  state.viewPayloadCacheOrder.push(key);
  while (state.viewPayloadCacheOrder.length > VIEW_PAYLOAD_CACHE_LIMIT) {
    const staleKey = state.viewPayloadCacheOrder.shift();
    if (staleKey) delete state.viewPayloadCache[staleKey];
  }
}

function hydrateFromViewCache(viewName, selectedDate) {
  const key = buildViewCacheKey(viewName, selectedDate);
  const cached = state.viewPayloadCache[key];
  if (!cached) return false;
  state.days = Array.isArray(cached.days) ? cached.days : [];
  state.serverAccounts = Array.isArray(cached.accounts) ? cached.accounts : [];
  state.legendSourceDays = null;
  state.legendSourceAccounts = null;
  state.dayMap = {};
  for (const day of state.days) {
    if (day && day.date) state.dayMap[day.date] = day;
  }
  return true;
}

function dayData(dateKey) {
  return state.dayMap[dateKey] || { date: dateKey, events: [], stickyNotes: [] };
}

function renderWeekdayHeader() {
  return `<div class="tv-weekdays">${weekdayNames().map(name => `<div class="tv-weekday-chip">${name}</div>`).join('')}</div>`;
}

function renderLeftSidebar() {
  const side = sidebarItems();
  const selected = parseLocalDate(state.selectedDate || toISO(new Date()));
  const selectedLabel = selected.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
  const syncIndex = side.findIndex(item => item.key === 'sync');
  const undoIndex = side.findIndex(item => item.key === 'undo');
  const redoIndex = side.findIndex(item => item.key === 'redo');
  const primary = side.filter(item => item.group === 'primary');
  const footer = side.filter(item => item.group === 'footer');
  return `
    <div class="tv-sidebar">
      <div class="tv-sidebar-title">Selected Date</div>
      <div class="tv-sidebar-date">${escapeHtml(selectedLabel)}</div>
      <div class="tv-sidebar-actions">
        ${syncIndex >= 0 ? `<button class="tv-side-btn primary ${state.focus.region === 'sidebar' && state.focus.sidebarIndex === syncIndex ? 'focused' : ''}" type="button" data-tv-click="sidebar" data-sidebar-index="${syncIndex}">${escapeHtml(side[syncIndex].label)}</button>` : ''}
        <div class="tv-history-row">
          ${undoIndex >= 0 ? `<button class="tv-side-btn ${state.focus.region === 'sidebar' && state.focus.sidebarIndex === undoIndex ? 'focused' : ''}" type="button" data-tv-click="sidebar" data-sidebar-index="${undoIndex}" ${side[undoIndex].disabled ? 'disabled' : ''}>${escapeHtml(side[undoIndex].label)}</button>` : ''}
          ${redoIndex >= 0 ? `<button class="tv-side-btn ${state.focus.region === 'sidebar' && state.focus.sidebarIndex === redoIndex ? 'focused' : ''}" type="button" data-tv-click="sidebar" data-sidebar-index="${redoIndex}" ${side[redoIndex].disabled ? 'disabled' : ''}>${escapeHtml(side[redoIndex].label)}</button>` : ''}
        </div>
        <div class="tv-sidebar-divider"></div>
        ${primary.map(item => {
    const idx = side.findIndex(x => x.key === item.key);
    return `<button class="tv-side-btn ${state.focus.region === 'sidebar' && state.focus.sidebarIndex === idx ? 'focused' : ''}" type="button" data-tv-click="sidebar" data-sidebar-index="${idx}">${escapeHtml(item.label)}</button>`;
  }).join('')}
      </div>
      <div class="tv-sidebar-footer">
        ${footer.map(item => {
    const idx = side.findIndex(x => x.key === item.key);
    return `<button class="tv-side-btn ${item.key === 'admin-dashboard' ? 'warn' : ''} ${state.focus.region === 'sidebar' && state.focus.sidebarIndex === idx ? 'focused' : ''}" type="button" data-tv-click="sidebar" data-sidebar-index="${idx}">${escapeHtml(item.label)}</button>`;
  }).join('')}
      </div>
      <div class="tv-editor-anchor"></div>
    </div>`;
}

function renderTopControls() {
  const date = parseLocalDate(state.selectedDate || toISO(new Date()));
  const dateText = date.toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit', year: 'numeric' });
  return `
    <div class="tv-controls">
      <div class="tv-controls-group">
        <button class="tv-btn ghost" type="button" data-tv-click="control" data-control="prev">&lt; Prev</button>
        <button class="tv-btn primary" type="button" data-tv-click="control" data-control="today">Today</button>
        <button class="tv-btn ghost" type="button" data-tv-click="control" data-control="next">Next &gt;</button>
      </div>
      <div class="tv-controls-group">
        <button class="tv-btn view ${state.currentView === 'day' ? 'active' : ''}" type="button" data-tv-click="control" data-control="view-day">Day</button>
        <button class="tv-btn view ${state.currentView === '3-day' ? 'active' : ''}" type="button" data-tv-click="control" data-control="view-three-day">3-Day</button>
        <button class="tv-btn view ${state.currentView === 'week' ? 'active' : ''}" type="button" data-tv-click="control" data-control="view-week">Week</button>
        <button class="tv-btn view ${state.currentView === 'month' ? 'active' : ''}" type="button" data-tv-click="control" data-control="view-month">Month</button>
        <button class="tv-btn active" type="button" disabled>${escapeHtml(dateText)}</button>
      </div>
    </div>`;
}

function authStatusLabel() {
  if (state.authStatus === 'kiosk') return 'Kiosk URL token active';
  if (state.authStatus === 'paired') return 'Paired token active';
  if (state.authStatus === 'invalid') return `Token invalid${state.lastAuthIssue ? ` (${state.lastAuthIssue})` : ''}`;
  if (state.authStatus === 'unpaired') return 'No token loaded';
  return 'Unknown';
}

function remoteCapabilityLines() {
  const caps = state.remoteCapabilities;
  const lines = [];
  if (caps.arrows) lines.push('Arrows (navigation)');
  if (caps.select) lines.push('Select / Enter');
  if (caps.back) lines.push('Back / Escape');
  if (caps.list) lines.push('Menu / Context');
  if (caps.volume) lines.push('Volume +/- mapped to app');
  if (caps.media) lines.push('Fast Forward / Rewind');
  if (caps.channel) lines.push('Channel +/-');
  if (caps.mute) lines.push('Mute key observed');
  return lines;
}

function renderRemoteCapabilitySummary() {
  const lines = remoteCapabilityLines();
  if (!lines.length) return '<div class="tv-empty">No remote keys confirmed yet. Press remote buttons to detect capabilities.</div>';
  return lines.map(line => `<div class="tv-right-item"><div class="tv-right-item-title">${escapeHtml(line)}</div></div>`).join('');
}

function renderDynamicQuickLaunchSummary() {
  const caps = state.remoteCapabilities;
  const rows = [];
  if (caps.select) {
    rows.push('<div class="tv-right-item"><div class="tv-right-item-time">Select</div><div class="tv-right-item-title">Open / choose focused item</div></div>');
    rows.push('<div class="tv-right-item"><div class="tv-right-item-time">Long Select</div><div class="tv-right-item-title">Create new event or sticky note</div></div>');
    rows.push('<div class="tv-right-item"><div class="tv-right-item-time">Triple Select</div><div class="tv-right-item-title">Cycle NAV and CURSOR modes; unlock from LOCKED</div></div>');
  }
  if (caps.arrows) rows.push('<div class="tv-right-item"><div class="tv-right-item-time">Arrows</div><div class="tv-right-item-title">Navigate in NAV mode / move cursor in CURSOR mode</div></div>');
  if (caps.back) rows.push('<div class="tv-right-item"><div class="tv-right-item-time">Back</div><div class="tv-right-item-title">Close editor/panel or return focus</div></div>');
  if (caps.list) rows.push('<div class="tv-right-item"><div class="tv-right-item-time">Menu</div><div class="tv-right-item-title">Sticky-note action shortcut</div></div>');
  if (caps.volume) rows.push('<div class="tv-right-item"><div class="tv-right-item-time">+ / - Hold</div><div class="tv-right-item-title">Zoom in / zoom out</div></div>');
  else if (caps.media) rows.push('<div class="tv-right-item"><div class="tv-right-item-time">FF / REW Hold</div><div class="tv-right-item-title">Zoom in / zoom out fallback</div></div>');
  else if (caps.channel) rows.push('<div class="tv-right-item"><div class="tv-right-item-time">CH+ / CH- Hold</div><div class="tv-right-item-title">Zoom in / zoom out fallback</div></div>');
  if (!rows.length) return '<div class="tv-empty">No confirmed controls yet.</div>';
  return rows.join('');
}

function renderRightRail(selectedDateKey, weekDateKeys, extraClass = '') {
  if (state.utilityPanel === 'accounts') {
    return `
      <aside class="tv-right-rail ${extraClass}">
        <div class="tv-right-title">Manage Accounts</div>
        <div class="tv-right-subtitle">Currently signed in</div>
        <div class="tv-right-list">
          <div class="tv-right-item">
            <div class="tv-right-item-time">Email</div>
            <div class="tv-right-item-title">${escapeHtml(state.userEmail || 'Unknown')}</div>
          </div>
          <div class="tv-right-item">
            <div class="tv-right-item-time">Role</div>
            <div class="tv-right-item-title">${escapeHtml(state.userRole || 'user')}</div>
          </div>
        </div>
        <div class="tv-right-subtitle">Connections</div>
        <div class="tv-right-list">
          ${state.accountLegend.length ? state.accountLegend.map(item => `<div class="tv-right-item" style="background:${softColor(item.color, 0.2)}; border-color:${softColor(item.color, 0.52)}"><div class="tv-right-item-time">${escapeHtml(item.source)}</div><div class="tv-right-item-title">${escapeHtml(item.account)}</div></div>`).join('') : '<div class="tv-empty">No connected accounts found</div>'}
        </div>
        <div class="tv-right-editor-anchor"><button class="tv-side-btn full" type="button" data-tv-click="control" data-control="close-panel">Close</button></div>
      </aside>`;
  }

  if (state.utilityPanel === 'admin') {
    return `
      <aside class="tv-right-rail ${extraClass}">
        <div class="tv-right-title">Admin Dashboard</div>
        <div class="tv-right-subtitle">User access</div>
        <div class="tv-right-list">
          ${state.adminUsers.length ? state.adminUsers.map(user => `<div class="tv-right-item"><div class="tv-right-item-time">${escapeHtml(user.role || 'user')}</div><div class="tv-right-item-title">${escapeHtml(user.email || '')}</div></div>`).join('') : '<div class="tv-empty">No admin data loaded</div>'}
        </div>
        <div class="tv-right-editor-anchor"><button class="tv-side-btn full" type="button" data-tv-click="control" data-control="close-panel">Close</button></div>
      </aside>`;
  }

  if (state.utilityPanel === 'settings') {
    const defaultZoom = state.defaultZoomLevel || 100;
    return `
      <aside class="tv-right-rail ${extraClass}">
        <div class="tv-right-title">TV Settings</div>
        <div class="tv-right-subtitle">Zoom and home-view preferences</div>
        <div class="tv-right-list">
          <div class="tv-right-item">
            <div class="tv-right-item-time">Current Zoom</div>
            <div class="tv-right-item-title">${state.zoomLevel}%</div>
          </div>
          <div class="tv-right-item">
            <div class="tv-right-item-time">Auth Status</div>
            <div class="tv-right-item-title">${escapeHtml(authStatusLabel())}</div>
          </div>
          <div class="tv-right-item">
            <div class="tv-right-item-time">App Version</div>
            <div class="tv-right-item-title">Client ${escapeHtml(state.clientAppVersion)}${state.serverAppVersion && state.serverAppVersion !== state.clientAppVersion ? ` • Server ${escapeHtml(state.serverAppVersion)}` : ''}</div>
          </div>
          <div class="tv-right-item">
            <div class="tv-right-item-time">Home Zoom</div>
            <div class="tv-right-item-title">${defaultZoom}%</div>
          </div>
          <div class="tv-right-item">
            <div class="tv-right-item-time">Remote Zoom</div>
            <div class="tv-right-item-title">Hold + / - to zoom, or use FF / REW if volume keys are OS-reserved</div>
          </div>
          <div class="tv-right-item">
            <div class="tv-right-item-time">Input Mode</div>
            <div class="tv-right-item-title">${isLockedMode() ? 'LOCKED (app input paused)' : isCursorMode() ? 'CURSOR (virtual pointer active)' : 'NAV (focus navigation active)'}</div>
          </div>
        </div>
        <div class="tv-right-subtitle">Actions</div>
        <div class="tv-sidebar-actions">
          <button class="tv-side-btn" type="button" data-tv-click="control" data-control="toggle-cursor-mode">${isCursorMode() ? 'Switch to NAV Mode' : 'Switch to CURSOR Mode'}</button>
          <button class="tv-side-btn warn" type="button" data-tv-click="control" data-control="toggle-lock-mode">${isLockedMode() ? 'Unlock Remote Input' : 'Lock Remote Input'}</button>
          <button class="tv-side-btn primary" type="button" data-tv-click="control" data-control="zoom-in">Zoom In</button>
          <button class="tv-side-btn" type="button" data-tv-click="control" data-control="zoom-out">Zoom Out</button>
          <button class="tv-side-btn" type="button" data-tv-click="control" data-control="save-zoom-default">Save Current As Home</button>
          <button class="tv-side-btn" type="button" data-tv-click="control" data-control="restore-home-zoom">Restore Home Zoom</button>
          <button class="tv-side-btn warn" type="button" data-tv-click="control" data-control="zoom-reset">Reset to 100%</button>
        </div>
        <div class="tv-right-subtitle">Detected Controls (This Device)</div>
        <div class="tv-right-list">${renderRemoteCapabilitySummary()}</div>
        <div class="tv-right-subtitle">Quick Launch Summary</div>
        <div class="tv-right-list">${renderDynamicQuickLaunchSummary()}</div>
        <div class="tv-right-editor-anchor"><button class="tv-side-btn full" type="button" data-tv-click="control" data-control="close-panel">Close</button></div>
      </aside>`;
  }

  if (state.editor) {
    return `
      <aside class="tv-right-rail editor-cover ${extraClass}">
        <div class="tv-right-title">Inline Editing</div>
        <div class="tv-right-subtitle">Day/Week rail hidden while editing</div>
        <div class="tv-right-editor-anchor"></div>
      </aside>`;
  }

  const selectedItems = itemsForDate(selectedDateKey).slice(0, 12);
  const weekEvents = weekDateKeys.flatMap(dateKey => filteredEventsForDay(dayData(dateKey)).map(ev => ({ dateKey, ev })));
  const selectedDay = dayData(selectedDateKey);
  const selectedDateStickyCount = Array.isArray(selectedDay.stickyNotes) ? selectedDay.stickyNotes.length : 0;
  const selectedEventStickyCount = filteredEventsForDay(selectedDay).filter((ev) => eventHasStickyPayload(ev)).length;
  const selectedStickyTotal = selectedDateStickyCount + selectedEventStickyCount;
  const selectedDayStickyBadge = selectedStickyTotal > 0
    ? `<span class="tv-sticky-indicator tv-inline-sticky-badge" aria-label="${escapeHtml(`${selectedStickyTotal} sticky note${selectedStickyTotal === 1 ? '' : 's'} on selected day`)}">${escapeHtml(selectedStickyTotal > 1 ? String(Math.min(selectedStickyTotal, 9)) : 'S')}</span>`
    : '';
  const weekStickyTotal = weekEvents.filter((row) => eventHasStickyPayload(row.ev)).length
    + weekDateKeys.reduce((count, dateKey) => count + ((dayData(dateKey).stickyNotes || []).length), 0);
  const weekStickyBadge = weekStickyTotal > 0
    ? `<span class="tv-sticky-indicator tv-inline-sticky-badge" aria-label="${escapeHtml(`${weekStickyTotal} sticky note${weekStickyTotal === 1 ? '' : 's'} this week`)}">${escapeHtml(weekStickyTotal > 1 ? String(Math.min(weekStickyTotal, 9)) : 'S')}</span>`
    : '';
  return `
    <aside class="tv-right-rail ${extraClass}">
      <div class="tv-right-title">${escapeHtml(parseLocalDate(selectedDateKey).toLocaleDateString([], { weekday: 'long', month: 'short', day: '2-digit', year: 'numeric' }))}${selectedDayStickyBadge}</div>
      <div class="tv-right-list">
        ${selectedItems.length ? selectedItems.map(item => {
    if (item.type === 'event') {
      const eventColor = resolveEventColor(item.event);
      const sticky = eventHasStickyPayload(item.event) ? '<span class="tv-sticky-indicator" aria-label="Event sticky note"></span>' : '';
      return `<div class="tv-right-item" style="background:${softColor(eventColor, 0.2)}; border-color:${softColor(eventColor, 0.52)}">${sticky}<div class="tv-right-item-time">${escapeHtml(formatTime(item.event.start))}</div><div class="tv-right-item-title">${escapeHtml(item.event.title || 'Untitled')}</div></div>`;
    }
    return `<div class="tv-right-item"><span class="tv-sticky-indicator" aria-label="Date sticky note"></span><div class="tv-right-item-time">Sticky</div><div class="tv-right-item-title">${escapeHtml(item.sticky.content || '')}</div></div>`;
  }).join('') : '<div class="tv-empty">No events or sticky notes</div>'}
      </div>
      <div class="tv-right-subtitle">This Week${weekStickyBadge}</div>
      <div class="tv-right-list">
        ${weekEvents.length ? weekEvents.slice(0, 12).map(row => {
    const eventColor = resolveEventColor(row.ev);
    const sticky = eventHasStickyPayload(row.ev) ? '<span class="tv-sticky-indicator" aria-label="Event sticky note"></span>' : '';
    return `<div class="tv-right-item" style="background:${softColor(eventColor, 0.2)}; border-color:${softColor(eventColor, 0.52)}">${sticky}<div class="tv-right-item-time">${escapeHtml(parseLocalDate(row.dateKey).toLocaleDateString([], { weekday: 'short' }))} ${escapeHtml(formatTime(row.ev.start))}</div><div class="tv-right-item-title">${escapeHtml(row.ev.title || 'Untitled')}</div></div>`;
  }).join('') : '<div class="tv-empty">No events this week</div>'}
      </div>
      <div class="tv-right-editor-anchor"></div>
    </aside>`;
}

function sidebarItems() {
  const items = [
    { key: 'sync', label: 'Sync', group: 'top', action: () => patchTvState({ selectedDate: state.selectedDate || toISO(new Date()) }, { recordHistory: false }).then(() => refreshEvents(true, { showSync: true })) },
    { key: 'undo', label: 'Undo', group: 'history', action: () => undoTvState(), disabled: !state.history.past.length },
    { key: 'redo', label: 'Redo', group: 'history', action: () => redoTvState(), disabled: !state.history.future.length },
    { key: 'create-event', label: 'Create Event', group: 'primary', action: () => createEventAndEdit() },
    { key: 'create-sticky', label: 'Create Sticky', group: 'primary', action: () => createStickyAndEdit() },
    { key: 'jump-today', label: 'Jump Today', group: 'primary', action: () => goToday() },
    { key: 'view-day', label: 'View Day', group: 'primary', action: () => setView('day', { applyHomeZoom: true }) },
    { key: 'view-three-day', label: 'View 3-Day', group: 'primary', action: () => setView('3-day') },
    { key: 'view-week', label: 'View Week', group: 'primary', action: () => setView('week') },
    { key: 'view-month', label: 'View Month', group: 'primary', action: () => setView('month') },
    { key: 'save-zoom-default', label: 'Save Zoom as Default', group: 'footer', action: () => saveCurrentZoomAsDefault() },
    { key: 'settings', label: 'Settings', group: 'footer', action: () => openSettingsPanel() },
    { key: 'manage-accounts', label: 'Manage Accounts', group: 'footer', action: () => openManageAccountsPanel() },
  ];
  if (state.userRole === 'admin') {
    items.push({ key: 'admin-dashboard', label: 'Admin Dashboard', group: 'footer', action: () => openAdminDashboardPanel() });
  }
  return items;
}

function runSidebarAction(index) {
  closeEditor(true);
  const items = sidebarItems();
  if (items[index]) items[index].action();
}

function resetAccountFilters() {
  state.selectedAccountKeys = [];
  render();
}

function applySingleAccountFilter(key) {
  if (!key) return;
  state.selectedAccountKeys = [key];
  render();
}

function toggleMultiAccountFilter(key) {
  if (!key) return;
  const set = new Set(state.selectedAccountKeys);
  if (set.has(key)) set.delete(key);
  else set.add(key);
  state.selectedAccountKeys = Array.from(set);
  render();
}

function clickAccountChip(key, isMulti = false) {
  if (!key) return;
  if (isMulti) {
    toggleMultiAccountFilter(key);
    return;
  }
  state.accountChipClickCount += 1;
  if (state.accountChipClickTimer) clearTimeout(state.accountChipClickTimer);
  state.accountChipClickTimer = setTimeout(() => {
    const count = state.accountChipClickCount;
    state.accountChipClickCount = 0;
    if (count >= 2) {
      resetAccountFilters();
    } else {
      applySingleAccountFilter(key);
    }
  }, 260);
}

function onAccountLegendPointerDown(e) {
  const chip = e.target.closest('[data-tv-click="account-chip"]');
  if (!chip) return;
  const key = chip.getAttribute('data-account-key');
  state.accountChipPressFired = false;
  if (state.accountChipPressTimer) clearTimeout(state.accountChipPressTimer);
  state.accountChipPressTimer = setTimeout(() => {
    state.accountChipPressFired = true;
    toggleMultiAccountFilter(key);
  }, LONG_PRESS_MS);
}

function onAccountLegendPointerUp() {
  if (state.accountChipPressTimer) {
    clearTimeout(state.accountChipPressTimer);
    state.accountChipPressTimer = null;
  }
}

function onAccountLegendClick(e) {
  const chip = e.target.closest('[data-tv-click="account-chip"]');
  if (!chip) return;
  const key = chip.getAttribute('data-account-key') || '';
  if (state.accountChipPressFired) {
    state.accountChipPressFired = false;
    return;
  }
  clickAccountChip(key, Boolean(e.ctrlKey || e.metaKey));
}

function focusNext() {
  showRemoteAction('Focus Next');
  if (state.currentView === 'month') {
    if (state.focus.region === 'sidebar') {
      state.focus.sidebarIndex = (state.focus.sidebarIndex + 1) % sidebarItems().length;
    } else {
      state.focus.monthIndex = (state.focus.monthIndex + 1) % 42;
      const date = getFocusedMonthDate();
      if (date) {
        state.selectedDate = date;
        queueSelectedDatePatch(date);
      }
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
  showRemoteAction('Focus Previous');
  if (state.currentView === 'month') {
    if (state.focus.region === 'sidebar') {
      state.focus.sidebarIndex = (state.focus.sidebarIndex - 1 + sidebarItems().length) % sidebarItems().length;
    } else {
      state.focus.monthIndex = (state.focus.monthIndex - 1 + 42) % 42;
      const date = getFocusedMonthDate();
      if (date) {
        state.selectedDate = date;
        queueSelectedDatePatch(date);
      }
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
  showRemoteAction('Sticky Action');
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
  patchTvState({ focusedEventId: item.id }, { recordHistory: false });
}

function getFocusedMonthDate() {
  const date = state.monthDates[state.focus.monthIndex];
  return date || null;
}

function queueSelectedDatePatch(dateKey) {
  const normalized = String(dateKey || '').trim();
  if (!normalized) return;
  state.selectedDatePatchValue = normalized;
  if (state.selectedDatePatchTimer) clearTimeout(state.selectedDatePatchTimer);
  state.selectedDatePatchTimer = setTimeout(() => {
    const nextDate = state.selectedDatePatchValue;
    state.selectedDatePatchTimer = null;
    if (!nextDate) return;
    patchTvState({ selectedDate: nextDate }, { recordHistory: false }).catch(() => null);
  }, 140);
}

function normalizeAccountSource(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'local';
  const head = raw.split(/[|:]/)[0] || raw;
  if (!head || head === 'db' || head === 'memory') return 'local';
  if (head.startsWith('google') || head === 'gmail' || head === 'gcal') return 'google';
  if (head.startsWith('microsoft') || head.startsWith('ms') || head === 'outlook' || head === 'office365') return 'microsoft';
  if (head.startsWith('apple') || head === 'icloud' || head === 'caldav') return 'apple';
  if (head.startsWith('local')) return 'local';
  return head;
}

function normalizeAccountIdentifier(value) {
  let raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  raw = raw.replace(/^mailto:/, '');
  raw = raw.replace(/^['\"]+|['\"]+$/g, '');

  // Canonicalize Gmail aliases so account colors still match when dots/+tags differ.
  if (isEmailLikeAccount(raw)) {
    const [localPart, domainPart] = raw.split('@');
    const domain = String(domainPart || '').trim();
    if (domain === 'googlemail.com' || domain === 'gmail.com') {
      const canonicalLocal = String(localPart || '').split('+')[0].replace(/\./g, '');
      return `${canonicalLocal}@gmail.com`;
    }
  }
  return raw;
}

function isEmailLikeAccount(value) {
  const raw = String(value || '').trim();
  return /.+@.+\..+/.test(raw);
}

function isGenericProviderBucket(source, account) {
  const normalizedSource = normalizeAccountSource(source);
  const normalizedAccount = normalizeAccountIdentifier(account);
  if (!normalizedAccount) return true;
  if (normalizedAccount === normalizedSource) return true;
  if (normalizedAccount === `${normalizedSource}_calendar`) return true;
  return false;
}

function parseCompositeAccountKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (raw.includes(':')) {
    const [left, ...rest] = raw.split(':');
    const right = rest.join(':').trim();
    if (right) {
      const leftNormalized = normalizeAccountIdentifier(left);
      const rightNormalized = normalizeAccountIdentifier(right);
      const leftLooksEmail = isEmailLikeAccount(leftNormalized);
      const rightLooksProvider = ['google', 'microsoft', 'apple', 'local'].includes(normalizeAccountSource(right));
      if (leftLooksEmail && rightLooksProvider) {
        return {
          source: normalizeAccountSource(right),
          account: leftNormalized,
        };
      }
      return {
        source: normalizeAccountSource(left),
        account: rightNormalized,
      };
    }
  }
  if (raw.includes('|')) {
    const [left, ...rest] = raw.split('|');
    const right = rest.join('|');
    const leftNormalized = normalizeAccountIdentifier(left);
    const rightNormalized = normalizeAccountIdentifier(right);
    const leftLooksEmail = isEmailLikeAccount(leftNormalized);
    const rightLooksProvider = ['google', 'microsoft', 'apple', 'local'].includes(normalizeAccountSource(right));
    if (leftLooksEmail && rightLooksProvider) {
      return {
        source: normalizeAccountSource(right),
        account: leftNormalized,
      };
    }
    return {
      source: normalizeAccountSource(left),
      account: rightNormalized,
    };
  }
  const atIdx = raw.indexOf('@');
  if (atIdx > 0) {
    const left = raw.slice(0, atIdx);
    const right = raw.slice(atIdx);
    const providerMatch = left.match(/(google|microsoft|apple|local)[^a-z0-9]*$/i);
    if (providerMatch && right.includes('.')) {
      return {
        source: normalizeAccountSource(providerMatch[1]),
        account: normalizeAccountIdentifier(`${left.slice(providerMatch.index + providerMatch[1].length)}${right}`.replace(/^[^a-z0-9]+/i, '')),
      };
    }
  }
  const sourcePrefixMatch = raw.match(/^(google|microsoft|apple|local)[_|\-](.+)$/i);
  if (sourcePrefixMatch) {
    return {
      source: normalizeAccountSource(sourcePrefixMatch[1]),
      account: normalizeAccountIdentifier(sourcePrefixMatch[2]),
    };
  }
  return null;
}

function extractExternalAccountIdentity(ev) {
  const candidates = [];
  const rawMaps = [
    ev?.external_ids,
    ev?.externalIds,
    ev?.extendedProps?.external_ids,
    ev?.extendedProps?.externalIds,
  ];
  for (const rawMap of rawMaps) {
    if (!rawMap || typeof rawMap !== 'object') continue;
    for (const key of Object.keys(rawMap)) {
      const parsed = parseCompositeAccountKey(key);
      if (!parsed) continue;
      const account = normalizeAccountIdentifier(parsed.account);
      if (!account || account === 'local') continue;
      candidates.push({
        source: normalizeAccountSource(parsed.source),
        account,
      });
    }
  }
  if (!candidates.length) return null;
  const sourceHint = normalizeAccountSource(ev?.source || ev?.provider || ev?.extendedProps?.source || 'local');
  const exactSource = candidates.find((item) => item.source === sourceHint);
  return exactSource || candidates[0];
}

function shouldPreferExternalIdentity(source, account) {
  const normalizedSource = normalizeAccountSource(source || 'local');
  const normalizedAccount = normalizeAccountIdentifier(account);
  if (!normalizedAccount) return true;
  if (normalizedAccount === 'local') return true;
  return isGenericProviderBucket(normalizedSource, normalizedAccount);
}

function eventAccountIdentity(ev) {
  const rawSource = (
    ev?.source
    || ev?.provider
    || ev?.extendedProps?.source
    || 'local'
  );
  const sourceComposite = parseCompositeAccountKey(rawSource);
  const composite = parseCompositeAccountKey(
    ev?.account_key
    || ev?.accountKey
    || ev?.extendedProps?.account_key
    || ev?.extendedProps?.accountKey,
  );
  const externalIdentity = extractExternalAccountIdentity(ev);

  const source = normalizeAccountSource(
    composite?.source
    || sourceComposite?.source
    || externalIdentity?.source
    || rawSource
    || 'local',
  );

  let account = normalizeAccountIdentifier(
    composite?.account
    || ev?.accountEmail
    || ev?.account_email
    || ev?.account
    || ev?.email
    || ev?.extendedProps?.account_email
    || ev?.extendedProps?.accountEmail
    || externalIdentity?.account
    || sourceComposite?.account
    || source,
  ) || source;

  let resolvedSource = source;
  if (externalIdentity && shouldPreferExternalIdentity(resolvedSource, account)) {
    resolvedSource = normalizeAccountSource(externalIdentity.source || resolvedSource);
    account = normalizeAccountIdentifier(externalIdentity.account) || account;
  }

  return {
    source: resolvedSource,
    account,
    key: `${resolvedSource}:${account}`,
  };
}

function serverAccountIdentity(account) {
  const rawKey = account?.account_key || account?.accountKey;
  const composite = parseCompositeAccountKey(rawKey);
  const source = normalizeAccountSource(composite?.source || account?.provider || account?.source || 'local');
  const normalizedAccount = normalizeAccountIdentifier(
    composite?.account || account?.accountEmail || account?.account_email || account?.email || source,
  ) || source;
  return {
    source,
    account: normalizedAccount,
    key: `${source}:${normalizedAccount}`,
  };
}

function eventAccountKey(ev) {
  return eventAccountIdentity(ev).key;
}

function isAccountVisibleForEvent(ev) {
  if (!state.selectedAccountKeys.length) return true;
  return state.selectedAccountKeys.includes(eventAccountKey(ev));
}

function sortEventsAsc(events) {
  return [...(events || [])].sort((a, b) => {
    const aTs = Date.parse(a.start || '') || 0;
    const bTs = Date.parse(b.start || '') || 0;
    return aTs - bTs;
  });
}

function filteredEventsForDay(day) {
  const dateKey = String(day?.date || '');
  if (dateKey && state.renderEventsCache && state.renderEventsCache[dateKey]) {
    return state.renderEventsCache[dateKey];
  }
  const allEvents = sortEventsAsc(day.events || []);
  const filtered = allEvents.filter(ev => isAccountVisibleForEvent(ev));
  if (dateKey && state.renderEventsCache) {
    state.renderEventsCache[dateKey] = filtered;
  }
  return filtered;
}

function extractStickyText(payload) {
  if (typeof payload === 'string') return payload.trim();
  if (!payload || typeof payload !== 'object') return '';
  const keys = ['content', 'text', 'note', 'title', 'body', 'message'];
  for (const key of keys) {
    const value = payload[key];
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return text;
  }
  return '';
}

function normalizeStickyEntry(entry) {
  if (typeof entry === 'string') {
    const content = entry.trim();
    if (!content) return null;
    return { id: `sticky-${Date.now()}`, content, color: '#F7E68A' };
  }
  if (!entry || typeof entry !== 'object') return null;
  const content = extractStickyText(entry);
  if (!content) return null;
  return {
    ...entry,
    content,
    color: String(entry.color || '#F7E68A'),
  };
}

function normalizeStickyEntries(rawEntries) {
  if (!rawEntries) return [];
  let items = rawEntries;
  if (typeof rawEntries === 'string') {
    const txt = rawEntries.trim();
    if (!txt || txt === '[]' || txt === '{}' || txt.toLowerCase() === 'null') return [];
    try {
      items = JSON.parse(txt);
    } catch {
      items = [txt];
    }
  }
  if (!Array.isArray(items)) items = [items];
  return items.map(normalizeStickyEntry).filter(Boolean);
}

function eventHasStickyPayload(event) {
  if (!event || typeof event !== 'object') return false;

  const explicit = event.hasSticky;
  if (explicit === true) return true;
  if (typeof explicit === 'string') {
    const normalized = explicit.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  }

  if (normalizeStickyEntries(event.stickyNotes).length) return true;
  if (normalizeStickyEntries(event.sticky_notes).length) return true;
  if (normalizeStickyEntries(event.stickyNote).length) return true;
  if (normalizeStickyEntries(event.sticky_note).length) return true;

  if (Array.isArray(event.notes)) {
    return event.notes.some((note) => Boolean(extractStickyText(note)));
  }
  if (typeof event.noteCount === 'number' && event.noteCount > 0) return true;
  if (typeof event.note_count === 'number' && event.note_count > 0) return true;

  return false;
}

function normalizeTvDays(daysPayload) {
  if (!Array.isArray(daysPayload)) return [];
  return daysPayload.map((day) => {
    const rawEvents = Array.isArray(day?.events) ? day.events : [];
    const stickyNotes = normalizeStickyEntries(day?.stickyNotes ?? day?.sticky_notes);
    const events = rawEvents.map((ev) => ({
      ...ev,
      hasSticky: eventHasStickyPayload(ev),
    }));
    return {
      ...day,
      stickyNotes,
      events,
    };
  });
}

function buildTvSnapshotIndex(days) {
  const index = {};
  for (const day of (days || [])) {
    const dateKey = String(day?.date || '');

    const events = Array.isArray(day?.events) ? day.events : [];
    for (const ev of events) {
      const eventIdentity = ev?.id != null
        ? String(ev.id)
        : `${dateKey}|${String(ev?.start || '')}|${String(ev?.end || '')}|${String(ev?.title || '')}`;
      const eventKey = `event:${eventIdentity}`;
      index[eventKey] = [
        dateKey,
        String(ev?.title || ''),
        String(ev?.start || ''),
        String(ev?.end || ''),
        String(ev?.description || ''),
        ev?.hasSticky ? '1' : '0',
        String(ev?.updatedAt || ev?.updated_at || ''),
      ].join('|');
    }

    const stickyNotes = Array.isArray(day?.stickyNotes) ? day.stickyNotes : [];
    for (let i = 0; i < stickyNotes.length; i += 1) {
      const sticky = stickyNotes[i] || {};
      const stickyIdentity = sticky.id != null
        ? String(sticky.id)
        : `${i}|${String(sticky.content || '')}`;
      const stickyKey = `sticky:${dateKey}:${stickyIdentity}`;
      index[stickyKey] = [
        dateKey,
        String(sticky.content || ''),
        String(sticky.color || ''),
        String(sticky.updatedAt || sticky.updated_at || ''),
      ].join('|');
    }
  }
  return index;
}

function buildTvSnapshotSignature(index) {
  const keys = Object.keys(index || {}).sort();
  return keys.map((key) => `${key}=${index[key]}`).join(';');
}

function computeTvSnapshotDelta(prevIndex, nextIndex) {
  if (!prevIndex || typeof prevIndex !== 'object') {
    return {
      added: Object.keys(nextIndex || {}).length,
      updated: 0,
      deleted: 0,
    };
  }

  let added = 0;
  let updated = 0;
  let deleted = 0;

  for (const key of Object.keys(nextIndex || {})) {
    if (!(key in prevIndex)) {
      added += 1;
      continue;
    }
    if (prevIndex[key] !== nextIndex[key]) {
      updated += 1;
    }
  }

  for (const key of Object.keys(prevIndex)) {
    if (!(key in (nextIndex || {}))) {
      deleted += 1;
    }
  }

  return { added, updated, deleted };
}

function itemsForDate(dateKey) {
  const normalizedDateKey = String(dateKey || '');
  if (normalizedDateKey && state.renderItemsCache && state.renderItemsCache[normalizedDateKey]) {
    return state.renderItemsCache[normalizedDateKey];
  }
  const day = state.dayMap[dateKey];
  if (!day) return [];
  const events = filteredEventsForDay(day).map(ev => ({ type: 'event', id: ev.id, date: dateKey, event: ev }));
  const sticky = (day.stickyNotes || []).map((s, i) => ({ type: 'sticky', id: s.id || `sticky-${i}`, date: dateKey, sticky: s, index: i }));
  const merged = [...events, ...sticky];
  if (normalizedDateKey && state.renderItemsCache) {
    state.renderItemsCache[normalizedDateKey] = merged;
  }
  return merged;
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
  state.renderEventsCache = {};
  state.renderItemsCache = {};
  syncAccountLegend();
  renderHeader();
  renderAccountLegend();
  applySyncVisualState();
  renderMain();
  renderFooterHint();
  applyZoom();
}

function initZoomEngine() {
  if (zoomEngine) return;
  zoomEngine = createTvZoomEngine();
  const restored = zoomEngine.restore();
  state.zoomLevel = restored.currentZoomLevel;
  state.defaultZoomLevel = restored.defaultZoomLevel;
}

function syncZoomState() {
  if (!zoomEngine) return;
  state.zoomLevel = zoomEngine.getZoomLevel();
  state.defaultZoomLevel = zoomEngine.getDefaultZoomLevel();
}

function announceZoomChange(kind) {
  syncZoomState();
  renderFooterHint();
  if (tvDiag) {
    if (kind === 'default') {
      tvDiag.log('default_zoom_changed', `defaultZoom=${state.defaultZoomLevel}%`);
    } else {
      tvDiag.log('zoom_changed', `zoom=${state.zoomLevel}%`);
    }
  }
}

function zoomIn() {
  if (!zoomEngine || !zoomEngine.zoomIn()) return false;
  announceZoomChange('current');
  return true;
}

function zoomOut() {
  if (!zoomEngine || !zoomEngine.zoomOut()) return false;
  announceZoomChange('current');
  return true;
}

function resetZoom() {
  if (!zoomEngine || !zoomEngine.resetZoom()) return false;
  announceZoomChange('current');
  renderFooterHint('Zoom reset to 100%');
  return true;
}

function saveCurrentZoomAsDefault() {
  if (!zoomEngine) return false;
  const changed = zoomEngine.saveDefaultZoomLevel();
  syncZoomState();
  renderFooterHint(changed ? `Home default zoom saved at ${state.defaultZoomLevel}%` : `Home default already ${state.defaultZoomLevel}%`);
  if (tvDiag && changed) {
    tvDiag.log('default_zoom_changed', `defaultZoom=${state.defaultZoomLevel}%`);
  }
  return changed;
}

function applyHomeZoomPreference() {
  if (!zoomEngine || !zoomEngine.applyHomeZoomPreference()) return false;
  announceZoomChange('current');
  return true;
}

function clearSelectLongPressState() {
  if (state.longPressTimer) {
    clearTimeout(state.longPressTimer);
    state.longPressTimer = null;
  }
  state.longPressTriggered = false;
}

function clearZoomHoldState() {
  if (state.zoomHold.timer) {
    clearTimeout(state.zoomHold.timer);
    state.zoomHold.timer = null;
  }
  state.zoomHold.key = null;
  state.zoomHold.triggered = false;
}

function clearRemoteHoldState() {
  clearSelectLongPressState();
  clearZoomHoldState();
}

function handleZoomHoldKeyDown(key) {
  if (!isVolumeForwardKey(key) && !isVolumeReverseKey(key)) return false;

  if (state.zoomHold.key === key) return true;

  clearZoomHoldState();

  state.zoomHold.key = key;
  state.zoomHold.triggered = false;
  state.zoomHold.timer = setTimeout(() => {
    state.zoomHold.timer = null;
    state.zoomHold.triggered = true;
    if (isVolumeForwardKey(key)) {
      showRemoteAction('Zoom In');
      zoomIn();
    } else {
      showRemoteAction('Zoom Out');
      zoomOut();
    }
  }, LONG_PRESS_MS);
  return true;
}

function handleZoomHoldKeyUp(key) {
  if (state.zoomHold.key !== key) return false;

  const wasTriggered = state.zoomHold.triggered;
  clearZoomHoldState();

  if (wasTriggered) return true;
  if (isVolumeForwardKey(key)) focusNext();
  else focusPrev();
  return true;
}

function syncAccountLegend() {
  const daysRef = state.days;
  const accountsRef = state.serverAccounts;

  const reconcileSelectedAccountKeys = () => {
    if (!state.selectedAccountKeys.length) return;
    const allowed = new Set(state.accountLegend.map(item => item.key || `${item.source}:${item.account}`));
    state.selectedAccountKeys = state.selectedAccountKeys
      .map((key) => {
        const parsed = parseCompositeAccountKey(key);
        if (!parsed) return String(key || '').trim().toLowerCase();
        const src = normalizeAccountSource(parsed.source);
        const acct = normalizeAccountIdentifier(parsed.account) || src;
        return `${src}:${acct}`;
      })
      .filter(key => allowed.has(key));
  };

  if (state.legendSourceDays === daysRef && state.legendSourceAccounts === accountsRef) {
    reconcileSelectedAccountKeys();
    return;
  }

  const isPlaceholderAccount = (value) => {
    const email = String(value || '').trim().toLowerCase();
    if (!email) return false;
    if (email === 'test' || email === 'test@example.com') return true;
    return email.endsWith('@example.com');
  };

  const map = new Map();
  const colorMap = {};
  const emailColorMap = {};

  for (const account of (state.serverAccounts || [])) {
    const identity = serverAccountIdentity(account);
    if (isPlaceholderAccount(identity.account)) continue;
    const color = normalizeHexColor(account.color) || providerFallbackColor(identity.source);
    map.set(identity.key, { key: identity.key, source: identity.source, account: identity.account, color });
    colorMap[identity.key] = color;
    const normalizedEmail = normalizeAccountIdentifier(account?.account_email || account?.accountEmail || account?.email);
    if (normalizedEmail && !emailColorMap[normalizedEmail]) {
      emailColorMap[normalizedEmail] = color;
    }
  }

  for (const day of state.days) {
    for (const ev of (day.events || [])) {
      const identity = eventAccountIdentity(ev);
      if (isPlaceholderAccount(identity.account)) continue;
      const eventColor = normalizeHexColor(ev.color);
      const normalizedEmail = normalizeAccountIdentifier(ev?.account_email || ev?.accountEmail || ev?.extendedProps?.account_email || ev?.extendedProps?.accountEmail);
      if (!map.has(identity.key)) {
        map.set(identity.key, {
          key: identity.key,
          source: identity.source,
          account: identity.account,
          color: eventColor || providerFallbackColor(identity.source),
        });
      }
      if (eventColor && !colorMap[identity.key]) colorMap[identity.key] = eventColor;
      if (eventColor && normalizedEmail && !emailColorMap[normalizedEmail]) emailColorMap[normalizedEmail] = eventColor;
    }
  }
  state.accountLegend = Array.from(map.values());
  state.accountColorMap = colorMap;
  state.accountEmailColorMap = emailColorMap;
  state.legendSourceDays = daysRef;
  state.legendSourceAccounts = accountsRef;
  reconcileSelectedAccountKeys();
}

function resolveEventColor(ev) {
  const identity = eventAccountIdentity(ev);
  const exact = state.accountColorMap[identity.key];
  if (exact) return exact;

  const normalizedEventEmail = normalizeAccountIdentifier(
    ev?.account_email
    || ev?.accountEmail
    || ev?.extendedProps?.account_email
    || ev?.extendedProps?.accountEmail,
  );
  if (normalizedEventEmail) {
    const byEmail = state.accountEmailColorMap[normalizedEventEmail];
    if (byEmail) return byEmail;
  }

  // Fallback for legacy key formats where source/account order varied.
  const normalizedTargetAccount = normalizeAccountIdentifier(identity.account);
  for (const [rawKey, color] of Object.entries(state.accountColorMap || {})) {
    if (!color) continue;
    const parsed = parseCompositeAccountKey(rawKey);
    if (!parsed) continue;
    if (normalizeAccountSource(parsed.source) !== identity.source) continue;
    if (normalizeAccountIdentifier(parsed.account) === normalizedTargetAccount) return color;
  }

  const direct = normalizeHexColor(ev.color) || normalizeHexColor(ev?.extendedProps?.eventColor);
  if (direct) return direct;
  return providerFallbackColor(identity.source);
}

function renderAccountLegend() {
  if (!dom.accountLegend) return;
  if (!state.accountLegend.length) {
    dom.accountLegend.innerHTML = '<div class="tv-account-chip">No account legend available</div>';
    return;
  }
  const filtered = state.selectedAccountKeys.length > 0;
  const chips = state.accountLegend.map(item => {
    const bg = softColor(item.color, 0.2);
    const border = softColor(item.color, 0.55);
    const key = item.key || `${item.source}|${item.account}`;
    const active = !filtered || state.selectedAccountKeys.includes(key);
    return `<div class="tv-account-chip ${active ? 'active' : 'inactive'}" data-tv-click="account-chip" data-account-key="${escapeHtml(key)}" style="background:${bg}; border-color:${border};"><span class="tv-account-dot" style="background:${item.color};"></span><span>${escapeHtml(item.source)}: ${escapeHtml(item.account)}</span></div>`;
  }).join('');
  const userEmailChip = state.userEmail
    ? `<div class="tv-account-chip user-email-chip"><span>${escapeHtml(state.userEmail)}</span></div>`
    : '';
  dom.accountLegend.innerHTML = `${chips}<div class="tv-account-spacer"></div>${userEmailChip}`;
}

function renderHeader() {
  if (dom.dateHeader) {
    const d = parseLocalDate(state.selectedDate || toISO(new Date()));
    dom.dateHeader.textContent = `${currentViewLabel(state.currentView).toUpperCase()} • ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
  }
  if (dom.headerUserEmail) {
    dom.headerUserEmail.textContent = '';
    dom.headerUserEmail.style.display = 'none';
  }
}

function currentViewLabel(viewName) {
  if (viewName === '3-day') return '3-Day';
  if (viewName === 'week') return 'Week';
  if (viewName === 'month') return 'Month';
  return 'Day';
}

function renderMain() {
  if (!dom.tvMain) return;
  dom.tvMain.classList.toggle('tv-editor-active', Boolean(state.editor));
  dom.tvMain.classList.remove('tv-view-day', 'tv-view-three-day', 'tv-view-week', 'tv-view-month');
  if (state.currentView === 'month') {
    dom.tvMain.classList.add('tv-view-month');
    dom.tvMain.innerHTML = renderMonthView();
  } else if (state.currentView === 'week') {
    dom.tvMain.classList.add('tv-view-week');
    dom.tvMain.innerHTML = renderWeekView();
  } else if (state.currentView === '3-day') {
    dom.tvMain.classList.add('tv-view-three-day');
    dom.tvMain.innerHTML = renderThreeDayView();
  } else {
    dom.tvMain.classList.add('tv-view-day');
    dom.tvMain.innerHTML = renderSingleDayView();
  }
  if (state.editor) {
    const holder = dom.tvMain.querySelector('.tv-right-editor-anchor') || dom.tvMain.querySelector('.tv-editor-anchor');
    if (holder) holder.innerHTML = renderEditor();
  }
}

function renderThreeDayView() {
  const selected = parseLocalDate(state.selectedDate || toISO(new Date()));
  const dayDates = buildThreeDayDates(selected);
  return `
    <div class="tv-shell">
      ${renderLeftSidebar()}
      <div>
        ${renderTopControls()}
        <div class="tv-weekdays">${dayDates.map(dateKey => `<div class="tv-weekday-chip">${escapeHtml(parseLocalDate(dateKey).toLocaleDateString([], { weekday: 'short', month: 'short', day: '2-digit' }))}</div>`).join('')}</div>
        <div class="tv-main-grid day">${dayDates.map(dateKey => renderDayCard(dayData(dateKey), dateKey === state.selectedDate, dateKey !== state.selectedDate)).join('')}</div>
      </div>
      ${renderRightRail(state.selectedDate, buildWeekDates(selected))}
    </div>`;
}

function renderSingleDayView() {
  const selectedDateKey = state.selectedDate || toISO(new Date());
  const selected = parseLocalDate(selectedDateKey);
  const day = dayData(selectedDateKey);
  const schedule = buildDaySchedule(day, selectedDateKey);
  const weekDates = buildWeekDates(selected);
  const allDayItems = schedule.allDayEvents;
  const timedItems = schedule.timedEvents;
  const stickyNotes = Array.isArray(day.stickyNotes) ? day.stickyNotes : [];
  const freeBlocks = schedule.freeBlocks;
  const daySections = state.daySectionState || { allDay: true, freeTime: true, sticky: true };
  const allDayCollapsed = daySections.allDay !== false;
  const freeTimeCollapsed = daySections.freeTime !== false;
  const stickyCollapsed = daySections.sticky !== false;
  const timedColumnCount = getTimedEventColumnCount(timedItems.length);
  const timedRowCount = Math.max(1, Math.ceil(timedItems.length / timedColumnCount));
  const busyMinutes = timedItems.reduce((total, ev) => total + minutesBetween(parseDateTime(ev.start), parseDateTime(ev.end)), 0);
  const summaryBits = [
    `${allDayItems.length} all-day`,
    `${timedItems.length} timed`,
    `${stickyNotes.length} sticky`,
    `${busyMinutes} busy min`,
  ];
  return `
    <div class="tv-shell">
      ${renderLeftSidebar()}
      <div class="tv-single-day-pane">
        ${renderTopControls()}
        <div class="tv-single-day-summary">
          <div>
            <div class="tv-single-day-title">Day Selected</div>
            <div class="tv-single-day-subtitle">${escapeHtml(selected.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }))}</div>
          </div>
          <div class="tv-single-day-pills">${summaryBits.map(bit => `<span class="tv-hint-chip">${escapeHtml(bit)}</span>`).join('')}</div>
        </div>
        <div class="tv-single-day-grid">
          <section class="tv-day-section tv-day-section-wide ${allDayCollapsed ? 'collapsed' : ''}">
            <div class="tv-day-section-head">
              <div class="tv-day-section-title">All-Day Events</div>
              <div class="tv-day-section-meta">${allDayCollapsed ? `${allDayItems.length} item${allDayItems.length === 1 ? '' : 's'}` : 'Scheduling anchors that span the whole day'}</div>
              <button class="tv-day-section-toggle" type="button" data-tv-click="day-toggle" data-section="allDay">${allDayCollapsed ? 'Expand' : 'Collapse'}</button>
            </div>
            <div class="tv-day-section-body">
              <div class="tv-day-section-list">
                ${allDayItems.length ? allDayItems.map((ev, idx) => renderEventSummaryCard(ev, 'all-day', idx)).join('') : '<div class="tv-empty">No all-day events</div>'}
              </div>
              <section class="tv-day-section tv-day-subsection ${stickyCollapsed ? 'collapsed' : ''}">
                <div class="tv-day-section-head">
                  <div class="tv-day-section-title">Day Sticky Notes</div>
                  <div class="tv-day-section-meta">${stickyCollapsed ? `${stickyNotes.length} note${stickyNotes.length === 1 ? '' : 's'}` : 'Visible across the selected day'}</div>
                  <button class="tv-day-section-toggle" type="button" data-tv-click="day-toggle" data-section="sticky">${stickyCollapsed ? 'Expand' : 'Collapse'}</button>
                </div>
                <div class="tv-day-section-body">
                  <div class="tv-day-section-list compact">
                    ${stickyNotes.length ? stickyNotes.map(renderStickySummaryCard).join('') : '<div class="tv-empty">No sticky notes for this day</div>'}
                  </div>
                </div>
              </section>
            </div>
          </section>
          <section class="tv-day-section tv-day-section-wide">
            <div class="tv-day-section-head">
              <div class="tv-day-section-title">Timed Events</div>
              <div class="tv-day-section-meta">Ordered schedule with sticky-note markers and status context</div>
            </div>
            <div class="tv-day-section-body">
              <div class="tv-day-timed-grid ${timedColumnCount >= 3 ? 'dense' : ''} ${timedColumnCount >= 4 ? 'dense-4' : ''}" style="--timed-columns:${timedColumnCount}; --timed-rows:${timedRowCount};">
              ${timedItems.length ? timedItems.map((ev, idx) => renderEventSummaryCard(ev, 'timed', idx)).join('') : '<div class="tv-empty">No timed events</div>'}
              </div>
            </div>
          </section>
          <section class="tv-day-section ${freeTimeCollapsed ? 'collapsed' : ''}">
            <div class="tv-day-section-head">
              <div class="tv-day-section-title">Free Time</div>
              <div class="tv-day-section-meta">${freeTimeCollapsed ? `${freeBlocks.length} block${freeBlocks.length === 1 ? '' : 's'}` : 'Gaps between scheduled items (7:00 AM - 7:00 PM)'}</div>
              <button class="tv-day-section-toggle" type="button" data-tv-click="day-toggle" data-section="freeTime">${freeTimeCollapsed ? 'Expand' : 'Collapse'}</button>
            </div>
            <div class="tv-day-section-body">
              <div class="tv-day-section-list">
                ${freeBlocks.length ? freeBlocks.slice(0, 6).map(renderFreeBlockCard).join('') : '<div class="tv-empty">No free time blocks detected</div>'}
              </div>
            </div>
          </section>
        </div>
      </div>
      ${renderRightRail(selectedDateKey, weekDates)}
    </div>`;
}

function renderWeekView() {
  const selected = parseLocalDate(state.selectedDate || toISO(new Date()));
  const weekDates = buildWeekDates(selected);
  return `
    <div class="tv-shell">
      ${renderLeftSidebar()}
      <div>
        ${renderTopControls()}
        ${renderWeekdayHeader()}
        <div class="tv-main-grid week">${weekDates.map(dateKey => renderDayCard(dayData(dateKey), dateKey === state.selectedDate)).join('')}</div>
      </div>
      ${renderRightRail(state.selectedDate, weekDates)}
    </div>`;
}

function renderMonthView() {
  const anchorDate = parseLocalDate(state.selectedDate || toISO(new Date()));
  const monthAnchorKey = `${anchorDate.getFullYear()}-${String(anchorDate.getMonth() + 1).padStart(2, '0')}`;
  if (!state.monthDates.length || state.monthDatesAnchorKey !== monthAnchorKey) {
    state.monthDates = buildMonthDates(anchorDate);
    state.monthDatesAnchorKey = monthAnchorKey;
  }
  const selected = parseLocalDate(state.selectedDate || toISO(new Date()));
  const weekDates = buildWeekDates(selected);
  return `
  <div class="tv-shell month ${state.monthDetailOpen ? 'has-popout' : ''}">
    ${renderLeftSidebar()}
    <div>
      ${renderTopControls()}
      ${renderWeekdayHeader()}
      <div class="tv-main-grid month">
      ${state.monthDates.map((dateKey, idx) => renderMonthCell(dayData(dateKey), idx)).join('')}
      </div>
    </div>
    ${state.monthDetailOpen ? renderRightRail(state.selectedDate, weekDates, 'month-popout') : ''}
  </div>`;
}

function renderDayCard(day, selected, contextDay = false) {
  const date = parseLocalDate(day.date);
  const items = itemsForDate(day.date);
  const dayEvents = day.events || [];
  const hasDaySticky = Boolean((day.stickyNotes || []).length || dayEvents.some(ev => ev && eventHasStickyPayload(ev)));
  const now = new Date();
  const cards = items.length
    ? items.map((item, idx) => {
      const focused = day.date === state.selectedDate && idx === state.focus.itemIndex && state.focus.region === 'main';
      if (item.type === 'event') {
        const ev = item.event;
        const eventColor = resolveEventColor(ev);
        const bg = softColor(eventColor, eventIsNow(ev, now) ? 0.34 : 0.2);
        const border = softColor(eventColor, focused ? 0.7 : 0.5);
        const eventStickyIndicator = eventHasStickyPayload(ev) ? '<span class="tv-sticky-indicator" aria-label="Event sticky note"></span>' : '';
        return `<div class="tv-item ${focused ? 'focused' : ''} ${eventIsNow(ev, now) ? 'now' : ''} ${eventIsUpcoming(ev, now) ? 'next' : ''}" style="background:${bg}; border-color:${border}" data-tv-click="item" data-item-type="event" data-date="${escapeHtml(day.date)}" data-item-index="${idx}" data-event-id="${ev.id}">${eventStickyIndicator}<div class="tv-item-title">${escapeHtml(ev.title || 'Untitled')}</div><div class="tv-item-sub">${escapeHtml(formatTime(ev.start))} - ${escapeHtml(formatTime(ev.end))}</div><div class="tv-item-sub">${escapeHtml(ev.description || '')}</div></div>`;
      }
      return `<div class="tv-item ${focused ? 'focused' : ''}" data-tv-click="item" data-item-type="sticky" data-date="${escapeHtml(day.date)}" data-item-index="${idx}"><div class="tv-item-title">Sticky Note</div><div class="tv-item-sub">${escapeHtml(item.sticky.content || '')}</div></div>`;
    }).join('')
    : `<div class="tv-empty">No events or sticky notes</div>`;

  const stickyIndicator = hasDaySticky ? '<span class="tv-sticky-indicator" aria-label="Sticky note"></span>' : '';
  return `<div class="tv-day-card ${selected ? 'selected' : ''} ${contextDay ? 'context-day' : ''}" data-tv-click="day" data-date="${escapeHtml(day.date)}">${stickyIndicator}<div class="tv-day-head">${date.toLocaleDateString([], { weekday: 'long' })}</div><div class="tv-day-num">${date.getDate()}</div><div class="tv-item-list">${cards}</div><div class="tv-editor-anchor"></div></div>`;
}

function buildDaySchedule(day, dateKey) {
  const selectedDate = parseLocalDate(dateKey);
  const dayStart = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 7, 0, 0, 0);
  const dayEnd = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), selectedDate.getDate(), 19, 0, 0, 0);
  const events = filteredEventsForDay(day).slice().sort((left, right) => parseDateTime(left.start) - parseDateTime(right.start));
  const allDayEvents = events.filter(isAllDayLikeEvent);
  const timedEvents = events.filter((ev) => !isAllDayLikeEvent(ev));
  const freeBlocks = [];
  let cursor = new Date(dayStart);

  for (const ev of timedEvents) {
    const evStart = clampDateTimeToDay(parseDateTime(ev.start), dayStart, dayEnd);
    const evEnd = clampDateTimeToDay(parseDateTime(ev.end), dayStart, dayEnd);
    if (evStart - cursor >= 15 * 60000) {
      freeBlocks.push({ start: new Date(cursor), end: new Date(evStart) });
    }
    if (evEnd > cursor) {
      cursor = new Date(evEnd);
    }
  }

  if (dayEnd - cursor >= 15 * 60000) {
    freeBlocks.push({ start: new Date(cursor), end: new Date(dayEnd) });
  }

  return { allDayEvents, timedEvents, freeBlocks };
}

function clampDateTimeToDay(dateValue, dayStart, dayEnd) {
  const time = dateValue instanceof Date && !Number.isNaN(dateValue.getTime()) ? dateValue : new Date(dayStart);
  if (time < dayStart) return new Date(dayStart);
  if (time > dayEnd) return new Date(dayEnd);
  return time;
}

function isAllDayLikeEvent(ev) {
  if (!ev || typeof ev !== 'object') return false;
  const explicit = ev.allDay ?? ev.all_day ?? ev.isAllDay ?? ev.is_all_day;
  if (explicit === true) return true;
  if (typeof explicit === 'string') {
    const normalized = explicit.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  }

  const start = parseDateTime(ev.start);
  const end = parseDateTime(ev.end || ev.start);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return false;
  const durationMinutes = minutesBetween(start, end);
  const startMinutes = start.getHours() * 60 + start.getMinutes();
  const endMinutes = end.getHours() * 60 + end.getMinutes();
  return durationMinutes >= 20 * 60 && startMinutes === 0 && (endMinutes === 0 || endMinutes >= 23 * 60);
}

function minutesBetween(start, end) {
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 60000));
}

function formatDuration(minutes) {
  const total = Math.max(0, Math.round(Number(minutes) || 0));
  const hours = Math.floor(total / 60);
  const mins = total % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function renderEventSummaryCard(ev, bucket, index = 0) {
  const eventColor = resolveEventColor(ev);
  const now = new Date();
  const bg = softColor(eventColor, bucket === 'all-day' ? 0.26 : eventIsNow(ev, now) ? 0.34 : 0.2);
  const border = softColor(eventColor, 0.56);
  const duration = formatDuration(minutesBetween(parseDateTime(ev.start), parseDateTime(ev.end)));
  const sticky = eventHasStickyPayload(ev) ? '<span class="tv-sticky-indicator" aria-label="Event sticky note"></span>' : '';
  const timeLine = bucket === 'all-day'
    ? 'All day'
    : `${escapeHtml(formatTime(ev.start))} - ${escapeHtml(formatTime(ev.end))}`;
  const contextLine = bucket === 'all-day'
    ? `Duration ${escapeHtml(duration)}`
    : `Duration ${escapeHtml(duration)} • ${eventIsNow(ev, now) ? 'In progress' : eventIsUpcoming(ev, now) ? 'Upcoming' : 'Completed'}`;
  return `<div class="tv-day-event-card ${bucket}" data-tv-click="item" data-item-type="event" data-item-index="${index}" data-event-id="${ev.id}" style="background:${bg}; border-color:${border}">${sticky}<div class="tv-item-title">${escapeHtml(ev.title || 'Untitled')}</div><div class="tv-item-sub">${timeLine}</div><div class="tv-item-sub">${escapeHtml(ev.description || '') || contextLine}</div></div>`;
}

function renderFreeBlockCard(block) {
  const startLabel = block.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const endLabel = block.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const duration = formatDuration(minutesBetween(block.start, block.end));
  return `<div class="tv-day-event-card free"><div class="tv-item-title">Free Block</div><div class="tv-item-sub">${escapeHtml(startLabel)} - ${escapeHtml(endLabel)}</div><div class="tv-item-sub">Open for ${escapeHtml(duration)}</div></div>`;
}

function getTimedEventColumnCount(eventCount) {
  const count = Math.max(0, Math.trunc(Number(eventCount) || 0));
  const width = typeof window !== 'undefined' ? window.innerWidth : 0;
  const widthLimit = width >= 1700 ? 4 : width >= 1400 ? 3 : width >= 1100 ? 2 : 1;

  if (count >= 18) return Math.min(4, widthLimit);
  if (count >= 10) return Math.min(3, widthLimit);
  if (count >= 4) return Math.min(2, widthLimit);
  return 1;
}

function renderStickySummaryCard(sticky, index = 0) {
  const color = normalizeHexColor(sticky.color) || '#F7E68A';
  return `<div class="tv-day-event-card sticky" data-tv-click="item" data-item-type="sticky" data-item-index="${index}" style="background:${softColor(color, 0.28)}; border-color:${softColor(color, 0.62)}"><div class="tv-item-title">Sticky Note</div><div class="tv-item-sub">${escapeHtml(sticky.content || '')}</div></div>`;
}

function renderMonthCell(day, idx) {
  const date = parseLocalDate(day.date);
  const anchor = parseLocalDate(state.selectedDate || toISO(new Date()));
  const focused = state.focus.region === 'main' && state.focus.monthIndex === idx;
  const inMonth = date.getMonth() === anchor.getMonth();
  const selected = day.date === state.selectedDate;
  const dayEvents = filteredEventsForDay(day);
  const stickyNoteCount = Array.isArray(day.stickyNotes) ? day.stickyNotes.length : 0;
  const stickyEventCount = (day.events || []).filter(ev => ev && (ev.hasSticky || eventHasStickyPayload(ev))).length;
  const totalStickyCount = stickyNoteCount + stickyEventCount;
  const hasDaySticky = totalStickyCount > 0;
  const stickyBadgeText = totalStickyCount > 1 ? String(Math.min(totalStickyCount, 9)) : 'S';
  const stickyIndicator = hasDaySticky
    ? `<span class="tv-sticky-indicator tv-month-sticky-indicator" aria-label="${escapeHtml(`${totalStickyCount} sticky note${totalStickyCount === 1 ? '' : 's'} present`)}">${escapeHtml(stickyBadgeText)}</span>`
    : '';
  const count = dayEvents.length + (day.stickyNotes || []).length;
  const countLabel = count ? `${count} item${count === 1 ? '' : 's'}` : '&nbsp;';
  const previewHtml = dayEvents.length
    ? `<div class="tv-month-preview-list">${dayEvents.slice(0, 4).map(ev => {
      const eventColor = resolveEventColor(ev);
      const bg = softColor(eventColor, 0.2);
      const border = softColor(eventColor, 0.52);
      const stickyFlag = eventHasStickyPayload(ev) ? '<span class="tv-inline-sticky" aria-label="Event sticky note">S</span>' : '';
      return `<div class="tv-month-preview" style="background:${bg}; border-color:${border}"><span class="tv-month-preview-time">${escapeHtml(formatTime(ev.start))}</span><span class="tv-month-preview-title">${escapeHtml(ev.title || 'Untitled')}</span>${stickyFlag}</div>`;
    }).join('')}</div>`
    : '<div class="tv-month-preview">No events</div>';
  return `<div class="tv-month-cell ${focused ? 'focused' : ''} ${selected ? 'selected' : ''} ${inMonth ? '' : 'outside'}" data-tv-click="month-cell" data-month-index="${idx}" data-date="${escapeHtml(day.date)}">${stickyIndicator}<div class="tv-month-date">${date.getDate()}</div><div class="tv-month-count">${countLabel}</div>${previewHtml}</div>`;
}

function renderEditor() {
  if (!state.editor) return '';
  const fieldsHtml = state.editor.fields.map((f, idx) => `<div class="tv-field ${idx === state.editor.fieldIndex ? 'focused' : ''}" data-tv-click="field" data-field-index="${idx}"><div class="tv-field-name">${escapeHtml(f.label)}</div><div class="tv-field-value">${escapeHtml(formatFieldValue(f.key, state.editor.data[f.key]))}</div></div>`).join('');
  return `<div class="tv-editor"><div class="tv-editor-title">Inline Editing</div>${fieldsHtml}<div class="tv-hint-chip">UP/DOWN field • LEFT/RIGHT change • SELECT save • ESC cancel</div></div>`;
}

function renderFooterHint(extra) {
  if (!dom.statusEl || !dom.lastUpdated) return;
  const modeLabel = isLockedMode() ? 'LOCKED' : isCursorMode() ? 'CURSOR' : 'NAV';
  dom.statusEl.innerHTML = `<span class="tv-status-chip">Mode ${modeLabel}</span><span class="tv-status-sep">•</span><span class="tv-status-chip">Zoom ${state.zoomLevel}%</span>`;
  if (state.syncInProgress) {
    dom.lastUpdated.classList.remove('tv-sync-ok', 'tv-sync-fail');
    dom.lastUpdated.classList.add('syncing');
    dom.lastUpdated.textContent = 'Syncing...';
    return;
  }
  const hasSyncStatus = state.syncStatusTone && Date.now() < state.syncStatusUntil;
  if (hasSyncStatus) {
    dom.lastUpdated.textContent = state.syncStatusMessage || (state.syncStatusTone === 'ok' ? 'Sync Succeed' : 'Sync Failed');
    dom.lastUpdated.classList.toggle('tv-sync-ok', state.syncStatusTone === 'ok');
    dom.lastUpdated.classList.toggle('tv-sync-fail', state.syncStatusTone === 'fail');
    dom.lastUpdated.classList.remove('syncing');
    return;
  }
  dom.lastUpdated.classList.remove('tv-sync-ok', 'tv-sync-fail', 'syncing');
  dom.lastUpdated.textContent = extra || buildDynamicRemoteHelpText();
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
  state.editorDirty = false;
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
  state.editorDirty = false;
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
    state.editorDirty = false;
    render();
    return true;
  }
  return false;
}

function handleMainClick(e) {
  const t = e.target.closest('[data-tv-click]');
  if (!t) {
    if (state.currentView === 'month' && state.monthDetailOpen) {
      state.monthDetailOpen = false;
      render();
    }
    return;
  }

  const role = t.getAttribute('data-tv-click');
  if (state.editor && role !== 'field') {
    const navRoles = ['control', 'sidebar', 'day', 'month-cell'];
    closeEditor(navRoles.includes(role));
    if (state.editor) return;
  }

  if (role === 'sidebar') {
    const idx = Number(t.getAttribute('data-sidebar-index') || 0);
    state.focus.region = 'sidebar';
    state.focus.sidebarIndex = idx;
    state.monthDetailOpen = false;
    onSelect();
    return;
  }

  if (role === 'account-chip') {
    const key = t.getAttribute('data-account-key') || '';
    if (state.accountChipPressFired) {
      state.accountChipPressFired = false;
      return;
    }
    clickAccountChip(key, Boolean(e.ctrlKey || e.metaKey));
    return;
  }

  if (role === 'month-cell') {
    const idx = Number(t.getAttribute('data-month-index') || 0);
    const date = t.getAttribute('data-date');
    state.focus.region = 'main';
    state.focus.monthIndex = idx;
    if (date) {
      closeUtilityPanel();
      if (state.monthDetailOpen && state.selectedDate === date) {
        state.monthDetailOpen = false;
        render();
        return;
      }
      state.monthDetailOpen = true;
      patchTvState({ selectedDate: date }, { recordHistory: true }).then(() => {
        render();
        refreshEvents(true);
      });
    }
    return;
  }

  if (role === 'day') {
    const date = t.getAttribute('data-date');
    if (date) {
      closeUtilityPanel();
      state.monthDetailOpen = false;
      patchTvState({ selectedDate: date }, { recordHistory: true }).then(() => refreshEvents(true));
    }
    return;
  }

  if (role === 'day-toggle') {
    const section = t.getAttribute('data-section');
    if (section && state.daySectionState && Object.prototype.hasOwnProperty.call(state.daySectionState, section)) {
      state.daySectionState = {
        ...state.daySectionState,
        [section]: !state.daySectionState[section],
      };
      render();
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
    return;
  }

  if (role === 'control') {
    const control = t.getAttribute('data-control');
    if (control === 'close-panel') {
      closeUtilityPanel();
      render();
      return;
    }
    if (control === 'prev') {
      shiftByView(-1);
      return;
    }
    if (control === 'next') {
      shiftByView(1);
      return;
    }
    if (control === 'today') {
      goToday();
      return;
    }
    if (control === 'back') {
      goBackAction();
      return;
    }
    if (control === 'view-day') {
      state.monthDetailOpen = false;
      setView('day', { applyHomeZoom: true });
      return;
    }
    if (control === 'view-three-day') {
      closeUtilityPanel();
      state.monthDetailOpen = false;
      setView('3-day');
      return;
    }
    if (control === 'view-week') {
      closeUtilityPanel();
      state.monthDetailOpen = false;
      setView('week');
      return;
    }
    closeUtilityPanel();
    if (control === 'view-month') {
      setView('month');
      return;
    }
    if (control === 'save-zoom-default') {
      saveCurrentZoomAsDefault();
      return;
    }
    if (control === 'toggle-cursor-mode') {
      toggleCursorMode();
      return;
    }
    if (control === 'toggle-lock-mode') {
      toggleLockMode();
      return;
    }
    if (control === 'zoom-in') {
      zoomIn();
      return;
    }
    if (control === 'zoom-out') {
      zoomOut();
      return;
    }
    if (control === 'restore-home-zoom') {
      applyHomeZoomPreference();
      renderFooterHint(`Home zoom restored to ${state.zoomLevel}%`);
      return;
    }
    if (control === 'zoom-reset') {
      resetZoom();
      return;
    }
    closeUtilityPanel();
    if (control === 'exit') {
      exitTvAction();
    }
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
    state.editorDirty = true;
    return;
  }

  if (field === 'title') {
    data.title = cycleValue(TITLE_PRESETS, data.title, direction);
    state.editorDirty = true;
    return;
  }

  if (field === 'description') {
    data.description = cycleValue(DESC_PRESETS, data.description, direction);
    state.editorDirty = true;
    return;
  }

  if (field === 'content') {
    data.content = cycleValue(STICKY_PRESETS, data.content, direction);
    state.editorDirty = true;
    return;
  }

  if (field === 'color') {
    data.color = cycleValue(STICKY_COLORS, data.color, direction);
    state.editorDirty = true;
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
  state.editorDirty = false;
  await refreshEvents(true);
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
  if (!str || typeof str !== 'string' || str.length < 10) return new Date();
  const [y, m, d] = str.slice(0, 10).split('-').map(Number);
  if (![y, m, d].every(Number.isFinite)) return new Date();
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

function providerFallbackColor(source) {
  const normalized = normalizeAccountSource(source);
  if (normalized === 'google') return '#34A853';
  if (normalized === 'microsoft') return '#2563EB';
  if (normalized === 'apple') return '#EF4444';
  if (normalized === 'local') return '#7CA3AF';
  return '#8EA4C4';
}

function buildEventsRequestUrl(stateOverride = null) {
  const params = new URLSearchParams();
  const selectedDate = String((stateOverride && stateOverride.selectedDate) || state.selectedDate || '').trim();
  if (selectedDate) {
    params.set('selectedDate', selectedDate);
  }

  const requestedViewRaw = String((stateOverride && stateOverride.currentView) || state.currentView || '').trim().toLowerCase();
  if (TV_VIEW_NAMES.has(requestedViewRaw)) {
    params.set('currentView', requestedViewRaw);
  }

  const query = params.toString();
  return query ? `/tv/events?${query}` : '/tv/events';
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

document.addEventListener('DOMContentLoaded', () => {
  void init();
});
