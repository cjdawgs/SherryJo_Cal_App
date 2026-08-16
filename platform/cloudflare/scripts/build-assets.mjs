import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cloudflareDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const projectDir = path.resolve(cloudflareDir, "../..");
const staticDir = path.join(projectDir, "app/static");
const templateDir = path.join(projectDir, "app/templates");
const outputDir = path.join(cloudflareDir, ".worker-assets");

const pageDefinitions = [
    {
        template: "index.html",
        output: "index.html",
        imports: {
            "/static/api.js": "api.js",
            "/static/account_connections.js": "account_connections.js",
            "/static/calendar.fullcalendar.js": "calendar.fullcalendar.js",
            "/static/calendar.ui.js": "calendar.ui.js",
            "/static/calendar.js": "calendar.js",
            "/static/core.js": "core.js",
            "/static/undo_redo.js": "undo_redo.js",
        },
    },
    {
        template: "accounts.html",
        output: "accounts.html",
        imports: { "/static/api.js": "api.js" },
    },
    { template: "admin.html", output: "admin.html", imports: null },
    { template: "login.html", output: "login.html", imports: null },
    { template: "tv.html", output: "tv.html", imports: null },
    { template: "tv_kiosk.html", output: "tv-kiosk.html", imports: null },
];

const assetHashes = new Map();

async function assetUrl(assetName) {
    const relativeName = String(assetName).replace(/^\/?static\//, "").replace(/^\//, "");
    let hash = assetHashes.get(relativeName);
    if (!hash) {
        const contents = await readFile(path.join(staticDir, relativeName));
        hash = createHash("sha256").update(contents).digest("hex").slice(0, 12);
        assetHashes.set(relativeName, hash);
    }
    return `/static/${relativeName}?v=${hash}`;
}

async function renderTemplate(definition) {
    let html = await readFile(path.join(templateDir, definition.template), "utf8");
    if (definition.template === "tv.html" || definition.template === "tv_kiosk.html") {
        html = html
            .replaceAll("{{ is_cloudflare_request | tojson }}", "true")
            .replaceAll("{{ app_version }}", "__TV_APP_VERSION__");
    }
    if (definition.template === "tv_kiosk.html") {
        html = html.replaceAll("{{ kiosk_token }}", "__KIOSK_TOKEN__");
    }
    const assetExpressions = [
        /\{\{\s*asset_url\(['"]([^'"]+)['"]\)\s*\}\}/g,
        /\{\{\s*url_for\(['"]static['"],\s*path=['"]([^'"]+)['"]\)\s*\}\}/g,
    ];

    for (const expression of assetExpressions) {
        const matches = [...html.matchAll(expression)];
        for (const match of matches) {
            html = html.replace(match[0], await assetUrl(match[1]));
        }
    }

    if (definition.imports) {
        const imports = {};
        for (const [specifier, assetName] of Object.entries(definition.imports)) {
            imports[specifier] = await assetUrl(assetName);
        }
        html = html.replace(
            /\{\{\s*asset_import_map_json\(asset_imports\)\|safe\s*\}\}/g,
            JSON.stringify({ imports }),
        );
    }

    if (/\{[{%]/.test(html)) {
        throw new Error(`Unsupported template expression remains in ${definition.template}`);
    }
    await writeFile(path.join(outputDir, definition.output), html);
}

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
await cp(staticDir, path.join(outputDir, "static"), { recursive: true });
for (const definition of pageDefinitions) {
    await renderTemplate(definition);
}