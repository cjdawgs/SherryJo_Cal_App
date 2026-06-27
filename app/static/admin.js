import { apiRequest } from "/static/api.js";

const state = {
  entity: "users",
  items: [],
  filtered: [],
  editing: null,
  overview: null,
  tableQuery: null,
};

const el = {
  switchUsers: document.getElementById("switchUsers"),
  switchProviders: document.getElementById("switchProviders"),
  createBtn: document.getElementById("createBtn"),
  reloadBtn: document.getElementById("reloadBtn"),
  selectAllBtn: document.getElementById("selectAllBtn"),
  exportBtn: document.getElementById("exportBtn"),
  goCalendar: document.getElementById("goCalendar"),
  searchInput: document.getElementById("searchInput"),
  tableInput: document.getElementById("tableInput"),
  tableQueryPanel: document.getElementById("tableQueryPanel"),
  tableQueryTitle: document.getElementById("tableQueryTitle"),
  tableQueryResult: document.getElementById("tableQueryResult"),
  accountsSummary: document.getElementById("accountsSummary"),
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
};

function setStatus(message, isError = false) {
  el.statusLine.textContent = message || "";
  el.statusLine.classList.toggle("error", Boolean(isError));
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
    columns: ["ID", "Provider Name", "Contact", "Status", "Owner", "Actions"],
    row: (item) => [
      item.id,
      item.provider_name || "-",
      item.contact_email || "-",
      item.status || "inactive",
      item.metadata?.user_id ?? "-",
    ],
    cardTitle: (item) => item.provider_name || item.metadata?.provider || "Provider",
    cardBody: (item) => [
      `Contact: ${item.contact_email || "-"}`,
      `Status: ${item.status || "inactive"}`,
      `Provider: ${item.metadata?.provider || "-"}`,
      `Owner User ID: ${item.metadata?.user_id ?? "-"}`,
    ],
    searchText: (item) => `${item.provider_name} ${item.contact_email} ${item.status} ${item.metadata?.provider}`,
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
  applySearch();

  if (el.accountsSummary) {
    const label = state.entity === "users" ? "User Login Accounts" : "Provider Accounts";
    el.accountsSummary.textContent = `${label} (${state.filtered.length})`;
  }

  setStatus(`Loaded ${state.filtered.length} ${state.entity}.`);
}

function applySearch() {
  const config = activeConfig();
  const q = (el.searchInput.value || "").trim().toLowerCase();

  state.filtered = state.items.filter((item) => {
    if (!q) return true;
    return config.searchText(item).toLowerCase().includes(q);
  });

  renderTable();
  renderCards();
}

function renderTable() {
  const config = activeConfig();

  const header = config.columns.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const rows = state.filtered.map((item) => {
    const cells = config.row(item).map((v) => `<td>${escapeHtml(v)}</td>`).join("");
    return `<tr>${cells}<td>${renderRowActions(item)}</td></tr>`;
  }).join("");

  el.desktopGrid.innerHTML = `<table><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>`;

  el.desktopGrid.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", onRowActionClick);
  });
}

function renderCards() {
  const config = activeConfig();
  const html = state.filtered.map((item) => {
    const body = config.cardBody(item).map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    return `<div class="card"><h4>${escapeHtml(config.cardTitle(item))}</h4>${body}<div class="row-actions">${renderRowActions(item)}</div></div>`;
  }).join("");

  el.mobileCards.innerHTML = html;
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

  if (state.entity === "users") {
    return [
      `<button data-action="edit" data-id="${id}" type="button">Edit</button>`,
      `<button data-action="reset" data-id="${id}" type="button">Reset Password</button>`,
      `<button data-action="delete" data-id="${id}" class="btn-danger" type="button">Delete</button>`,
    ].join("");
  }

  const statusAction = item.status === "active" ? "deactivate" : "activate";

  return [
    `<button data-action="edit" data-id="${id}" type="button">Edit</button>`,
    `<button data-action="${statusAction}" data-id="${id}" type="button">${statusAction === "activate" ? "Activate" : "Deactivate"}</button>`,
    `<button data-action="delete" data-id="${id}" class="btn-danger" type="button">Delete</button>`,
  ].join("");
}

function findItem(id) {
  return state.items.find((item) => Number(item.id) === Number(id));
}

function openDialog(mode, item = null) {
  state.editing = { mode, item };
  const config = activeConfig();
  const titleBase = state.entity === "users" ? "User" : "Provider";

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
  const action = event.currentTarget.getAttribute("data-action");
  const id = Number(event.currentTarget.getAttribute("data-id"));
  const item = findItem(id);

  if (!item) return;

  if (action === "edit") {
    openDialog("edit", item);
    return;
  }

  if (action === "delete") {
    const ok = window.confirm(`Delete this ${state.entity === "users" ? "user" : "provider"}?`);
    if (!ok) return;

    const endpoint = state.entity === "users" ? `/admin/users/${id}` : `/admin/providers/${id}`;
    const res = await apiRequest(endpoint, { method: "DELETE" });
    if (!res) {
      setStatus("Delete request failed", true);
      return;
    }

    const data = await res.json();
    if (handleAdminForbidden(res, data)) {
      return;
    }

    if (!res.ok) {
      setStatus(data.detail || "Delete failed", true);
      return;
    }

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
  el.switchUsers.classList.toggle("active", nextEntity === "users");
  el.switchProviders.classList.toggle("active", nextEntity === "providers");
  if (el.accountsSummary) {
    el.accountsSummary.textContent = nextEntity === "users" ? "User Login Accounts" : "Provider Accounts";
  }
  loadData();
}

function bindEvents() {
  el.switchUsers.addEventListener("click", () => setEntity("users"));
  el.switchProviders.addEventListener("click", () => setEntity("providers"));
  el.reloadBtn.addEventListener("click", async () => {
    await loadSystemOverview();
    await loadData();
  });
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
