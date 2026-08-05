# Async scheduler capacity report

Generated: `2026-08-05T15:23:31.487809+00:00`
Baseline source: `/workspaces/SherryJo_Cal_App/artifacts/baselines/production-baseline-20260805T151850Z.json`
Baseline generated at: `2026-08-05T15:18:45.341583+00:00`
Baseline commit: `e51bb421321129495b0339e3b9b54d292e73d7fd`

## Data readiness

- Authenticated baseline configured: `False`
- Operation-ledger summary available: `False`
- Window hours: `None`
- Total operations observed: `None`
- Operations created in window: `None`

## Volume projections

| Metric | Observed | Projected daily | Projected 30-day |
| --- | ---: | ---: | ---: |
| Total operations | n/a | n/a | n/a |
| Created operations (window) | n/a | n/a | n/a |

## Operation mix in window

| Operation type | Count | Projected daily | Projected 30-day |
| --- | ---: | ---: | ---: |
| n/a | n/a | n/a | n/a |

## Status distribution in window

| Status | Count |
| --- | ---: |
| n/a | n/a |

## Decision readiness

| Option | Readiness | Notes |
| --- | --- | --- |
| defer | ready_with_data_gap | Ready to keep Render-owned scheduler while remaining evidence is collected. |
| cron only | blocked_on_volume_evidence | Needs complete observed-volume evidence and canary ownership proof. |
| queues + cron | blocked_on_volume_and_replay_evidence | Needs volume evidence plus end-to-end queue replay and dead-letter recovery evidence. |

## Remaining blockers

1. Capture authenticated baseline with scheduler operation-ledger summaries enabled.
2. Add provider-limit inputs and compare projected operation volume against current plan limits.
3. Complete queue-consumer replay test matrix before any ownership migration decision beyond defer.
