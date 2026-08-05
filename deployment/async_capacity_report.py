"""Generate a lightweight async-capacity report from baseline evidence."""

from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASELINE = REPOSITORY_ROOT / "artifacts" / "baselines"


def summarize_baseline(baseline: dict[str, Any]) -> dict[str, Any]:
    authenticated = baseline.get("authenticated") if isinstance(baseline.get("authenticated"), dict) else {}
    probes = authenticated.get("probes") if isinstance(authenticated.get("probes"), dict) else {}
    sync_status = probes.get("sync_status") if isinstance(probes.get("sync_status"), dict) else {}
    summary = sync_status.get("summary") if isinstance(sync_status.get("summary"), dict) else {}
    scheduler = summary.get("scheduler") if isinstance(summary.get("scheduler"), dict) else {}
    ledger = scheduler.get("operation_ledger") if isinstance(scheduler.get("operation_ledger"), dict) else {}

    if not authenticated.get("configured") or not ledger.get("available"):
        return {
            "available": False,
            "evidence_status": "pending",
            "recommendation": "defer",
            "total_operations": None,
            "created_in_window": None,
            "estimated_daily_operations": None,
            "notes": ["No authenticated scheduler ledger evidence was captured in the baseline."],
        }

    total_operations = ledger.get("total_operations")
    created_in_window = ledger.get("created_in_window")
    estimated_daily = total_operations if total_operations is not None else None
    if estimated_daily is None and created_in_window is not None and ledger.get("window_hours"):
        estimated_daily = int(created_in_window * (24 / int(ledger.get("window_hours"))))
    recommendation = "cron-only" if estimated_daily and estimated_daily >= 100 else "defer"

    return {
        "available": True,
        "evidence_status": "ready",
        "recommendation": recommendation,
        "total_operations": total_operations,
        "created_in_window": created_in_window,
        "estimated_daily_operations": estimated_daily,
        "notes": [
            "Ledger volume evidence was captured from scheduler health output.",
            "Use this as a starting point for cost comparison and owner decision.",
        ],
        "by_status": ledger.get("by_status") if isinstance(ledger.get("by_status"), dict) else {},
        "by_operation_type": ledger.get("by_operation_type") if isinstance(ledger.get("by_operation_type"), dict) else {},
    }


def render_markdown(summary: dict[str, Any], generated_at: str | None = None) -> str:
    generated_at = generated_at or datetime.now(timezone.utc).isoformat()
    lines = [
        "# Async capacity report",
        "",
        f"Generated: `{generated_at}`",
        "",
        "## Evidence summary",
        "",
        f"- Status: `{summary.get('evidence_status', 'pending')}`",
        f"- Available: `{summary.get('available', False)}`",
        f"- Recommendation: `{summary.get('recommendation', 'defer')}`",
        f"- Total operations: `{summary.get('total_operations', 'unknown')}`",
        f"- Created in window: `{summary.get('created_in_window', 'unknown')}`",
        f"- Estimated daily operations: `{summary.get('estimated_daily_operations', 'unknown')}`",
        "",
        "## Notes",
        "",
    ]
    for note in summary.get("notes", []):
        lines.append(f"- {note}")
    lines.extend(["", "## Status breakdown", ""])
    status_breakdown = summary.get("by_status") or {}
    for status, count in sorted(status_breakdown.items()):
        lines.append(f"- {status}: {count}")
    lines.extend(["", "## Operation-type breakdown", ""])
    op_breakdown = summary.get("by_operation_type") or {}
    for operation_type, count in sorted(op_breakdown.items()):
        lines.append(f"- {operation_type}: {count}")
    return "\n".join(lines) + "\n"


def generate_report(baseline_path: Path | None = None, output_dir: Path | None = None) -> tuple[Path, Path]:
    baseline_path = baseline_path or _latest_baseline_path()
    output_dir = output_dir or DEFAULT_BASELINE.parent / "capacity"
    output_dir.mkdir(parents=True, exist_ok=True)

    baseline = json.loads(baseline_path.read_text(encoding="utf-8")) if baseline_path.exists() else {}
    summary = summarize_baseline(baseline)
    generated_at = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    json_path = output_dir / f"async-capacity-{generated_at}.json"
    markdown_path = output_dir / f"async-capacity-{generated_at}.md"
    json_path.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    markdown_path.write_text(render_markdown(summary, generated_at=generated_at), encoding="utf-8")
    return json_path, markdown_path


def _latest_baseline_path() -> Path:
    candidates = sorted(DEFAULT_BASELINE.glob("production-baseline-*.json"), key=lambda path: path.name, reverse=True)
    return candidates[0] if candidates else DEFAULT_BASELINE / "production-baseline-latest.json"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--baseline", type=Path, default=None)
    parser.add_argument("--output-dir", type=Path, default=None)
    args = parser.parse_args()
    json_path, markdown_path = generate_report(baseline_path=args.baseline, output_dir=args.output_dir)
    print(json_path)
    print(markdown_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
