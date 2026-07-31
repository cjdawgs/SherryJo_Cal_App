# TV Colorization + Sticky Icon Validation Collateral

Date: 2026-07-31
Workspace: GitHub Codespaces (/workspaces/SherryJo_Cal_App)

## Scope
This collateral validates two fixes:
1. Account colorization in TV event cards across views.
2. Updated sticky note icon visibility in TV UI.

## Code Changes Under Test
- app/routers/tv.py
  - _serialize_event_for_tv now includes:
    - color_enabled
    - external_ids
    - extendedProps.external_ids
- app/static/tv_dashboard.js
  - Added extractExternalAccountIdentity fallback using external_ids keys.
  - eventAccountIdentity now falls back to external identity when account key/email are canonicalized.
  - Sticky marker CSS now uses /static/icons/sticky-note-mini.svg.
- app/tests/test_tv.py
  - Added canonical local row regression:
    - test_events_payload_exposes_external_identity_for_local_canonical_rows
- app/tests/test_tv_dashboard_keys.py
  - Added source-contract assertions for:
    - extractExternalAccountIdentity
    - external_ids
    - sticky-note-mini.svg

## Local Commands Executed (Codespace)
1) node --check app/static/tv_dashboard.js
2) pytest -q app/tests/test_tv.py -k "color_metadata_for_tv or external_identity_for_local_canonical_rows or events_accounts_include_account_key_and_color"
3) pytest -q app/tests/test_tv_dashboard_keys.py -k "account_chip_filtering_and_sticky_icons"

## Results Observed
- TV backend payload test subset: 3 passed, 43 deselected
- TV dashboard key-contract test subset: 1 passed, 14 deselected
- JS syntax check: pass (no syntax errors)

## What This Proves
- Payload now carries enough identity metadata for TV to map canonical local events to real account color keys.
- Client fallback logic can recover account identity from external_ids when source/account_key are generic local values.
- Sticky markers are now styled with the updated sticky-note icon asset.

## Quick Reproduction Script
Run from repo root:

node --check app/static/tv_dashboard.js && \
pytest -q app/tests/test_tv.py -k "color_metadata_for_tv or external_identity_for_local_canonical_rows or events_accounts_include_account_key_and_color" && \
pytest -q app/tests/test_tv_dashboard_keys.py -k "account_chip_filtering_and_sticky_icons"

Expected:
- All tests in these subsets pass.

## Manual TV UI Validation Checklist
1. Hard refresh /tv/dashboard.
2. In Day view, verify event cards show per-account colors (not collapsed fallback).
3. Repeat in 3-Day, Week, and Month views.
4. Confirm sticky note icon appears on:
   - event cards that have sticky payload
   - month/day sticky markers
   - right-side summary rows where sticky is present.
