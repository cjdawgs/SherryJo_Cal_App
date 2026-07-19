(() => {
  const STYLE_ID = "sj-window-controls-style";
  const MINI_BAR_ID = "appWindowMiniBar";
  const CLOSED_PANEL_ID = "appWindowClosedPanel";

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .appWindowControls {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
        margin-left: auto;
        z-index: 20;
      }
      .appWindowControlBtn,
      .appWindowRestoreBtn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border: 1px solid rgba(148, 163, 184, 0.58);
        border-radius: 7px;
        background: rgba(255, 255, 255, 0.88);
        color: #1f3658;
        font-size: 15px;
        font-weight: 800;
        line-height: 1;
        cursor: pointer;
      }
      .appWindowControlBtn:hover,
      .appWindowRestoreBtn:hover {
        background: #eaf1fb;
      }
      .appWindowControlBtn.close:hover {
        border-color: #f1a7a7;
        background: #fee2e2;
        color: #991b1b;
      }
      .appWindowMiniBar,
      .appWindowClosedPanel {
        position: fixed;
        inset: 16px auto auto 16px;
        display: none;
        align-items: center;
        gap: 10px;
        padding: 10px 12px;
        border: 1px solid rgba(148, 163, 184, 0.45);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.94);
        color: #1f3658;
        box-shadow: 0 18px 40px rgba(15, 23, 42, 0.18);
        z-index: 99999;
        font: 700 13px Arial, sans-serif;
      }
      .appWindowClosedPanel {
        inset: 50% auto auto 50%;
        transform: translate(-50%, -50%);
        flex-direction: column;
        text-align: center;
        min-width: min(340px, calc(100vw - 32px));
      }
      body.appWindowMinimized > :not(.appWindowMiniBar):not(script):not(style) {
        display: none !important;
      }
      body.appWindowMinimized .appWindowMiniBar {
        display: inline-flex;
      }
      body.appWindowClosed > :not(.appWindowClosedPanel):not(script):not(style) {
        display: none !important;
      }
      body.appWindowClosed .appWindowClosedPanel {
        display: flex;
      }
      body.appWindowMaximized {
        min-height: 100vh;
      }
      body.appWindowMaximized .appWindowControlBtn[data-app-window-action="maximize"] {
        background: #dbeafe;
        border-color: #93c5fd;
      }
    `;
    document.head.appendChild(style);
  }

  function ensureMiniBar() {
    let bar = document.getElementById(MINI_BAR_ID);
    if (bar) return bar;
    bar = document.createElement("div");
    bar.id = MINI_BAR_ID;
    bar.className = "appWindowMiniBar";
    bar.innerHTML = `<span>SherryJo Calendar</span><button type="button" class="appWindowRestoreBtn" data-app-window-restore="minimize">Restore</button>`;
    document.body.appendChild(bar);
    return bar;
  }

  function ensureClosedPanel() {
    let panel = document.getElementById(CLOSED_PANEL_ID);
    if (panel) return panel;
    panel = document.createElement("div");
    panel.id = CLOSED_PANEL_ID;
    panel.className = "appWindowClosedPanel";
    panel.innerHTML = `<strong>Window closed</strong><button type="button" class="appWindowRestoreBtn" data-app-window-restore="close">Restore</button>`;
    document.body.appendChild(panel);
    return panel;
  }

  function getHeaderTarget() {
    return document.querySelector(".topbar-inner, .accountsTopbar, .admin-header, .tv-header, .card, body");
  }

  function setMaximizeButton(maximized) {
    document.querySelectorAll(".appWindowControlBtn[data-app-window-action='maximize']").forEach((button) => {
      button.setAttribute("aria-label", maximized ? "Restore window" : "Maximize window");
      button.title = maximized ? "Restore" : "Maximize";
      button.textContent = maximized ? "❐" : "□";
    });
  }

  async function toggleMaximized() {
    const shouldRestore = Boolean(document.fullscreenElement) || document.body.classList.contains("appWindowMaximized");
    try {
      if (shouldRestore) {
        if (document.fullscreenElement) await document.exitFullscreen();
        document.body.classList.remove("appWindowMaximized");
        setMaximizeButton(false);
        return;
      }
      if (document.documentElement.requestFullscreen) {
        await document.documentElement.requestFullscreen();
      }
      document.body.classList.add("appWindowMaximized");
      setMaximizeButton(true);
    } catch {
      document.body.classList.toggle("appWindowMaximized");
      setMaximizeButton(document.body.classList.contains("appWindowMaximized"));
    }
  }

  function closeAppWindow() {
    window.close();
    setTimeout(() => {
      if (!window.closed) {
        ensureClosedPanel();
        document.body.classList.add("appWindowClosed");
      }
    }, 80);
  }

  function installControls() {
    if (document.querySelector(".appWindowControls")) return;
    ensureStyles();
    ensureMiniBar();
    ensureClosedPanel();

    const target = getHeaderTarget();
    if (!target) return;

    const controls = document.createElement("div");
    controls.className = "appWindowControls";
    controls.innerHTML = `
      <button type="button" class="appWindowControlBtn" data-app-window-action="minimize" aria-label="Minimize window" title="Minimize">−</button>
      <button type="button" class="appWindowControlBtn" data-app-window-action="maximize" aria-label="Maximize window" title="Maximize">□</button>
      <button type="button" class="appWindowControlBtn close" data-app-window-action="close" aria-label="Close window" title="Close">×</button>
    `;
    target.appendChild(controls);
  }

  document.addEventListener("click", (event) => {
    const restore = event.target.closest?.("[data-app-window-restore]");
    if (restore) {
      document.body.classList.remove("appWindowMinimized", "appWindowClosed");
      return;
    }

    const button = event.target.closest?.(".appWindowControlBtn[data-app-window-action]");
    if (!button) return;

    event.preventDefault();
    const action = button.dataset.appWindowAction;
    if (action === "minimize") document.body.classList.add("appWindowMinimized");
    if (action === "maximize") toggleMaximized();
    if (action === "close") closeAppWindow();
  });

  document.addEventListener("fullscreenchange", () => {
    const maximized = Boolean(document.fullscreenElement);
    document.body.classList.toggle("appWindowMaximized", maximized);
    setMaximizeButton(maximized);
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installControls, { once: true });
  } else {
    installControls();
  }
})();
