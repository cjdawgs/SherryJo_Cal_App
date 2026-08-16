import { argon2id, argon2Verify } from "hash-wasm";

import { issueUserToken } from "./auth-token-issue.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function response(payload, status) {
    return new Response(JSON.stringify(payload), {
        status,
        headers: { "cache-control": "no-store", "content-type": "application/json; charset=utf-8" },
    });
}

async function requestBody(request) {
    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().startsWith("application/json")) {
        throw new TypeError("application/json is required");
    }
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
        throw new TypeError("JSON object is required");
    }
    return body;
}

async function secretsEqual(left, right) {
    const [leftDigest, rightDigest] = await Promise.all([
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(left)),
        crypto.subtle.digest("SHA-256", new TextEncoder().encode(right)),
    ]);
    const leftBytes = new Uint8Array(leftDigest);
    const rightBytes = new Uint8Array(rightDigest);
    let difference = 0;
    for (let index = 0; index < leftBytes.length; index += 1) {
        difference |= leftBytes[index] ^ rightBytes[index];
    }
    return difference === 0;
}

export async function verifyPassword(password, hash) {
    if (typeof password !== "string" || !password || password.length > 256) return false;
    if (typeof hash !== "string" || !hash.startsWith("$argon2id$")) return false;
    try {
        return await argon2Verify({ password, hash });
    } catch {
        return false;
    }
}

export async function hashPassword(password) {
    if (typeof password !== "string" || !password || password.length > 256) {
        throw new TypeError("Password must be between 1 and 256 characters");
    }
    const salt = crypto.getRandomValues(new Uint8Array(16));
    return argon2id({
        password,
        salt,
        parallelism: 4,
        iterations: 3,
        memorySize: 65536,
        hashLength: 32,
        outputType: "encoded",
    });
}

export async function handleNativeLogin(request, env, adapter, dependencies = {}) {
    let body;
    try {
        body = await requestBody(request);
    } catch {
        return response({ detail: "Invalid login request" }, 422);
    }
    const identifier = String(body.email || "").trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    if (!identifier || identifier.length > 320 || !password || password.length > 256) {
        return response({ detail: "Invalid email, username, or password" }, 401);
    }

    const candidate = await adapter.findLoginUser(identifier);
    const passwordVerifier = dependencies.verifyPassword || verifyPassword;
    if (!candidate || !await passwordVerifier(password, candidate.hashed_password)) {
        return response({ detail: "Invalid email, username, or password" }, 401);
    }

    try {
        const tokenIssuer = dependencies.issueToken || issueUserToken;
        const token = await tokenIssuer(candidate.id, env);
        return response({ access_token: token, token_type: "bearer" }, 200);
    } catch {
        return response({ detail: "Session signing is unavailable" }, 503);
    }
}

export async function handleNativeRegistration(request, env, adapter, dependencies = {}) {
    let body;
    try {
        body = await requestBody(request);
    } catch {
        return response({ detail: "Invalid registration request" }, 422);
    }

    const username = String(body.username || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const role = String(body.role || "staff").trim().toLowerCase();
    if (!username || username.length > 100 || !EMAIL_PATTERN.test(email) || email.length > 320
        || !password || password.length > 256 || !["admin", "staff"].includes(role)) {
        return response({ detail: "Invalid registration fields" }, 422);
    }

    if (role === "admin") {
        const expected = String(env.ADMIN_SETUP_CODE || "").trim();
        const provided = String(body.admin_setup_code || "").trim();
        if (!expected || !await secretsEqual(provided, expected)) {
            return response({ detail: "Invalid admin setup code" }, 403);
        }
    }

    const passwordHasher = dependencies.hashPassword || hashPassword;
    const hashedPassword = await passwordHasher(password);
    try {
        const user = await adapter.registerUser({ username, email, hashedPassword, role });
        return response({ message: "User created successfully", ...user }, 200);
    } catch (error) {
        if (error?.code === "23505") {
            const detail = String(error.constraint || "").includes("username")
                ? "Username already taken"
                : "Email already registered";
            return response({ detail }, 400);
        }
        throw error;
    }
}