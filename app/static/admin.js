import { apiRequest } from "/static/api.js";

const state = {
  entity: "users",
  items: [],
  filtered: [],
  selectedIds: new Set(),
  editing: null,
  overview: null,
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
  securityWarningBanner: document.getElementById("securityWarningBanner"),
};

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
    .replace(/'/g, "&#039;");
}

function renderSystemOverview(data) {
  state.overview = data;

  const db = data?.database || {};
  const security = data?.security || {};
  const tables = Array.isArray(data?.tables) ? data.tables : [];
  const userOps = Array.isArray(data?.admin_operations?.users) ? data.admin_operations.users : [];
  const providerOps = Array.isArray(data?.admin_operations?.providers) ? data.admin_operations.providers : [];

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
    if (hasCriticalCryptoGap) {
      const encryptedRows = Number(security?.encrypted_access_token_rows || 0);
      el.securityWarningBanner.hidden = false;
      el.securityWarningBanner.innerHTML =
        `<strong>Credential Decryption Blocked:</strong> ` +
        `${encryptedRows} encrypted OAuth credential row${encryptedRows === 1 ? " is" : "s are"} present, ` +
        `but TOKEN_ENCRYPTION_KEY is not configured. ` +
        `Background sync and provider publish will fail until the key is restored.`;
    } else {
      el.securityWarningBanner.hidden = true;
      el.securityWarningBanner.textContent = "";
    }
  }
}

async function loadSystemOverview() {
  const res = await apiRequest("/admin/system/overview", { method: "GET" });
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

  renderSystemOverview(data);
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
    searchText: (item) => `${item.provider_name} ${item.contact_email} ${item.status} ${item.metadata?.provider} ${item.metadata?.user_id ?? ""} ${item.metadata?.owner_email || ""}`,
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
}

bindEvents();
loadSystemOverview();
loadData();
