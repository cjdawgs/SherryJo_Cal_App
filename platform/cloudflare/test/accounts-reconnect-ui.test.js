import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../../../app/static/accounts.js", import.meta.url), "utf8");
const start = source.indexOf("function normalizeProvider(");
const end = source.indexOf("function normalizeRemedyAction(", start);
const candidateStart = source.indexOf("function isReconnectAvailable(");
const candidateEnd = source.indexOf("// ---------- Reconnect-all", candidateStart);
assert.ok(start >= 0 && end > start && candidateStart >= 0 && candidateEnd > candidateStart);
const context = vm.createContext({});
vm.runInContext(source.slice(start, end) + source.slice(candidateStart, candidateEnd), context);

test("bulk reconnect targets authentication problems, not ordinary sync failures", () => {
    const account = { provider: "google", status: "error", token_issue: { recommended_action: "retry_sync" } };
    assert.equal(context.isReconnectAvailable(account), true);
    assert.equal(context.isReconnectCandidate(account), false);
    account.token_issue.recommended_action = "reconnect";
    assert.equal(context.isReconnectCandidate(account), true);
    account.token_issue.requires_admin = true;
    assert.equal(context.isReconnectCandidate(account), false);
    account.token_issue.requires_admin = false;
    account.status = "ok";
    assert.equal(context.isReconnectCandidate(account), false);
});
