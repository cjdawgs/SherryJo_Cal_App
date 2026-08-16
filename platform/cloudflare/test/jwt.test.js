import assert from "node:assert/strict";
import test from "node:test";
import { generateKeyPairSync, sign } from "node:crypto";

import { authenticateTvRequest, authenticateWorkerRequest, JwtVerificationError, verifyWorkerJwt } from "../src/jwt.js";

const NOW = 1_800_000_000;
const ISSUER = "https://auth.sherryjo.test";
const AUDIENCE = "sherryjo-calendar-test";

function base64Url(value) {
    return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

function keypair() {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    return {
        privateKey: pair.privateKey,
        publicKey: pair.publicKey.export({ type: "spki", format: "pem" }),
    };
}

function payload(overrides = {}) {
    return {
        sub: "42",
        user_id: 42,
        iss: ISSUER,
        aud: AUDIENCE,
        iat: NOW,
        nbf: NOW,
        exp: NOW + 3600,
        jti: "test-jti",
        ...overrides,
    };
}

function signedToken(privateKey, claims = payload(), header = { alg: "RS256", kid: "key-1", typ: "JWT" }) {
    const encodedHeader = base64Url(header);
    const encodedPayload = base64Url(claims);
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
}

function options(publicKey, overrides = {}) {
    return {
        publicKeys: { "key-1": publicKey },
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
        clockSkewSeconds: 5,
        maxLifetimeSeconds: 3600,
        ...overrides,
    };
}

test("verifies a fully claimed RS256 token using an SPKI PEM key", async () => {
    const pair = keypair();
    const claims = await verifyWorkerJwt(signedToken(pair.privateKey), options(pair.publicKey));

    assert.equal(claims.user_id, 42);
    assert.equal(claims.sub, "42");
});

test("rejects legacy HS256 and unknown key IDs", async () => {
    const pair = keypair();
    const hsToken = `${base64Url({ alg: "HS256", kid: "key-1" })}.${base64Url(payload())}.${base64Url("signature")}`;

    await assert.rejects(
        verifyWorkerJwt(hsToken, options(pair.publicKey)),
        /must use RS256/,
    );
    await assert.rejects(
        verifyWorkerJwt(
            signedToken(pair.privateKey, payload(), { alg: "RS256", kid: "retired" }),
            options(pair.publicKey),
        ),
        /missing or unknown/,
    );
});

test("rejects a signature produced by a different key", async () => {
    const trusted = keypair();
    const untrusted = keypair();

    await assert.rejects(
        verifyWorkerJwt(signedToken(untrusted.privateKey), options(trusted.publicKey)),
        /signature is invalid/,
    );
});

test("accepts overlapping public keys and rejects a retired key", async () => {
    const oldPair = keypair();
    const newPair = keypair();
    const oldToken = signedToken(oldPair.privateKey, payload(), { alg: "RS256", kid: "old" });
    const newToken = signedToken(newPair.privateKey, payload(), { alg: "RS256", kid: "new" });
    const overlapping = options(newPair.publicKey, {
        publicKeys: { old: oldPair.publicKey, new: newPair.publicKey },
    });

    assert.equal((await verifyWorkerJwt(oldToken, overlapping)).user_id, 42);
    assert.equal((await verifyWorkerJwt(newToken, overlapping)).user_id, 42);
    await assert.rejects(
        verifyWorkerJwt(oldToken, options(newPair.publicKey, { publicKeys: { new: newPair.publicKey } })),
        /missing or unknown/,
    );
});

test("rejects issuer, audience, and subject mismatches", async () => {
    const pair = keypair();
    const cases = [
        [payload({ iss: "https://attacker.example" }), /issuer/],
        [payload({ aud: "other-application" }), /audience/],
        [payload({ sub: "41" }), /does not match/],
        [payload({ sub: "not-a-user", user_id: "not-a-user" }), /positive integer/],
    ];

    for (const [claims, expected] of cases) {
        await assert.rejects(
            verifyWorkerJwt(signedToken(pair.privateKey, claims), options(pair.publicKey)),
            expected,
        );
    }
});

test("rejects every missing required claim", async () => {
    const pair = keypair();
    for (const claim of ["iss", "aud", "sub", "user_id", "iat", "nbf", "exp", "jti"]) {
        const claims = payload();
        delete claims[claim];
        await assert.rejects(
            verifyWorkerJwt(signedToken(pair.privateKey, claims), options(pair.publicKey)),
            JwtVerificationError,
        );
    }
});

test("rejects expired, future, inconsistent, and excessive time claims", async () => {
    const pair = keypair();
    const cases = [
        [payload({ exp: NOW - 6 }), /expired/],
        [payload({ iat: NOW + 6, nbf: NOW + 6, exp: NOW + 3600 }), /issued-at/],
        [payload({ nbf: NOW + 6, exp: NOW + 3600 }), /not active/],
        [payload({ nbf: NOW - 10, exp: NOW + 3600 }), /inconsistent/],
        [payload({ exp: NOW + 3601 }), /lifetime/],
    ];

    for (const [claims, expected] of cases) {
        await assert.rejects(
            verifyWorkerJwt(signedToken(pair.privateKey, claims), options(pair.publicKey)),
            expected,
        );
    }
});

test("rejects malformed compact tokens and keyring configuration", async () => {
    const pair = keypair();

    await assert.rejects(verifyWorkerJwt("not-a-jwt", options(pair.publicKey)), JwtVerificationError);
    await assert.rejects(
        verifyWorkerJwt(signedToken(pair.privateKey), options(pair.publicKey, { publicKeys: "not-json" })),
        /valid JSON/,
    );
});

test("authenticates a Bearer request from fixed Worker policy bindings", async () => {
    const pair = keypair();
    const currentNow = Math.floor(Date.now() / 1000);
    const token = signedToken(pair.privateKey, payload({
        iat: currentNow,
        nbf: currentNow,
        exp: currentNow + 3600,
    }));
    const request = new Request("https://calendar.example.com/native", {
        headers: { authorization: `Bearer ${token}` },
    });
    const env = {
        JWT_PUBLIC_KEYS_JSON: JSON.stringify({ "key-1": pair.publicKey }),
        JWT_ISSUER: ISSUER,
        JWT_AUDIENCE: AUDIENCE,
        JWT_CLOCK_SKEW_SECONDS: "5",
        JWT_MAX_LIFETIME_SECONDS: "3600",
    };

    assert.equal((await authenticateWorkerRequest(request, env)).user_id, 42);
});

test("request authentication fails closed on missing credentials or policy", async () => {
    const pair = keypair();
    const token = signedToken(pair.privateKey);
    const configured = {
        JWT_PUBLIC_KEYS_JSON: JSON.stringify({ "key-1": pair.publicKey }),
        JWT_ISSUER: ISSUER,
        JWT_AUDIENCE: AUDIENCE,
    };

    await assert.rejects(
        authenticateWorkerRequest(new Request("https://calendar.example.com/native"), configured),
        /single Bearer token/,
    );
    await assert.rejects(
        authenticateWorkerRequest(
            new Request("https://calendar.example.com/native", { headers: { authorization: `Bearer ${token}` } }),
            { ...configured, JWT_AUDIENCE: "" },
        ),
        /issuer and audience/,
    );
    await assert.rejects(
        authenticateWorkerRequest(
            new Request("https://calendar.example.com/native", { headers: { authorization: `Bearer ${token}` } }),
            { ...configured, JWT_MAX_LIFETIME_SECONDS: "not-a-number" },
        ),
        /JWT_MAX_LIFETIME_SECONDS/,
    );
});

test("persistent TV tokens are accepted only by the TV authentication policy", async () => {
    const pair = keypair();
    const currentNow = Math.floor(Date.now() / 1000);
    const tvClaims = payload({ iat: currentNow, nbf: currentNow, token_use: "tv" });
    delete tvClaims.exp;
    const token = signedToken(pair.privateKey, tvClaims);
    const request = () => new Request("https://calendar.example.com/tv/state", {
        headers: { authorization: `Bearer ${token}` },
    });
    const env = {
        JWT_PUBLIC_KEYS_JSON: JSON.stringify({ "key-1": pair.publicKey }),
        JWT_ISSUER: ISSUER,
        JWT_AUDIENCE: AUDIENCE,
    };

    assert.equal((await authenticateTvRequest(request(), env)).user_id, 42);
    await assert.rejects(authenticateWorkerRequest(request(), env), /exp claim/);
    await assert.rejects(
        verifyWorkerJwt(token, options(pair.publicKey, { nowSeconds: currentNow })),
        /exp claim/,
    );
});