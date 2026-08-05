/*
 * Central API client for auth headers, request normalization, and error handling.
 * This is the single fetch abstraction used by frontend modules.
 */

function getAuthToken() {
  return localStorage.getItem("token");
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem("token", token);
  }
}

function clearAuthToken() {
  localStorage.removeItem("token");
}

function requireAuth() {
  const token = getAuthToken();
  if (!token) {
    window.location.href = "/login";
    return null;
  }
  return token;
}

async function addReplaySafetyHeader(url, method, payload, headers) {
  const pathname = new URL(url, window.location.origin).pathname;
  const replaySafePost = new Set(["/calendar/event", "/notes/", "/tasks/"]);
  if (method.toUpperCase() === "POST" && replaySafePost.has(pathname)) {
    if (!headers["Idempotency-Key"] && !headers["idempotency-key"]) {
      headers["Idempotency-Key"] = crypto.randomUUID();
    }
    return;
  }
  if (["PUT", "DELETE"].includes(method.toUpperCase()) && /^\/calendar\/event\/\d+$/.test(pathname)) {
    if (!headers["Idempotency-Key"] && !headers["idempotency-key"]) {
      headers["Idempotency-Key"] = crypto.randomUUID();
    }
    return;
  }
  const replaySafePut = pathname.startsWith("/calendar/date-sticky/") || pathname === "/calendar/tag-colors";
  if (method.toUpperCase() !== "PUT" || !replaySafePut) return;
  if (headers["Idempotency-Key"] || headers["idempotency-key"]) return;

  const source = `${method.toUpperCase()}:${pathname}:${payload || ""}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  headers["Idempotency-Key"] = Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

async function request(url, options = {}) {
  const {
    method = "GET",
    auth = true,
    body,
    headers: extraHeaders = {},
    ...rest
  } = options;

  const headers = {
    ...extraHeaders,
  };

  let payload = body;
  const isFormLike = typeof FormData !== "undefined" && body instanceof FormData;
  const isJsonBody = payload != null && typeof payload !== "string" && !isFormLike;

  if (isJsonBody) {
    payload = JSON.stringify(payload);
  }

  if (!isFormLike && payload != null && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  await addReplaySafetyHeader(url, method, payload, headers);

  if (auth) {
    const token = getAuthToken();
    if (!token) {
      window.location.href = "/login";
      return null;
    }
    headers.Authorization = `Bearer ${token}`;
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: payload,
      ...rest,
    });
  } catch (error) {
    console.error("Network request failed:", error);
    return null;
  }

  if (response.status === 401 && auth) {
    clearAuthToken();
    window.location.href = "/login";
    return null;
  }

  // ✅ Unified safe return (compatibility layer)
  let json = {};
  try {
    json = await response.json();
  } catch {
    json = {};
  }

  return {
    ...json,

    // ✅ old-style compatibility
    json: async () => json,
    text: async () => JSON.stringify(json),

    // ✅ preserve metadata if anything relies on it
    ok: response.ok,
    status: response.status,
  };

  //return response;
}

const api = {
  request,
  get: (url, options = {}) => request(url, { ...options, method: "GET" }),
  post: (url, body, options = {}) => request(url, { ...options, method: "POST", body }),
  put: (url, body, options = {}) => request(url, { ...options, method: "PUT", body }),
  del: (url, options = {}) => request(url, { ...options, method: "DELETE" }),
};

// Backward-compatible aliases used by existing modules.
const apiRequest = request;
const apiFetch = (url, options = {}) => request(url, { ...options, auth: options.auth !== false });

window.api = api;
window.apiRequest = apiRequest;
window.apiFetch = apiFetch;
window.getAuthToken = getAuthToken;
window.setAuthToken = setAuthToken;
window.requireAuth = requireAuth;

export { api, apiRequest, apiFetch, requireAuth, getAuthToken, setAuthToken, clearAuthToken };
