import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

test("master admin recovery is available only in Admin registration", async () => {
    const html = await readFile(new URL("../../../app/templates/login.html", import.meta.url), "utf8");
    const body = html.split("<body>")[1].split('<script type="module">')[0];
    const elements = new Map();
    const stack = [];
    for (const match of body.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
        const [tag, name, attributes] = match;
        if (tag.startsWith("</")) {
            if (stack.at(-1)?.name === name) stack.pop();
            continue;
        }
        const id = attributes.match(/\bid="([^"]+)"/)?.[1];
        const element = {
            name,
            parent: stack.at(-1),
            style: { display: attributes.match(/\bstyle="display:\s*([^;"]+)/)?.[1] || "" },
            value: id === "registerRole" ? "staff" : "",
            textContent: "",
            addEventListener(type, handler) { this[type] = handler; },
        };
        if (id) elements.set(id, element);
        if (!["input", "br", "meta", "link"].includes(name)) stack.push(element);
    }

    const script = html.split('<script type="module">')[1].split("</script>")[0]
        .replace(/^\s*import .*;\s*/m, "");
    const requests = [];
    const window = { location: {} };
    runInNewContext(script, {
        document: { getElementById: (id) => elements.get(id) },
        localStorage: { getItem: () => null },
        window,
        console,
        apiRequest: async (url, options) => {
            requests.push({ url, options });
            return { ok: true, json: async () => ({}) };
        },
        setAuthToken() {},
    });

    const recovery = elements.get("adminRecoveryForm");
    const visible = () => {
        for (let element = recovery; element; element = element.parent) {
            if (element.style.display === "none") return false;
        }
        return true;
    };
    const role = elements.get("registerRole");

    assert.equal(visible(), false, "hidden on login");
    window.showRegisterForm();
    assert.equal(visible(), false, "hidden for Staff");
    role.value = "admin";
    window.toggleAdminCode();
    assert.equal(visible(), true, "visible for Admin registration");

    elements.get("adminRecoveryCode").value = "test-recovery";
    elements.get("newMasterAdminCode").value = "test-new-master-admin-code";
    elements.get("newMasterAdminCodeConfirm").value = "test-new-master-admin-code";
    await elements.get("masterAdminRecoveryForm").submit({ preventDefault() {} });
    assert.equal(requests[0].url, "/auth/admin-recovery/master-code");
    assert.match(elements.get("adminRecoveryStatus").textContent, /Master Admin Code reset/);

    role.value = "staff";
    window.toggleAdminCode();
    assert.equal(visible(), false, "hidden after switching to Staff");
    role.value = "admin";
    window.toggleAdminCode();
    window.hideRegisterForm();
    assert.equal(visible(), false, "hidden after Cancel");
    window.showRegisterForm();
    assert.equal(visible(), true, "visible when reopening Admin registration");
});
