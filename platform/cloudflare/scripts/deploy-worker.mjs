import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const target = process.argv[2] || "production";
const dryRun = process.argv.includes("--dry-run");
const gitCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim().toLowerCase();

if (!/^[0-9a-f]{40}$/.test(gitCommit)) {
    throw new Error("Unable to determine the checked-out Git commit for this Worker deployment.");
}

const wranglerPath = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const buildAssetsPath = fileURLToPath(new URL("./build-assets.mjs", import.meta.url));
execFileSync(process.execPath, [buildAssetsPath], { stdio: "inherit" });
const args = [wranglerPath, "deploy", "--config", "../../wrangler.toml"];
if (dryRun) args.push("--dry-run");
args.push("--env", target === "canary" ? "canary" : "");
args.push("--var", `WORKER_GIT_COMMIT:${gitCommit}`);

const result = spawnSync(process.execPath, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;