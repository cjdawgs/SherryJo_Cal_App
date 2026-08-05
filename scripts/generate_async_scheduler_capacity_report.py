#!/usr/bin/env python3
"""Generate async scheduler capacity and decision-readiness report from baseline evidence."""

from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
BASELINE_DIR = REPO_ROOT / "artifacts" / "baselines"
OUTPUT_DIR = REPO_ROOT / "artifacts" / "capacity"


@dataclass
class CapacitySummary:
    baseline_path: Path
    generated_at: str
    baseline_generated_at: str
    baseline_commit: str
    authenticated_configured: bool
    ledger_available: bool
    window_hours: int | None
    total_operations: int | None
    created_in_window: int | None
    by_status: dict[str, int]
    by_operation_type: dict[str, int]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _latest_baseline_path() -> Path:
    candidates = sorted(BASELINE_DIR.glob("production-baseline-*.json"))
    if not candidates:
        raise FileNotFoundError(f"No baseline JSON found in {BASELINE_DIR}")
    return candidates[-1]


def _to_int(value: Any) -> int | None:
    try:
        if value is None:
            return None
        return int(value)
    except (TypeError, ValueError):
        return None


def _safe_counts(raw: Any) -> dict[str, int]:
    if not isinstance(raw, dict):
        return {}
    counts: dict[str, int] = {}
    for key, value in raw.items():
        parsed = _to_int(value)
        if parsed is not None:
            counts[str(key)] = parsed
    return counts


def parse_summary(baseline: dict[str, Any], baseline_path: Path) -> CapacitySummary:
    authenticated = baseline.get("authenticated") if isinstance(baseline.get("authenticated"), dict) else {}
    probes = authenticated.get("probes") if isinstance(authenticated.get("probes"), dict) else {}
    sync_status = probes.get("sync_status") if isinstance(probes.get("sync_status"), dict) else {}
    sync_summary = sync_status.get("summary") if isinstance(sync_status.get("summary"), dict) else {}
    scheduler = sync_summary.get("scheduler") if isinstance(sync_summary.get("scheduler"), dict) else {}
    operation_ledger = scheduler.get("operation_ledger") if isinstance(scheduler.get("operation_ledger"), dict) else {}

    return CapacitySummary(
        baseline_path=baseline_path,
        generated_at=_utc_now_iso(),
        baseline_generated_at=str(baseline.get("generated_at") or "unknown"),
        baseline_commit=str((baseline.get("repository") or {}).get("git_commit") or "unknown"),
        authenticated_configured=bool(authenticated.get("configured")),
        ledger_available=bool(operation_ledger.get("available")),
        window_hours=_to_int(operation_ledger.get("window_hours")),
        total_operations=_to_int(operation_ledger.get("total_operations")),
        created_in_window=_to_int(operation_ledger.get("created_in_window")),
        by_status=_safe_counts(operation_ledger.get("by_status")),
        by_operation_type=_safe_counts(operation_ledger.get("by_operation_type")),
    )


def projected_from_window(count: int | None, window_hours: int | None) -> tuple[float | None, float | None]:
    if count is None or window_hours is None or window_hours <= 0:
        return None, None
    daily = (count / window_hours) * 24.0
    monthly = daily * 30.0
    return daily, monthly


def decision_status(summary: CapacitySummary) -> dict[str, str]:
    has_volume = summary.ledger_available and summary.created_in_window is not None and summary.window_hours not in (None, 0)

    defer_state = "ready"
    cron_state = "pending"
    queues_state = "pending"

    if not has_volume:
        defer_state = "ready_with_data_gap"
        cron_state = "blocked_on_volume_evidence"
        queues_state = "blocked_on_volume_and_replay_evidence"

    return {
        "defer": defer_state,
        "cron_only": cron_state,
        "queues_plus_cron": queues_state,
    }


def render_markdown(summary: CapacitySummary) -> str:
    created_daily, created_monthly = projected_from_window(summary.created_in_window, summary.window_hours)
    total_daily, total_monthly = projected_from_window(summary.total_operations, summary.window_hours)

    lines = [
        "# Async scheduler capacity report",
        "",
        f"Generated: `{summary.generated_at}`",
        f"Baseline source: `{summary.baseline_path.as_posix()}`",
        f"Baseline generated at: `{summary.baseline_generated_at}`",
        f"Baseline commit: `{summary.baseline_commit}`",
        "",
        "## Data readiness",
        "",
        f"- Authenticated baseline configured: `{summary.authenticated_configured}`",
        f"- Operation-ledger summary available: `{summary.ledger_available}`",
        f"- Window hours: `{summary.window_hours}`",
        f"- Total operations observed: `{summary.total_operations}`",
        f"- Operations created in window: `{summary.created_in_window}`",
        "",
        "## Volume projections",
        "",
        "| Metric | Observed | Projected daily | Projected 30-day |",
        "| --- | ---: | ---: | ---: |",
        f"| Total operations | {summary.total_operations if summary.total_operations is not None else 'n/a'} | {f'{total_daily:.2f}' if total_daily is not None else 'n/a'} | {f'{total_monthly:.2f}' if total_monthly is not None else 'n/a'} |",
        f"| Created operations (window) | {summary.created_in_window if summary.created_in_window is not None else 'n/a'} | {f'{created_daily:.2f}' if created_daily is not None else 'n/a'} | {f'{created_monthly:.2f}' if created_monthly is not None else 'n/a'} |",
        "",
        "## Operation mix in window",
        "",
        "| Operation type | Count | Projected daily | Projected 30-day |",
        "| --- | ---: | ---: | ---: |",
    ]

    if summary.by_operation_type:
        for op_type, count in sorted(summary.by_operation_type.items()):
            daily, monthly = projected_from_window(count, summary.window_hours)
            lines.append(
                f"| {op_type} | {count} | {f'{daily:.2f}' if daily is not None else 'n/a'} | {f'{monthly:.2f}' if monthly is not None else 'n/a'} |"
            )
    else:
        lines.append("| n/a | n/a | n/a | n/a |")

    lines.extend([
        "",
        "## Status distribution in window",
        "",
        "| Status | Count |",
        "| --- | ---: |",
    ])

    if summary.by_status:
        for status, count in sorted(summary.by_status.items()):
            lines.append(f"| {status} | {count} |")
    else:
        lines.append("| n/a | n/a |")

    decisions = decision_status(summary)
    lines.extend([
        "",
        "## Decision readiness",
        "",
        "| Option | Readiness | Notes |",
        "| --- | --- | --- |",
        f"| defer | {decisions['defer']} | Ready to keep Render-owned scheduler while remaining evidence is collected. |",
        f"| cron only | {decisions['cron_only']} | Needs complete observed-volume evidence and canary ownership proof. |",
        f"| queues + cron | {decisions['queues_plus_cron']} | Needs volume evidence plus end-to-end queue replay and dead-letter recovery evidence. |",
        "",
        "## Remaining blockers",
        "",
        "1. Capture authenticated baseline with scheduler operation-ledger summaries enabled.",
        "2. Add provider-limit inputs and compare projected operation volume against current plan limits.",
        "3. Complete queue-consumer replay test matrix before any ownership migration decision beyond defer.",
    ])

    return "\n".join(lines) + "\n"


def write_outputs(summary: CapacitySummary, output_dir: Path) -> tuple[Path, Path]:
    output_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = output_dir / f"async-scheduler-capacity-{timestamp}.json"
    markdown_path = output_dir / f"async-scheduler-capacity-{timestamp}.md"

    payload = {
        "generated_at": summary.generated_at,
        "baseline_source": summary.baseline_path.as_posix(),
        "baseline_generated_at": summary.baseline_generated_at,
        "baseline_commit": summary.baseline_commit,
        "authenticated_configured": summary.authenticated_configured,
        "ledger_available": summary.ledger_available,
        "window_hours": summary.window_hours,
        "total_operations": summary.total_operations,
        "created_in_window": summary.created_in_window,
        "by_status": summary.by_status,
        "by_operation_type": summary.by_operation_type,
        "decision_readiness": decision_status(summary),
    }

    json_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(summary), encoding="utf-8")
    return json_path, markdown_path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, help="Path to a baseline JSON file.")
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    args = parser.parse_args()

    baseline_path = args.baseline if args.baseline else _latest_baseline_path()
    baseline_path = baseline_path.resolve()
    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    summary = parse_summary(baseline, baseline_path)
    json_path, markdown_path = write_outputs(summary, args.output_dir)

    print(f"Capacity JSON: {json_path}")
    print(f"Capacity Markdown: {markdown_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
