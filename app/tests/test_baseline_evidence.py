import json

import pytest
from sqlalchemy import create_engine, text

from deployment import baseline_evidence


def test_safe_url_removes_credentials_query_and_fragment():
    assert baseline_evidence.safe_url(
        "https://user:recognizable-password@example.com:8443/health?token=recognizable-token#private"
    ) == "https://example.com:8443/health"


def test_build_snapshot_records_secret_presence_without_values(monkeypatch):
    secret = "recognizable-jwt-secret-value"
    token = "recognizable-bearer-token-value"
    environment = {"JWT_SECRET_KEY": secret, "DATABASE_URL": "postgresql://user:password@db.example/app"}

    monkeypatch.setattr(baseline_evidence, "collect_repository_baseline", lambda: {"git_commit": "a" * 40, "alembic_heads": ["head"]})
    monkeypatch.setattr(baseline_evidence, "collect_public_target", lambda base_url, paths: {"base_url": baseline_evidence.safe_url(base_url), "probes": {}})
    monkeypatch.setattr(baseline_evidence, "collect_authenticated_baseline", lambda base_url, bearer_token: {"configured": bool(bearer_token)})

    snapshot = baseline_evidence.build_snapshot(
        render_url="https://render.example.com",
        edge_url="https://edge.example.com",
        environment=environment,
        bearer_token=token,
    )
    serialized = json.dumps(snapshot, sort_keys=True)

    assert snapshot["environment_presence"]["JWT_SECRET_KEY"] is True
    assert snapshot["environment_presence"]["GOOGLE_CLIENT_SECRET"] is False
    assert secret not in serialized
    assert token not in serialized
    assert environment["DATABASE_URL"] not in serialized


def test_build_snapshot_rejects_secret_from_collector(monkeypatch):
    token = "recognizable-leaked-bearer-token"
    monkeypatch.setattr(baseline_evidence, "collect_repository_baseline", lambda: {})
    monkeypatch.setattr(baseline_evidence, "collect_public_target", lambda base_url, paths: {})
    monkeypatch.setattr(
        baseline_evidence,
        "collect_authenticated_baseline",
        lambda base_url, bearer_token: {"accidental_leak": bearer_token},
    )

    with pytest.raises(ValueError, match="forbidden value"):
        baseline_evidence.build_snapshot(
            render_url="https://render.example.com",
            edge_url="https://edge.example.com",
            environment={},
            bearer_token=token,
        )


def test_database_baseline_reads_counts_without_mutating_rows(tmp_path):
    database_path = tmp_path / "baseline.db"
    database_url = f"sqlite:///{database_path.as_posix()}"
    engine = create_engine(database_url)
    with engine.begin() as connection:
        connection.execute(text("CREATE TABLE sample (id INTEGER PRIMARY KEY, private_value TEXT NOT NULL)"))
        connection.execute(text("INSERT INTO sample (private_value) VALUES ('recognizable-private-row')"))
    engine.dispose()

    result = baseline_evidence.collect_database_baseline(database_url)

    assert result["dialect"] == "sqlite"
    assert result["tables"] == ["sample"]
    assert result["row_counts"] == {"sample": 1}
    assert "recognizable-private-row" not in json.dumps(result)

    verification_engine = create_engine(database_url)
    with verification_engine.connect() as connection:
        assert connection.execute(text("SELECT COUNT(*) FROM sample")).scalar_one() == 1
    verification_engine.dispose()


def test_authenticated_summaries_drop_unrecognized_fields():
    scheduler = baseline_evidence._safe_scheduler(
        {
            "running": True,
            "unexpected_secret": "scheduler-secret",
            "efficiency": {"changes": 2, "unexpected_secret": "efficiency-secret"},
            "google_calendar_list_cache": {"hits": 3, "unexpected_secret": "cache-secret"},
        }
    )
    rollups = baseline_evidence._safe_rollups(
        {
            "rows": [{"snapshot_date": "2026-08-01", "unexpected_secret": "row-secret"}],
            "current_week": {"days_present": 1, "unexpected_secret": "week-secret"},
            "unexpected_secret": "rollup-secret",
        }
    )

    serialized = json.dumps({"scheduler": scheduler, "rollups": rollups})

    assert scheduler["running"] is True
    assert scheduler["efficiency"]["changes"] == 2
    assert rollups["row_count"] == 1
    assert rollups["current_week"]["days_present"] == 1
    assert "secret" not in serialized