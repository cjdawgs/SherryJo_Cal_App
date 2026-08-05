import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { fernetEncrypt, fernetDecrypt } from "../src/fernet.js";

// 32-byte key: 16 signing + 16 encryption, URL-safe base64 encoded.
function testKey() {
    const raw = new Uint8Array(32);
    for (let i = 0; i < 32; i++) raw[i] = i + 1;
    return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_");
}

function rotationKey() {
    const raw = new Uint8Array(32).fill(0xaa);
    return btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_");
}

describe("fernetEncrypt / fernetDecrypt", () => {
    it("round-trips plaintext through encrypt and decrypt", async () => {
        const key = testKey();
        const sealed = await fernetEncrypt("hello fernet", key);
        assert.ok(sealed.startsWith("v1:"), "sealed value must start with v1:");
        const plain = await fernetDecrypt(sealed, key);
        assert.equal(plain, "hello fernet");
    });

    it("produces a different ciphertext each call (random IV)", async () => {
        const key = testKey();
        const a = await fernetEncrypt("same input", key);
        const b = await fernetEncrypt("same input", key);
        assert.notEqual(a, b);
    });

    it("decrypts using the second key in a rotation list", async () => {
        const primary = testKey();
        const old = rotationKey();
        const sealed = await fernetEncrypt("rotate me", old);
        // primary cannot decrypt it; the rotation list can.
        const plain = await fernetDecrypt(sealed, `${primary},${old}`);
        assert.equal(plain, "rotate me");
    });

    it("rejects a tampered token", async () => {
        const key = testKey();
        const sealed = await fernetEncrypt("tamper me", key);
        const tampered = sealed.slice(0, -4) + "XXXX";
        await assert.rejects(() => fernetDecrypt(tampered, key));
    });

    it("rejects a token decrypted with the wrong key", async () => {
        const key = testKey();
        const wrong = rotationKey();
        const sealed = await fernetEncrypt("wrong key test", key);
        await assert.rejects(() => fernetDecrypt(sealed, wrong));
    });

    it("returns legacy plaintext rows without v1: prefix unchanged", async () => {
        const key = testKey();
        const plain = await fernetDecrypt("legacy-plaintext-no-prefix", key);
        assert.equal(plain, "legacy-plaintext-no-prefix");
    });

    it("encrypts empty string", async () => {
        const key = testKey();
        const sealed = await fernetEncrypt("", key);
        assert.ok(sealed.startsWith("v1:"));
        assert.equal(await fernetDecrypt(sealed, key), "");
    });

    it("encrypts a long unicode string", async () => {
        const key = testKey();
        const input = "🔑 ".repeat(200) + "end";
        assert.equal(await fernetDecrypt(await fernetEncrypt(input, key), key), input);
    });
});
