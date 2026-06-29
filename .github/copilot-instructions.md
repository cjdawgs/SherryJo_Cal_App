# GitHub Copilot Instructions for SherryJo_Cal_App

## File Naming Rules

**NEVER** include machine names, hostnames, or computer names in any file name.

Examples of forbidden patterns:
- `calendar-Athens.py` ❌
- `style-Athens.css` ❌
- `calendar.ui-Athens.js` ❌
- `*-Athens.*` ❌
- Any file containing a computer or machine name ❌

When creating variants or environment-specific files, use generic suffixes only:
- `.local.env` for local environment overrides
- `.example.env` for example env templates
- `*.backup.*` for backup files
- `*.v2.*` or `*.new.*` for versioned alternatives

## Project Overview

FastAPI + FullCalendar web app. Backend in `app/`, frontend static files in `app/static/`.

## Key Files

- `app/static/calendar.js` — main calendar controller (2200+ lines)
- `app/static/calendar.fullcalendar.js` — FullCalendar init, event handlers
- `app/static/calendar.ui.js` — modal and UI event bindings
- `app/static/style.css` — all styles (includes context menu and event-selection CSS)
- `app/routers/calendar.py` — calendar API routes

## Architecture

- `window.selectedDate` — single source of truth for the active date (YYYY-MM-DD string)
- `window.sessionEventCache` — in-memory event cache, no repeated fetches
- `window.calendar` — the FullCalendar instance

## Code Standards

- All views must read from `window.selectedDate` only — never fall back to `new Date()` or `today()`
- Never create duplicate/variant files per machine — edit the canonical file directly
- All new features go into the existing canonical files, not new machine-named copies
