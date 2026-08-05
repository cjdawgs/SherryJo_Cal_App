// Issues RS256 JWTs using the Worker's configured private key and active kid.
// Produces tokens with the same claims structure as Render's create_token()
// when jwt_private_key is configured (see app/security.py).

function pemPrivateKeyBytes(pem) {
    const match = pem.trim().match(
        /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PRIVATE KEY-----$/,
    );
    if (!match) throw new Error("JWT_PRIVATE_KEY must be PKCS8 PEM (BEGIN PRIVATE KEY)");
    return Uint8Array.from(atob(match[1].replace(/\s/g, "")), (c) => c.charCodeAt(0));
}

function b64urlEncode(bytes) {
    let binary = "";
    bytes.forEach((b) => (binary += String.fromCharCode(b)));
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

export async function issueUserToken(userId, env) {
    const pemRaw = String(env.JWT_PRIVATE_KEY || "").trim();
    const kid = String(env.JWT_ACTIVE_KID || "").trim();
    const issuer = String(env.JWT_ISSUER || "").trim();
    const audience = String(env.JWT_AUDIENCE || "").trim();
    if (!pemRaw || !kid || !issuer || !audience) {
        throw new Error("JWT_PRIVATE_KEY, JWT_ACTIVE_KID, JWT_ISSUER, and JWT_AUDIENCE are required");
    }

    const privateKey = await crypto.subtle.importKey(
        "pkcs8",
        pemPrivateKeyBytes(pemRaw),
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["sign"],
    );

    const now = Math.floor(Date.now() / 1000);
    const lifetime = Math.max(1, Number(env.JWT_MAX_LIFETIME_SECONDS || 3600));
    const header = b64urlEncode(new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid })));
    const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({
        sub: String(userId),
        user_id: userId,
        iss: issuer,
        aud: audience,
        iat: now,
        nbf: now,
        exp: now + lifetime,
        jti: crypto.randomUUID(),
    })));
    const signingInput = `${header}.${payload}`;
    const sig = new Uint8Array(await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        privateKey,
        new TextEncoder().encode(signingInput),
    ));
    return `${signingInput}.${b64urlEncode(sig)}`;
}
