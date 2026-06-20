/*
 * Central API helper for authorization and error handling.
 * Used by all authenticated frontend pages.
 */

function getAuthToken() {
  return localStorage.getItem("token");
}

function setAuthToken(token) {
  if (token) {
    localStorage.setItem("token", token);
  }
}

function requireAuth() {
  const token = getAuthToken();
  if (!token) {
    console.warn("⚠️ Missing auth token");
    window.location.href = "/login";
    return null;
  }
  return token;
}

async function apiRequest(url, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };

  if (options.auth !== false) {
    const token = getAuthToken();
    if (token) {
      headers.Authorization = "Bearer " + token;
    }
  }

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers
    });
  } catch (err) {
    console.error("⚠️ Network request failed:", err);
    return null;
  }

  if (response.status === 401 && options.auth !== false) {
    console.warn("⚠️ Authentication expired, redirecting to login");
    localStorage.removeItem("token");
    window.location.href = "/login";
    return null;
  }

  return response;
}

async function apiFetch(url, options = {}) {
  const token = requireAuth();
  if (!token) {
    return null;
  }

  const headers = {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + token,
    ...(options.headers || {})
  };

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers
    });
  } catch (err) {
    console.error("⚠️ Network request failed:", err);
    return null;
  }

  if (response.status === 401) {
    console.warn("⚠️ Authentication expired, redirecting to login");
    localStorage.removeItem("token");
    window.location.href = "/login";
    return null;
  }

  return response;
}

window.apiRequest = apiRequest;
window.apiFetch = apiFetch;
window.getAuthToken = getAuthToken;
window.setAuthToken = setAuthToken;
window.requireAuth = requireAuth;

export { apiRequest, apiFetch, requireAuth, getAuthToken, setAuthToken };
