import assert from "node:assert/strict";
import test from "node:test";

import {
    InvalidPairingCodeError,
        autoRedeemTvPairingCode,
    TvPairingPostgresAdapter,
    createTvPairingCode,
    pairingClientFingerprint,
    redeemTvPairingCode,
} from "../src/tv-pairing-postgres.js";

test("creates an unambiguous code and stores only its hash", async () => {
    const writes = [];
    const result = await createTvPairingCode({ create: async (value) => writes.push(value) }, {
        userId: 42,
        clientFingerprint: "203.0.113.8",
        now: new Date("2026-08-16T12:00:00.000Z"),
        randomValues(bytes) {
            bytes.fill(0);
            return bytes;
        },
    });

    assert.deepEqual(result, {
        pairingCode: "AAAA-AAAA",
        expiresAt: "2026-08-16T12:10:00.000Z",
        expiresIn: 600,
    });
    assert.equal(writes[0].userId, 42);
    assert.match(writes[0].hash, /^[0-9a-f]{64}$/);
    assert.equal(JSON.stringify(writes[0]).includes(result.pairingCode), false);
});

test("normalizes redemption and fails indistinguishably for invalid or consumed codes", async () => {
    const hashes = [];
    const adapter = {
        async redeem(hash) {
            hashes.push(hash);
            return hashes.length === 1 ? { user_id: 42, client_fingerprint: null } : null;
        },
    };
    assert.deepEqual(await redeemTvPairingCode(adapter, "aaaa aaaa"), { userId: 42, clientFingerprint: null });
    await assert.rejects(redeemTvPairingCode(adapter, "AAAA-AAAA"), InvalidPairingCodeError);
    await assert.rejects(redeemTvPairingCode(adapter, "OOOO-OOOO"), InvalidPairingCodeError);
});

test("adapter sets local identity for issuance and uses the atomic redemption function", async () => {
    const calls = [];
    const client = {
        connect: async () => calls.push(["connect"]),
        end: async () => calls.push(["end"]),
        query: async (sql, params) => {
            calls.push([sql, params]);
            return { rows: sql.includes("worker_redeem") ? [{ user_id: 42 }] : [] };
        },
    };
    const adapter = new TvPairingPostgresAdapter({ createClient: () => client, connectionString: "postgres://test" });
    await adapter.create({ userId: 42, hash: "a".repeat(64), expiresAt: new Date(), clientFingerprint: null });
    assert.deepEqual(calls[2], ["SELECT set_config('app.user_id', $1, true)", ["42"]]);
    assert.match(calls[3][0], /worker_create_tv_pairing_code/);

    calls.length = 0;
    assert.equal((await adapter.redeem("a".repeat(64))).user_id, 42);
    assert.match(calls[1][0], /worker_redeem_tv_pairing_code/);
});

test("prefers Cloudflare's verified connecting address for the auto-pair fingerprint", () => {
    const request = new Request("https://calendar.example.com/tv/generate-code", {
        headers: { "cf-connecting-ip": "203.0.113.8", "x-real-ip": "198.51.100.2" },
    });
    assert.equal(pairingClientFingerprint(request), "203.0.113.8");
});

test("auto-pair requires a fingerprint and consumes the newest matching code", async () => {
    const adapter = { autoRedeem: async (fingerprint) => fingerprint === "203.0.113.8" ? { user_id: 42 } : null };
    assert.deepEqual(await autoRedeemTvPairingCode(adapter, "203.0.113.8"), { userId: 42, clientFingerprint: null });
    await assert.rejects(autoRedeemTvPairingCode(adapter, null), /Auto-pair unavailable/);
});