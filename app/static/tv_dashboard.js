'use strict';

const TOKEN_KEY = 'tv_token';
// TV state remains backend-driven. Use low-frequency auto poll; interactions trigger immediate refresh.
const POLL_MS = 300000;
const LONG_PRESS_MS = 600;

const IS_KIOSK = Boolean(window.KIOSK_TOKEN);

// tvDiag is assigned after state is initialised (below).
// Declaring it here with let means wakeLock/antiSleep callbacks can safely
// reference it at runtime without a temporal-dead-zone crash.
let tvDiag = null;

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
    if (_sentinel && !_sentinel.released) return;

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
      _sentinel.release().catch(() => {});
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
  let _rafHandle  = null;
  let _evtHandle  = null;
  let _tick = 0;
  let _lastRafTs  = null;
  let _gapCb      = null;

  // ── Layer 2: Hidden canvas (rAF loop keeps GPU renderer active) ──────────
  const _canvas = document.createElement('canvas');
  _canvas.width  = 2;   // 2×2 so captureStream has real pixels
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
        _videoEl.srcObject   = stream;
        _videoEl.muted       = true;
        _videoEl.loop        = true;
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
      try { _videoEl.pause(); } catch {}
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
    try { if (_audioOsc) _audioOsc.stop();  } catch {}
    try { if (_audioCtx) _audioCtx.close(); } catch {}
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
      }, 20000);
      console.log('[AntiSleep] Layer 3 synthetic events: started (20s)');
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

  function setRafGapCb(fn) { _gapCb = fn; }

  return { start, stop, setRafGapCb };
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
  syncInProgress: false,
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
  editorDirty: false,
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
  accountLegend: [],
  serverAccounts: [],
  accountColorMap: {},
  selectedAccountKeys: [],
  accountChipPressTimer: null,
  accountChipPressFired: false,
  accountChipClickTimer: null,
  accountChipClickCount: 0,
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
    try { localStorage.setItem(KEY, id); } catch {}
  }
  return id;
})();
tvDiag = (() => {
  const MAX = 60;
  const _buf = [];

  function _elapsed() {
    if (!state.sessionStartAt) return '—';
    return `${Math.floor((Date.now() - state.sessionStartAt) / 60000)}m`;
  }

  function log(event, details = '') {
    const entry = {
      t:        new Date().toISOString(),
      ms:       Date.now(),
      event,
      details:  String(details).slice(0, 200),
      guard:    state.sleepGuardEnabled,
      timeout:  state.sleepGuardTimeoutMinutes,
      elapsed:  _elapsed(),
      vis:      document.visibilityState,
    };
    _buf.push(entry);
    if (_buf.length > MAX) _buf.shift();

    // Persist last 20 entries to localStorage (survives backgrounding)
    try { localStorage.setItem('tv_diag', JSON.stringify(_buf.slice(-20))); } catch {}

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
    const token = state.token || (IS_KIOSK ? window.KIOSK_TOKEN : null);
    if (!token) return;
    fetch('/tv/diag', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({
        event:            entry.event,
        details:          entry.details,
        ts:               entry.t,
        sessionElapsedMin: state.sessionStartAt ? Math.floor((Date.now() - state.sessionStartAt) / 60000) : null,
        visibilityState:  entry.vis,
        guardEnabled:     entry.guard,
        guardTimeout:     entry.timeout,
        device_id:        TV_DEVICE_ID,
      }),
      keepalive: true,   // delivers even when page is unloading
    }).catch(() => {});  // never block on diagnostics
  }

  function getLog() { return [..._buf]; }

  return { log, getLog };
})();

// Wire the RAF frame-gap callback now that tvDiag is ready
antiSleep.setRafGapCb((deltaMs) => {
  tvDiag.log('raf_gap', `${Math.round(deltaMs / 1000)}s gap \u2014 OS may be throttling renderer`);
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
    diagLine:    document.getElementById('tv-diag-line'),
  };
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
  @keyframes tv-sync-chip-pulse { 0% { opacity: 0.55; } 50% { opacity: 1; } 100% { opacity: 0.55; } }
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
  .tv-main.tv-view-day .tv-day-card { min-height: 0; }
  .tv-main.tv-view-day .tv-item-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; align-content: start; overflow-y: auto; }
  .tv-main.tv-view-day .tv-day-card.selected .tv-item-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .tv-main.tv-view-day .tv-day-card.context-day .tv-item-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }

  /* Lock day-view card column density across all TV widths. */
  @media (max-width: 9999px) {
    .tv-main.tv-view-day .tv-day-card.selected .tv-item-list { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .tv-main.tv-view-day .tv-day-card.context-day .tv-item-list { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }
  .tv-main.tv-view-day .tv-day-card.context-day { opacity: 0.84; background: rgba(11, 20, 33, 0.34); }
  .tv-main.tv-view-day .tv-day-card.context-day .tv-day-num { opacity: 0.85; }
  .tv-main.tv-view-day .tv-day-card.context-day .tv-item { opacity: 0.74; }
  .tv-main.tv-view-day .tv-day-card.context-day .tv-item-title { font-size: 14px; font-weight: 500; color: rgba(198, 213, 232, 0.9); }
  .tv-main.tv-view-day .tv-day-card.context-day .tv-item-sub { font-size: 11px; color: rgba(168, 184, 206, 0.82); }
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
  .tv-sticky-indicator { position: absolute; top: 4px; right: 4px; z-index: 4; width: 14px; height: 14px; border-radius: 2px; background: #ffe26a; border: 1px solid rgba(145,112,18,0.96); box-shadow: 0 0 0 1px rgba(255,255,255,0.34) inset, 0 1px 4px rgba(0,0,0,0.35); display: inline-flex; align-items: center; justify-content: center; }
  .tv-sticky-indicator::before { content: 'S'; font-size: 8px; font-weight: 800; color: rgba(48,34,0,0.9); line-height: 1; }
  .tv-sticky-indicator::after { content: ''; position: absolute; right: 0; top: 0; width: 0; height: 0; border-left: 5px solid transparent; border-top: 5px solid rgba(255,255,255,0.72); }
  .tv-month-date { font-size: 18px; font-weight: 700; margin-bottom: 6px; }
  .tv-month-count { font-size: 10px; opacity: 0.68; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.8px; }
  .tv-month-preview-list { display: flex; flex-direction: column; gap: 3px; margin-top: 2px; }
  .tv-month-preview { position: relative; border: 1px solid rgba(201,219,244,0.22); border-radius: 7px; padding: 2px 5px; font-size: 10px; opacity: 0.96; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.2; }
  .tv-month-preview-time { opacity: 0.92; margin-right: 4px; font-weight: 700; }
  .tv-month-preview-title { opacity: 0.96; }
  .tv-inline-sticky { display: inline-flex; align-items: center; justify-content: center; width: 11px; height: 11px; border-radius: 2px; margin-left: 4px; border: 1px solid rgba(145,112,18,0.9); background: rgba(255,226,106,0.98); color: rgba(48,34,0,0.9); font-size: 7px; font-weight: 800; }
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
  #tv-virtual-cursor { position: fixed; width: 18px; height: 18px; border-radius: 50%; border: 2px solid #4f8cff; box-shadow: 0 0 0 2px rgba(79,140,255,0.18); background: rgba(79,140,255,0.2); pointer-events: none; z-index: 999999; transform: translate(-50%, -50%); display: none; }
  #tv-debug-overlay { position: fixed; right: 12px; bottom: 52px; width: 420px; max-height: 50vh; overflow: hidden; background: rgba(9,12,20,0.92); border: 1px solid rgba(79,140,255,0.35); border-radius: 10px; box-shadow: 0 12px 26px rgba(0,0,0,0.45); z-index: 999998; color: #d7e6ff; display: none; }
  #tv-debug-overlay.visible { display: block; }
  .tv-debug-head { padding: 8px 10px; border-bottom: 1px solid rgba(79,140,255,0.22); font-size: 11px; letter-spacing: 1.2px; text-transform: uppercase; color: #8eb7ff; display: flex; justify-content: space-between; }
  #tv-debug-list { list-style: none; margin: 0; padding: 8px 10px; max-height: 40vh; overflow-y: auto; font-family: Menlo, Consolas, monospace; font-size: 11px; line-height: 1.5; }
  .tv-debug-row { white-space: pre-wrap; word-break: break-word; border-bottom: 1px dashed rgba(255,255,255,0.08); padding: 2px 0; }
  .tv-debug-row:last-child { border-bottom: 0; }

  /* Broadcast typography scaling by view */
  .tv-main.tv-view-day .tv-day-num { font-size: 32px; }
  .tv-main.tv-view-day .tv-item-title { font-size: 18px; font-weight: 700; letter-spacing: 0.18px; }
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

  dom.cursor = document.getElementById('tv-virtual-cursor');
  dom.debugOverlay = document.getElementById('tv-debug-overlay');
  dom.debugList = document.getElementById('tv-debug-list');

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
    if (!document.hidden) {
      refreshEvents(true);
      // Re-acquire wake lock — the OS always releases it when the tab hides.
      if (state.token) wakeLock.reacquire();
      if (state.sleepGuardEnabled !== false) antiSleep.start();
    }
  });

  // window blur / focus — fires when focus shifts (e.g., FireOS overlay opens)
  window.addEventListener('blur',  () => { if (tvDiag) tvDiag.log('window_blur',  `vis=${document.visibilityState}`); });
  window.addEventListener('focus', () => {
    if (tvDiag) tvDiag.log('window_focus', `vis=${document.visibilityState}`);
    if (state.token && document.visibilityState === 'visible') {
      wakeLock.reacquire();
      if (state.sleepGuardEnabled !== false) antiSleep.start();
    }
  });

  // pagehide / pageshow — fires on navigation and bfcache restore
  window.addEventListener('pagehide', (e) => { if (tvDiag) tvDiag.log('pagehide', `persisted=${e.persisted}`); });
  window.addEventListener('pageshow', (e) => {
    if (tvDiag) tvDiag.log('pageshow', `persisted=${e.persisted}`);
    if (state.token && document.visibilityState === 'visible') {
      wakeLock.reacquire();
      if (state.sleepGuardEnabled !== false) antiSleep.start();
    }
  });

  // Page Lifecycle API (Chromium 68+ / Amazon Silk)
  // 'freeze' fires when the browser decides to freeze the page (CPU saving).
  // This is the last chance to log before the page stops executing.
  document.addEventListener('freeze',  () => { if (tvDiag) tvDiag.log('page_freeze',  'browser froze the page'); });
  document.addEventListener('resume',  () => {
    if (tvDiag) tvDiag.log('page_resume', 'page resumed from frozen state');
    if (state.token) { wakeLock.reacquire(); if (state.sleepGuardEnabled !== false) antiSleep.start(); }
  });

  // beforeunload — last sync opportunity before page is torn down
  window.addEventListener('beforeunload', () => { if (tvDiag) tvDiag.log('beforeunload', 'page unloading'); });
  // ────────────────────────────────────────────────────────────────────────────

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
  state.sessionStartAt = Date.now();
  if (tvDiag) tvDiag.log('session_start', `guard=${state.sleepGuardEnabled} timeout=${state.sleepGuardTimeoutMinutes}min`);
  refreshEvents(true);
  state.pollHandle = setInterval(refreshEvents, POLL_MS);
  state.clockHandle = setInterval(tickClock, 1000);
  // Heartbeat every 60 s — confirms guard is alive between visible events
  state.heartbeatHandle = setInterval(() => {
    if (tvDiag) tvDiag.log('heartbeat',
      `elapsed=${Math.floor((Date.now()-state.sessionStartAt)/60000)}m` +
      ` guard=${state.sleepGuardEnabled}` +
      ` timeout=${state.sleepGuardTimeoutMinutes}` +
      ` rafActive=${window.__ANTI_SLEEP_ACTIVE__}` +
      ` wakeLock=${window.__WAKE_LOCK_ACTIVE__}`);
  }, 60000);
  tickClock();
  // Layer 1: Screen Wake Lock API
  wakeLock.request();
  // Layers 2+3: rAF canvas loop + synthetic events (main FireOS defense)
  if (state.sleepGuardEnabled !== false) antiSleep.start();
}

function stopAll() {
  if (state.pollHandle)     clearInterval(state.pollHandle);
  if (state.clockHandle)    clearInterval(state.clockHandle);
  if (state.heartbeatHandle) clearInterval(state.heartbeatHandle);
  state.pollHandle = null;
  state.clockHandle = null;
  state.heartbeatHandle = null;
  // Release wake lock on clean teardown (unpair / logout).
  wakeLock.release();
  antiSleep.stop();
}

function tickClock() {
  if (dom.clock) {
    dom.clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  renderSleepStatus();
  enforceSleepTimeout();
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

  const totalSecs  = Math.floor((Date.now() - state.sessionStartAt) / 1000);
  const hours      = Math.floor(totalSecs / 3600);
  const mins       = Math.floor((totalSecs % 3600) / 60);
  const elapsed    = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

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
  let v = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 8);
  if (v.length > 4) v = `${v.slice(0, 4)}-${v.slice(4)}`;
  e.target.value = v;
}

function setPairError(message) {
  if (!dom.pairError) return;
  dom.pairError.textContent = message || '';
  dom.pairError.style.display = message ? 'block' : 'none';
}

function applySyncVisualState() {
  if (!dom.accountLegend) return;
  dom.accountLegend.classList.toggle('syncing', Boolean(state.syncInProgress));
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
  state.editorDirty = false;
  state.monthDetailOpen = false;
  state.syncInProgress = false;
  if (state.syncStatusTimer) clearTimeout(state.syncStatusTimer);
  state.syncStatusTimer = null;
  state.syncStatusTone = null;
  state.syncStatusUntil = 0;
  state.serverAccounts = [];
  state.accountLegend = [];
  state.accountColorMap = {};
  state.selectedAccountKeys = [];
  state.accountChipPressFired = false;
  if (state.accountChipPressTimer) clearTimeout(state.accountChipPressTimer);
  if (state.accountChipClickTimer) clearTimeout(state.accountChipClickTimer);
  state.accountChipPressTimer = null;
  state.accountChipClickTimer = null;
  state.accountChipClickCount = 0;
  closeUtilityPanel();
  state.userEmail = null;
  state.userRole = null;
  state.history.past = [];
  state.history.future = [];
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
  const showSync = Boolean(options && options.showSync);
  if (document.hidden && !force) {
    return;
  }

  const nowMs = Date.now();
  if (!force && state.lastEventsFetchAt && (nowMs - state.lastEventsFetchAt) < POLL_MS) {
    return;
  }

  if (state.eventsRequestInFlight) {
    state.eventsRefreshQueued = true;
    state.queuedRefreshForce = state.queuedRefreshForce || force;
    return;
  }

  state.eventsRequestInFlight = true;
  if (showSync) {
    state.syncInProgress = true;
    applySyncVisualState();
  }
  state.lastEventsFetchAt = nowMs;
  const res = await authFetch('/tv/events');
  try {
    if (!res) {
      if (showSync) setSyncStatus(false, 'Sync Failed');
      return;
    }
    if (!res.ok) {
      renderFooterHint(`Data sync issue: /tv/events returned ${res.status}`);
      if (showSync) setSyncStatus(false, 'Sync Failed');
      return;
    }

    const data = await res.json().catch(() => ({}));
    if (data.selectedDate) state.selectedDate = data.selectedDate;
    if (data.currentView) state.currentView = data.currentView;
    state.days = data.days || [];
    state.serverAccounts = data.accounts || [];
    state.dayMap = {};
    for (const day of state.days) state.dayMap[day.date] = day;
    const summary = data.summary || {};
    const eventCount = Number(summary.eventCount || 0);
    const stickyCount = Number(summary.stickyCount || 0);
    const totalItems = eventCount + stickyCount;
    syncFocusAfterData();
    render();
    if (showSync) {
      if (totalItems > 0) {
        setSyncStatus(true, 'Sync Succeed');
      } else {
        setSyncStatus(true, 'Sync Succeed - No data in current view window');
      }
    }
  } finally {
    state.eventsRequestInFlight = false;
    if (showSync) {
      state.syncInProgress = false;
      applySyncVisualState();
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
    state.monthDetailOpen = true;
    patchTvState({ selectedDate: date }, { recordHistory: true }).then(() => refreshEvents(true));
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
  if (date) patchTvState({ selectedDate: date }, { recordHistory: true });
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
    render();
    patchTvState({ selectedDate: toISO(d) }, { recordHistory: true }).then(() => refreshEvents(true));
    return;
  }
  const next = offsetDate(d, direction * delta);
  state.selectedDate = toISO(next);
  render();
  patchTvState({ selectedDate: toISO(next) }, { recordHistory: true }).then(() => refreshEvents(true));
}

function goToday() {
  closeEditor(true);
  state.monthDetailOpen = false;
  state.selectedDate = toISO(new Date());
  render();
  patchTvState({ selectedDate: toISO(new Date()) }, { recordHistory: true }).then(() => refreshEvents(true));
}

function setView(viewName) {
  closeEditor(true);
  state.currentView = viewName;
  if (viewName !== 'month') state.monthDetailOpen = false;
  render();
  patchTvState({ currentView: viewName }, { recordHistory: true }).then(() => refreshEvents(true));
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
        <button class="tv-btn view ${state.currentView === 'week' ? 'active' : ''}" type="button" data-tv-click="control" data-control="view-week">Week</button>
        <button class="tv-btn view ${state.currentView === 'month' ? 'active' : ''}" type="button" data-tv-click="control" data-control="view-month">Month</button>
        <button class="tv-btn active" type="button" disabled>${escapeHtml(dateText)}</button>
      </div>
    </div>`;
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
  return `
    <aside class="tv-right-rail ${extraClass}">
      <div class="tv-right-title">${escapeHtml(parseLocalDate(selectedDateKey).toLocaleDateString([], { weekday: 'long', month: 'short', day: '2-digit', year: 'numeric' }))}</div>
      <div class="tv-right-list">
        ${selectedItems.length ? selectedItems.map(item => {
          if (item.type === 'event') {
            const eventColor = resolveEventColor(item.event);
            const sticky = item.event.hasSticky ? '<span class="tv-sticky-indicator" aria-label="Event sticky note"></span>' : '';
            return `<div class="tv-right-item" style="background:${softColor(eventColor, 0.2)}; border-color:${softColor(eventColor, 0.52)}">${sticky}<div class="tv-right-item-time">${escapeHtml(formatTime(item.event.start))}</div><div class="tv-right-item-title">${escapeHtml(item.event.title || 'Untitled')}</div></div>`;
          }
          return `<div class="tv-right-item"><div class="tv-right-item-time">Sticky</div><div class="tv-right-item-title">${escapeHtml(item.sticky.content || '')}</div></div>`;
        }).join('') : '<div class="tv-empty">No events or sticky notes</div>'}
      </div>
      <div class="tv-right-subtitle">This Week</div>
      <div class="tv-right-list">
        ${weekEvents.length ? weekEvents.slice(0, 12).map(row => {
          const eventColor = resolveEventColor(row.ev);
          const sticky = row.ev.hasSticky ? '<span class="tv-sticky-indicator" aria-label="Event sticky note"></span>' : '';
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
    { key: 'view-day', label: 'View Day', group: 'primary', action: () => setView('day') },
    { key: 'view-week', label: 'View Week', group: 'primary', action: () => setView('week') },
    { key: 'view-month', label: 'View Month', group: 'primary', action: () => setView('month') },
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
  patchTvState({ focusedEventId: item.id }, { recordHistory: false });
}

function getFocusedMonthDate() {
  const date = state.monthDates[state.focus.monthIndex];
  return date || null;
}

function eventAccountKey(ev) {
  const source = ev.source || 'local';
  const account = ev.accountEmail || source;
  return `${source}|${account}`;
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
  const allEvents = sortEventsAsc(day.events || []);
  return allEvents.filter(ev => isAccountVisibleForEvent(ev));
}

function itemsForDate(dateKey) {
  const day = state.dayMap[dateKey];
  if (!day) return [];
  const events = filteredEventsForDay(day).map(ev => ({ type: 'event', id: ev.id, date: dateKey, event: ev }));
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
  const colorMap = {};

  for (const account of (state.serverAccounts || [])) {
    const source = account.provider || account.source || 'local';
    const email = account.accountEmail || account.email || source;
    const color = normalizeHexColor(account.color) || '#9AA3B2';
    const key = `${source}|${email}`;
    map.set(key, { source, account: email, color });
    colorMap[key] = color;
    colorMap[email] = color;
  }

  for (const day of state.days) {
    for (const ev of (day.events || [])) {
      const source = ev.source || 'local';
      const account = ev.accountEmail || source;
      const key = `${source}|${account}`;
      const eventColor = normalizeHexColor(ev.color);
      if (!map.has(key)) {
        map.set(key, {
          source,
          account,
          color: eventColor || '#9AA3B2',
        });
      }
      if (eventColor && !colorMap[key]) colorMap[key] = eventColor;
      if (eventColor && !colorMap[account]) colorMap[account] = eventColor;
    }
  }
  state.accountLegend = Array.from(map.values());
  state.accountColorMap = colorMap;
  if (state.selectedAccountKeys.length) {
    const allowed = new Set(state.accountLegend.map(item => `${item.source}|${item.account}`));
    state.selectedAccountKeys = state.selectedAccountKeys.filter(key => allowed.has(key));
  }
}

function resolveEventColor(ev) {
  const source = ev.source || 'local';
  const account = ev.accountEmail || source;
  const exact = state.accountColorMap[`${source}|${account}`];
  if (exact) return exact;
  const byAccount = state.accountColorMap[account];
  if (byAccount) return byAccount;
  const direct = normalizeHexColor(ev.color);
  if (direct) return direct;
  return '#8EA4C4';
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
    const key = `${item.source}|${item.account}`;
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
    dom.dateHeader.textContent = `${state.currentView.toUpperCase()} • ${d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
  }
  if (dom.headerUserEmail) {
    dom.headerUserEmail.textContent = '';
    dom.headerUserEmail.style.display = 'none';
  }
}

function renderMain() {
  if (!dom.tvMain) return;
  dom.tvMain.classList.toggle('tv-editor-active', Boolean(state.editor));
  dom.tvMain.classList.remove('tv-view-day', 'tv-view-week', 'tv-view-month');
  if (state.currentView === 'month') {
    dom.tvMain.classList.add('tv-view-month');
    dom.tvMain.innerHTML = renderMonthView();
  } else if (state.currentView === 'week') {
    dom.tvMain.classList.add('tv-view-week');
    dom.tvMain.innerHTML = renderWeekView();
  } else {
    dom.tvMain.classList.add('tv-view-day');
    dom.tvMain.innerHTML = renderDayView();
  }
  if (state.editor) {
    const holder = dom.tvMain.querySelector('.tv-right-editor-anchor') || dom.tvMain.querySelector('.tv-editor-anchor');
    if (holder) holder.innerHTML = renderEditor();
  }
}

function renderDayView() {
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
  state.monthDates = buildMonthDates(parseLocalDate(state.selectedDate || toISO(new Date())));
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
  const hasDaySticky = Boolean((day.stickyNotes || []).length || dayEvents.some(ev => ev && ev.hasSticky));
  const now = new Date();
  const cards = items.length
    ? items.map((item, idx) => {
        const focused = day.date === state.selectedDate && idx === state.focus.itemIndex && state.focus.region === 'main';
        if (item.type === 'event') {
          const ev = item.event;
          const eventColor = resolveEventColor(ev);
          const bg = softColor(eventColor, eventIsNow(ev, now) ? 0.34 : 0.2);
          const border = softColor(eventColor, focused ? 0.7 : 0.5);
          const eventStickyIndicator = ev.hasSticky ? '<span class="tv-sticky-indicator" aria-label="Event sticky note"></span>' : '';
          return `<div class="tv-item ${focused ? 'focused' : ''} ${eventIsNow(ev, now) ? 'now' : ''} ${eventIsUpcoming(ev, now) ? 'next' : ''}" style="background:${bg}; border-color:${border}" data-tv-click="item" data-item-type="event" data-date="${escapeHtml(day.date)}" data-item-index="${idx}" data-event-id="${ev.id}">${eventStickyIndicator}<div class="tv-item-title">${escapeHtml(ev.title || 'Untitled')}</div><div class="tv-item-sub">${escapeHtml(formatTime(ev.start))} - ${escapeHtml(formatTime(ev.end))}</div><div class="tv-item-sub">${escapeHtml(ev.description || '')}</div></div>`;
        }
        return `<div class="tv-item ${focused ? 'focused' : ''}" data-tv-click="item" data-item-type="sticky" data-date="${escapeHtml(day.date)}" data-item-index="${idx}"><div class="tv-item-title">Sticky Note</div><div class="tv-item-sub">${escapeHtml(item.sticky.content || '')}</div></div>`;
      }).join('')
    : `<div class="tv-empty">No events or sticky notes</div>`;

  const stickyIndicator = hasDaySticky ? '<span class="tv-sticky-indicator" aria-label="Sticky note"></span>' : '';
  return `<div class="tv-day-card ${selected ? 'selected' : ''} ${contextDay ? 'context-day' : ''}" data-tv-click="day" data-date="${escapeHtml(day.date)}">${stickyIndicator}<div class="tv-day-head">${date.toLocaleDateString([], { weekday: 'long' })}</div><div class="tv-day-num">${date.getDate()}</div><div class="tv-item-list">${cards}</div><div class="tv-editor-anchor"></div></div>`;
}

function renderMonthCell(day, idx) {
  const date = parseLocalDate(day.date);
  const anchor = parseLocalDate(state.selectedDate || toISO(new Date()));
  const focused = state.focus.region === 'main' && state.focus.monthIndex === idx;
  const inMonth = date.getMonth() === anchor.getMonth();
  const selected = day.date === state.selectedDate;
  const dayEvents = filteredEventsForDay(day);
  const hasDaySticky = Boolean((day.stickyNotes || []).length || (day.events || []).some(ev => ev && ev.hasSticky));
  const stickyIndicator = hasDaySticky ? '<span class="tv-sticky-indicator" aria-label="Sticky note"></span>' : '';
  const count = dayEvents.length + (day.stickyNotes || []).length;
  const countLabel = count ? `${count} item${count === 1 ? '' : 's'}` : '&nbsp;';
  const previewHtml = dayEvents.length
    ? `<div class="tv-month-preview-list">${dayEvents.slice(0, 4).map(ev => {
      const eventColor = resolveEventColor(ev);
      const bg = softColor(eventColor, 0.2);
      const border = softColor(eventColor, 0.52);
      const stickyFlag = ev.hasSticky ? '<span class="tv-inline-sticky" aria-label="Event sticky note">S</span>' : '';
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
  dom.statusEl.textContent = state.centerArrowMode ? 'Arrow Mode: ON' : 'Arrow Mode: OFF';
  const hasSyncStatus = state.syncStatusTone && Date.now() < state.syncStatusUntil;
  if (hasSyncStatus) {
    dom.lastUpdated.textContent = state.syncStatusMessage || (state.syncStatusTone === 'ok' ? 'Sync Succeed' : 'Sync Failed');
    dom.lastUpdated.classList.toggle('tv-sync-ok', state.syncStatusTone === 'ok');
    dom.lastUpdated.classList.toggle('tv-sync-fail', state.syncStatusTone === 'fail');
    return;
  }
  dom.lastUpdated.classList.remove('tv-sync-ok', 'tv-sync-fail');
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
      setView('day');
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
