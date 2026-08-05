// Fernet-compatible AES-128-CBC + HMAC-SHA256 symmetric encryption.
// Key format: URL-safe base64-encoded 32 bytes (16 signing + 16 encryption).
// Stored format matches Python cryptography.Fernet with the "v1:" version prefix
// added by app/utils/crypto.py.

const FERNET_VERSION = 0x80;

function b64urlDecode(s) {
    const padded = s.replace(/-/g, "+").replace(/_/g, "/");
    const pad = (4 - (padded.length % 4)) % 4;
    const binary = atob(padded + "=".repeat(pad));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function b64urlEncode(bytes) {
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    // Preserve = padding to match Python urlsafe_b64encode output.
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_");
}

function concat(...arrays) {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

async function splitKey(keyB64) {
    const raw = b64urlDecode(keyB64.replace(/=/g, ""));
    if (raw.length !== 32) throw new Error(`Fernet key must be 32 bytes, got ${raw.length}`);
    return { signingKey: raw.slice(0, 16), encryptionKey: raw.slice(16) };
}

// Encrypts plaintext and returns "v1:<fernet-token>" matching Python's seal().
export async function fernetEncrypt(plaintext, tokenEncryptionKey) {
    const primaryKey = tokenEncryptionKey.split(",")[0].trim();
    const { signingKey, encryptionKey } = await splitKey(primaryKey);

    const iv = crypto.getRandomValues(new Uint8Array(16));
    const nowBig = BigInt(Math.floor(Date.now() / 1000));
    const timestamp = new Uint8Array(8);
    new DataView(timestamp.buffer).setBigUint64(0, nowBig, false);

    const aesKey = await crypto.subtle.importKey("raw", encryptionKey, { name: "AES-CBC" }, false, ["encrypt"]);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CBC", iv }, aesKey, new TextEncoder().encode(plaintext)));

    const body = concat(new Uint8Array([FERNET_VERSION]), timestamp, iv, ciphertext);
    const hmacKey = await crypto.subtle.importKey("raw", signingKey, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const hmac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, body));

    return "v1:" + b64urlEncode(concat(body, hmac));
}

// Decrypts a "v1:<fernet-token>" value, trying each comma-separated key in order.
// Legacy plaintext rows (no "v1:" prefix) are returned as-is.
export async function fernetDecrypt(sealedValue, tokenEncryptionKey) {
    if (!sealedValue || !sealedValue.startsWith("v1:")) return sealedValue ?? null;
    const token = sealedValue.slice(3);
    const keys = tokenEncryptionKey.split(",").map((k) => k.trim()).filter(Boolean);
    let lastErr;
    for (const k of keys) {
        try { return await tryDecrypt(token, k); } catch (e) { lastErr = e; }
    }
    throw lastErr ?? new Error("Fernet decryption failed");
}

async function tryDecrypt(token, keyB64) {
    const { signingKey, encryptionKey } = await splitKey(keyB64);
    const bytes = b64urlDecode(token);
    if (bytes.length < 57) throw new Error("Fernet token too short");
    if (bytes[0] !== FERNET_VERSION) throw new Error(`Fernet version mismatch: ${bytes[0]}`);

    const body = bytes.slice(0, bytes.length - 32);
    const storedHmac = bytes.slice(bytes.length - 32);
    const hmacKey = await crypto.subtle.importKey("raw", signingKey, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    if (!await crypto.subtle.verify("HMAC", hmacKey, storedHmac, body)) throw new Error("Fernet HMAC invalid");

    const iv = bytes.slice(9, 25);
    const ciphertext = bytes.slice(25, bytes.length - 32);
    const aesKey = await crypto.subtle.importKey("raw", encryptionKey, { name: "AES-CBC" }, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, aesKey, ciphertext);
    return new TextDecoder().decode(plain);
}
