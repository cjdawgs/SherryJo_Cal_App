import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../../app/static/admin.js", import.meta.url), "utf8");

function extract(start, end) {
    const first = source.indexOf(start);
    const last = source.indexOf(end, first);
    assert.ok(first >= 0 && last > first, `Missing ${start}`);
    return source.slice(first, last);
}

function button() {
    return { disabled: false };
}

function resultElement() {
    const classes = new Set();
    return {
        textContent: "",
        classList: {
            toggle(name, enabled) {
                if (enabled) classes.add(name);
                else classes.delete(name);
            },
            contains(name) { return classes.has(name); },
        },
    };
}

test("Render and Cloudflare commit comparisons are independent and unknown stays unknown", () => {
    const context = vm.createContext({});
    vm.runInContext(
        extract("function normalizeCommit(", "function applyWorkerDeploymentStatus("),
        context,
    );
    assert.equal(context.platformSyncStatus("aaaaaaaa", "aaaaaaaa"), "synced");
    assert.equal(context.platformSyncStatus("bbbbbbbb", "aaaaaaaa"), "out-of-sync");
    assert.equal(context.platformSyncStatus(null, "aaaaaaaa"), "unknown");
    assert.equal(context.platformSyncStatus("aaaaaaaa", null), "unknown");
});

test("native Worker status does not mislabel the Worker commit as Render", () => {
    const context = vm.createContext({});
    vm.runInContext(
        extract("function normalizeCommit(", "async function refreshDeploymentSync("),
        context,
    );
    const data = { deployment: {
        active_platform: "cloudflare",
        current_commit: "bbbbbbbb",
        current_commit_source: "Cloudflare Worker build",
        github_latest_commit: "aaaaaaaa",
        platforms: [],
    } };
    context.applyWorkerDeploymentStatus(data, { platform: "cloudflare-worker", deploymentCommit: "bbbbbbbb" });
    assert.equal(data.deployment.origin_commit, undefined);
    assert.equal(data.deployment.status, "out_of_sync");
});

test("unconfigured pause control explains why no change was made", async () => {
    const result = resultElement();
    const context = vm.createContext({
        state: { cloudflareReleaseControl: { configured: false } },
        el: {
            cloudflareReleaseActionResult: result,
            cloudflareReleasePauseBtn: button(),
            cloudflareReleaseResumeBtn: button(),
        },
        apiRequest() { throw new Error("Unconfigured control must not send a request"); },
    });
    vm.runInContext(extract("async function updateCloudflareReleaseControl(", "async function loadMasterAdminCodeStatus("), context);
    await context.updateCloudflareReleaseControl(true);
    assert.match(result.textContent, /No change made.*GITHUB_TOKEN/);
    assert.equal(result.classList.contains("is-error"), true);
});

test("pause errors remain visible next to controls after reloading current state", async () => {
    const result = resultElement();
    const context = vm.createContext({
        state: { cloudflareReleaseControl: { configured: true, paused: false } },
        el: {
            cloudflareReleaseActionResult: result,
            cloudflareReleasePauseBtn: button(),
            cloudflareReleaseResumeBtn: button(),
        },
        apiRequest: async () => ({ ok: false, status: 502, json: async () => ({ detail: "GitHub denied access" }) }),
        handleAdminForbidden: () => false,
        loadCloudflareReleaseControl: async () => {},
    });
    vm.runInContext(extract("async function updateCloudflareReleaseControl(", "async function loadMasterAdminCodeStatus("), context);
    await context.updateCloudflareReleaseControl(true);
    assert.equal(result.textContent, "GitHub denied access");
    assert.equal(result.classList.contains("is-error"), true);
});

test("pause success is reported only after GitHub confirms the requested state", async () => {
    const result = resultElement();
    const context = vm.createContext({
        state: { cloudflareReleaseControl: { configured: true, paused: false } },
        el: {
            cloudflareReleaseActionResult: result,
            cloudflareReleasePauseBtn: button(),
            cloudflareReleaseResumeBtn: button(),
        },
        apiRequest: async () => ({ ok: true, json: async () => ({ configured: true, paused: true }) }),
        handleAdminForbidden: () => false,
        renderCloudflareReleaseControl: () => {},
    });
    vm.runInContext(extract("async function updateCloudflareReleaseControl(", "async function loadMasterAdminCodeStatus("), context);
    await context.updateCloudflareReleaseControl(true);
    assert.match(result.textContent, /Confirmed: Worker releases are paused/);
    assert.equal(result.classList.contains("is-success"), true);
});

test("unexpected returned pause state is not reported as success", async () => {
    const result = resultElement();
    const context = vm.createContext({
        state: { cloudflareReleaseControl: { configured: true, paused: false } },
        el: {
            cloudflareReleaseActionResult: result,
            cloudflareReleasePauseBtn: button(),
            cloudflareReleaseResumeBtn: button(),
        },
        apiRequest: async () => ({ ok: true, json: async () => ({ configured: true, paused: false }) }),
        handleAdminForbidden: () => false,
        renderCloudflareReleaseControl: () => {},
    });
    vm.runInContext(extract("async function updateCloudflareReleaseControl(", "async function loadMasterAdminCodeStatus("), context);
    await context.updateCloudflareReleaseControl(true);
    assert.match(result.textContent, /did not confirm/);
    assert.equal(result.classList.contains("is-error"), true);
});
