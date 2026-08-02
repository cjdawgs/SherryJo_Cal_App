const RSA_ALGORITHM = {
    name: "RSASSA-PKCS1-v1_5",
    hash: "SHA-256",
};

export class JwtVerificationError extends Error {
    constructor(message) {
        super(message);
        this.name = "JwtVerificationError";
    }
}

function decodeBase64Url(value, label) {
    if (typeof value !== "string" || !value || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) {
        throw new JwtVerificationError(`JWT ${label} is not valid base64url`);
    }

    const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    try {
        const decoded = atob(padded);
        return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    } catch {
        throw new JwtVerificationError(`JWT ${label} is not valid base64url`);
    }
}

function decodeJsonSegment(value, label) {
    const bytes = decodeBase64Url(value, label);
    let parsed;
    try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
        throw new JwtVerificationError(`JWT ${label} is not valid JSON`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new JwtVerificationError(`JWT ${label} must be a JSON object`);
    }
    return parsed;
}

function parsePublicKeyring(value) {
    let keyring = value;
    if (typeof value === "string") {
        try {
            keyring = JSON.parse(value);
        } catch {
            throw new JwtVerificationError("JWT public keyring must be valid JSON");
        }
    }
    if (!keyring || typeof keyring !== "object" || Array.isArray(keyring)) {
        throw new JwtVerificationError("JWT public keyring must map key IDs to public keys");
    }
    return keyring;
}

function publicKeyBytes(publicKeyPem) {
    if (typeof publicKeyPem !== "string") {
        throw new JwtVerificationError("JWT public key must be a PEM string");
    }
    const match = publicKeyPem.trim().match(
        /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PUBLIC KEY-----$/,
    );
    if (!match) {
        throw new JwtVerificationError("JWT public key must use SubjectPublicKeyInfo PEM format");
    }
    try {
        const decoded = atob(match[1].replaceAll(/\s/g, ""));
        return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
    } catch {
        throw new JwtVerificationError("JWT public key contains invalid base64");
    }
}

function requiredNumericClaim(payload, name) {
    const value = payload[name];
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new JwtVerificationError(`JWT ${name} claim must be numeric`);
    }
    return value;
}

function validateClaims(payload, options) {
    const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const clockSkewSeconds = Math.max(0, Number(options.clockSkewSeconds ?? 30));
    const maxLifetimeSeconds = Math.max(1, Number(options.maxLifetimeSeconds ?? 3600));
    if (![nowSeconds, clockSkewSeconds, maxLifetimeSeconds].every(Number.isFinite)) {
        throw new JwtVerificationError("JWT verification time settings must be finite numbers");
    }

    if (payload.iss !== options.issuer) {
        throw new JwtVerificationError("JWT issuer is not allowed");
    }
    if (payload.aud !== options.audience) {
        throw new JwtVerificationError("JWT audience is not allowed");
    }
    if (typeof payload.sub !== "string" || !/^[1-9][0-9]*$/.test(payload.sub)) {
        throw new JwtVerificationError("JWT subject must be a positive integer string");
    }
    if (!Number.isSafeInteger(payload.user_id) || payload.user_id <= 0 || String(payload.user_id) !== payload.sub) {
        throw new JwtVerificationError("JWT subject does not match user_id");
    }
    if (typeof payload.jti !== "string" || !payload.jti.trim()) {
        throw new JwtVerificationError("JWT jti claim is required");
    }

    const issuedAt = requiredNumericClaim(payload, "iat");
    const notBefore = requiredNumericClaim(payload, "nbf");
    const expiresAt = requiredNumericClaim(payload, "exp");
    if (issuedAt > nowSeconds + clockSkewSeconds) {
        throw new JwtVerificationError("JWT issued-at time is in the future");
    }
    if (notBefore > nowSeconds + clockSkewSeconds) {
        throw new JwtVerificationError("JWT is not active yet");
    }
    if (expiresAt <= nowSeconds - clockSkewSeconds) {
        throw new JwtVerificationError("JWT has expired");
    }
    if (notBefore < issuedAt - clockSkewSeconds || expiresAt <= notBefore) {
        throw new JwtVerificationError("JWT time claims are inconsistent");
    }
    if (expiresAt - issuedAt > maxLifetimeSeconds) {
        throw new JwtVerificationError("JWT lifetime exceeds the allowed maximum");
    }
}

export async function verifyWorkerJwt(token, options) {
    if (typeof token !== "string") {
        throw new JwtVerificationError("JWT must be a compact string");
    }
    const segments = token.split(".");
    if (segments.length !== 3 || segments.some((segment) => !segment)) {
        throw new JwtVerificationError("JWT must have three compact segments");
    }

    const [encodedHeader, encodedPayload, encodedSignature] = segments;
    const header = decodeJsonSegment(encodedHeader, "header");
    if (header.alg !== "RS256") {
        throw new JwtVerificationError("Worker-compatible tokens must use RS256");
    }
    if (typeof header.kid !== "string" || !header.kid.trim()) {
        throw new JwtVerificationError("JWT key ID is missing or unknown");
    }

    const keyring = parsePublicKeyring(options?.publicKeys);
    const publicKeyPem = Object.prototype.hasOwnProperty.call(keyring, header.kid) ? keyring[header.kid] : null;
    if (typeof publicKeyPem !== "string" || !publicKeyPem.trim()) {
        throw new JwtVerificationError("JWT key ID is missing or unknown");
    }

    let publicKey;
    try {
        publicKey = await crypto.subtle.importKey(
            "spki",
            publicKeyBytes(publicKeyPem),
            RSA_ALGORITHM,
            false,
            ["verify"],
        );
    } catch (error) {
        if (error instanceof JwtVerificationError) {
            throw error;
        }
        throw new JwtVerificationError("JWT public key could not be imported");
    }

    const signatureValid = await crypto.subtle.verify(
        RSA_ALGORITHM,
        publicKey,
        decodeBase64Url(encodedSignature, "signature"),
        new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
    if (!signatureValid) {
        throw new JwtVerificationError("JWT signature is invalid");
    }

    const payload = decodeJsonSegment(encodedPayload, "payload");
    validateClaims(payload, options || {});
    return payload;
}

function integerSetting(value, name, fallback, minimum) {
    const candidate = value === undefined || value === null || value === "" ? fallback : Number(value);
    if (!Number.isInteger(candidate) || candidate < minimum) {
        throw new JwtVerificationError(`${name} must be an integer at or above ${minimum}`);
    }
    return candidate;
}

export async function authenticateWorkerRequest(request, env) {
    const authorization = request.headers.get("authorization") || "";
    const match = authorization.match(/^Bearer ([^\s]+)$/i);
    if (!match) {
        throw new JwtVerificationError("A single Bearer token is required");
    }

    const issuer = String(env.JWT_ISSUER || "").trim();
    const audience = String(env.JWT_AUDIENCE || "").trim();
    if (!issuer || !audience) {
        throw new JwtVerificationError("Worker JWT issuer and audience must be configured");
    }

    return verifyWorkerJwt(match[1], {
        publicKeys: env.JWT_PUBLIC_KEYS_JSON,
        issuer,
        audience,
        clockSkewSeconds: integerSetting(env.JWT_CLOCK_SKEW_SECONDS, "JWT_CLOCK_SKEW_SECONDS", 30, 0),
        maxLifetimeSeconds: integerSetting(env.JWT_MAX_LIFETIME_SECONDS, "JWT_MAX_LIFETIME_SECONDS", 3600, 1),
    });
}