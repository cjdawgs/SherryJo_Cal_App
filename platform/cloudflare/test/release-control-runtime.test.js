import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

test("GitHub release requests execute in Workers runtime and reject redirects", async () => {
    const source = await readFile(new URL("../src/admin-api.js", import.meta.url), "utf8");
    const start = source.indexOf("async function githubReleaseRequest(");
    const end = source.indexOf("async function releasePauseState(", start);
    assert.ok(start >= 0 && end > start);
    const requests = [];
    const server = createServer((request, response) => {
        requests.push(request.url);
        if (request.url === "/redirect") {
            response.writeHead(302, { location: "/forwarded" });
            response.end();
            return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ value: "false" }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const script = `
        const RELEASE_PAUSE_VARIABLE = "CLOUDFLARE_RELEASE_PAUSED";
        const originalFetch = globalThis.fetch;
        const fetch = (_url, init) => originalFetch("http://127.0.0.1:${port}" + currentPath, init);
        let currentPath;
        ${source.slice(start, end)}
        export default {
            async fetch(request) {
                currentPath = new URL(request.url).pathname;
                return Response.json(await githubReleaseRequest("owner/repo", "test-token", "/variable"));
            }
        };
    `;
    let emulator;
    try {
        emulator = new Miniflare(convertV4MiniflareOptions({
            modules: true,
            compatibilityDate: "2026-08-01",
            script,
        }));
        const success = await emulator.dispatchFetch("http://test/success");
        assert.deepEqual(await success.json(), { payload: { value: "false" } });
        const redirect = await emulator.dispatchFetch("http://test/redirect");
        assert.match((await redirect.json()).error, /redirect was not followed/);
        assert.deepEqual(requests, ["/success", "/redirect"]);
    } finally {
        if (emulator) await emulator.dispose();
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
});
