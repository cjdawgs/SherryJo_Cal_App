import { api, setAuthToken } from "/static/api.js";

let pendingRemediationTarget = null;

function normalizeProvider(provider) {
  const p = (provider || "").toLowerCase().trim();
  if (["google", "gmail"].includes(p)) return "google";
  if (["microsoft", "ms", "outlook", "office365", "msft"].includes(p)) return "microsoft";
  if (["apple", "icloud", "caldav"].includes(p)) return "apple";
  return p || "other";
}

function normalizeRemedyAction(action) {
  const value = String(action || "").toLowerCase().trim();
  if (["verify", "verify_access", "retry", "retry_sync"].includes(value)) return "verify";
  if (value === "reconnect") return "reconnect";
  return "verify";
}

function setGlobalMessage(message, kind = "error") {
  const errorBox = document.getElementById("error");
  if (!errorBox) return;
  errorBox.className = kind === "success" ? "status-line success" : kind === "info" ? "status-line" : "error";
  errorBox.textContent = message || "";
}

function getIssueSteps(acc) {
  const steps = Array.isArray(acc?.token_issue?.resolution_steps) ? acc.token_issue.resolution_steps : [];
  return steps.map((step) => String(step || "").trim()).filter(Boolean);
}

function buildIssueGuidance(acc) {
  const steps = getIssueSteps(acc);
  if (!steps.length) return "";
  return steps.map((step, index) => `${index + 1}. ${step}`).join(" ");
}

function setSyncStatus(message, meta = "") {
  const text = document.getElementById("sync-status-text");
  const metaBox = document.getElementById("sync-status-meta");
  if (text) text.textContent = message || "";
  if (metaBox) metaBox.textContent = meta || "";
}

function renderSyncDetailList(statusPayload = null) {
  const detailList = document.getElementById("sync-detail-list");
  const select = document.getElementById("sync-account-select");
  if (!detailList || !select) return;

  const accounts = Array.isArray(statusPayload?.accounts) ? statusPayload.accounts : [];
  const previousSelection = [...select.selectedOptions].map((option) => option.value).filter(Boolean);
  const shouldDefaultAll = previousSelection.length === 0 || previousSelection.includes("__all__");
  const selectionSet = new Set(shouldDefaultAll ? accounts.map((account) => String(account.id)) : previousSelection);

  select.innerHTML = [`<option value="__all__">All Accounts</option>`].concat(accounts.map((account) => {
    const label = `${account.provider?.toUpperCase?.() || account.provider} - ${account.account_email || "Unknown"}`;
    const isSelected = selectionSet.has(String(account.id));
    return `<option value="${account.id}" ${isSelected ? "selected" : ""}>${isSelected ? "✓ " : ""}${label}</option>`;
  })).join("");

  if (!accounts.length) {
    detailList.innerHTML = '<div class="syncDetailItem">No sync-enabled accounts found.</div>';
    setSyncStatus("No sync-enabled accounts found.", "");
    return;
  }

  if (shouldDefaultAll) {
    [...select.options].forEach((option) => {
      option.selected = option.value !== "__all__";
    });
  }

  const effectiveSelection = [...select.selectedOptions].map((option) => option.value);
  const selectedIds = effectiveSelection.includes("__all__") || !effectiveSelection.length
    ? accounts.map((account) => String(account.id))
    : effectiveSelection;

  const selectedAccounts = accounts.filter((account) => selectedIds.includes(String(account.id)));
  const chosen = selectedAccounts[0] || accounts[0];

  const scheduler = statusPayload?.scheduler || {};
  const lines = selectedAccounts.length > 1
    ? [
      {
        title: `Selected accounts (${selectedAccounts.length})`,
        body: selectedAccounts.map((account) => `${account.provider?.toUpperCase?.() || account.provider} - ${account.account_email || "Unknown"} (${account.status || "unknown"})`).join(" | "),
      },
      {
        title: "Current preferences",
        body: [`Range: ${chosen.sync_range_days || 30} days`, `Frequency: ${chosen.sync_frequency_minutes || 5} min`, `Enabled: ${chosen.sync_enabled ? "yes" : "no"}`].join(" | "),
      },
      {
        title: "Scheduler health",
        body: [`Last started: ${scheduler.last_started_at || "unknown"}`, `Last finished: ${scheduler.last_finished_at || "unknown"}`, `Next run: ${scheduler.next_run_at || "unknown"}`].join(" | "),
      },
    ]
    : [
      {
        title: `${chosen.provider?.toUpperCase?.() || chosen.provider} - ${chosen.account_email || "Unknown"}`,
        body: [
          `Status: ${chosen.status || "unknown"}`,
          `Last sync: ${chosen.last_sync_success || chosen.last_sync_failure || chosen.last_sync || "never"}`,
          `Last error: ${chosen.last_error || "none"}`,
        ].join(" | "),
      },
      {
        title: "Current preferences",
        body: [`Range: ${chosen.sync_range_days || 30} days`, `Frequency: ${chosen.sync_frequency_minutes || 5} min`, `Enabled: ${chosen.sync_enabled ? "yes" : "no"}`].join(" | "),
      },
      {
        title: "Scheduler health",
        body: [`Last started: ${scheduler.last_started_at || "unknown"}`, `Last finished: ${scheduler.last_finished_at || "unknown"}`, `Next run: ${scheduler.next_run_at || "unknown"}`].join(" | "),
      },
    ];

  detailList.innerHTML = lines.map((line) => `<div class="syncDetailItem"><strong>${line.title}</strong><span>${line.body}</span></div>`).join("");
  setSyncStatus(
    selectedAccounts.length > 1
      ? `Selected accounts: ${selectedAccounts.length}`
      : `Selected account: ${chosen.account_email || "Unknown"}`,
    `Range ${chosen.sync_range_days || 30} days • Every ${chosen.sync_frequency_minutes || 5} min • ${scheduler.running ? "scheduler running" : "scheduler idle"}`
  );

  const rangeInput = document.getElementById("sync-range-days");
  const freqInput = document.getElementById("sync-frequency-minutes");
  if (rangeInput) rangeInput.value = String(chosen.sync_range_days || 30);
  if (freqInput) freqInput.value = String(chosen.sync_frequency_minutes || 5);
}

function getSelectedSyncAccounts() {
  const select = document.getElementById("sync-account-select");
  if (!select) return [];

  const selectedValues = [...select.selectedOptions].map((option) => option.value);
  if (!selectedValues.length || selectedValues.includes("__all__")) {
    return [...select.options]
      .filter((option) => option.value !== "__all__")
      .map((option) => option.value)
      .filter(Boolean);
  }

  return selectedValues.filter((value) => value !== "__all__");
}

function syncAccountSelectionSummary() {
  const select = document.getElementById("sync-account-select");
  if (!select) return;

  const selectedCount = [...select.selectedOptions].filter((option) => option.value !== "__all__").length;
  const hint = select.parentElement?.querySelector(".syncFieldHint");
  if (hint) {
    hint.textContent = selectedCount > 0
      ? `${selectedCount} account${selectedCount === 1 ? "" : "s"} selected. Use All Accounts or Ctrl/Cmd+Click to change the selection.`
      : "Choose All Accounts or use Ctrl/Cmd+Click to pick multiple accounts.";
  }
}

async function fetchSyncStatus() {
  const res = await api.get("/accounts/sync-status");
  if (!res || !res.ok) {
    setSyncStatus("Unable to load sync status.", "");
    return null;
  }

  const payload = await res.json();
  renderSyncDetailList(payload);
  return payload;
}

async function refreshAllSyncStatus() {
  setSyncStatus("Refreshing sync health...", "Please wait");
  await fetchSyncStatus();
  await loadAccounts();
  syncAccountSelectionSummary();
}

async function saveSyncSettings() {
  const rangeInput = document.getElementById("sync-range-days");
  const freqInput = document.getElementById("sync-frequency-minutes");
  const selectedAccountIds = getSelectedSyncAccounts();

  if (!selectedAccountIds.length) {
    setGlobalMessage("Select one or more accounts first.");
    return;
  }

  const payload = {
    sync_range_days: Number(rangeInput?.value || 30),
    sync_frequency_minutes: Number(freqInput?.value || 5),
  };

  for (const accountId of selectedAccountIds) {
    const res = await api.put(`/accounts/${accountId}/sync-settings`, payload);
    if (!res) {
      setGlobalMessage("Unable to save sync settings.");
      return;
    }

    const data = await res.json();
    if (!res.ok) {
      setGlobalMessage(data.detail || data.message || "Unable to save sync settings.");
      return;
    }
  }

  setGlobalMessage("Sync settings saved.", "success");
  await refreshAllSyncStatus();
}

async function manualRefreshSelectedAccount() {
  const selectedAccountIds = getSelectedSyncAccounts();
  if (!selectedAccountIds.length) {
    setGlobalMessage("Select one or more accounts first.");
    return;
  }

  setSyncStatus(
    selectedAccountIds.length > 1 ? "Manual refresh requested for multiple accounts..." : "Manual refresh requested...",
    "Syncing your account data now"
  );

  for (const accountId of selectedAccountIds) {
    const res = await api.post(`/accounts/${accountId}/refresh-sync`);
    if (!res) {
      setGlobalMessage("Manual refresh failed to start.");
      return;
    }

    const data = await res.json();
    if (!res.ok || data.success === false) {
      setGlobalMessage(data.message || data.detail || data.error || "Manual refresh failed.");
      return;
    }
  }

  setGlobalMessage("Manual refresh started for the selected accounts.", "success");
  await refreshAllSyncStatus();
}

function getHealthStatus(acc) {
  if (acc.status === "ok") return `<span style="color:#16a34a; font-weight:600;">OK</span>`;
  if (acc.status === "error") {
    const code = String(acc?.token_issue?.code || "").trim();
    if (code) {
      return `<span style="color:#dc2626; font-weight:600;">Needs Attention (${code.replaceAll("_", " ")})</span>`;
    }
    return `<span style="color:#dc2626; font-weight:600;">Needs Attention</span>`;
  }
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
      const remediation = data?.remediation || {};
      const steps = Array.isArray(remediation.steps) ? remediation.steps.filter(Boolean) : [];
      const guidance = steps.length ? ` Steps: ${steps.map((step, index) => `${index + 1}) ${step}`).join(" ")}` : "";
      setGlobalMessage((data.error || data.message || "Retry failed.") + guidance);
      await loadAccounts();
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
    div.dataset.accountKey = normalizeAccountKey(acc.provider, acc.account_email);

    const normalizedProvider = normalizeProvider(acc.provider);
    const retryLabel = normalizedProvider === "microsoft" ? "Verify Access" : "Refresh Sync";
    const retryTitle = normalizedProvider === "microsoft"
      ? "Checks both read access and publish/create access for this Microsoft calendar account."
      : "Runs an immediate sync health check for this account using saved credentials.";

    const reconnectVisible = acc.status === "error"
      && !Boolean(acc?.token_issue?.requires_admin)
      && (normalizeProvider(acc.provider) === "google" || normalizeProvider(acc.provider) === "microsoft" || normalizeProvider(acc.provider) === "apple");
    const issueMessage = String(acc?.token_issue?.message || "").trim();
    const issueCode = String(acc?.token_issue?.code || "").trim();
    const issueGuidance = buildIssueGuidance(acc);
    const recommendedAction = String(acc?.token_issue?.recommended_action || "").trim();
    const recommendedLabel = String(acc?.token_issue?.recommended_label || "Resolve").trim();
    const isRecommendedRetry = recommendedAction === "retry_sync";
    const showIssue = acc.status === "error" && (issueMessage || issueCode);
    const showVerify = normalizedProvider !== "apple";

    div.innerHTML = `
      <div class="left">
        <span class="provider ${provider}">${provider.toUpperCase()}</span>
        <span>${acc.account_email || "UNKNOWN"}</span>
        ${acc.is_primary ? "⭐" : ""}
        <span style="margin-left:8px; font-size:12px;">${getHealthStatus(acc)}</span>
        ${showIssue ? `<div style="margin-top:4px; font-size:12px; color:#7f1d1d;"><strong>${issueCode ? issueCode.replaceAll("_", " ") : "issue"}:</strong> ${issueMessage || "Token action required."}</div>` : ""}
        ${showIssue && issueGuidance ? `<div style="margin-top:2px; font-size:11px; color:#7f1d1d;">${issueGuidance}</div>` : ""}
      </div>
      <div class="account-actions">
        <button data-action="primary" title="Marks this account as the default for its provider.">Set Primary</button>
        <button data-action="toggle" title="${acc.sync_enabled ? "Turns off background syncing for this account." : "Turns on background syncing for this account."}">${acc.sync_enabled ? "Disable Sync" : "Enable Sync"}</button>
        <button data-action="remove" title="Disconnects this account from the app.">Disconnect</button>
        ${showVerify ? `<button data-action="retry" title="${retryTitle}">${isRecommendedRetry ? recommendedLabel : retryLabel}</button>` : ""}
        ${reconnectVisible ? "<button data-action=\"reconnect\" title=\"Reconnects OAuth permissions for this account.\">Reconnect</button>" : ""}
        ${acc.status === "error" && acc?.token_issue?.requires_admin ? "<button data-action=\"admin-fix\" title=\"Opens Admin Dashboard for app-level key or permission fixes.\">Admin Fix Needed</button>" : ""}
      </div>
    `;

    div.querySelector('[data-action="primary"]').onclick = () => setPrimary(acc.id);
    div.querySelector('[data-action="toggle"]').onclick = () => toggleSync(acc.id, !acc.sync_enabled);
    div.querySelector('[data-action="remove"]').onclick = () => removeAccount(acc.id);
    const retryBtn = div.querySelector('[data-action="retry"]');
    if (retryBtn) {
      retryBtn.onclick = (e) => retryAccount(acc.id, e.currentTarget);
    }

    const reconnectBtn = div.querySelector('[data-action="reconnect"]');
    if (reconnectBtn) {
      reconnectBtn.textContent = isRecommendedReconnect ? recommendedLabel : "Reconnect";
      reconnectBtn.onclick = (e) => reconnectAccount(acc.provider, acc.account_email, e.currentTarget);
    }

    const adminFixBtn = div.querySelector('[data-action="admin-fix"]');
    if (adminFixBtn) {
      adminFixBtn.onclick = () => {
        window.location.href = "/admin/ui";
      };
    }

    container.appendChild(div);
  });
}

function normalizeAccountKey(provider, email) {
  return `${normalizeProvider(provider)}:${String(email || "").toLowerCase().trim()}`;
}

function focusRemediationTargetIfRequested() {
  if (!pendingRemediationTarget) return;
  const targetKey = normalizeAccountKey(pendingRemediationTarget.provider, pendingRemediationTarget.account);
  const cards = [...document.querySelectorAll(".account[data-account-key]")];
  const target = cards.find((card) => String(card.dataset.accountKey || "").toLowerCase() === targetKey);
  if (!target) return;

  target.style.boxShadow = "0 0 0 3px rgba(220, 38, 38, 0.35)";
  target.style.borderColor = "#dc2626";
  target.scrollIntoView({ behavior: "smooth", block: "center" });

  const action = normalizeRemedyAction(pendingRemediationTarget.action);
  if (action === "reconnect") {
    setGlobalMessage(`Resolution target: ${targetKey}. Click Reconnect for this account, complete consent, then retry publish.`, "info");
  } else {
    setGlobalMessage(`Resolution target: ${targetKey}. Click Verify Access first. If write access is still denied, click Reconnect, then retry publish.`, "info");
  }
  pendingRemediationTarget = null;
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
  focusRemediationTargetIfRequested();

  await fetchSyncStatus();

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
  const remedyProvider = params.get("remedy_provider");
  const remedyAccount = params.get("remedy_account");
  const remedyAction = params.get("remedy_action");

  if (token) {
    setAuthToken(token);
    if (connected && connectedAccount) {
      markPendingCalendarSync(connected, connectedAccount);
    }
  }

  if (oauthError) {
    const known = {
      microsoft_scope_missing_write: "Microsoft connection is missing calendar write permission. Click Microsoft Reconnect and accept full consent.",
      microsoft_token_missing: "Microsoft token was not returned. Please reconnect Microsoft.",
      microsoft_profile_failed: "Microsoft profile lookup failed. Please reconnect Microsoft.",
      microsoft_reconnect_mismatch: "Reconnect completed with a different Microsoft account than expected.",
      microsoft_email_missing: "Microsoft did not return an account email. Please reconnect Microsoft.",
    };
    setGlobalMessage(known[oauthError] || oauthError.replace(/_/g, " "));
  }

  if (remedyProvider || remedyAccount) {
    pendingRemediationTarget = {
      provider: remedyProvider || "",
      account: remedyAccount || "",
      action: normalizeRemedyAction(remedyAction),
    };
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

  await fetchSyncStatus();

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
window.refreshAllSyncStatus = refreshAllSyncStatus;
window.saveSyncSettings = saveSyncSettings;
window.manualRefreshSelectedAccount = manualRefreshSelectedAccount;

window.testApple = () => testApple(document.getElementById("apple-test-btn"));
window.connectApple = () => connectApple(document.getElementById("apple-connect-btn"));

init();
