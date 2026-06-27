import { api, setAuthToken } from "/static/api.js";

function normalizeProvider(provider) {
  const p = (provider || "").toLowerCase().trim();
  if (["google", "gmail"].includes(p)) return "google";
  if (["microsoft", "ms", "outlook", "office365", "msft"].includes(p)) return "microsoft";
  if (["apple", "icloud", "caldav"].includes(p)) return "apple";
  return p || "other";
}

function setGlobalMessage(message, kind = "error") {
  const errorBox = document.getElementById("error");
  if (!errorBox) return;
  errorBox.className = kind === "success" ? "status-line success" : kind === "info" ? "status-line" : "error";
  errorBox.textContent = message || "";
}

function getHealthStatus(acc) {
  if (acc.status === "ok") return `<span style="color:#16a34a; font-weight:600;">OK</span>`;
  if (acc.status === "error") return `<span style="color:#dc2626; font-weight:600;">Needs Attention</span>`;
  return `<span style="color:#64748b;">Unknown</span>`;
}

function buildReconnectUrl(provider, email) {
  const token = localStorage.getItem("token") || "";
  if (!token) return "/accounts/ui";

  const safeProvider = normalizeProvider(provider);
  const encodedToken = encodeURIComponent(token);
  const encodedEmail = encodeURIComponent((email || "").trim());

  if (safeProvider === "google") return `/auth/google/login?token=${encodedToken}&reconnect=${encodedEmail}`;
  if (safeProvider === "microsoft") return `/ms/login?token=${encodedToken}&reconnect=${encodedEmail}`;
  if (safeProvider === "apple") return `/accounts/ui?reconnect=apple&email=${encodedEmail}`;

  return "/accounts/ui";
}

function setButtonBusy(button, label) {
  if (!button) return;
  button.disabled = true;
  button.dataset.originalLabel = button.dataset.originalLabel || button.textContent;
  button.innerHTML = `<span class="inline-spinner"></span>${label}`;
}

function resetButton(button) {
  if (!button) return;
  button.disabled = false;
  if (button.dataset.originalLabel) {
    button.textContent = button.dataset.originalLabel;
  }
}

function getAppleKnownEmails() {
  try {
    const raw = localStorage.getItem("appleKnownEmails");
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function rememberAppleEmail(email) {
  const clean = (email || "").trim().toLowerCase();
  if (!clean) return;
  const emails = getAppleKnownEmails();
  const next = [clean, ...emails.filter((item) => item !== clean)].slice(0, 8);
  localStorage.setItem("appleKnownEmails", JSON.stringify(next));
  renderAppleEmailSuggestions();
}

function renderAppleEmailSuggestions() {
  const datalist = document.getElementById("apple-email-options");
  if (!datalist) return;
  const emails = getAppleKnownEmails();
  datalist.innerHTML = emails.map((email) => `<option value="${email}"></option>`).join("");
}

function updateAppleSetupVisibility(accounts = []) {
  const appleAccounts = accounts.filter((acc) => normalizeProvider(acc.provider) === "apple");
  const hasAppleSuccess = appleAccounts.some((acc) => acc.status === "ok");
  const setupBlock = document.getElementById("apple-details");
  const requirements = document.getElementById("apple-requirements");

  if (requirements) {
    requirements.classList.toggle("hidden", hasAppleSuccess);
  }

  if (setupBlock) {
    setupBlock.open = !hasAppleSuccess;
  }
}

function markPendingCalendarSync(provider, email) {
  const payload = {
    provider: normalizeProvider(provider),
    account: (email || "").toLowerCase().trim(),
    createdAt: Date.now(),
  };
  localStorage.setItem("postReconnectSync", JSON.stringify(payload));
}

function goToCalendar() {
  window.location.href = "/calendar-ui";
}

function goToAdmin() {
  window.location.href = "/admin/ui";
}

async function hydrateAdminNavigation() {
  const adminBtn = document.getElementById("adminPanelBtn");
  if (!adminBtn) return;

  adminBtn.classList.add("hidden");

  try {
    const res = await api.get("/users/me");
    if (res && res.ok) {
      const me = await res.json();
      const role = String(me?.role || "").toLowerCase();
      adminBtn.dataset.userRole = role;
      if (role === "admin") {
        adminBtn.classList.remove("hidden");
      }
      return;
    }

    // Fallback guard: if role payload is unavailable, probe an admin-only route.
    const adminProbe = await api.get("/admin/users");
    if (adminProbe && adminProbe.ok) {
      adminBtn.classList.remove("hidden");
      return;
    }
  } catch (error) {
    console.warn("Unable to determine admin role for accounts nav", error);
  }
}

function addGoogle() {
  const token = localStorage.getItem("token") || "";
  if (!token) {
    window.location.href = "/login";
    return;
  }
  window.location.href = `/auth/google/login?token=${encodeURIComponent(token)}`;
}

function addMicrosoft() {
  const token = localStorage.getItem("token") || "";
  if (!token) {
    window.location.href = "/login";
    return;
  }
  window.location.href = `/ms/login?token=${encodeURIComponent(token)}`;
}

function toggleAppleForm() {
  const details = document.getElementById("apple-details");
  if (!details) return;
  details.open = true;
  details.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function onRetrySuccess(account) {
  if (account) {
    markPendingCalendarSync(account.provider, account.account_email);
  }
  window.dispatchEvent(new Event("accountsUpdated"));
}

async function retryAccount(id, button) {
  setGlobalMessage("", "info");
  setButtonBusy(button, "Retrying...");

  try {
    const res = await api.post(`/accounts/${id}/retry`);
    if (!res) {
      setGlobalMessage("Retry request failed.");
      return;
    }

    const data = await res.json();
    if (!res.ok || data.success === false) {
      setGlobalMessage(data.error || data.message || "Retry failed.");
      return;
    }

    setGlobalMessage(data.message || "Sync retry succeeded.", "success");
    await loadAccounts();
    onRetrySuccess(data.account || null);
  } catch (error) {
    console.error(error);
    setGlobalMessage("Retry failed due to a network or server error.");
  } finally {
    resetButton(button);
  }
}

async function reconnectAccount(provider, email, button) {
  setButtonBusy(button, "Opening...");
  try {
    markPendingCalendarSync(provider, email);
    window.location.href = buildReconnectUrl(provider, email);
  } finally {
    resetButton(button);
  }
}

async function setPrimary(id) {
  await api.put(`/accounts/${id}/set-primary`);
  await loadAccounts();
  window.dispatchEvent(new Event("accountsUpdated"));
}

async function toggleSync(id, enabled) {
  await api.put(`/accounts/${id}/sync/${enabled}`);
  await loadAccounts();
  window.dispatchEvent(new Event("accountsUpdated"));
}

async function removeAccount(id) {
  await api.del(`/accounts/${id}`);
  await loadAccounts();
  window.dispatchEvent(new Event("accountsUpdated"));
}

function renderProviderAccounts(provider, list) {
  const container = document.getElementById(provider + "Accounts");
  if (!container) return;

  container.innerHTML = "";

  if (!list.length) {
    container.innerHTML = "<i>No accounts</i>";
    return;
  }

  list.forEach((acc) => {
    const div = document.createElement("div");
    div.className = "account";

    const reconnectVisible = acc.status === "error" && (normalizeProvider(acc.provider) === "google" || normalizeProvider(acc.provider) === "microsoft" || normalizeProvider(acc.provider) === "apple");

    div.innerHTML = `
      <div class="left">
        <span class="provider ${provider}">${provider.toUpperCase()}</span>
        <span>${acc.account_email || "UNKNOWN"}</span>
        ${acc.is_primary ? "⭐" : ""}
        <span style="margin-left:8px; font-size:12px;">${getHealthStatus(acc)}</span>
      </div>
      <div class="account-actions">
        <button data-action="primary">Primary</button>
        <button data-action="toggle">${acc.sync_enabled ? "Disable" : "Enable"}</button>
        <button data-action="remove">Remove</button>
        <button data-action="retry">Retry</button>
        ${reconnectVisible ? "<button data-action=\"reconnect\">Reconnect</button>" : ""}
      </div>
    `;

    div.querySelector('[data-action="primary"]').onclick = () => setPrimary(acc.id);
    div.querySelector('[data-action="toggle"]').onclick = () => toggleSync(acc.id, !acc.sync_enabled);
    div.querySelector('[data-action="remove"]').onclick = () => removeAccount(acc.id);
    div.querySelector('[data-action="retry"]').onclick = (e) => retryAccount(acc.id, e.currentTarget);

    const reconnectBtn = div.querySelector('[data-action="reconnect"]');
    if (reconnectBtn) {
      reconnectBtn.onclick = (e) => reconnectAccount(acc.provider, acc.account_email, e.currentTarget);
    }

    container.appendChild(div);
  });
}

async function loadAccounts() {
  const res = await api.get("/accounts");
  if (!res) {
    setGlobalMessage("Failed to load accounts.");
    return [];
  }

  if (!res.ok) {
    setGlobalMessage("Failed to load accounts.");
    return [];
  }

  const payload = await res.json();
  const accounts = Array.isArray(payload) ? payload : payload.accounts || [];

  updateAppleSetupVisibility(accounts);
  renderAppleEmailSuggestions();

  const groups = { google: [], microsoft: [], apple: [] };
  accounts.forEach((acc) => {
    const key = normalizeProvider(acc.provider);
    if (groups[key]) groups[key].push(acc);
  });

  renderProviderAccounts("google", groups.google);
  renderProviderAccounts("microsoft", groups.microsoft);
  renderProviderAccounts("apple", groups.apple);

  return accounts;
}

async function testApple(button) {
  const email = document.getElementById("apple-email").value.trim();
  const password = document.getElementById("apple-password").value.trim();
  const statusDiv = document.getElementById("apple-status");

  if (!email || !password) {
    statusDiv.textContent = "Enter Apple ID email and App Password.";
    statusDiv.className = "status-line error";
    return;
  }

  setButtonBusy(button, "Testing...");
  statusDiv.textContent = "Testing connection...";
  statusDiv.className = "status-line";

  try {
    const res = await api.post("/accounts/apple/test", {
      email,
      app_password: password,
      caldav_url: "https://caldav.icloud.com",
    });

    if (!res) {
      statusDiv.textContent = "Connection test failed.";
      statusDiv.className = "status-line error";
      return;
    }

    const data = await res.json();
    if (!res.ok || data.success === false) {
      statusDiv.textContent = data.message || "Connection test failed.";
      statusDiv.className = "status-line error";
      return;
    }

    rememberAppleEmail(email);
    statusDiv.textContent = data.message || "Connection successful.";
    statusDiv.className = "status-line success";
  } catch (error) {
    console.error(error);
    statusDiv.textContent = "Connection test failed.";
    statusDiv.className = "status-line error";
  } finally {
    resetButton(button);
  }
}

async function connectApple(button) {
  const email = document.getElementById("apple-email").value.trim();
  const password = document.getElementById("apple-password").value.trim();
  const statusDiv = document.getElementById("apple-status");

  if (!email || !password) {
    statusDiv.textContent = "Enter Apple ID email and App Password.";
    statusDiv.className = "status-line error";
    return;
  }

  setButtonBusy(button, "Connecting...");
  statusDiv.textContent = "Connecting...";
  statusDiv.className = "status-line";

  try {
    const res = await api.post("/accounts/apple/connect", {
      email,
      app_password: password,
      caldav_url: "https://caldav.icloud.com",
    });

    if (!res) {
      statusDiv.textContent = "Connection failed.";
      statusDiv.className = "status-line error";
      return;
    }

    const data = await res.json();
    if (!res.ok || data.success === false) {
      statusDiv.textContent = data.message || "Connection failed.";
      statusDiv.className = "status-line error";
      return;
    }

    rememberAppleEmail(email);
    markPendingCalendarSync("apple", email);
    statusDiv.textContent = data.message || "Apple connected.";
    statusDiv.className = "status-line success";

    const accounts = await loadAccounts();
    window.dispatchEvent(new Event("accountsUpdated"));

    const isOnboarding = document.body.dataset.onboarding === "1";
    if (isOnboarding && Array.isArray(accounts) && accounts.length > 0) {
      window.location.href = "/calendar-ui";
      return;
    }
  } catch (error) {
    console.error(error);
    statusDiv.textContent = "Connection failed.";
    statusDiv.className = "status-line error";
  } finally {
    resetButton(button);
  }
}

function applyQueryState() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const connected = params.get("connected");
  const connectedAccount = params.get("account");
  const oauthError = params.get("error");
  const onboarding = params.get("onboarding");

  if (token) {
    setAuthToken(token);
    if (connected && connectedAccount) {
      markPendingCalendarSync(connected, connectedAccount);
    }
  }

  if (oauthError) {
    setGlobalMessage(oauthError.replace(/_/g, " "));
  }

  if (connected) {
    setGlobalMessage(
      connectedAccount ? `Connected ${connectedAccount} successfully.` : `Connected ${connected} successfully.`,
      "success"
    );
    window.dispatchEvent(new Event("accountsUpdated"));
  }

  if (onboarding === "1") {
    document.body.dataset.onboarding = "1";
    const guide = document.getElementById("onboardingGuide");
    if (guide) {
      guide.style.display = "block";
      setTimeout(() => guide.scrollIntoView({ behavior: "smooth", block: "start" }), 120);
    }
  }

  window.history.replaceState({}, "", window.location.pathname);
}

function handleAppleReconnectParam() {
  const p = new URLSearchParams(window.location.search);
  const reconnect = p.get("reconnect");
  const email = p.get("email");
  if (reconnect === "apple") {
    const details = document.getElementById("apple-details");
    if (details) {
      details.open = true;
      setTimeout(() => details.scrollIntoView({ behavior: "smooth", block: "center" }), 150);
    }

    if (email) {
      const emailInput = document.getElementById("apple-email");
      if (emailInput) emailInput.value = decodeURIComponent(email);
    }

    const statusDiv = document.getElementById("apple-status");
    if (statusDiv) {
      statusDiv.textContent = "Re-enter your App Password to reconnect Apple.";
      statusDiv.className = "status-line";
    }
  }
}

async function init() {
  applyQueryState();
  handleAppleReconnectParam();
  renderAppleEmailSuggestions();

  if (!localStorage.getItem("token")) {
    window.location.href = "/login";
    return;
  }

  await hydrateAdminNavigation();

  const accounts = await loadAccounts();

  if (document.body.dataset.onboarding === "1" && Array.isArray(accounts) && accounts.length > 0) {
    window.location.href = "/calendar-ui";
  }
}

window.addEventListener("accountsUpdated", async () => {
  await loadAccounts();
});

window.goToCalendar = goToCalendar;
window.goToAdmin = goToAdmin;
window.addGoogle = addGoogle;
window.addMicrosoft = addMicrosoft;
window.toggleAppleForm = toggleAppleForm;
window.setPrimary = setPrimary;
window.toggleSync = toggleSync;
window.removeAccount = removeAccount;
window.retryAccount = retryAccount;
window.reconnectAccount = reconnectAccount;

window.testApple = () => testApple(document.getElementById("apple-test-btn"));
window.connectApple = () => connectApple(document.getElementById("apple-connect-btn"));

init();
