import os
import subprocess
import sys

from deployment.platform_contract import validate_cloudflare_edge, validate_render, validate_repository


def _render_environment():
    return {
        "ADMIN_SETUP_CODE": "test-admin-code",
        "BASE_URL": "https://calendar.example.com",
        "DATABASE_URL": "postgresql+psycopg2://user:pass@db.example.com/app",
        "DB_TYPE": "postgres",
        "DISABLE_SQLITE_FALLBACK": "1",
        "GOOGLE_CLIENT_ID": "google-id",
        "GOOGLE_CLIENT_SECRET": "google-secret",
        "GOOGLE_REDIRECT_URI": "https://calendar.example.com/auth/google/callback",
        "JWT_ALGORITHM": "HS256",
        "JWT_SECRET_KEY": "jwt-secret",
        "MS_CLIENT_ID": "ms-id",
        "MS_CLIENT_SECRET": "ms-secret",
        "MS_REDIRECT_URI": "https://calendar.example.com/ms/callback",
        "MS_TENANT_ID": "tenant-id",
        "REQUIRE_DB_KIND": "postgres",
        "TOKEN_ENCRYPTION_KEY": "fernet-key",
    }


def test_repository_contains_both_deployment_targets():
    assert validate_repository() == []


def test_render_contract_accepts_production_configuration():
    assert validate_render(_render_environment()) == []


def test_render_contract_rejects_sqlite_and_token_algorithm_drift():
    environment = _render_environment()
    environment.update({"DATABASE_URL": "sqlite:///app.db", "JWT_ALGORITHM": "HS512"})

    errors = validate_render(environment)

    assert "DATABASE_URL must use PostgreSQL in production" in errors
    assert "JWT_ALGORITHM must remain HS256 until a coordinated token migration" in errors


def test_cloudflare_edge_contract_requires_https_origin():
    assert validate_cloudflare_edge({"ORIGIN_BASE_URL": "http://origin.example.com"}) == [
        "ORIGIN_BASE_URL must be an absolute HTTPS URL"
    ]


def test_production_database_failure_never_falls_back_to_sqlite(tmp_path):
    sqlite_sentinel = tmp_path / "must-not-be-created.db"
    environment = {
        **os.environ,
        **_render_environment(),
        "DISABLE_DOTENV": "1",
        "ENV": "production",
        "RENDER": "true",
        "DATABASE_URL": "postgresql+psycopg2://invalid:invalid@127.0.0.1:9/app?connect_timeout=1",
        "SQLITE_PATH": str(sqlite_sentinel),
    }

    result = subprocess.run(
        [sys.executable, "-c", "import app.database"],
        cwd=os.getcwd(),
        env=environment,
        capture_output=True,
        text=True,
        check=False,
        timeout=15,
    )

    output = f"{result.stdout}\n{result.stderr}"
    assert result.returncode != 0
    assert "DISABLE_SQLITE_FALLBACK is enabled" in output
    assert not sqlite_sentinel.exists()