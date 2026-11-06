import json
import os
from pathlib import Path
import shutil
import subprocess
import tomllib

import yaml


ROOT = Path(__file__).resolve().parents[2]


def test_migration_job_bootstraps_alembic_without_application_secrets(tmp_path):
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "cloudflare-release.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    migration_step = next(
        step for step in workflow["jobs"]["migrate-supabase"]["steps"]
        if step.get("name") == "Apply Supabase migrations"
    )
    env = os.environ.copy()
    for name in (
        "MS_CLIENT_ID", "MS_CLIENT_SECRET", "MS_TENANT_ID", "MS_REDIRECT_URI",
        "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REDIRECT_URI", "JWT_SECRET_KEY",
        "TOKEN_ENCRYPTION_KEY",
    ):
        env.pop(name, None)
    env.update({key: value for key, value in migration_step["env"].items() if not value.startswith("${{")})
    env["DISABLE_DOTENV"] = "true"
    env["DATABASE_URL"] = f"sqlite:///{tmp_path / 'migration.db'}"
    env["ALEMBIC_DATABASE_URL"] = env["DATABASE_URL"]
    env.pop("PYTHONPATH", None)
    shutil.copytree(ROOT / "app", tmp_path / "app", ignore=shutil.ignore_patterns(
        "__pycache__", "tests", "static", "templates",
    ))
    shutil.copytree(ROOT / "alembic", tmp_path / "alembic", ignore=shutil.ignore_patterns("__pycache__"))
    shutil.copyfile(ROOT / "alembic.ini", tmp_path / "alembic.ini")
    result = subprocess.run(
        ["alembic", "current"], cwd=tmp_path, env=env, capture_output=True, text=True, timeout=30,
    )
    assert result.returncode == 0, result.stderr


def test_cloudflare_release_is_automated_and_promotion_is_smoke_gated():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "cloudflare-release.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )

    # Push to main is the primary trigger; workflow_dispatch remains only for
    # an on-demand manual re-run against a chosen set of URLs.
    assert set(workflow["on"]) == {"push", "workflow_dispatch"}
    assert workflow["on"]["push"]["branches"] == ["main"]
    inputs = workflow["on"]["workflow_dispatch"]["inputs"]
    assert "render_deployment_ready" not in inputs
    assert "promote_production" not in inputs
    assert inputs["production_url"]["default"] == "https://sherryjo-cal-app.realty-cal.workers.dev"
    assert inputs["canary_url"]["default"] == "https://sherryjo-cal-app-canary.realty-cal.workers.dev"

    jobs = workflow["jobs"]
    setup_python_steps = [
        step
        for job_config in jobs.values()
        for step in job_config.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/setup-python@")
    ]
    assert setup_python_steps
    assert {step["uses"] for step in setup_python_steps} == {"actions/setup-python@v6"}
    assert {step["with"]["python-version"] for step in setup_python_steps} == {"3.14"}
    setup_node_steps = [
        step
        for job_config in jobs.values()
        for step in job_config.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/setup-node@")
    ]
    assert {step["uses"] for step in setup_node_steps} == {"actions/setup-node@v7"}

    assert jobs["verify"]["services"]["postgres"]["image"] == "postgres:16"
    assert "if" not in jobs["verify"]
    assert jobs["verify"]["env"]["TEST_DATABASE_URL"].startswith("postgresql+psycopg2://")
    drift_step = next(
        step for step in jobs["verify"]["steps"]
        if step.get("name") == "Validate migrations with pre-existing TV refresh schema"
    )
    assert "alembic upgrade aq997l22ddd11" in drift_step["run"]
    assert "CREATE POLICY worker_tv_state_admin" in drift_step["run"]
    assert "alembic upgrade head" in drift_step["run"]
    assert drift_step["env"]["ALEMBIC_DATABASE_URL"].endswith("/sherryjo_migration_drift_test")
    python_suite = next(step for step in jobs["verify"]["steps"] if step.get("name") == "Run Python suite")
    assert python_suite["env"]["TEST_MIGRATION_DATABASE_URL"].endswith("/sherryjo_migration_test")
    assert set(jobs["deploy-canary"]["needs"]) == {"verify", "migrate-supabase"}
    assert jobs["migrate-supabase"]["needs"] == "verify"
    assert "if" not in jobs["migrate-supabase"]
    assert jobs["release-paused"]["if"] == "${{ vars.CLOUDFLARE_RELEASE_PAUSED == 'true' }}"
    assert set(jobs["release-paused"]["needs"]) == {"verify", "migrate-supabase"}
    assert "CLOUDFLARE_RELEASE_PAUSED" in jobs["release-paused"]["steps"][0]["run"]
    assert jobs["deploy-canary"]["if"] == "${{ vars.CLOUDFLARE_RELEASE_PAUSED != 'true' }}"
    assert jobs["migrate-supabase"]["env"]["ALEMBIC_DATABASE_URL"] == "${{ secrets.ALEMBIC_DATABASE_URL }}"
    migration_step = next(
        step for step in jobs["migrate-supabase"]["steps"]
        if step.get("name") == "Apply Supabase migrations"
    )
    assert migration_step["if"] == "${{ env.ALEMBIC_DATABASE_URL != '' }}"
    assert "alembic upgrade head" in migration_step["run"]
    missing_migration_secret = next(
        step for step in jobs["migrate-supabase"]["steps"]
        if step.get("name") == "Fail when migration secret is absent"
    )
    assert missing_migration_secret["if"] == "${{ env.ALEMBIC_DATABASE_URL == '' }}"
    assert "exit 1" in missing_migration_secret["run"]
    assert jobs["deploy-canary"]["environment"] == "cloudflare-canary"
    assert jobs["smoke-unauthenticated-canary"]["needs"] == "deploy-canary"
    assert jobs["smoke-authenticated-canary"]["needs"] == "deploy-canary"
    assert jobs["smoke-authenticated-canary"]["concurrency"] == {
        "group": "sherryjo-authenticated-smoke",
        "cancel-in-progress": "false",
    }

    promotion = jobs["promote-root-worker"]
    # No manual approval input gates promotion; the only gate is that both
    # canary smoke jobs (below) must succeed first.
    assert "if" not in promotion
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
    canary_parity = next(
        step for step in jobs["smoke-unauthenticated-canary"]["steps"]
        if step.get("name") == "Run canary parity smoke"
    )
    production_parity = next(
        step for step in jobs["smoke-unauthenticated-production"]["steps"]
        if step.get("name") == "Run production parity smoke"
    )
    assert "--native-worker" not in canary_parity["run"]
    assert "--native-worker" in production_parity["run"]


def test_canary_wait_checks_asset_availability_not_cross_runtime_identity():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "cloudflare-release.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    wait_step = next(
        step for step in workflow["jobs"]["smoke-unauthenticated-canary"]["steps"]
        if step.get("name") == "Wait for canary static assets and Render schema readiness"
    )

    assert "curl --fail" in wait_step["run"]
    assert "wc -c" in wait_step["run"]
    assert "-gt 0" in wait_step["run"]
    assert "sha256sum" not in wait_step["run"]
    assert "render_hash" not in wait_step["run"]
    assert "canary_hash" not in wait_step["run"]


def test_cloudflare_release_uses_environment_secrets_and_exact_targets():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "cloudflare-release.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    package = json.loads(
        (ROOT / "platform" / "cloudflare" / "package.json").read_text(encoding="utf-8")
    )
    deploy_wrapper = (
        ROOT / "platform" / "cloudflare" / "scripts" / "deploy-worker.mjs"
    ).read_text(encoding="utf-8")
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
    assert scripts["deploy:canary"] == "node scripts/deploy-worker.mjs canary"
    assert scripts["deploy"] == "node scripts/deploy-worker.mjs production"
    assert 'args.push("--env", target === "canary" ? "canary" : "")' in deploy_wrapper
    assert 'args.push("--var", `WORKER_GIT_COMMIT:${gitCommit}`)' in deploy_wrapper
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
    # URLs are resolved through env vars (with an inputs.* || vars.* || literal
    # fallback chain) so the same steps work on both push and workflow_dispatch.
    assert "inputs.canary_url" in canary_smoke["env"]["CANARY_URL"]
    assert "inputs.production_url" in production_smoke["env"]["PRODUCTION_URL"]
    assert '"$CANARY_URL"' in canary_smoke["run"]
    assert '"$PRODUCTION_URL"' in production_smoke["run"]
    assert "--allow-remote" in canary_smoke["run"]
    assert "--allow-remote" in production_smoke["run"]


def test_root_and_canary_workers_require_edge_proxy_authentication():
    config = tomllib.loads((ROOT / "wrangler.toml").read_text(encoding="utf-8"))

    assert config["name"] == "sherryjo-cal-app"
    assert config["env"]["canary"]["name"] == "sherryjo-cal-app-canary"
    required_secrets = ["EDGE_PROXY_SECRET", "JWT_PUBLIC_KEYS_JSON", "GOOGLE_CLIENT_SECRET", "MS_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY", "JWT_PRIVATE_KEY", "ADMIN_SETUP_CODE"]
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
    assert job["if"] == (
        "${{ github.event_name == 'workflow_dispatch' || "
        "vars.CLOUDFLARE_CANARY_MONITOR_ENABLED == 'true' }}"
    )
    assert "secrets." not in monitor_path.read_text(encoding="utf-8")

    setup_python_step = next(
        step for step in job["steps"]
        if str(step.get("uses", "")).startswith("actions/setup-python@")
    )
    assert setup_python_step["uses"] == "actions/setup-python@v6"
    assert setup_python_step["with"]["python-version"] == "3.14"

    monitor_step = next(
        step for step in job["steps"]
        if step.get("name") == "Run direct Render and canary parity"
    )
    assert "--render-url" in monitor_step["run"]
    assert "--cloudflare-url" in monitor_step["run"]
    assert "--native-worker" not in monitor_step["run"]
    assert "max_attempts" not in monitor_step["run"]
    assert "sleep 30" not in monitor_step["run"]

    upload_step = next(
        step for step in job["steps"]
        if step.get("name") == "Upload monitor report"
    )
    assert upload_step["if"] == "${{ always() }}"
    assert upload_step["with"]["retention-days"] == "14"


def test_stage_c_observation_uses_proxy_canary_and_current_python_action():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "stage-c-daily-observation.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    job = workflow["jobs"]["observe"]
    setup_python_step = next(
        step for step in job["steps"]
        if str(step.get("uses", "")).startswith("actions/setup-python@")
    )
    parity_step = next(
        step for step in job["steps"]
        if step.get("name") == "Run unauthenticated canary parity"
    )

    assert setup_python_step["uses"] == "actions/setup-python@v6"
    assert setup_python_step["with"]["python-version"] == "3.14"
    assert "--native-worker" not in parity_step["run"]


def test_python_test_workflow_pins_supported_runtime_and_current_node_action():
    workflow = yaml.load(
        (ROOT / ".github" / "workflows" / "tests.yml").read_text(encoding="utf-8"),
        Loader=yaml.BaseLoader,
    )
    setup_python_steps = [
        step
        for job_config in workflow["jobs"].values()
        for step in job_config.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/setup-python@")
    ]
    setup_node_steps = [
        step
        for job_config in workflow["jobs"].values()
        for step in job_config.get("steps", [])
        if str(step.get("uses", "")).startswith("actions/setup-node@")
    ]

    assert setup_python_steps
    assert {step["with"]["python-version"] for step in setup_python_steps} == {"3.14"}
    assert {step["uses"] for step in setup_node_steps} == {"actions/setup-node@v7"}