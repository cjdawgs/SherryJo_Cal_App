# SLO, capacity, and free-tier decision sheet

Date: 2026-08-02  
Stage: A3  
Status: Owner accepted continued Supabase operation above the egress allowance; reliability policy and exact Render cold-start evidence remain open.

## Reliability policy decision

Choose exactly one before the A3 gate can pass:

- [ ] **Best-effort free tier:** accepts Render's approximately one-minute wake after 15 idle minutes, platform restarts, and the absence of provider uptime SLAs.
- [ ] **Paid always-on RTO:** requires an always-on origin and an owner-approved monthly budget before committing to a strict recovery target.

The current architecture must be treated as best-effort until the owner records a choice. A sleeping Render free service is not a hot spare.

## Candidate service objectives

These are engineering targets for measurement, not provider-backed SLAs.

| Signal | Candidate objective | Measurement | Current evidence |
| --- | --- | --- | --- |
| Public availability | At least 99.0% monthly under best-effort policy | Independent `/health` probes against Render and Cloudflare | Direct Render synthetic workflow implemented but not enabled; policy decision pending |
| Warm health latency | p95 at or below 750 ms | `deployment/capacity_probe.py` | Three-window median p95 824.599 ms; 2 of 3 windows missed |
| Warm static latency | p95 at or below 1,000 ms | Read-only `/static/admin.js` probe | Three-window median p95 873.805 ms; 1 of 3 windows missed |
| Authenticated calendar read latency | p95 at or below 2,000 ms for a seven-day read | Token supplied only through `CAPACITY_PROBE_BEARER_TOKEN` | Owner-assisted local/canary run pending |
| WebSocket handshake/rejection latency | p95 at or below 2,000 ms | Invalid one-time-ticket handshake must return 403 | Three-window median p95 529.373 ms; every handshake returned 403 |
| Google/Microsoft passive freshness | At most 65 minutes while adaptive idle backoff is active | Scheduler health and sync rollups | Production scheduler running; 5-minute base frequency and 60-minute maximum backoff captured |
| Apple passive freshness | At most 245 minutes | Scheduler health and sync rollups | Production scheduler running with 240-minute Apple minimum captured |
| Manual sync freshness | Updated read available within 2 minutes after successful manual sync | Authenticated smoke workflow | Not measured |
| Sync success | At least 99% excluding confirmed provider outages or revoked consent | Daily sync-efficiency rollup | Three production rollup days captured; latest day 88 changes, 2 no-change cycles, and no endpoint error |
| OAuth callback success | At least 95% during operator canary, with zero state-replay acceptance | Canary telemetry and callback tests | Canary blocked |
| RTO | Best effort under free tier; strict value requires paid always-on decision | Failure drill | Owner decision pending |
| RPO | Supabase remains authoritative; numeric RPO requires a documented backup/export policy | Restore drill and provider plan evidence | Owner decision pending |

## Verified platform limits and baseline utilization

Limits were checked against provider documentation on 2026-08-02.

| Platform signal | Current limit or behavior | 24-hour baseline | Initial headroom assessment |
| --- | --- | --- | --- |
| Cloudflare Worker requests | 100,000 requests/day on Free | 366 | 0.366% used; 99.634% request headroom |
| Cloudflare Worker CPU | 10 ms/request on Free | 0.824 ms average; 1.829 ms p99 | p99 uses 18.29% of the per-request limit |
| Cloudflare Worker subrequests | 50/request on Free | 350 total, 0.956/request average | Average uses 1.91% of the per-request limit |
| Supabase database size | 0.5 GB/project on Free | 0.039 GB for 2026-07-22 through 2026-08-22 | 8% used; 92% storage headroom |
| Supabase egress | 5 GB/organization on Free | 5.346 GB for 2026-07-22 through 2026-08-22 | 107% used; owner accepted continued use and smoke testing during the grace period |
| Supabase project behavior | Free projects may pause after one inactive week | Operational; 41-day database uptime | No provider uptime SLA |
| Render instance hours | 750 hours/workspace/month | 11.52 hours | 1.536% used; 738.48 hours and 98.464% headroom remain |
| Render idle behavior | Spins down after 15 idle minutes; wake takes about one minute | No lifecycle events in capture window | Exact cold-start evidence missing |
| Render bandwidth | 5 GB/workspace included | 153 MB workspace usage; 148 MB service-initiated, 5 MB HTTP responses, 0 MB WebSocket responses | About 3% used and about 97% headroom remains |

## Probe protocol

Run locally first:

```powershell
.\.venv\Scripts\python.exe deployment\capacity_probe.py --base-url http://127.0.0.1:8787 --json-output artifacts\capacity\local-a3.json
```

For authenticated calendar, scheduler-health, and sync-rollup reads, set `CAPACITY_PROBE_BEARER_TOKEN` interactively in the process environment and add `--require-calendar`. Never put the token in the command, task file, report, workbook, or chat.

Remote execution requires `--allow-remote`. Do not run it against Render or Cloudflare until the operator-canary gate permits it. Defaults are intentionally small: 2 unreported warm-up requests and 10 measured requests per HTTP case, concurrency 4, and 3 invalid-ticket WebSocket handshakes. Hard caps are 20 warm-up requests, 200 measured requests per case, concurrency 20, and 20 WebSocket samples.

## Alert and phase budgets

Provisional stop thresholds pending owner approval:

| Signal | Warning | Stop / rollback |
| --- | --- | --- |
| Required probe success | Below 99.5% | Any unexplained 5xx or required check below 99% |
| Cloudflare daily requests | 70% of current daily limit | 85% of current daily limit |
| Cloudflare CPU p99 | 60% of per-request limit | 80% of per-request limit or any exceeded-CPU outcome |
| Supabase database size | 70% of quota | 85% of quota |
| Supabase egress | 70% of quota | 85% of quota |
| Render monthly instance hours/bandwidth | 70% of included allowance | 85% of included allowance |
| Calendar/WebSocket p95 | 75% of candidate objective | Objective exceeded in two consecutive windows |

On 2026-08-02, the owner accepted continued Supabase use above the allowance and authorized development and smoke testing during the fair-use grace period. The grace period ends 2026-08-19, and the dashboard warns that restricted requests may return HTTP 402 afterward. Monitor for that response and stop the affected test if it occurs. Traffic movement and direct Worker data access still require their separate security and promotion gates.

## Initial local result

Evidence: `artifacts/capacity/local-a3-20260802.json`

- Target: local Cloudflare development endpoint at `127.0.0.1:8787`.
- Warm-up: 2 unreported requests per HTTP case before measurement.
- Health: 10/10 HTTP 200, p95 776.494 ms. Functional check passed; draft latency objective narrowly missed.
- Static JavaScript: 10/10 HTTP 200, p95 887.904 ms. Functional and draft latency checks passed.
- Invalid WebSocket ticket: 3/3 HTTP 403, p95 588.871 ms. Functional and draft latency checks passed.
- Authenticated calendar read: skipped because no token environment variable was supplied.

This is a partial local baseline, not an A3 pass. The health result must be repeated to distinguish local proxy/tool overhead from stable warm latency, and the authenticated calendar read remains required.

### Three-window characterization

Evidence: `artifacts/capacity/local-a3-warm-windows-20260802.json`

Three additional warmed windows completed with all functional checks passing:

| Signal | Window p95 values (ms) | Median p95 | Result |
| --- | --- | --- | --- |
| Health | 945.827, 659.933, 824.599 | 824.599 | Variable; 2 of 3 windows missed the 750 ms draft target |
| Static JavaScript | 1,155.832, 752.504, 873.805 | 873.805 | Median met target; 1 of 3 windows missed |
| Invalid WebSocket ticket | 1,295.771, 412.967, 529.373 | 529.373 | All windows met target and every handshake returned 403 |

The initial shared Admin browser sessions contained expired credentials and returned 401. A fresh owner-assisted capture on 2026-08-02 subsequently returned HTTP 200 for `/accounts/sync-status` and `/accounts/sync-rollups?days=28`. The minimized evidence records four accounts as a count only, a running scheduler with no reported last error, a 5-minute base frequency, a 240-minute Apple minimum, adaptive backoff enabled with no user currently in backoff, and three daily rollup rows. Account email addresses and user IDs were removed from the evidence package. Authenticated calendar latency remains unmeasured because this collection was not the bounded capacity probe.

## Remaining gate evidence

1. Owner selects best-effort free tier or paid always-on RTO.
2. Monitor the owner-accepted Supabase overage for HTTP 402 or loss of service. Cross-vendor usage is captured: Render is 11.52/750 instance hours and 153 MB/5 GB bandwidth; Supabase egress is 5.346/5 GB (107%).
3. Repeat the local probe until the warm health objective is characterized, and include an authenticated calendar read supplied through the environment. Scheduler and rollup endpoint authentication are now proven separately.
4. Operator-canary probe passes only after A1/A2 blockers are closed.
5. Alert thresholds and budgets are approved.

The default-disabled direct Render synthetic is defined in `.github/workflows/render-hot-spare-monitor.yml`. Enabling it requires the protected `render-monitor` environment and designated smoke-account secrets. It does not replace the missing cold-start sample, selected RTO/RPO, verified backup, or timed failover drill.