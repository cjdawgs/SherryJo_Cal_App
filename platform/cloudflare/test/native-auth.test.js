import assert from "node:assert/strict";
import test from "node:test";

import {
    hashPassword,
    handleNativeLogin,
    handleNativeRegistration,
    verifyPassword,
} from "../src/native-auth.js";

const PASSLIB_HASH = "$argon2id$v=19$m=65536,t=3,p=4$6F0r5Vwr5fwf41xLibF2Tg$W0qiHzLG5Z0XUF3YU4QS612ViwjA3hqe7pGMrHZoSA0";

function jsonRequest(path, body) {
    return new Request(`https://calendar.example.com${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
    });
}

test("verifies existing Passlib Argon2id hashes", async () => {
    assert.equal(await verifyPassword("NativeAuth-Test-123", PASSLIB_HASH), true);
    assert.equal(await verifyPassword("wrong", PASSLIB_HASH), false);
});

test("creates Passlib-compatible Argon2id hashes", async () => {
    const hash = await hashPassword("NativeAuth-Roundtrip-456");

    assert.match(hash, /^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    assert.equal(await verifyPassword("NativeAuth-Roundtrip-456", hash), true);
    assert.equal(await verifyPassword("wrong", hash), false);
});

test("logs in by normalized identifier and issues the native token contract", async () => {
    const identifiers = [];
    const response = await handleNativeLogin(
        jsonRequest("/auth/login", { email: " USER@example.com ", password: "correct" }),
        {},
        {
            async findLoginUser(identifier) {
                identifiers.push(identifier);
                return { id: 42, hashed_password: "hash" };
            },
        },
        {
            verifyPassword: async (password, hash) => password === "correct" && hash === "hash",
            issueToken: async (userId) => `token-${userId}`,
        },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { access_token: "token-42", token_type: "bearer" });
    assert.deepEqual(identifiers, ["user@example.com"]);
});

test("returns one indistinguishable failure for missing users and bad passwords", async () => {
    for (const candidate of [null, { id: 42, hashed_password: "hash" }]) {
        const response = await handleNativeLogin(
            jsonRequest("/auth/login", { email: "user", password: "wrong" }),
            {},
            { findLoginUser: async () => candidate },
            { verifyPassword: async () => false },
        );
        assert.equal(response.status, 401);
        assert.deepEqual(await response.json(), { detail: "Invalid email, username, or password" });
    }
});

test("registers staff with a compatible hash and protects admin registration", async () => {
    const registrations = [];
    const adapter = {
        async registerUser(values) {
            registrations.push(values);
            return { id: 7, username: values.username, email: values.email, role: values.role };
        },
    };
    const dependencies = { hashPassword: async () => "$argon2id$test" };

    const staffResponse = await handleNativeRegistration(
        jsonRequest("/auth/register", {
            username: "staff-user", email: "STAFF@example.com", password: "secret", role: "staff",
        }),
        {}, adapter, dependencies,
    );
    assert.equal(staffResponse.status, 200);
    assert.equal(registrations[0].email, "staff@example.com");
    assert.equal(registrations[0].hashedPassword, "$argon2id$test");

    const adminResponse = await handleNativeRegistration(
        jsonRequest("/auth/register", {
            username: "admin-user", email: "admin@example.com", password: "secret",
            role: "admin", admin_setup_code: "wrong",
        }),
        { ADMIN_SETUP_CODE: "correct" }, adapter, dependencies,
    );
    assert.equal(adminResponse.status, 403);
    assert.equal(registrations.length, 1);
});