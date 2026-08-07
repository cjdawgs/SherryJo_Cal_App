import json
from pathlib import Path
import tomllib

import yaml


ROOT = Path(__file__).resolve().parents[2]


def test_cloudflare_release_is_manual_and_promotion_is_smoke_gated():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "cloudflare-release.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )

    assert set(workflow["on"]) == {"workflow_dispatch"}
    inputs = workflow["on"]["workflow_dispatch"]["inputs"]
    assert inputs["render_deployment_ready"]["default"] == "false"
    assert inputs["promote_production"]["default"] == "false"
    assert inputs["production_url"]["default"] == "https://sherryjo-cal-app.realty-cal.workers.dev"
    assert inputs["canary_url"]["default"] == "https://sherryjo-cal-app-canary.realty-cal.workers.dev"

    jobs = workflow["jobs"]
    assert jobs["verify"]["services"]["postgres"]["image"] == "postgres:16"
    assert jobs["verify"]["env"]["TEST_DATABASE_URL"].startswith("postgresql+psycopg2://")
    assert jobs["deploy-canary"]["needs"] == "verify"
    assert jobs["deploy-canary"]["environment"] == "cloudflare-canary"
    assert jobs["smoke-unauthenticated-canary"]["needs"] == "deploy-canary"
    assert jobs["smoke-authenticated-canary"]["needs"] == "deploy-canary"
    assert jobs["smoke-authenticated-canary"]["concurrency"] == {
        "group": "sherryjo-authenticated-smoke",
        "cancel-in-progress": "false",
    }

    promotion = jobs["promote-root-worker"]
    assert "inputs.promote_production" in promotion["if"]
    assert set(promotion["needs"]) == {
        "smoke-unauthenticated-canary",
        "smoke-authenticated-canary",
    }
    assert promotion["environment"] == "cloudflare-production"
    assert jobs["smoke-unauthenticated-production"]["needs"] == "promote-root-worker"
    assert jobs["smoke-authenticated-production"]["needs"] == "promote-root-worker"
    assert jobs["smoke-authenticated-production"]["concurrency"] == {
        "group": "sherryjo-authenticated-smoke",
        "cancel-in-progress": "false",
    }


def test_cloudflare_release_uses_environment_secrets_and_exact_targets():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "cloudflare-release.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    package = json.loads(
        (ROOT / "platform" / "cloudflare" / "package.json").read_text(encoding="utf-8")
    )
    jobs = workflow["jobs"]
    scripts = package["scripts"]

    deploy_step = next(
        step for step in jobs["deploy-canary"]["steps"]
        if step.get("name") == "Deploy isolated canary Worker"
    )
    promotion_step = next(
        step for step in jobs["promote-root-worker"]["steps"]
        if step.get("name") == "Promote verified build to root Worker"
    )
    assert deploy_step["run"].endswith("run deploy:canary")
    assert promotion_step["run"].endswith("run deploy")
    assert scripts["deploy:canary"].endswith("--env canary")
    assert scripts["deploy"].endswith('--env=""')
    assert deploy_step["env"] == {
        "CLOUDFLARE_API_TOKEN": "${{ secrets.CLOUDFLARE_API_TOKEN }}",
        "CLOUDFLARE_ACCOUNT_ID": "${{ secrets.CLOUDFLARE_ACCOUNT_ID }}",
    }

    canary_smoke = next(
        step for step in jobs["smoke-authenticated-canary"]["steps"]
        if step.get("name") == "Run reversible canary smoke"
    )
    production_smoke = next(
        step for step in jobs["smoke-authenticated-production"]["steps"]
        if step.get("name") == "Run reversible production smoke"
    )
    assert 'inputs.canary_url' in canary_smoke["run"]
    assert 'inputs.production_url' in production_smoke["run"]
    assert "--allow-remote" in canary_smoke["run"]
    assert "--allow-remote" in production_smoke["run"]


def test_root_and_canary_workers_require_edge_proxy_authentication():
    config = tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))

    assert config["name"] == "sherryjo-cal-app"
    assert config["env"]["canary"]["name"] == "sherryjo-cal-app-canary"
    required_secrets = ["EDGE_PROXY_SECRET", "JWT_PUBLIC_KEYS_JSON", "GOOGLE_CLIENT_SECRET", "MS_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY", "JWT_PRIVATE_KEY"]
    assert config["secrets"]["required"] == required_secrets
    assert config["env"]["canary"]["secrets"]["required"] == required_secrets
    expected_jwt_policy = {
        "JWT_ISSUER": "sherryjo-calendar",
        "JWT_AUDIENCE": "sherryjo-calendar-app",
        "JWT_CLOCK_SKEW_SECONDS": "30",
        "JWT_MAX_LIFETIME_SECONDS": "3600",
    }
    assert {name: config["vars"][name] for name in expected_jwt_policy} == expected_jwt_policy
    assert {
        name: config["env"]["canary"]["vars"][name]
        for name in expected_jwt_policy
    } == expected_jwt_policy
    assert "AUTH_PROXY_FALLBACK" not in config["vars"]
    assert "AUTH_PROXY_FALLBACK" not in config["env"]["canary"]["vars"]


def test_note_and_task_writes_are_replay_safe_and_production_native():
    config = tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))
    api_client = (ROOT / "app" / "static" / "api.js").read_text(encoding="utf-8")

    assert 'new Set(["/calendar/event", "/notes/", "/tasks/"])' in api_client
    assert 'headers["Idempotency-Key"] = crypto.randomUUID()' in api_client
    assert config["vars"]["NOTE_WRITE_MODE"] == "native"
    assert config["vars"]["TASK_WRITE_MODE"] == "native"
    assert config["env"]["canary"]["vars"]["NOTE_WRITE_MODE"] == "proxy"
    assert config["env"]["canary"]["vars"]["TASK_WRITE_MODE"] == "proxy"


def test_canary_monitor_is_scheduled_but_default_disabled_and_secret_free():
    monitor_path = ROOT / ".github" / "workflows" / "cloudflare-canary-monitor.yml"
    workflow = yaml.load(monitor_path.read_text(encoding="utf-8"), Loader=yaml.BaseLoader)

    assert set(workflow["on"]) == {"schedule", "workflow_dispatch"}
    assert workflow["on"]["schedule"] == [{"cron": "17 * * * *"}]
    inputs = workflow["on"]["workflow_dispatch"]["inputs"]
    assert inputs["canary_url"]["default"] == "https://sherryjo-cal-app-canary.realty-cal.workers.dev"
    job = workflow["jobs"]["parity"]
    assert "CLOUDFLARE_CANARY_MONITOR_ENABLED" in job["if"]
    assert "workflow_dispatch" in job["if"]
    assert "secrets." not in monitor_path.read_text(encoding="utf-8")

    monitor_step = next(
        step for step in job["steps"]
        if step.get("name") == "Run direct Render and canary parity"
    )
    assert "--render-url" in monitor_step["run"]
    assert "--cloudflare-url" in monitor_step["run"]

    upload_step = next(
        step for step in job["steps"]
        if step.get("name") == "Upload monitor report"
    )
    assert upload_step["if"] == "${{ always() }}"
    assert upload_step["with"]["retention-days"] == "14"