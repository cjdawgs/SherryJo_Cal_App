// HMAC-SHA256 OAuth state tokens using EDGE_PROXY_SECRET as the signing key.
// Format: base64url(payload_json) + "." + base64url(hmac_of_encoded_payload)
// Payload: { user_id, reconnect, exp }

const STATE_TTL_SECONDS = 600;

function b64urlEncode(bytes) {
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function b64urlDecode(s) {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (padded.length % 4)) % 4;
    return Uint8Array.from(atob(padded + "=".repeat(pad)), (c) => c.charCodeAt(0));
}

async function hmacKey(secret) {
    return crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"],
    );
}

export async function encodeOAuthState(userId, reconnectEmail, secret) {
    const payload = {
        user_id: userId,
        reconnect: reconnectEmail || "",
        exp: Math.floor(Date.now() / 1000) + STATE_TTL_SECONDS,
    };
    const encoded = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
    const key = await hmacKey(secret);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
    return `${encoded}.${b64urlEncode(sig)}`;
}

export async function decodeOAuthState(state, secret) {
    const dot = state.lastIndexOf(".");
    if (dot === -1) throw new Error("Invalid OAuth state");
    const encoded = state.slice(0, dot);
    const sig = b64urlDecode(state.slice(dot + 1));
    const key = await hmacKey(secret);
    if (!await crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(encoded))) {
        throw new Error("OAuth state signature invalid");
    }
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(encoded)));
    if (payload.exp < Math.floor(Date.now() / 1000)) throw new Error("OAuth state expired");
    if (!Number.isInteger(payload.user_id) || payload.user_id <= 0) throw new Error("Invalid user_id in state");
    return { userId: payload.user_id, reconnectEmail: payload.reconnect || "" };
}
