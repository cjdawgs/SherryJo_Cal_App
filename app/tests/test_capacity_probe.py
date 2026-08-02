import argparse

import pytest

from deployment.capacity_probe import (
    build_cases,
    bounded_int,
    percentile,
    summarize_samples,
    validate_target,
    websocket_url,
)


def test_remote_probe_requires_explicit_https_opt_in():
    with pytest.raises(ValueError, match="--allow-remote"):
        validate_target("https://calendar.example.com", allow_remote=False)
    with pytest.raises(ValueError, match="HTTPS"):
        validate_target("http://calendar.example.com", allow_remote=True)

    assert validate_target("https://calendar.example.com/", allow_remote=True) == "https://calendar.example.com"


def test_local_probe_is_allowed_without_remote_flag():
    assert validate_target("http://127.0.0.1:8787/", allow_remote=False) == "http://127.0.0.1:8787"
    assert websocket_url("http://127.0.0.1:8787") == (
        "ws://127.0.0.1:8787/ws?ticket=invalid-capacity-probe-ticket"
    )


def test_calendar_probe_requires_environment_token_but_never_stores_it_as_evidence():
    cases, skipped = build_cases(None)
    assert [case.name for case in cases] == ["health", "static_javascript"]
    assert skipped == [
        "calendar_read: token environment variable is not configured",
        "scheduler_health: token environment variable is not configured",
        "sync_rollups: token environment variable is not configured",
    ]

    cases, skipped = build_cases("sensitive-token")
    assert [case.name for case in cases] == [
        "health",
        "static_javascript",
        "calendar_read",
        "scheduler_health",
        "sync_rollups",
    ]
    calendar = next(case for case in cases if case.name == "calendar_read")
    assert calendar.headers["Authorization"] == "Bearer sensitive-token"
    assert skipped == []
    assert "sensitive-token" not in repr([case.name for case in cases])


def test_percentile_uses_nearest_rank():
    values = [10.0, 20.0, 30.0, 40.0]
    assert percentile(values, 0.50) == 20.0
    assert percentile(values, 0.95) == 40.0


def test_summary_reports_latency_status_and_failure_counts():
    summary = summarize_samples(
        "health",
        [
            {"status": 200, "latency_ms": 10, "response_bytes": 5},
            {"status": 200, "latency_ms": 20, "response_bytes": 5},
            {"status": 503, "latency_ms": 30, "response_bytes": 2},
        ],
    )

    assert summary["requests"] == 3
    assert summary["successes"] == 2
    assert summary["failures"] == 1
    assert summary["latency_ms"]["p95"] == 30
    assert summary["statuses"] == {"200": 2, "503": 1}


@pytest.mark.parametrize("value", ["0", "21"])
def test_probe_bounds_reject_unsafe_concurrency(value):
    with pytest.raises(argparse.ArgumentTypeError):
        bounded_int(value, 1, 20, "concurrency")


def test_warmup_bounds_allow_zero_but_reject_excess():
    assert bounded_int("0", 0, 20, "warmup requests") == 0
    with pytest.raises(argparse.ArgumentTypeError):
        bounded_int("21", 0, 20, "warmup requests")