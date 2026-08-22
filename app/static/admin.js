import { apiRequest } from "/static/api.js";

const state = {
  entity: "users",
  items: [],
  filtered: [],
  selectedIds: new Set(),
  editing: null,
  overview: null,
  currentUserFailureCheck: null,
  failureHistory: null,
  tokenKeyRepairStatus: null,
  deploymentSyncStatus: null,
  tableQuery: null,
  purgeMeta: {
    users: {},
    providers: {},
  },
};

const el = {
  switchUsers: document.getElementById("switchUsers"),
  switchProviders: document.getElementById("switchProviders"),
  createBtn: document.getElementById("createBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  bulkDeleteBtn: document.getElementById("bulkDeleteBtn"),
  bulkDeleteRelated: document.getElementById("bulkDeleteRelated"),
  dangerConfirmInput: document.getElementById("dangerConfirmInput"),
  scanOrphansBtn: document.getElementById("scanOrphansBtn"),
  deleteOrphansBtn: document.getElementById("deleteOrphansBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  selectEmptyUsersBtn: document.getElementById("selectEmptyUsersBtn"),
  clearSelectionBtn: document.getElementById("clearSelectionBtn"),
  selectionSummary: document.getElementById("selectionSummary"),
  cleanupControls: document.getElementById("cleanupControls"),
  cleanupTitle: document.getElementById("cleanupTitle"),
  exportBtn: document.getElementById("exportBtn"),
  goCalendar: document.getElementById("goCalendar"),
  searchInput: document.getElementById("searchInput"),
  tableInput: document.getElementById("tableInput"),
  tableQueryPanel: document.getElementById("tableQueryPanel"),
  tableQueryTitle: document.getElementById("tableQueryTitle"),
  tableQueryResult: document.getElementById("tableQueryResult"),
  accountsSummary: document.getElementById("accountsSummary"),
  controlStatusLine: document.getElementById("controlStatusLine"),
  statusLine: document.getElementById("statusLine"),
  desktopGrid: document.getElementById("desktopGrid"),
  mobileCards: document.getElementById("mobileCards"),
  dialog: document.getElementById("entityDialog"),
  form: document.getElementById("entityForm"),
  formFields: document.getElementById("formFields"),
  dialogTitle: document.getElementById("dialogTitle"),
  cancelDialog: document.getElementById("cancelDialog"),
  dbTypeText: document.getElementById("dbTypeText"),
  dbHostText: document.getElementById("dbHostText"),
  dbNameText: document.getElementById("dbNameText"),
  tableCountText: document.getElementById("tableCountText"),
  tableList: document.getElementById("tableList"),
  userOpsList: document.getElementById("userOpsList"),
  providerOpsList: document.getElementById("providerOpsList"),
  overviewLastUpdated: document.getElementById("overviewLastUpdated"),
  copyOverviewBtn: document.getElementById("copyOverviewBtn"),
  deploymentSyncPanel: document.getElementById("deploymentSyncPanel"),
  deploymentSyncDetails: document.getElementById("deploymentSyncDetails"),
  deploymentSyncStatusPill: document.getElementById("deploymentSyncStatusPill"),
  deploymentSyncCurrentCommit: document.getElementById("deploymentSyncCurrentCommit"),
  deploymentSyncOriginCommit: document.getElementById("deploymentSyncOriginCommit"),
  deploymentSyncGithubCommit: document.getElementById("deploymentSyncGithubCommit"),
  deploymentSyncRepoBranch: document.getElementById("deploymentSyncRepoBranch"),
  deploymentSyncSource: document.getElementById("deploymentSyncSource"),
  deploymentSyncCheckedAt: document.getElementById("deploymentSyncCheckedAt"),
  deploymentSyncDetail: document.getElementById("deploymentSyncDetail"),
  deploymentSyncMessage: document.getElementById("deploymentSyncMessage"),
  deploymentSyncHint: document.getElementById("deploymentSyncHint"),
  deploymentSyncRefreshBtn: document.getElementById("deploymentSyncRefreshBtn"),
  deploymentSyncGithubBtn: document.getElementById("deploymentSyncGithubBtn"),
  deploymentSyncCompareBtn: document.getElementById("deploymentSyncCompareBtn"),
  deploymentSyncResolveBtn: document.getElementById("deploymentSyncResolveBtn"),
  deploymentSyncPlatform: document.getElementById("deploymentSyncPlatform"),
  deploymentSyncCurrentLabel: document.getElementById("deploymentSyncCurrentLabel"),
  deploymentSyncPlatformSummary: document.getElementById("deploymentSyncPlatformSummary"),
  databaseConfigSummary: document.getElementById("databaseConfigSummary"),
  hyperdriveLiveBadge: document.getElementById("hyperdriveLiveBadge"),
  hyperdriveLiveBadgeText: document.getElementById("hyperdriveLiveBadgeText"),
  hyperdriveSetupBanner: document.getElementById("hyperdriveSetupBanner"),
  hyperdriveSetupMessage: document.getElementById("hyperdriveSetupMessage"),
  databaseModeSelect: document.getElementById("databaseModeSelect"),
  databaseProfileSelect: document.getElementById("databaseProfileSelect"),
  databaseProviderTitleInput: document.getElementById("databaseProviderTitleInput"),
  databaseHostInput: document.getElementById("databaseHostInput"),
  databasePortInput: document.getElementById("databasePortInput"),
  databaseNameInput: document.getElementById("databaseNameInput"),
  databaseUserInput: document.getElementById("databaseUserInput"),
  databasePasswordInput: document.getElementById("databasePasswordInput"),
  databaseSslModeSelect: document.getElementById("databaseSslModeSelect"),
  databaseUrlInput: document.getElementById("databaseUrlInput"),
  databaseFallbackToggle: document.getElementById("databaseFallbackToggle"),
  databaseConnectBtn: document.getElementById("databaseConnectBtn"),
  databaseTestBtn: document.getElementById("databaseTestBtn"),
  databaseSaveBtn: document.getElementById("databaseSaveBtn"),
  databaseConfigStatus: document.getElementById("databaseConfigStatus"),
  databaseCopySourceSelect: document.getElementById("databaseCopySourceSelect"),
  databaseCopyTargetSelect: document.getElementById("databaseCopyTargetSelect"),
  databaseCopyBtn: document.getElementById("databaseCopyBtn"),
  databaseCopyStatus: document.getElementById("databaseCopyStatus"),
  gitCommitPasswordInput: document.getElementById("gitCommitPasswordInput"),
  gitCommitPushBtn: document.getElementById("gitCommitPushBtn"),
  gitCommitPushHint: document.getElementById("gitCommitPushHint"),
  gitFetchPullTargets: document.getElementById("gitFetchPullTargets"),
  securityWarningBanner: document.getElementById("securityWarningBanner"),
  runCurrentUserFailureCheckBtn: document.getElementById("runCurrentUserFailureCheckBtn"),
  currentUserFailureCheckStamp: document.getElementById("currentUserFailureCheckStamp"),
  currentUserFailureCheckResult: document.getElementById("currentUserFailureCheckResult"),
  tokenEncryptionKeyInput: document.getElementById("tokenEncryptionKeyInput"),
  applyTokenEncryptionKeyBtn: document.getElementById("applyTokenEncryptionKeyBtn"),
  failureFixRow: document.getElementById("failureFixRow"),
  failureFixHelp: document.getElementById("failureFixHelp"),
  historyStartDate: document.getElementById("historyStartDate"),
  historyEndDate: document.getElementById("historyEndDate"),
  runFailureHistoryBtn: document.getElementById("runFailureHistoryBtn"),
  failureHistoryResult: document.getElementById("failureHistoryResult"),
};

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isoDateDaysAgo(daysAgo) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() - Number(daysAgo || 0));
  return value.toISOString().slice(0, 10);
}

function updateFailureFixAvailability(hasLiveIssue) {
  if (el.failureFixRow) {
    el.failureFixRow.classList.toggle("is-disabled", !hasLiveIssue);
  }
  if (el.tokenEncryptionKeyInput) {
    el.tokenEncryptionKeyInput.disabled = !hasLiveIssue;
    if (!hasLiveIssue) {
      el.tokenEncryptionKeyInput.value = "";
    }
  }
  if (el.applyTokenEncryptionKeyBtn) {
    el.applyTokenEncryptionKeyBtn.disabled = !hasLiveIssue;
  }
  if (el.failureFixHelp) {
    el.failureFixHelp.textContent = hasLiveIssue
      ? "This applies the key now and saves it for automatic restart bootstrap. After it succeeds, the page rechecks automatically and marks the issue resolved in green."
      : "This fix is currently inactive because there is no live credential decryption issue to repair in this running app.";
  }
}

function shortCommit(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "unavailable";
  }
  return text.length > 12 ? text.slice(0, 12) : text;
}

function normalizeCommit(value) {
  const commit = String(value || "").trim().toLowerCase();
  return /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
}

function applyWorkerDeploymentStatus(data, workerStatus) {
  if (workerStatus?.platform !== "cloudflare-worker" || !data?.deployment) {
    return data;
  }

  const deployment = data.deployment;
  if (deployment.worker_status_applied) {
    return data;
  }
  const workerCommit = normalizeCommit(workerStatus.deploymentCommit);
  const githubCommit = normalizeCommit(deployment.github_latest_commit);
  deployment.origin_commit = deployment.current_commit;
  deployment.origin_commit_source = deployment.current_commit_source;
  deployment.current_commit = workerCommit;
  deployment.current_commit_source = "Cloudflare Worker build";
  deployment.active_platform = "cloudflare";
  deployment.active_platform_label = "Cloudflare Worker";

  if (workerCommit && githubCommit) {
    deployment.status = workerCommit === githubCommit ? "synced" : "out_of_sync";
    deployment.message = workerCommit === githubCommit
      ? "The active Cloudflare Worker matches the latest GitHub commit."
      : "The active Cloudflare Worker is not on the latest GitHub commit yet.";
  } else {
    deployment.status = "unknown";
    deployment.message = "Cloudflare is active, but its deployed Git commit is unavailable.";
  }

  const platforms = Array.isArray(deployment.platforms) ? deployment.platforms : [];
  for (const platform of platforms) {
    if (platform.id === "cloudflare") platform.role = "Primary application runtime";
    if (platform.id === "render") platform.role = "Proxied admin and legacy origin";
  }
  const cloudflareTarget = platforms.find((platform) => platform.id === "cloudflare") || {};
  deployment.manual_deploy_available = Boolean(cloudflareTarget.manual_deploy_available);
  deployment.manual_deploy_endpoint = cloudflareTarget.manual_deploy_endpoint || null;
  deployment.manual_deploy_hint = deployment.manual_deploy_available
    ? "Trigger the Cloudflare deploy hook from this admin app."
    : "Open the Cloudflare dashboard and deploy the latest GitHub commit.";
  deployment.current_commit_url = workerCommit
    ? `${deployment.repository_url}/commit/${workerCommit}`
    : null;
  deployment.compare_url = workerCommit && githubCommit && workerCommit !== githubCommit
    ? `${deployment.compare_base_url}/${workerCommit}...${githubCommit}`
    : null;
  return data;
}

async function refreshDeploymentSync() {
  await loadSystemOverview();
}

async function resolveDeploymentSync() {
  const deployment = state.overview?.deployment || {};
  const platforms = Array.isArray(deployment.platforms) ? deployment.platforms : [];
  const activeTarget = platforms.find((item) => item.id === deployment.active_platform) || {};
  const deployAvailable = activeTarget.manual_deploy_available ?? deployment.manual_deploy_available;
  const deployEndpoint = activeTarget.manual_deploy_endpoint || deployment.manual_deploy_endpoint;
  const platformLabel = activeTarget.label || deployment.active_platform_label || "deployment";
  if (deployAvailable && deployEndpoint) {
    if (el.deploymentSyncResolveBtn) {
      el.deploymentSyncResolveBtn.disabled = true;
      el.deploymentSyncResolveBtn.textContent = "Triggering...";
    }

    const res = await apiRequest(deployEndpoint, { method: "POST" });
    if (!res) {
      setStatus(`Unable to trigger the ${platformLabel} deploy hook.`, true);
      if (el.deploymentSyncResolveBtn) {
        el.deploymentSyncResolveBtn.disabled = false;
        el.deploymentSyncResolveBtn.textContent = "Trigger Redeploy";
      }
      return;
    }

    const data = await res.json();
    if (handleAdminForbidden(res, data)) {
      return;
    }

    if (!res.ok) {
      setStatus(data.detail || `Unable to trigger the ${platformLabel} deploy hook.`, true);
      if (el.deploymentSyncResolveBtn) {
        el.deploymentSyncResolveBtn.disabled = false;
        el.deploymentSyncResolveBtn.textContent = "Trigger Redeploy";
      }
      return;
    }

    setStatus(data.message || `${platformLabel} deploy hook triggered.`);
    await loadSystemOverview();
    return;
  }

  const targetUrl = activeTarget.dashboard_url || deployment.render_dashboard_url || "https://dashboard.render.com/";
  window.open(targetUrl, "_blank", "noopener,noreferrer");
}

async function launchGitCommitPush() {
  const controls = state.overview?.deployment?.repository_controls || {};
  const password = String(el.gitCommitPasswordInput?.value || "");
  if (!password) {
    setStatus("Enter your current admin login password.", true);
    return;
  }
  if (!controls.commit_push_endpoint) {
    setStatus(controls.commit_push_hint || "Commit and push is unavailable in this runtime.", true);
    return;
  }

  el.gitCommitPushBtn.disabled = true;
  el.gitCommitPushBtn.textContent = "Opening workflow...";
  const res = await apiRequest(controls.commit_push_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = res ? await res.json() : {};
  el.gitCommitPasswordInput.value = "";
  if (!res || !res.ok) {
    setStatus(data.detail || "Unable to open the commit and push workflow.", true);
  } else {
    setStatus(data.message || "Commit and push workflow opened.");
  }
  el.gitCommitPushBtn.disabled = !controls.commit_push_available;
  el.gitCommitPushBtn.textContent = "Open Commit & Push Workflow";
}

function openDeploymentGithub() {
  const deployment = state.overview?.deployment || {};
  const targetUrl = deployment.latest_commit_url
    || deployment.branch_url
    || deployment.repository_url
    || `https://github.com/${deployment.repository || "cjdawgs/SherryJo_Cal_App"}`;
  window.open(targetUrl, "_blank", "noopener,noreferrer");
}

function openDeploymentCompare() {
  const deployment = state.overview?.deployment || {};
  const targetUrl = deployment.compare_url || deployment.branch_url || deployment.repository_url;
  if (!targetUrl) {
    setStatus("No GitHub compare URL is available yet.", true);
    return;
  }
  window.open(targetUrl, "_blank", "noopener,noreferrer");
}

let adminWindowControlsReady = false;

function resetWindowFrame(frame) {
  if (!frame) return;
  frame.classList.remove("windowFrameMinimized", "windowFrameMaximized");
  frame.querySelectorAll(".windowControlBtn[data-window-action='maximize']").forEach((btn) => {
    btn.setAttribute("aria-label", "Maximize window");
    btn.title = "Maximize";
    btn.textContent = "□";
  });
}

function toggleWindowMinimized(frame) {
  if (!frame) return;
  const minimized = frame.classList.toggle("windowFrameMinimized");
  if (minimized) frame.classList.remove("windowFrameMaximized");
}

function toggleWindowMaximized(frame, button) {
  if (!frame) return;
  const maximized = frame.classList.toggle("windowFrameMaximized");
  if (maximized) frame.classList.remove("windowFrameMinimized");
  if (button) {
    button.setAttribute("aria-label", maximized ? "Restore window" : "Maximize window");
    button.title = maximized ? "Restore" : "Maximize";
    button.textContent = maximized ? "❐" : "□";
  }
}

function closeWindowFrame(frame) {
  if (!frame) return;
  if (typeof frame.close === "function" && frame.open) {
    frame.close();
    return;
  }
  frame.classList.remove("show");
}

function installWindowControls(frame) {
  const form = frame?.querySelector("form");
  const title = form?.querySelector("h3");
  if (!frame || !form || !title || form.querySelector(".windowControls")) return;

  frame.classList.add("windowFrame");
  const header = document.createElement("div");
  header.className = "adminDialogHeader";
  form.insertBefore(header, form.firstElementChild);
  header.appendChild(title);

  const controls = document.createElement("div");
  controls.className = "windowControls";
  controls.innerHTML = `
    <button type="button" class="windowControlBtn" data-window-action="minimize" aria-label="Minimize window" title="Minimize">−</button>
    <button type="button" class="windowControlBtn" data-window-action="maximize" aria-label="Maximize window" title="Maximize">□</button>
    <button type="button" class="windowControlBtn close" data-window-action="close" aria-label="Close window" title="Close">×</button>
  `;
  header.appendChild(controls);
}

function initAdminWindowControls() {
  if (adminWindowControlsReady) return;
  adminWindowControlsReady = true;

  document.querySelectorAll("dialog.entity-dialog").forEach((dialog) => {
    installWindowControls(dialog);
    dialog.addEventListener("close", () => resetWindowFrame(dialog));
  });

  document.addEventListener("click", (event) => {
    const button = event.target.closest?.(".windowControlBtn[data-window-action]");
    if (!button) return;

    const frame = button.closest(".windowFrame");
    const action = button.dataset.windowAction;
    if (!frame || !action) return;

    event.preventDefault();
    event.stopPropagation();

    if (action === "minimize") toggleWindowMinimized(frame);
    if (action === "maximize") toggleWindowMaximized(frame, button);
    if (action === "close") closeWindowFrame(frame);
  });
}

initAdminWindowControls();

function setStatus(message, isError = false) {
  [el.controlStatusLine, el.statusLine].forEach((node) => {
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("error", Boolean(isError));
  });
}

function handleAdminForbidden(res, data = null) {
  if (!res || res.status !== 403) return false;

  const detail = data?.detail || "Admin access required";
  localStorage.setItem("adminAccessNotice", detail);
  window.location.href = "/calendar-ui";
  return true;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .split("'").join("&#039;");
}

function renderSystemOverview(data) {
  state.overview = data;

  const db = data?.database || {};
  const security = data?.security || {};
  const deployment = data?.deployment || {};
  const tables = Array.isArray(data?.tables) ? data.tables : [];
  const userOps = Array.isArray(data?.admin_operations?.users) ? data.admin_operations.users : [];
  const providerOps = Array.isArray(data?.admin_operations?.providers) ? data.admin_operations.providers : [];
  const deploymentStatus = String(deployment?.status || "unknown");
  const isSynced = deploymentStatus === "synced";
  const isOutOfSync = deploymentStatus === "out_of_sync";
  const isUnknown = !isSynced && !isOutOfSync;
  const hasDeployedCommit = Boolean(normalizeCommit(deployment?.current_commit));
  const previousDeploymentStatus = state.deploymentSyncStatus;

  if (el.dbTypeText) {
    el.dbTypeText.textContent = `${db.label || "Unknown"} (${db.engine || "unknown"})`;
  }

  if (el.dbHostText) {
    el.dbHostText.textContent = `Host: ${db.host || "unknown"}`;
  }

  if (el.dbNameText) {
    el.dbNameText.textContent = `Database: ${db.database || "unknown"}`;
  }

  if (el.tableCountText) {
    el.tableCountText.textContent = `Detected ${tables.length} table(s)`;
  }

  if (el.tableList) {
    el.tableList.innerHTML = tables.length
      ? tables.map((table) => `<span class="table-pill">${escapeHtml(table)}</span>`).join("")
      : "<span class=\"table-pill\">No tables detected</span>";
  }

  if (el.userOpsList) {
    el.userOpsList.innerHTML = userOps.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  }

  if (el.providerOpsList) {
    el.providerOpsList.innerHTML = providerOps.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  }

  if (el.overviewLastUpdated) {
    const raw = data?.generated_at;
    const stamp = raw ? new Date(raw).toLocaleString() : new Date().toLocaleString();
    el.overviewLastUpdated.textContent = `Last refreshed: ${stamp}`;
  }

  if (el.securityWarningBanner) {
    const hasCriticalCryptoGap = Boolean(security?.missing_key_with_encrypted_credentials);
    const resolvedNow = Boolean(state.tokenKeyRepairStatus?.resolved) && !hasCriticalCryptoGap;
    updateFailureFixAvailability(hasCriticalCryptoGap);
    el.securityWarningBanner.classList.toggle("is-success", resolvedNow);
    if (hasCriticalCryptoGap) {
      const encryptedRows = Number(security?.encrypted_access_token_rows || 0);
      el.securityWarningBanner.hidden = false;
      el.securityWarningBanner.innerHTML =
        `<strong>Credential Decryption Blocked:</strong> ` +
        `${encryptedRows} encrypted OAuth credential row${encryptedRows === 1 ? " is" : "s are"} present, ` +
        `but TOKEN_ENCRYPTION_KEY is not configured. ` +
        `Background sync and provider publish will fail until the key is restored.`;
    } else if (resolvedNow) {
      el.securityWarningBanner.hidden = false;
      el.securityWarningBanner.innerHTML =
        `<strong>Resolved:</strong> TOKEN_ENCRYPTION_KEY is now active in this running app, and the credential decryption warning cleared.`;
    } else {
      el.securityWarningBanner.hidden = true;
      el.securityWarningBanner.textContent = "";
      el.securityWarningBanner.classList.remove("is-success");
    }
  }

  if (el.deploymentSyncPanel) {
    el.deploymentSyncPanel.classList.toggle("is-synced", isSynced);
    el.deploymentSyncPanel.classList.toggle("is-out-of-sync", isOutOfSync);
    el.deploymentSyncPanel.classList.toggle("is-unknown", isUnknown);
  }

  if (el.deploymentSyncDetails && previousDeploymentStatus !== deploymentStatus) {
    el.deploymentSyncDetails.open = !isSynced;
  }
  state.deploymentSyncStatus = deploymentStatus;

  if (el.deploymentSyncStatusPill) {
    el.deploymentSyncStatusPill.textContent = isSynced ? "In sync" : (isOutOfSync ? "Out of sync" : (hasDeployedCommit ? "Deployed, comparison unavailable" : "Unable to verify"));
    el.deploymentSyncStatusPill.classList.toggle("is-synced", isSynced);
    el.deploymentSyncStatusPill.classList.toggle("is-out-of-sync", isOutOfSync);
    el.deploymentSyncStatusPill.classList.toggle("is-unknown", isUnknown);
  }

  if (el.deploymentSyncCurrentCommit) {
    el.deploymentSyncCurrentCommit.textContent = shortCommit(deployment.current_commit);
  }

  if (el.deploymentSyncOriginCommit) {
    el.deploymentSyncOriginCommit.textContent = deployment.origin_commit
      ? `${shortCommit(deployment.origin_commit)} (${deployment.origin_commit_source || "origin"})`
      : "not used for Cloudflare sync";
  }

  if (el.deploymentSyncPlatform) {
    el.deploymentSyncPlatform.textContent = deployment.active_platform_label || "Unknown platform";
  }

  if (el.deploymentSyncCurrentLabel) {
    el.deploymentSyncCurrentLabel.textContent = deployment.active_platform === "cloudflare" ? "Cloudflare Worker build" : "Current Render build";
  }

  if (el.deploymentSyncPlatformSummary) {
    const platforms = Array.isArray(deployment.platforms) ? deployment.platforms : [];
    el.deploymentSyncPlatformSummary.textContent = platforms.length
      ? platforms.map((item) => `${item.label}: ${item.role}`).join(" | ")
      : "Render origin";
  }

  if (el.deploymentSyncGithubCommit) {
    el.deploymentSyncGithubCommit.textContent = shortCommit(deployment.github_latest_commit);
  }

  if (el.deploymentSyncRepoBranch) {
    el.deploymentSyncRepoBranch.textContent = `${deployment.repository || "unknown repo"} / ${deployment.branch || "main"}`;
  }

  if (el.deploymentSyncSource) {
    el.deploymentSyncSource.textContent = deployment.current_commit_source || "unknown";
  }

  if (el.deploymentSyncCheckedAt) {
    const raw = data?.generated_at;
    el.deploymentSyncCheckedAt.textContent = raw ? new Date(raw).toLocaleString() : new Date().toLocaleString();
  }

  if (el.deploymentSyncDetail) {
    const detail = deployment.github_error
      || (deployment.github_latest_commit ? "GitHub commit lookup succeeded." : "Waiting for verification result.");
    el.deploymentSyncDetail.textContent = detail;
  }

  if (el.deploymentSyncMessage) {
    el.deploymentSyncMessage.textContent = deployment.message || (hasDeployedCommit
      ? "The Worker build is deployed, but the latest GitHub commit could not be retrieved for comparison."
      : "Deployment sync check not available.");
  }

  if (el.deploymentSyncHint) {
    if (isSynced) {
      el.deploymentSyncHint.textContent = `${deployment.active_platform_label || "Deployment"} and GitHub are aligned. No deploy action is needed.`;
    } else if (isOutOfSync) {
      el.deploymentSyncHint.textContent = deployment.manual_deploy_hint || "Render is behind GitHub. Trigger or open a deploy now.";
    } else {
      el.deploymentSyncHint.textContent = deployment.github_error
        ? `Verification failed: ${deployment.github_error}`
        : (deployment.manual_deploy_hint || "Open the Render dashboard and trigger a manual deploy there.");
    }
  }

  if (el.deploymentSyncResolveBtn) {
    const platforms = Array.isArray(deployment.platforms) ? deployment.platforms : [];
    const activeTarget = platforms.find((item) => item.id === deployment.active_platform) || {};
    const deployAvailable = activeTarget.manual_deploy_available ?? deployment.manual_deploy_available;
    const targetLabel = activeTarget.label || "Render";
    el.deploymentSyncResolveBtn.disabled = isSynced;
    el.deploymentSyncResolveBtn.textContent = isSynced
      ? "In Sync"
      : (deployAvailable ? `Deploy ${targetLabel}` : `Open ${targetLabel}`);
    el.deploymentSyncResolveBtn.classList.toggle("is-danger", isOutOfSync);
  }

  if (el.deploymentSyncGithubBtn) {
    el.deploymentSyncGithubBtn.disabled = !deployment.branch_url && !deployment.repository_url;
  }

  if (el.deploymentSyncCompareBtn) {
    el.deploymentSyncCompareBtn.disabled = !deployment.compare_url && !deployment.branch_url && !deployment.repository_url;
    el.deploymentSyncCompareBtn.textContent = deployment.compare_url ? "Compare" : "Open Commits";
  }

  if (el.deploymentSyncRefreshBtn) {
    el.deploymentSyncRefreshBtn.disabled = false;
  }

  const repositoryControls = deployment.repository_controls || {};
  if (el.gitCommitPushHint) {
    el.gitCommitPushHint.textContent = repositoryControls.commit_push_hint || "Repository controls are unavailable in this runtime.";
  }
  if (el.gitCommitPasswordInput) {
    el.gitCommitPasswordInput.disabled = !repositoryControls.commit_push_available;
  }
  if (el.gitCommitPushBtn) {
    el.gitCommitPushBtn.disabled = !repositoryControls.commit_push_available;
  }
  if (el.gitFetchPullTargets) {
    const targets = Array.isArray(repositoryControls.fetch_pull_targets) ? repositoryControls.fetch_pull_targets : [];
    el.gitFetchPullTargets.innerHTML = targets.map((target) => `
      <div class="git-future-target">
        <span><strong>${escapeHtml(target.label)}</strong><small>${escapeHtml(target.status || "planned")}</small></span>
        <button class="ghost-btn" type="button" disabled>Fetch / Pull</button>
      </div>
    `).join("");
  }
}

function renderCurrentUserFailureCheck(data) {
  state.currentUserFailureCheck = data;

  if (el.currentUserFailureCheckStamp) {
    const raw = data?.checked_at;
    const stamp = raw ? new Date(raw).toLocaleString() : new Date().toLocaleString();
    el.currentUserFailureCheckStamp.textContent = `Last run: ${stamp}`;
  }

  if (!el.currentUserFailureCheckResult) {
    return;
  }

  const counts = data?.counts || {};
  const database = data?.checked_database || {};
  const summaryLines = Array.isArray(data?.summary_lines) ? data.summary_lines : [];
  const decryptWarnings = Array.isArray(data?.decrypt_warning_accounts) ? data.decrypt_warning_accounts : [];
  const syncFailures = Array.isArray(data?.sync_failure_accounts) ? data.sync_failure_accounts : [];
  const publishFailures = Array.isArray(data?.publish_failures) ? data.publish_failures : [];
  const hasFailures = Boolean(data?.has_failures);
  const resolvedNow = Boolean(state.tokenKeyRepairStatus?.resolved) && !hasFailures;
  const summaryItemsHtml = summaryLines.map((line) => `<li>${escapeHtml(line)}</li>`).join("");
  const decryptWarningsHtml = decryptWarnings.length
    ? `<div><strong>Accounts with decrypt warnings:</strong><ul>${decryptWarnings.map((item) => `<li>${escapeHtml(item.provider)} / ${escapeHtml(item.account_email)}: ${escapeHtml(item.reason || "decrypt warning")}</li>`).join("")}</ul></div>`
    : "";
  const syncFailuresHtml = syncFailures.length
    ? `<div><strong>Accounts with sync failures:</strong><ul>${syncFailures.map((item) => {
      const suffix = item.last_error ? `: ${escapeHtml(item.last_error)}` : "";
      return `<li>${escapeHtml(item.provider)} / ${escapeHtml(item.account_email)} at ${escapeHtml(item.last_sync_failure || "unknown time")}${suffix}</li>`;
    }).join("")}</ul></div>`
    : "";
  const publishFailuresHtml = publishFailures.length
    ? `<div><strong>Publish failure details:</strong><ul>${publishFailures.map((item) => `<li>${escapeHtml(item.ts_server || "unknown time")} - ${escapeHtml(item.details || "no details")}</li>`).join("")}</ul></div>`
    : "";

  el.currentUserFailureCheckResult.classList.toggle("is-error", hasFailures);
  el.currentUserFailureCheckResult.classList.toggle("is-success", resolvedNow);
  el.currentUserFailureCheckResult.innerHTML = `
    <div><strong>Checked user:</strong> ${escapeHtml(data?.user?.email || "unknown")}</div>
    <div><strong>Database used:</strong> ${escapeHtml(database.label || "Unknown")} (${escapeHtml(database.engine || "unknown")})</div>
    <div><strong>What this means:</strong> This is a same-day check for the logged-in admin only. Counts below come from this app&apos;s current database connection.</div>
    ${resolvedNow ? `<div><strong>Resolved:</strong> The credential decryption issue was rechecked after applying the key and is now clear in this running app.</div>` : ""}
    <ul>
      ${summaryItemsHtml}
      <li>Decrypt warnings today: ${escapeHtml(counts.decrypt_warning_accounts ?? 0)}</li>
      <li>Sync failures today: ${escapeHtml(counts.sync_failures_today ?? 0)}</li>
      <li>Publish failures today: ${escapeHtml(counts.publish_failures_today ?? 0)}</li>
      <li>Total publish diagnostic entries today: ${escapeHtml(counts.publish_diagnostics_today ?? 0)}</li>
    </ul>
    ${decryptWarningsHtml}
    ${syncFailuresHtml}
    ${publishFailuresHtml}
  `;
}

async function loadCurrentUserFailureCheck() {
  if (el.currentUserFailureCheckStamp) {
    el.currentUserFailureCheckStamp.textContent = "Running check...";
  }

  if (el.currentUserFailureCheckResult) {
    el.currentUserFailureCheckResult.classList.remove("is-error", "is-success");
    el.currentUserFailureCheckResult.textContent = "Running today’s failure check...";
  }

  const res = await apiRequest("/admin/system/current-user-failures-today", { method: "GET" });
  if (!res) {
    if (el.currentUserFailureCheckResult) {
      el.currentUserFailureCheckResult.classList.add("is-error");
      el.currentUserFailureCheckResult.textContent = "Unable to run the failure check.";
    }
    setStatus("Unable to run current user failure check", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    if (el.currentUserFailureCheckResult) {
      el.currentUserFailureCheckResult.classList.add("is-error");
      el.currentUserFailureCheckResult.textContent = data.detail || "Failure check could not be completed.";
    }
    setStatus(data.detail || "Unable to run current user failure check", true);
    return;
  }

  renderCurrentUserFailureCheck(data);
  setStatus(data.has_failures ? "Current user failure check found issues." : "Current user failure check found no issues today.");
}

function renderFailureHistory(data) {
  state.failureHistory = data;
  if (!el.failureHistoryResult) {
    return;
  }

  const counts = data?.counts || {};
  const meaningfulPoints = Array.isArray(data?.meaningful_points) ? data.meaningful_points : [];
  const reasonRows = Array.isArray(data?.publish_failure_reasons) ? data.publish_failure_reasons : [];
  const syncFailures = Array.isArray(data?.sync_failure_accounts) ? data.sync_failure_accounts : [];
  const recentErrors = Array.isArray(data?.recent_error_messages) ? data.recent_error_messages : [];
  const publishFailures = Array.isArray(data?.publish_failures) ? data.publish_failures : [];

  const reasonHtml = reasonRows.length
    ? `<div><strong>Publish failure reasons:</strong><ul>${reasonRows.map((item) => `<li>${escapeHtml(item.reason)}: ${escapeHtml(item.count)}</li>`).join("")}</ul></div>`
    : "";
  const syncHtml = syncFailures.length
    ? `<div><strong>Accounts whose latest sync failure falls in this range:</strong><ul>${syncFailures.map((item) => `<li>${escapeHtml(item.provider)} / ${escapeHtml(item.account_email)} at ${escapeHtml(item.last_sync_failure || "unknown")}${item.last_error ? `: ${escapeHtml(item.last_error)}` : ""}</li>`).join("")}</ul></div>`
    : "";
  const errorHtml = recentErrors.length
    ? `<div><strong>Distinct recent error messages:</strong><ul>${recentErrors.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
    : "";
  const samplePublishHtml = publishFailures.length
    ? `<div><strong>Sample publish diagnostics:</strong><ul>${publishFailures.slice(0, 5).map((item) => `<li>${escapeHtml(item.ts_server || "unknown time")} - ${escapeHtml(item.reason || "unknown")} - ${escapeHtml(item.details || "")}</li>`).join("")}</ul></div>`
    : "";

  el.failureHistoryResult.classList.remove("is-error");
  el.failureHistoryResult.innerHTML = `
    <div><strong>Checked user:</strong> ${escapeHtml(data?.user?.email || "unknown")}</div>
    <div><strong>Date range:</strong> ${escapeHtml(data?.window?.start_date || "?")} through ${escapeHtml(data?.window?.end_date || "?")}</div>
    <div><strong>Total signals found:</strong> Sync failures ${escapeHtml(counts.sync_failures ?? 0)}, publish failure rows ${escapeHtml(counts.publish_failure_rows ?? 0)}, distinct publish reasons ${escapeHtml(counts.distinct_publish_failure_reasons ?? 0)}</div>
    <ul>
      ${meaningfulPoints.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
    </ul>
    ${reasonHtml}
    ${syncHtml}
    ${errorHtml}
    ${samplePublishHtml}
  `;
}

async function loadFailureHistory() {
  const startDate = String(el.historyStartDate?.value || "").trim();
  const endDate = String(el.historyEndDate?.value || "").trim();
  if (!startDate || !endDate) {
    setStatus("Choose both start and end dates before querying prior issues.", true);
    return;
  }

  if (el.failureHistoryResult) {
    el.failureHistoryResult.classList.remove("is-error");
    el.failureHistoryResult.textContent = "Querying prior date range...";
  }

  const params = new URLSearchParams({ start_date: startDate, end_date: endDate });
  const res = await apiRequest(`/admin/system/current-user-failure-history?${params.toString()}`, { method: "GET" });
  if (!res) {
    if (el.failureHistoryResult) {
      el.failureHistoryResult.classList.add("is-error");
      el.failureHistoryResult.textContent = "Unable to query prior issues.";
    }
    setStatus("Unable to query prior issues.", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    if (el.failureHistoryResult) {
      el.failureHistoryResult.classList.add("is-error");
      el.failureHistoryResult.textContent = data.detail || "Could not query prior issues.";
    }
    setStatus(data.detail || "Could not query prior issues.", true);
    return;
  }

  renderFailureHistory(data);
  setStatus("Prior date range query completed.");
}

async function applyTokenEncryptionKey() {
  const keyValue = String(el.tokenEncryptionKeyInput?.value || "").trim();
  if (!keyValue) {
    setStatus("Enter the known TOKEN_ENCRYPTION_KEY first.", true);
    el.tokenEncryptionKeyInput?.focus();
    return;
  }

  if (el.applyTokenEncryptionKeyBtn) {
    el.applyTokenEncryptionKeyBtn.disabled = true;
    el.applyTokenEncryptionKeyBtn.textContent = "Applying...";
  }

  if (el.currentUserFailureCheckResult) {
    el.currentUserFailureCheckResult.classList.remove("is-error", "is-success");
    el.currentUserFailureCheckResult.textContent = "Applying key and rechecking this running app...";
  }

  const res = await apiRequest("/admin/system/token-encryption-key/runtime", {
    method: "POST",
    body: JSON.stringify({ token_encryption_key: keyValue }),
  });

  if (el.applyTokenEncryptionKeyBtn) {
    el.applyTokenEncryptionKeyBtn.disabled = false;
    el.applyTokenEncryptionKeyBtn.textContent = "Apply Key And Recheck";
  }

  if (!res) {
    setStatus("Unable to apply TOKEN_ENCRYPTION_KEY.", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    state.tokenKeyRepairStatus = null;
    if (el.currentUserFailureCheckResult) {
      el.currentUserFailureCheckResult.classList.add("is-error");
      el.currentUserFailureCheckResult.textContent = data.detail || "Could not apply TOKEN_ENCRYPTION_KEY.";
    }
    setStatus(data.detail || "Could not apply TOKEN_ENCRYPTION_KEY.", true);
    return;
  }

  state.tokenKeyRepairStatus = data;
  if (el.tokenEncryptionKeyInput) {
    el.tokenEncryptionKeyInput.value = "";
  }
  await loadSystemOverview();
  await loadCurrentUserFailureCheck();
  setStatus(data.resolved ? "TOKEN_ENCRYPTION_KEY applied and the issue is now resolved in this running app." : (data.message || "TOKEN_ENCRYPTION_KEY applied."));
}

async function loadSystemOverview() {
  const [res, workerStatusRes] = await Promise.all([
    apiRequest("/admin/system/overview", { method: "GET" }),
    fetch("/api/platform/status", { cache: "no-store" }).catch(() => null),
  ]);
  if (!res) {
    setStatus("Unable to load system overview", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Unable to load system overview", true);
    return;
  }

  let workerStatus = null;
  if (workerStatusRes?.ok) {
    workerStatus = await workerStatusRes.json().catch(() => null);
  }
  renderSystemOverview(applyWorkerDeploymentStatus(data, workerStatus));
}

function activeConfig() {
  if (state.entity === "users") {
    return {
      endpoint: "/admin/users",
      columns: ["ID", "Email", "Username", "Role", "Created", "Actions"],
      row: (item) => [
        item.id,
        item.email,
        item.username,
        item.role,
        item.created_at || "-",
      ],
      cardTitle: (item) => item.email,
      cardBody: (item) => [
        `Username: ${item.username}`,
        `Role: ${item.role}`,
        `Created: ${item.created_at || "-"}`,
      ],
      searchText: (item) => `${item.email} ${item.username} ${item.role}`,
      buildForm: buildUserForm,
    };
  }

  return {
    endpoint: "/admin/providers",
    columns: ["ID", "Provider Name", "Contact", "Status", "Owner User ID", "Owner Email", "Actions"],
    row: (item) => [
      item.id,
      item.provider_name || "-",
      item.contact_email || "-",
      item.status || "inactive",
      item.metadata?.user_id ?? "-",
      item.metadata?.owner_email || "-",
    ],
    cardTitle: (item) => item.provider_name || item.metadata?.provider || "Provider",
    cardBody: (item) => [
      `Contact: ${item.contact_email || "-"}`,
      `Status: ${item.status || "inactive"}`,
      `Provider: ${item.metadata?.provider || "-"}`,
      `Owner User ID: ${item.metadata?.user_id ?? "-"}`,
      `Owner Email: ${item.metadata?.owner_email || "-"}`,
    ],
    searchText: (item) => `${item.provider_name} ${item.contact_email} ${item.status} ${item.metadata?.provider} ${item.metadata?.user_id ?? ""} ${item.metadata?.owner_email ?? ""}`,
    buildForm: buildProviderForm,
  };
}

async function loadData() {
  const config = activeConfig();
  setStatus(`Loading ${state.entity}...`);

  const res = await apiRequest(config.endpoint, { method: "GET" });
  if (!res) {
    setStatus("Request failed", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Failed to load data", true);
    return;
  }

  state.items = Array.isArray(data) ? data : [];
  state.selectedIds.forEach((id) => {
    if (!state.items.some((item) => Number(item.id) === Number(id))) {
      state.selectedIds.delete(id);
    }
  });
  applySearch();

  if (el.accountsSummary) {
    const label = state.entity === "users" ? "User Login Accounts" : "Provider Accounts";
    el.accountsSummary.textContent = `${label} (${state.filtered.length})`;
  }

  setStatus(`Loaded ${state.filtered.length} ${state.entity}.`);
  primePurgeMetadata();
}

function totalRelatedCount(entity, related) {
  const data = related || {};
  if (entity === "users") {
    return Number(data.accounts || 0)
      + Number(data.events || 0)
      + Number(data.tasks || 0)
      + Number(data.sticky_notes || 0)
      + Number(data.notes || 0);
  }
  return Number(data.events || 0) + Number(data.notes || 0);
}

function normalizeRelatedCounts(entity, related) {
  const data = related || {};
  if (entity === "users") {
    return {
      accounts: Number(data.accounts || 0),
      events: Number(data.events || 0),
      notes: Number(data.notes || 0),
      sticky_notes: Number(data.sticky_notes || 0),
      tasks: Number(data.tasks || 0),
    };
  }

  return {
    events: Number(data.events || 0),
    notes: Number(data.notes || 0),
  };
}

function formatPurgeTitle(entity, counts, total) {
  const parts = [];
  if (entity === "users") {
    parts.push(`events: ${counts.events}`);
    parts.push(`notes: ${counts.notes}`);
    parts.push(`sticky: ${counts.sticky_notes}`);
    parts.push(`tasks: ${counts.tasks}`);
    parts.push(`accounts: ${counts.accounts}`);
  } else {
    parts.push(`events: ${counts.events}`);
    parts.push(`notes: ${counts.notes}`);
  }

  return `Calendar records found: ${total} (${parts.join(", ")})`;
}

function buildPurgeLabelHtml(entity, counts, total) {
  if (total <= 0) {
    return `<span class="purge-label-text">No Calendar Data</span>`;
  }

  const badges = [];
  if (counts.events > 0) badges.push(`<span class="purge-badge">Events ${counts.events}</span>`);
  if (counts.notes > 0) badges.push(`<span class="purge-badge">Notes ${counts.notes}</span>`);
  if (entity === "users" && counts.sticky_notes > 0) badges.push(`<span class="purge-badge">Sticky Notes ${counts.sticky_notes}</span>`);
  if (entity === "users" && counts.tasks > 0) badges.push(`<span class="purge-badge">Tasks ${counts.tasks}</span>`);
  if (entity === "users" && counts.accounts > 0) badges.push(`<span class="purge-badge">Accounts ${counts.accounts}</span>`);

  return [
    `<span class="purge-label-text">Purge Data</span>`,
    `<span class="purge-badges">${badges.join("")}</span>`,
  ].join("");
}

function renderUserRelatedSummary(item) {
  const purgeMeta = getPurgeMeta(item.id);
  if (!purgeMeta || purgeMeta.loading) {
    return `<span class="related-summary-loading">Checking related calendar data…</span>`;
  }

  const counts = purgeMeta.related || normalizeRelatedCounts("users", {});
  const total = Number(purgeMeta.count || 0);
  if (total <= 0) {
    return `<span class="related-summary-empty">No related calendar data</span>`;
  }

  const badges = [
    ["Events", counts.events],
    ["Notes", counts.notes],
    ["Sticky Notes", counts.sticky_notes],
    ["Tasks", counts.tasks],
    ["Accounts", counts.accounts],
  ].filter((entry) => Number(entry[1]) > 0)
    .map(([label, count]) => `<span class="related-data-badge"><strong>${escapeHtml(label)}</strong><span>${Number(count)}</span></span>`);

  return `<div class="related-data-summary"><span class="related-summary-label">Related Data</span>${badges.join("")}</div>`;
}

async function primePurgeMetadata() {
  const entity = state.entity;
  const cache = state.purgeMeta[entity] || {};
  state.purgeMeta[entity] = cache;

  const pending = [];
  for (const item of state.items) {
    const id = Number(item.id);
    if (!Number.isFinite(id)) continue;
    if (cache[id] !== undefined) continue;
    cache[id] = { loading: true, count: null };
    pending.push(id);
  }

  if (!pending.length) {
    return;
  }

  applySearch();

  await Promise.all(pending.map(async (id) => {
    try {
      const endpoint = entity === "users"
        ? `/admin/users/${id}/related-data`
        : `/admin/providers/${id}/related-data`;

      const res = await apiRequest(endpoint, { method: "GET" });
      if (!res) {
        cache[id] = { loading: false, count: 0 };
        return;
      }

      const payload = await res.json().catch(() => ({}));
      if (res.ok) {
        const relatedCounts = normalizeRelatedCounts(entity, payload?.related || {});
        const total = totalRelatedCount(entity, relatedCounts);
        cache[id] = {
          loading: false,
          count: total,
          related: relatedCounts,
        };
      } else {
        cache[id] = { loading: false, count: 0, related: null };
      }
    } catch (_err) {
      cache[id] = { loading: false, count: 0, related: null };
    }
  }));

  if (state.entity === entity) {
    applySearch();
  }
}

function getPurgeMeta(itemId) {
  const cache = state.purgeMeta[state.entity] || {};
  return cache[Number(itemId)] || null;
}

function selectedUsersWithRelatedData() {
  if (state.entity !== "users") return [];
  return state.items.filter((item) => {
    if (!state.selectedIds.has(Number(item.id))) return false;
    const meta = state.purgeMeta.users?.[Number(item.id)];
    return Number(meta?.count || 0) > 0;
  });
}

function updateDeleteButtonState() {
  if (!el.bulkDeleteBtn) return;
  const selectedCount = state.selectedIds.size;
  const confirmed = String(el.dangerConfirmInput?.value || "").trim().toUpperCase() === "DELETE";
  const riskySelection = selectedUsersWithRelatedData().length > 0;
  const relatedDeletionEnabled = Boolean(el.bulkDeleteRelated?.checked);
  const noun = state.entity === "users" ? "Account" : "Provider";

  el.bulkDeleteBtn.textContent = selectedCount
    ? `Delete ${selectedCount} Selected ${noun}${selectedCount === 1 ? "" : "s"}`
    : `Select ${noun}s to Delete`;
  el.bulkDeleteBtn.disabled = !selectedCount || !confirmed || (riskySelection && !relatedDeletionEnabled);
}

function updateSelectionSummary() {
  if (!el.selectionSummary) return;
  const selectedCount = state.selectedIds.size;
  const protectedCount = selectedUsersWithRelatedData().length;
  el.selectionSummary.textContent = protectedCount > 0
    ? `${selectedCount} selected · ${protectedCount} contain related data`
    : `${selectedCount} selected · no related data selected`;
  el.selectionSummary.classList.toggle("has-risk", protectedCount > 0);
  if (el.cleanupControls) el.cleanupControls.hidden = state.entity !== "users";
  if (el.cleanupTitle) {
    el.cleanupTitle.textContent = state.entity === "users" ? "Empty User Cleanup" : "Provider Account Cleanup";
  }
  updateDeleteButtonState();
}

function selectEmptyUsers() {
  if (state.entity !== "users") return;
  const metadataPending = state.filtered.some((item) => state.purgeMeta.users?.[Number(item.id)]?.loading);
  if (metadataPending) {
    setStatus("Related-data checks are still running. Try again when the badges finish loading.", true);
    return;
  }

  state.selectedIds.clear();
  state.filtered.forEach((item) => {
    const meta = state.purgeMeta.users?.[Number(item.id)];
    if (item.role !== "admin" && meta?.related && Number(meta.count || 0) === 0) {
      state.selectedIds.add(Number(item.id));
    }
  });
  if (el.bulkDeleteRelated) el.bulkDeleteRelated.checked = false;
  renderTable();
  renderCards();
  setStatus(`Selected ${state.selectedIds.size} empty non-admin user account(s). Review the checkboxes, deselect any account you want to keep, then complete Step 2.`);
}

function clearSelection() {
  state.selectedIds.clear();
  renderTable();
  renderCards();
  setStatus("Selection cleared.");
}

function setRowActionRunning(button, runningLabel) {
  if (!button) return;
  if (!button.dataset.baseLabel) {
    button.dataset.baseLabel = button.textContent || "";
  }
  button.disabled = true;
  button.classList.add("is-running");
  button.classList.remove("is-done");
  button.textContent = runningLabel;
}

function setRowActionDone(button, doneLabel) {
  if (!button) return;
  button.disabled = true;
  button.classList.remove("is-running");
  button.classList.add("is-done");
  button.textContent = doneLabel;
}

function clearRowActionState(button) {
  if (!button) return;
  button.classList.remove("is-running", "is-done");
  button.disabled = false;
  if (button.dataset.baseLabel) {
    button.textContent = button.dataset.baseLabel;
  }
}

async function showRelatedData(itemId) {
  const endpoint = state.entity === "users"
    ? `/admin/users/${itemId}/related-data`
    : `/admin/providers/${itemId}/related-data`;

  const res = await apiRequest(endpoint, { method: "GET" });
  if (!res) {
    setStatus("Related-data request failed", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Unable to load related data", true);
    return;
  }

  const title = state.entity === "users" ? `Related Data: User ${itemId}` : `Related Data: Provider ${itemId}`;
  if (el.tableQueryPanel && el.tableQueryTitle && el.tableQueryResult) {
    el.tableQueryPanel.hidden = false;
    el.tableQueryTitle.textContent = title;
    el.tableQueryResult.innerHTML = `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }
  setStatus(`Loaded related data for ${state.entity.slice(0, -1)} ${itemId}.`);
}

async function purgeRelatedData(itemId, sourceButton = null) {
  console.debug("[admin] purge-related clicked", { entity: state.entity, itemId });
  const kind = state.entity === "users" ? "login account" : "provider account";
  const ok = window.confirm(`Delete calendar data (events, notes, tasks, sticky notes) for this ${kind}?\n\nThis does NOT delete the ${kind} itself.`);
  if (!ok) {
    setStatus("Purge canceled.");
    return;
  }

  setRowActionRunning(sourceButton, "Deleting Calendar Data…");

  const endpoint = state.entity === "users"
    ? `/admin/users/${itemId}/purge-related`
    : `/admin/providers/${itemId}/purge-related`;

  const res = await apiRequest(endpoint, { method: "POST" });
  if (!res) {
    setStatus("Purge request failed", true);
    clearRowActionState(sourceButton);
    return;
  }

  let data = null;
  try {
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    if (contentType.includes("application/json")) {
      data = await res.json();
    } else {
      const text = await res.text();
      data = { detail: text || "Server returned a non-JSON response." };
    }
  } catch (_err) {
    data = { detail: "Unable to parse server response." };
  }

  if (handleAdminForbidden(res, data)) {
    clearRowActionState(sourceButton);
    return;
  }

  if (!res.ok) {
    if (res.status === 404) {
      setStatus(`${kind} ${itemId} was not found; treating as already purged.`);
      setRowActionDone(sourceButton, "Already Clear");
      await loadData();
      return;
    }
    const detail = String(data?.detail || "Purge failed").slice(0, 300);
    setStatus(detail, true);
    clearRowActionState(sourceButton);
    return;
  }

  setRowActionDone(sourceButton, "Calendar Data Cleared");
  setStatus(`Calendar data deleted for ${kind} ${itemId}.`);
  await loadData();
}

async function bulkDeleteSelected() {
  console.debug("[admin] bulk-delete clicked", { entity: state.entity, selectedIds: [...state.selectedIds] });
  syncSelectedIdsFromDom();

  if (!requireDangerConfirmation("bulk delete")) return;

  const ids = [...state.selectedIds];
  if (!ids.length) {
    setStatus("Select at least one row to bulk delete.", true);
    return;
  }

  const kind = state.entity === "users" ? "users" : "provider accounts";
  const deleteRelated = Boolean(el.bulkDeleteRelated?.checked);
  const riskyUsers = selectedUsersWithRelatedData();
  if (riskyUsers.length && !deleteRelated) {
    setStatus(`${riskyUsers.length} selected user account(s) contain related data. Deselect them, or explicitly enable “Also delete related data.”`, true);
    return;
  }
  const ok = window.confirm(`Delete ${ids.length} ${kind}?${deleteRelated ? " Related data will also be deleted." : ""}`);
  if (!ok) {
    setStatus("Bulk delete canceled.");
    return;
  }

  const endpoint = state.entity === "users" ? "/admin/users/bulk-delete" : "/admin/providers/bulk-delete";
  const payload = {
    ids,
    delete_related: deleteRelated,
    only_if_no_related: state.entity === "users" && !deleteRelated,
  };

  const res = await apiRequest(endpoint, { method: "POST", body: JSON.stringify(payload) });
  if (!res) {
    setStatus("Bulk delete request failed", true);
    return;
  }

  const data = await res.json().catch(() => ({ detail: "Unable to parse server response." }));

  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Bulk delete failed", true);
    return;
  }

  state.selectedIds.clear();
  if (el.dangerConfirmInput) el.dangerConfirmInput.value = "";
  if (el.bulkDeleteRelated) el.bulkDeleteRelated.checked = false;
  await loadData();
  const deletedCount = Number(data.deleted_users ?? data.deleted_providers ?? 0);
  const skippedCount = Array.isArray(data.skipped) ? data.skipped.length : 0;
  setStatus(`Bulk delete complete for ${kind}: deleted ${deletedCount}, skipped ${skippedCount}.`);
}

async function scanOrphans() {
  const res = await apiRequest("/admin/maintenance/orphans", { method: "GET" });
  if (!res) {
    setStatus("Orphan scan failed", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Orphan scan failed", true);
    return;
  }

  if (el.tableQueryPanel && el.tableQueryTitle && el.tableQueryResult) {
    el.tableQueryPanel.hidden = false;
    el.tableQueryTitle.textContent = "Orphan Scan Results";
    el.tableQueryResult.innerHTML = `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`;
  }

  setStatus("Orphan scan completed.");
}

async function deleteOrphans() {
  console.debug("[admin] delete-orphans clicked");
  if (!requireDangerConfirmation("deleting orphaned data")) return;

  const ok = window.confirm("Delete all orphaned users/accounts/events/notes/tasks/sticky notes?");
  if (!ok) {
    setStatus("Delete orphans canceled.");
    return;
  }

  const res = await apiRequest("/admin/maintenance/orphans/delete", {
    method: "POST",
    body: JSON.stringify({}),
  });
  if (!res) {
    setStatus("Delete orphans request failed", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Delete orphans failed", true);
    return;
  }

  setStatus("Orphan delete completed.");
  await loadData();
  await scanOrphans();
}

function compareUserAccounts(left, right) {
  const leftCreated = Date.parse(left.created_at || "") || 0;
  const rightCreated = Date.parse(right.created_at || "") || 0;
  if (leftCreated !== rightCreated) return rightCreated - leftCreated;

  const leftEvents = Number(state.purgeMeta.users?.[Number(left.id)]?.related?.events || 0);
  const rightEvents = Number(state.purgeMeta.users?.[Number(right.id)]?.related?.events || 0);
  if (leftEvents !== rightEvents) return rightEvents - leftEvents;

  return Number(right.id || 0) - Number(left.id || 0);
}

function applySearch() {
  const config = activeConfig();
  const q = (el.searchInput.value || "").trim().toLowerCase();

  state.filtered = state.items.filter((item) => {
    if (!q) return true;
    return config.searchText(item).toLowerCase().includes(q);
  });
  if (state.entity === "users") {
    state.filtered.sort(compareUserAccounts);
  }

  renderTable();
  renderCards();
}

function renderTable() {
  const config = activeConfig();

  const allSelected = state.filtered.length > 0 && state.filtered.every((item) => state.selectedIds.has(Number(item.id)));
  const header = [`<th><input id="selectAllRows" type="checkbox" ${allSelected ? "checked" : ""} aria-label="Select all rows"></th>`]
    .concat(config.columns.map((c) => `<th>${escapeHtml(c)}</th>`))
    .join("");
  const rows = state.filtered.map((item) => {
    const selected = state.selectedIds.has(Number(item.id));
    const cells = config.row(item).map((v) => `<td>${escapeHtml(v)}</td>`).join("");
    if (state.entity === "users") {
      return [
        `<tr class="user-related-row"><td colspan="6">${renderUserRelatedSummary(item)}</td><td class="user-actions-cell" rowspan="2"><div class="row-actions">${renderRowActions(item)}</div></td></tr>`,
        `<tr class="user-account-row"><td><input class="row-select" data-select-id="${item.id}" type="checkbox" ${selected ? "checked" : ""}></td>${cells}</tr>`,
      ].join("");
    }
    return `<tr><td><input class="row-select" data-select-id="${item.id}" type="checkbox" ${selected ? "checked" : ""}></td>${cells}<td><div class="row-actions">${renderRowActions(item)}</div></td></tr>`;
  }).join("");

  const tableClass = state.entity === "users" ? "admin-data-table users-table" : "admin-data-table providers-table";
  el.desktopGrid.innerHTML = `<table class="${tableClass}"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;
  updateSelectionSummary();

  const selectAllRows = el.desktopGrid.querySelector("#selectAllRows");
  if (selectAllRows) {
    selectAllRows.addEventListener("change", () => {
      if (selectAllRows.checked) {
        state.filtered.forEach((item) => state.selectedIds.add(Number(item.id)));
      } else {
        state.filtered.forEach((item) => state.selectedIds.delete(Number(item.id)));
      }
      renderTable();
      renderCards();
    });
  }

  el.desktopGrid.querySelectorAll(".row-select").forEach((box) => {
    box.addEventListener("change", () => {
      const id = Number(box.getAttribute("data-select-id"));
      if (box.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      updateSelectionSummary();
      renderCards();
    });
  });

  el.desktopGrid.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", onRowActionClick);
  });
}

function renderCards() {
  const config = activeConfig();
  const html = state.filtered.map((item) => {
    const body = config.cardBody(item).map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    const checked = state.selectedIds.has(Number(item.id));
    return `<div class="card"><h4><input class="row-select" data-select-id="${item.id}" type="checkbox" ${checked ? "checked" : ""}> ${escapeHtml(config.cardTitle(item))}</h4>${body}<div class="row-actions">${renderRowActions(item)}</div></div>`;
  }).join("");

  el.mobileCards.innerHTML = html;
  el.mobileCards.querySelectorAll(".row-select").forEach((box) => {
    box.addEventListener("change", () => {
      const id = Number(box.getAttribute("data-select-id"));
      if (box.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      updateSelectionSummary();
      renderTable();
    });
  });
  el.mobileCards.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", onRowActionClick);
  });
}

function renderTableQueryResult(payload) {
  if (!el.tableQueryPanel || !el.tableQueryResult || !el.tableQueryTitle) return;

  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const columns = Array.isArray(payload?.columns) ? payload.columns : [];
  const tableName = payload?.table || "unknown";
  const error = payload?.error;

  el.tableQueryPanel.hidden = false;
  el.tableQueryTitle.textContent = `Table Query: ${tableName}`;

  if (error) {
    el.tableQueryResult.innerHTML = `<p class="status-line error">${escapeHtml(error)}</p>`;
    return;
  }

  if (!rows.length) {
    el.tableQueryResult.innerHTML = `<p class="status-line">No rows found in ${escapeHtml(tableName)}.</p>`;
    return;
  }

  const header = columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const body = rows.map((row) => {
    const cells = columns.map((c) => `<td>${escapeHtml(row[c] ?? "")}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");

  el.tableQueryResult.innerHTML = `
    <div class="status-line">Loaded ${rows.length} row(s).</div>
    <table>
      <thead><tr>${header}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

async function runSelectAllQuery() {
  const table = (el.tableInput?.value || "").trim();
  if (!table) {
    setStatus("Enter a table name first.", true);
    return;
  }

  setStatus(`Running SELECT * on ${table}...`);
  const res = await apiRequest(`/admin/system/table/${encodeURIComponent(table)}/rows`, { method: "GET" });
  if (!res) {
    setStatus("Table query request failed", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Table query failed", true);
    return;
  }

  state.tableQuery = data;
  renderTableQueryResult(data);
  setStatus(data.error ? data.error : `Loaded ${data.count ?? 0} row(s) from ${table}.`, Boolean(data.error));
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[",\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function exportCurrentTableQueryCsv() {
  const payload = state.tableQuery;
  if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) {
    setStatus("Run Select ALL first before exporting.", true);
    return;
  }

  const columns = Array.isArray(payload.columns) ? payload.columns : Object.keys(payload.rows[0] || {});
  const lines = [columns.map(csvEscape).join(",")];

  for (const row of payload.rows) {
    lines.push(columns.map((col) => csvEscape(row[col])).join(","));
  }

  const csv = lines.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const tableName = (payload.table || "table").replace(/[^A-Za-z0-9_-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const a = document.createElement("a");
  a.href = url;
  a.download = `${tableName}_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);

  setStatus(`Exported ${payload.rows.length} row(s) from ${payload.table}.`);
}

function renderRowActions(item) {
  const id = item.id;
  const purgeMeta = getPurgeMeta(id);
  const purgeLoading = Boolean(purgeMeta?.loading);
  const purgeCount = Number.isFinite(Number(purgeMeta?.count)) ? Number(purgeMeta?.count) : null;
  const purgeRelated = purgeMeta?.related || normalizeRelatedCounts(state.entity, {});
  const purgeDisabled = purgeLoading || (purgeCount !== null && purgeCount <= 0);

  const purgeLabelHtml = purgeLoading
    ? "Checking Calendar Data…"
    : state.entity === "users" && Number(purgeCount || 0) > 0
      ? `<span class="purge-label-text">Purge Data</span>`
      : buildPurgeLabelHtml(state.entity, purgeRelated, Number(purgeCount || 0));

  const purgeTitle = purgeCount !== null && purgeCount >= 0
    ? formatPurgeTitle(state.entity, purgeRelated, purgeCount)
    : "Checking for related calendar records";

  const purgeClasses = ["ghost-btn", "btn-purge-related"];
  if (purgeDisabled) purgeClasses.push("btn-muted");

  const deleteLabel = state.entity === "users" ? "Delete Login Account" : "Delete Provider Account";

  if (state.entity === "users") {
    return [
      `<button data-action="edit" data-id="${id}" type="button">Edit</button>`,
      `<button data-action="related" data-id="${id}" type="button">Related</button>`,
      `<button data-action="purge-related" data-id="${id}" class="${purgeClasses.join(" ")}" type="button" title="${escapeHtml(purgeTitle)}" ${purgeDisabled ? "disabled" : ""}>${purgeLabelHtml}</button>`,
      `<button data-action="reset" data-id="${id}" type="button">Reset Password</button>`,
      `<button data-action="delete" data-id="${id}" class="btn-danger btn-delete-login" type="button">${deleteLabel}</button>`,
    ].join("");
  }

  const statusAction = item.status === "active" ? "deactivate" : "activate";

  return [
    `<button data-action="edit" data-id="${id}" type="button">Edit</button>`,
    `<button data-action="related" data-id="${id}" type="button">Related</button>`,
    `<button data-action="purge-related" data-id="${id}" class="${purgeClasses.join(" ")}" type="button" title="${escapeHtml(purgeTitle)}" ${purgeDisabled ? "disabled" : ""}>${purgeLabelHtml}</button>`,
    `<button data-action="${statusAction}" data-id="${id}" type="button">${statusAction === "activate" ? "Activate" : "Deactivate"}</button>`,
    `<button data-action="delete" data-id="${id}" class="btn-danger btn-delete-login" type="button">${deleteLabel}</button>`,
  ].join("");
}

function findItem(id) {
  return state.items.find((item) => Number(item.id) === Number(id));
}

function requireDangerConfirmation(actionLabel) {
  const phrase = String(el.dangerConfirmInput?.value || "").trim().toUpperCase();
  if (phrase !== "DELETE") {
    const msg = `Type DELETE in Danger confirm before ${actionLabel}.`;
    setStatus(msg, true);
    if (el.dangerConfirmInput) {
      el.dangerConfirmInput.focus();
      el.dangerConfirmInput.select();
    }
    return false;
  }
  return true;
}

function syncSelectedIdsFromDom() {
  const checked = document.querySelectorAll(".row-select:checked");
  checked.forEach((box) => {
    const id = Number(box.getAttribute("data-select-id"));
    if (Number.isFinite(id) && id > 0) {
      state.selectedIds.add(id);
    }
  });
}

function openDialog(mode, item = null) {
  state.editing = { mode, item };
  const config = activeConfig();
  const titleBase = state.entity === "users" ? "User" : "Provider";

  initAdminWindowControls();
  resetWindowFrame(el.dialog);
  el.dialogTitle.textContent = `${mode === "create" ? "Create" : "Edit"} ${titleBase}`;
  el.formFields.innerHTML = config.buildForm(item, mode);
  el.dialog.showModal();
}

function closeDialog() {
  if (el.dialog.open) {
    el.dialog.close();
  }
}

function buildUserForm(item, mode) {
  const current = item || {};
  return `
    <label class="field"><span>Email</span><input name="email" type="email" value="${escapeHtml(current.email || "")}" required></label>
    <label class="field"><span>Username</span><input name="username" type="text" value="${escapeHtml(current.username || "")}" required></label>
    <label class="field"><span>Role</span>
      <select name="role" required>
        <option value="staff" ${current.role === "staff" ? "selected" : ""}>staff</option>
        <option value="admin" ${current.role === "admin" ? "selected" : ""}>admin</option>
      </select>
    </label>
    ${mode === "create" ? '<label class="field"><span>Password</span><input name="password" type="password" minlength="8" required></label>' : ""}
  `;
}

function buildProviderForm(item) {
  const current = item || { metadata: {} };
  return `
    <label class="field"><span>Provider Name</span><input name="provider_name" type="text" value="${escapeHtml(current.provider_name || "")}" required></label>
    <label class="field"><span>Contact Email</span><input name="contact_email" type="email" value="${escapeHtml(current.contact_email || "")}" required></label>
    <label class="field"><span>Status</span>
      <select name="status" required>
        <option value="active" ${current.status === "active" ? "selected" : ""}>active</option>
        <option value="inactive" ${current.status !== "active" ? "selected" : ""}>inactive</option>
      </select>
    </label>
    <label class="field"><span>Display Name</span><input name="display_name" type="text" value="${escapeHtml(current.metadata?.display_name || "")}"></label>
    <label class="field"><span>Provider ID</span><input name="provider_id" type="text" value="${escapeHtml(current.metadata?.provider_id || "")}"></label>
    <label class="field"><span>Color</span><input name="color" type="text" placeholder="#3366cc" value="${escapeHtml(current.metadata?.color || "")}"></label>
    <label class="field"><span>Is Primary</span>
      <select name="is_primary">
        <option value="false" ${current.metadata?.is_primary ? "" : "selected"}>false</option>
        <option value="true" ${current.metadata?.is_primary ? "selected" : ""}>true</option>
      </select>
    </label>
    ${current.id ? "" : '<label class="field"><span>Owner User ID</span><input name="user_id" type="number" min="1" required></label>'}
    ${current.id ? "" : '<label class="field"><span>Provider Key</span><input name="provider" type="text" placeholder="google" required></label>'}
  `;
}

async function submitDialog(event) {
  event.preventDefault();

  if (!state.editing) return;

  const fd = new FormData(el.form);
  const mode = state.editing.mode;

  if (state.entity === "users") {
    if (mode === "create") {
      const payload = {
        email: String(fd.get("email") || "").trim(),
        username: String(fd.get("username") || "").trim(),
        role: String(fd.get("role") || "staff"),
        password: String(fd.get("password") || ""),
      };
      await saveEntity("/admin/users", "POST", payload);
    } else {
      const payload = {
        email: String(fd.get("email") || "").trim(),
        username: String(fd.get("username") || "").trim(),
        role: String(fd.get("role") || "staff"),
      };
      await saveEntity(`/admin/users/${state.editing.item.id}`, "PUT", payload);
    }
  } else {
    if (mode === "create") {
      const payload = {
        user_id: Number(fd.get("user_id")),
        provider: String(fd.get("provider") || "").trim().toLowerCase(),
        provider_name: String(fd.get("provider_name") || "").trim(),
        contact_email: String(fd.get("contact_email") || "").trim(),
        status: String(fd.get("status") || "inactive"),
        provider_id: String(fd.get("provider_id") || "").trim() || null,
        color: String(fd.get("color") || "").trim() || null,
        is_primary: String(fd.get("is_primary") || "false") === "true",
      };
      await saveEntity("/admin/providers", "POST", payload);
    } else {
      const payload = {
        provider_name: String(fd.get("provider_name") || "").trim(),
        contact_email: String(fd.get("contact_email") || "").trim(),
        status: String(fd.get("status") || "inactive"),
        display_name: String(fd.get("display_name") || "").trim() || null,
        provider_id: String(fd.get("provider_id") || "").trim() || null,
        color: String(fd.get("color") || "").trim() || null,
        is_primary: String(fd.get("is_primary") || "false") === "true",
      };
      await saveEntity(`/admin/providers/${state.editing.item.id}`, "PUT", payload);
    }
  }
}

async function saveEntity(url, method, payload) {
  const res = await apiRequest(url, { method, body: JSON.stringify(payload) });
  if (!res) {
    setStatus("Request failed", true);
    return;
  }

  const data = await res.json();
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    setStatus(data.detail || "Operation failed", true);
    return;
  }

  closeDialog();
  await loadData();
}

async function onRowActionClick(event) {
  const sourceButton = event.currentTarget;
  const action = event.currentTarget.getAttribute("data-action");
  const id = Number(event.currentTarget.getAttribute("data-id"));
  const item = findItem(id);

  if (!item) return;

  if (action === "edit") {
    openDialog("edit", item);
    return;
  }

  if (action === "related") {
    await showRelatedData(id);
    return;
  }

  if (action === "purge-related") {
    await purgeRelatedData(id, sourceButton);
    return;
  }

  if (action === "delete") {
    console.debug("[admin] row-delete clicked", { entity: state.entity, id });
    const ok = window.confirm(`Delete this ${state.entity === "users" ? "login" : "provider"} account record?\n\nCalendar data is NOT deleted by this button. Use \"Delete Calendar Data\" first if needed.`);
    if (!ok) {
      setStatus("Delete canceled.");
      return;
    }

    setRowActionRunning(sourceButton, "Deleting Account…");

    const endpoint = state.entity === "users" ? `/admin/users/${id}` : `/admin/providers/${id}`;
    const res = await apiRequest(endpoint, { method: "DELETE" });
    if (!res) {
      setStatus("Delete request failed", true);
      clearRowActionState(sourceButton);
      return;
    }

    const data = await res.json();
    if (handleAdminForbidden(res, data)) {
      clearRowActionState(sourceButton);
      return;
    }

    if (!res.ok) {
      if (res.status === 404) {
        setStatus("Account was already deleted.");
        setRowActionDone(sourceButton, "Already Deleted");
        await loadData();
        return;
      }
      setStatus(data.detail || "Delete failed", true);
      clearRowActionState(sourceButton);
      return;
    }

    setRowActionDone(sourceButton, "Account Deleted");
    setStatus("Login account deleted.");
    await loadData();
    return;
  }

  if (state.entity === "users" && action === "reset") {
    const newPassword = window.prompt("Enter new password (min 8 chars):");
    if (!newPassword) return;

    const res = await apiRequest(`/admin/users/${id}/reset-password`, {
      method: "POST",
      body: JSON.stringify({ new_password: newPassword }),
    });

    if (!res) {
      setStatus("Reset request failed", true);
      return;
    }

    const data = await res.json();
    if (handleAdminForbidden(res, data)) {
      return;
    }

    if (!res.ok) {
      setStatus(data.detail || "Password reset failed", true);
      return;
    }

    setStatus("Password reset complete.");
    return;
  }

  if (state.entity === "providers" && (action === "activate" || action === "deactivate")) {
    const status = action === "activate" ? "active" : "inactive";

    const res = await apiRequest(`/admin/providers/${id}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });

    if (!res) {
      setStatus("Status update failed", true);
      return;
    }

    const data = await res.json();
    if (handleAdminForbidden(res, data)) {
      return;
    }

    if (!res.ok) {
      setStatus(data.detail || "Status update failed", true);
      return;
    }

    await loadData();
  }
}

function setEntity(nextEntity) {
  state.entity = nextEntity;
  state.selectedIds.clear();
  el.switchUsers.classList.toggle("active", nextEntity === "users");
  el.switchProviders.classList.toggle("active", nextEntity === "providers");
  if (el.accountsSummary) {
    el.accountsSummary.textContent = nextEntity === "users" ? "User Login Accounts" : "Provider Accounts";
  }
  loadData();
}

function bindEvents() {
  if (el.dangerConfirmInput) el.dangerConfirmInput.value = "";
  if (el.bulkDeleteRelated) el.bulkDeleteRelated.checked = false;
  updateDeleteButtonState();
  el.switchUsers.addEventListener("click", () => setEntity("users"));
  el.switchProviders.addEventListener("click", () => setEntity("providers"));
  el.reloadBtn.addEventListener("click", async () => {
    await loadSystemOverview();
    await loadData();
  });
  el.bulkDeleteBtn?.addEventListener("click", bulkDeleteSelected);
  el.dangerConfirmInput?.addEventListener("input", updateDeleteButtonState);
  el.bulkDeleteRelated?.addEventListener("change", updateDeleteButtonState);
  el.selectEmptyUsersBtn?.addEventListener("click", selectEmptyUsers);
  el.clearSelectionBtn?.addEventListener("click", clearSelection);
  el.scanOrphansBtn?.addEventListener("click", scanOrphans);
  el.deleteOrphansBtn?.addEventListener("click", deleteOrphans);
  el.selectAllBtn?.addEventListener("click", runSelectAllQuery);
  el.exportBtn?.addEventListener("click", exportCurrentTableQueryCsv);
  el.createBtn.addEventListener("click", () => openDialog("create"));
  el.searchInput.addEventListener("input", applySearch);
  el.tableInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSelectAllQuery();
    }
  });
  el.goCalendar.addEventListener("click", () => { window.location.href = "/calendar-ui"; });
  el.cancelDialog.addEventListener("click", closeDialog);
  el.form.addEventListener("submit", submitDialog);

  el.copyOverviewBtn?.addEventListener("click", async () => {
    if (!state.overview) {
      setStatus("System snapshot is not ready yet", true);
      return;
    }

    const snapshot = JSON.stringify(state.overview, null, 2);

    try {
      await navigator.clipboard.writeText(snapshot);
      setStatus("System snapshot copied to clipboard.");
    } catch (error) {
      console.warn("Clipboard copy failed", error);
      setStatus("Copy failed. Browser blocked clipboard access.", true);
    }
  });

  el.deploymentSyncRefreshBtn?.addEventListener("click", refreshDeploymentSync);
  el.deploymentSyncGithubBtn?.addEventListener("click", openDeploymentGithub);
  el.deploymentSyncCompareBtn?.addEventListener("click", openDeploymentCompare);
  el.deploymentSyncResolveBtn?.addEventListener("click", resolveDeploymentSync);
  el.gitCommitPushBtn?.addEventListener("click", launchGitCommitPush);

  el.runCurrentUserFailureCheckBtn?.addEventListener("click", loadCurrentUserFailureCheck);
  el.applyTokenEncryptionKeyBtn?.addEventListener("click", applyTokenEncryptionKey);
  el.runFailureHistoryBtn?.addEventListener("click", loadFailureHistory);
  el.databaseConnectBtn?.addEventListener("click", connectPreferredDatabase);
  el.databaseTestBtn?.addEventListener("click", testDatabaseConfig);
  el.databaseSaveBtn?.addEventListener("click", saveDatabaseConfig);
  el.databaseProfileSelect?.addEventListener("change", selectDatabaseProfile);
  el.databaseCopyBtn?.addEventListener("click", copyCriticalDatabaseData);
  if (el.databaseConfigDetails) {
    el.databaseConfigDetails.open = localStorage.getItem("databaseConfigOpen") !== "false";
    el.databaseConfigDetails.addEventListener("toggle", () => localStorage.setItem("databaseConfigOpen", String(el.databaseConfigDetails.open)));
  }
}

function populateDatabaseCopyProviders(profiles) {
  [el.databaseCopySourceSelect, el.databaseCopyTargetSelect].forEach((select) => {
    if (!select) return;
    const placeholder = select === el.databaseCopySourceSelect ? "Source provider" : "Target provider";
    select.replaceChildren(new Option(placeholder, ""));
    profiles.forEach((profile) => select.add(new Option(profile.title, profile.title)));
  });
}

async function copyCriticalDatabaseData() {
  const source = el.databaseCopySourceSelect?.value;
  const target = el.databaseCopyTargetSelect?.value;
  if (!source || !target) {
    if (el.databaseCopyStatus) el.databaseCopyStatus.textContent = "Select both a source and target provider.";
    return;
  }
  if (source === target || !window.confirm(`Copy critical application data from ${source} to ${target}? Existing target records will be preserved.`)) return;
  if (el.databaseCopyBtn) el.databaseCopyBtn.disabled = true;
  if (el.databaseCopyStatus) el.databaseCopyStatus.textContent = "Copying critical data...";
  const res = await apiRequest("/admin/system/database-config/copy", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source_provider: source, target_provider: target }),
  });
  const data = res ? await res.json().catch(() => ({})) : {};
  const totals = Object.values(data.tables || {}).reduce((sum, item) => sum + Number(item.copied || 0), 0);
  const providerTotal = Number(data.tables?.oauth_accounts?.copied || 0);
  if (el.databaseCopyStatus) {
    el.databaseCopyStatus.textContent = res?.ok ? `${data.message || "Copy complete."} ${totals} new rows copied, including ${providerTotal} authenticated provider accounts.` : data.detail || "Database copy failed.";
    el.databaseCopyStatus.classList.toggle("error", !res?.ok);
  }
  if (el.databaseCopyBtn) el.databaseCopyBtn.disabled = false;
}

function selectDatabaseProfile() {
  const profile = (window.__databaseProfiles || []).find((item) => item.title === el.databaseProfileSelect?.value);
  if (!profile) return;
  const fields = {
    databaseProviderTitleInput: profile.title,
    databaseHostInput: profile.database_host,
    databasePortInput: profile.database_port || "5432",
    databaseNameInput: profile.database_name,
    databaseUserInput: profile.database_user,
    databasePasswordInput: profile.database_password,
    databaseSslModeSelect: profile.ssl_mode || "require",
    databaseUrlInput: profile.database_url,
  };
  Object.entries(fields).forEach(([key, value]) => { if (el[key]) el[key].value = value || ""; });
}

function databasePayload(mode, url) {
  return {
    provider_title: el.databaseProviderTitleInput?.value.trim() || null,
    database_mode: mode,
    database_url: mode === "sqlite" ? (url || "sqlite:///./app.db") : url,
    database_user: el.databaseUserInput?.value.trim() || null,
    database_password: el.databasePasswordInput?.value || null,
    database_host: el.databaseHostInput?.value.trim() || null,
    database_port: el.databasePortInput?.value.trim() || "5432",
    database_name: el.databaseNameInput?.value.trim() || null,
    ssl_mode: el.databaseSslModeSelect?.value || "require",
    disable_sqlite_fallback: !(el.databaseFallbackToggle?.checked ?? true),
  };
}

async function connectPreferredDatabase() {
  if (window.__databaseRuntime === "cloudflare-worker") {
    await testDatabaseConfig({ mode: "postgres", url: "" });
    return;
  }
  const preferredUrl = (window.__databasePreferredUrl || "").trim();
  if (!preferredUrl) {
    setStatus("No Supabase or Neon Postgres URL is configured yet.", true);
    if (el.databaseConfigStatus) {
      el.databaseConfigStatus.textContent = "No Supabase or Neon Postgres URL is configured yet.";
      el.databaseConfigStatus.classList.add("error");
    }
    return;
  }

  if (el.databaseModeSelect) el.databaseModeSelect.value = "postgres";
  if (el.databaseUrlInput) el.databaseUrlInput.value = preferredUrl;
  await saveDatabaseConfig({ mode: "postgres", url: preferredUrl });
}

async function loadDatabaseConfig() {
  const res = await apiRequest("/admin/system/database-config", { method: "GET" });
  if (!res) {
    if (el.databaseConfigStatus) {
      el.databaseConfigStatus.textContent = "Unable to load database settings right now.";
      el.databaseConfigStatus.classList.add("error");
    }
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (handleAdminForbidden(res, data)) {
    return;
  }

  if (!res.ok) {
    if (el.databaseConfigStatus) {
      el.databaseConfigStatus.textContent = data.detail || "Database settings could not be loaded.";
      el.databaseConfigStatus.classList.add("error");
    }
    return;
  }

  const mode = (data.database_mode || "postgres").toLowerCase();
  const fallback = Boolean(data.disable_sqlite_fallback === true || data.disable_sqlite_fallback === "true");
  const preferredUrl = (data.preferred_postgres_url || "").trim();
  const activeUrl = (data.database_url || "").trim();
  window.__databaseProfiles = data.profiles || [];
  if (data.runtime === "cloudflare-worker" && data.provider_label) {
    window.__databaseProfiles = [{
      title: `${data.provider_label} (active)`,
      database_url: "",
      database_host: "cloudflare-hyperdrive",
      database_port: "5432",
      database_name: "configured Hyperdrive database",
      database_user: "managed by Cloudflare",
      ssl_mode: "managed by Hyperdrive",
    }];
  }
  populateDatabaseCopyProviders(window.__databaseProfiles);
  if (el.databaseProfileSelect) {
    el.databaseProfileSelect.replaceChildren(new Option("New provider connection", ""));
    window.__databaseProfiles.forEach((profile) => el.databaseProfileSelect.add(new Option(profile.title, profile.title)));
    if (data.active_provider_title && window.__databaseProfiles.some((profile) => profile.title === data.active_provider_title)) {
      el.databaseProfileSelect.value = data.active_provider_title;
    }
  }
  window.__databasePreferredUrl = preferredUrl;
  window.__databaseRuntime = data.runtime || "origin";
  if (el.databaseModeSelect) el.databaseModeSelect.value = mode === "sqlite" ? "sqlite" : "postgres";
  if (el.databaseUrlInput) el.databaseUrlInput.value = activeUrl || preferredUrl || "";
  if (el.databaseFallbackToggle) el.databaseFallbackToggle.checked = !fallback;
  if (el.databaseConnectBtn) {
    const workerRuntime = data.runtime === "cloudflare-worker";
    el.databaseConnectBtn.disabled = workerRuntime ? false : !preferredUrl;
    el.databaseConnectBtn.textContent = workerRuntime
      ? "Test active Worker DB"
      : preferredUrl ? "Connect Supabase / Neon" : "No Supabase / Neon URL";
    if (workerRuntime) {
      if (el.databaseTestBtn) {
        el.databaseTestBtn.disabled = true;
        el.databaseTestBtn.textContent = "Neon test requires origin runtime";
        el.databaseTestBtn.title = "The Worker can test only its configured Hyperdrive database.";
      }
      if (el.databaseSaveBtn) {
        el.databaseSaveBtn.disabled = true;
        el.databaseSaveBtn.textContent = "Configure DB in Cloudflare";
        el.databaseSaveBtn.title = "Update HYPERDRIVE_RLS_NO_CACHE in Cloudflare, then redeploy.";
      }
    }
  }
  if (el.hyperdriveSetupBanner && data.runtime === "cloudflare-worker") {
    const hyperdriveLive = data.hyperdrive_configured === true && data.hyperdrive_reachable === true;
    el.hyperdriveSetupBanner.hidden = hyperdriveLive;
    if (el.hyperdriveSetupMessage) el.hyperdriveSetupMessage.textContent = data.message || "Configure and redeploy the Hyperdrive binding before testing again.";
  }
  if (el.hyperdriveLiveBadge && data.runtime === "cloudflare-worker") {
    const live = data.hyperdrive_configured === true && data.hyperdrive_reachable === true;
    const provider = data.provider_label || "Postgres provider not identified";
    el.hyperdriveLiveBadge.classList.toggle("hyperdrive-live-badge-active", live);
    el.hyperdriveLiveBadge.classList.toggle("hyperdrive-live-badge-inactive", !live);
    if (el.hyperdriveLiveBadgeText) el.hyperdriveLiveBadgeText.textContent = live
      ? `LIVE and connected: ${provider}`
      : `NOT LIVE: ${provider} is not connected`;
  }
  if (el.databaseConfigStatus) {
    const statusText = data.message
      ? (data.live_database_confirmed ? "Live database check complete." : [data.message, ...(data.next_steps || []).map((step) => `Next: ${step}`)].join(" "))
      : data.is_connected_to_supabase
        ? "Supabase Postgres is active. Auto Allow is still on so SQLite remains a safe fallback."
        : data.is_connected_to_neon
          ? "Neon Postgres is active. Auto Allow is still on so SQLite remains a safe fallback."
          : "Auto Allow is enabled by default so SQLite can be used as a safe fallback.";
    el.databaseConfigStatus.textContent = statusText;
    el.databaseConfigStatus.classList.toggle("error", data.hyperdrive_configured === false);
  }
  if (el.databaseCopyBtn && data.copy_supported === false) {
    el.databaseCopyBtn.disabled = true;
    if (el.databaseCopyStatus) el.databaseCopyStatus.textContent = "Data copy is unavailable in the single-binding Worker runtime. Configure a second database binding or use the origin runtime with two saved providers.";
  }
}

async function testDatabaseConfig(options = {}) {
  if (el.databaseTestBtn) {
    el.databaseTestBtn.disabled = true;
    el.databaseTestBtn.textContent = "Testing connection...";
  }
  if (el.databaseConfigStatus) {
    el.databaseConfigStatus.textContent = "Testing the database credentials and SSL connection...";
    el.databaseConfigStatus.classList.remove("error");
  }
  const mode = options.mode || el.databaseModeSelect?.value || "postgres";
  const url = (options.url ?? el.databaseUrlInput?.value ?? "").trim();
  const payload = databasePayload(mode, url);

  const res = await apiRequest("/admin/system/database-config/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res) {
    setStatus("Database test request failed.", true);
    if (el.databaseTestBtn) { el.databaseTestBtn.disabled = false; el.databaseTestBtn.textContent = "Test Neon connection"; }
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (handleAdminForbidden(res, data)) return;

  if (!res.ok) {
    setStatus(data.detail || "Database connection test failed.", true);
    if (el.databaseConfigStatus) {
      el.databaseConfigStatus.textContent = data.detail || "Database connection test failed.";
      el.databaseConfigStatus.classList.add("error");
    }
    if (el.databaseTestBtn) { el.databaseTestBtn.disabled = false; el.databaseTestBtn.textContent = "Test Neon connection"; }
    return;
  }

  const details = data.connection_details ? ` Host: ${data.connection_details.host}, port: ${data.connection_details.port}, database: ${data.connection_details.database}, SSL: ${data.connection_details.ssl_mode}.` : "";
  const message = [data.ok ? "Connection verified." : "Connection was not verified.", data.message, details, ...(data.next_steps || []).map((step) => `Next: ${step}`)].filter(Boolean).join(" ");
  setStatus(message || "Database connection test passed.");
  if (el.databaseConfigStatus) {
    el.databaseConfigStatus.textContent = message || "Database connection test passed.";
    el.databaseConfigStatus.classList.toggle("error", data.ok === false);
  }
  if (el.databaseTestBtn) { el.databaseTestBtn.disabled = false; el.databaseTestBtn.textContent = "Test Neon connection"; }
}

async function saveDatabaseConfig(options = {}) {
  const mode = options.mode || el.databaseModeSelect?.value || "postgres";
  const url = (options.url ?? el.databaseUrlInput?.value ?? "").trim();
  const payload = databasePayload(mode, url);

  const res = await apiRequest("/admin/system/database-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res) {
    setStatus("Save database settings request failed.", true);
    return;
  }

  const data = await res.json().catch(() => ({}));
  if (handleAdminForbidden(res, data)) return;

  if (!res.ok || data.ok === false) {
    const message = [data.detail, ...(data.next_steps || []).map((step) => `Next: ${step}`)].filter(Boolean).join(" ");
    setStatus(message || "Unable to save database settings.", true);
    if (el.databaseConfigStatus) {
      el.databaseConfigStatus.textContent = message || "Unable to save database settings.";
      el.databaseConfigStatus.classList.add("error");
    }
    return;
  }

  setStatus(data.message || "Database settings saved.");
  if (el.databaseConfigStatus) {
    el.databaseConfigStatus.textContent = data.saved?.provider_title
      ? `${data.saved.provider_title} saved as the active provider. Restart the app to fully apply the runtime engine.`
      : data.message || "Database settings saved. Restart the app to fully apply the runtime engine.";
    el.databaseConfigStatus.classList.remove("error");
  }
  await loadDatabaseConfig();
}

if (el.historyStartDate && !el.historyStartDate.value) {
  el.historyStartDate.value = isoDateDaysAgo(7);
}

if (el.historyEndDate && !el.historyEndDate.value) {
  el.historyEndDate.value = todayIsoDate();
}

bindEvents();
loadDatabaseConfig();
loadSystemOverview();
loadData();
