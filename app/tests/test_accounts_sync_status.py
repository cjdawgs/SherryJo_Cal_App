from datetime import datetime, timezone, timedelta

from app.models import SyncEfficiencyDailyRollup


def test_sync_status_includes_backoff_and_cache_metrics(client, auth_headers):
    response = client.get("/accounts/sync-status", headers=auth_headers)

    assert response.status_code == 200
    payload = response.json()

    assert "scheduler" in payload
    scheduler = payload["scheduler"]

    assert "adaptive_backoff_user" in scheduler
    assert "google_calendar_list_cache" in scheduler

    adaptive = scheduler["adaptive_backoff_user"]
    assert isinstance(adaptive, dict) or adaptive is None

    if isinstance(adaptive, dict):
        assert "user_id" in adaptive
        assert "no_change_streak" in adaptive
        assert "backoff_active" in adaptive
        assert "next_due_override_at" in adaptive

    cache = scheduler["google_calendar_list_cache"]
    assert "hits" in cache
    assert "misses" in cache
    assert "total_lookups" in cache
    assert "hit_ratio" in cache


def test_sync_rollups_endpoint_returns_rows_and_week_summary(client, auth_headers, db):
    today = datetime.now(timezone.utc).date()
    week_start = today - timedelta(days=today.weekday())

    db.add(
        SyncEfficiencyDailyRollup(
            snapshot_date=today,
            week_start_date=week_start,
            changes=4,
            no_changes=6,
            total_cycles=10,
            change_ratio=0.4,
            no_change_ratio=0.6,
            google_cache_hits=50,
            google_cache_misses=10,
            google_cache_total_lookups=60,
            google_cache_hit_ratio=0.8333,
            google_cache_entries=3,
        )
    )
    db.commit()

    response = client.get("/accounts/sync-rollups?days=13", headers=auth_headers)
    assert response.status_code == 200

    payload = response.json()
    assert payload["days"] == 7
    assert "rows" in payload and isinstance(payload["rows"], list)
    assert len(payload["rows"]) >= 1
    assert "current_week" in payload
    assert "rows" in payload["current_week"]
