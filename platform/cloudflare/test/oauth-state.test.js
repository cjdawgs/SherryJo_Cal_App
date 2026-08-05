import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { encodeOAuthState, decodeOAuthState } from "../src/oauth-state.js";

const SECRET = "test-edge-proxy-secret-for-oauth-state-unit-tests";

describe("encodeOAuthState / decodeOAuthState", () => {
    it("round-trips userId and reconnectEmail", async () => {
        const state = await encodeOAuthState(42, "user@example.com", SECRET);
        const { userId, reconnectEmail } = await decodeOAuthState(state, SECRET);
        assert.equal(userId, 42);
        assert.equal(reconnectEmail, "user@example.com");
    });

    it("round-trips with an empty reconnectEmail", async () => {
        const state = await encodeOAuthState(7, "", SECRET);
        const { userId, reconnectEmail } = await decodeOAuthState(state, SECRET);
        assert.equal(userId, 7);
        assert.equal(reconnectEmail, "");
    });

    it("rejects a state signed with a different secret", async () => {
        const state = await encodeOAuthState(1, "", SECRET);
        await assert.rejects(() => decodeOAuthState(state, "wrong-secret"));
    });

    it("rejects a tampered payload", async () => {
        const state = await encodeOAuthState(1, "", SECRET);
        const parts = state.split(".");
        const tampered = parts[0].slice(0, -2) + "AA." + parts[1];
        await assert.rejects(() => decodeOAuthState(tampered, SECRET));
    });

    it("rejects state without a dot separator", async () => {
        await assert.rejects(() => decodeOAuthState("nodot", SECRET));
    });

    it("rejects an expired state", async () => {
        // Build a state with exp already in the past.
        const pastPayload = JSON.stringify({ user_id: 1, reconnect: "", exp: 1 });
        function b64url(s) {
            return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
        }
        const encoded = b64url(pastPayload);
        const key = await crypto.subtle.importKey(
            "raw", new TextEncoder().encode(SECRET),
            { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
        );
        const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded)));
        const b64urlEncode = (bytes) => {
            let b = "";
            bytes.forEach((v) => (b += String.fromCharCode(v)));
            return btoa(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
        };
        const expiredState = `${encoded}.${b64urlEncode(sig)}`;
        await assert.rejects(() => decodeOAuthState(expiredState, SECRET));
    });
});
