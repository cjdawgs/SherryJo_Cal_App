from deployment import async_capacity_report


def test_summarize_baseline_marks_missing_ledger_evidence_as_pending():
    baseline = {
        "authenticated": {"configured": False, "probes": {}},
    }

    summary = async_capacity_report.summarize_baseline(baseline)

    assert summary["evidence_status"] == "pending"
    assert summary["recommendation"] == "defer"
    assert summary["available"] is False


def test_summarize_baseline_extracts_ledger_volume_and_recommendation():
    baseline = {
        "authenticated": {
            "configured": True,
            "probes": {
                "sync_status": {
                    "summary": {
                        "scheduler": {
                            "owner": "render",
                            "execution_enabled": True,
                            "operation_ledger": {
                                "available": True,
                                "window_hours": 24,
                                "total_operations": 120,
                                "created_in_window": 48,
                                "by_status": {"succeeded": 40, "retry_pending": 8},
                                "by_operation_type": {
                                    "scheduler-sync": 90,
                                    "scheduler-rollup": 30,
                                },
                            },
                        }
                    }
                }
            },
        }
    }

    summary = async_capacity_report.summarize_baseline(baseline)

    assert summary["available"] is True
    assert summary["total_operations"] == 120
    assert summary["created_in_window"] == 48
    assert summary["estimated_daily_operations"] == 120
    assert summary["recommendation"] == "cron-only"
