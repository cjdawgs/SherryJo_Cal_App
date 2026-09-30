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

## Parallel Runtime Parity Standard

- User-facing behavior may be implemented in both the Cloudflare Worker (`platform/cloudflare/`) and the FastAPI/Render app (`app/`). Before changing a shared workflow, identify every active implementation path and inspect both runtimes.
- When both runtimes support the workflow, keep externally observable behavior and failure/remediation contracts equivalent. If a runtime intentionally differs, document the reason and expected behavior.
- Add or update focused regression tests for each affected runtime, and run each runtime's relevant test suite plus any required asset build or frontend checks.
- In the completion summary, name the implementations and tests covered, and clearly identify any live-provider or deployed-environment checks that were not run.

Always repeat for New Chat prompts:
✅ 1. Console commands -first (prove issue is 100% resolved) prior to code changes
✅ 2. No assumptions — verify state
✅ 3. Replace entire broken blocks (not patch)
✅ 4. One source of truth only
✅ 5. No duplicate logic
✅ 6. Exact file + function targeting
✅ 7. Surgical (“brain surgery”) placement
✅ 8. Fully commented code blocks
✅ 9. Production-quality outcome

 	let's follow standard and primarily remember the Legos / Brain surgical technique we used to fix the last issue with Console commands testing code before we just into .js or .py or html or .css in everything we touch from here on and make sure our lego like instructions include the exact file names of which we must change and if we do not know for sure --- ask for files to review first: “Always Use our 9 Step Gold Standard: file-by-file + + commented code blocks + commented new blocks of code + surgical fixes with Lego like instructions and steps (as if you were telling me how to perform brain surgery) to give detailed steps for Pinpoint Code Fix placements in within existing code + bulletproof code + no guessing, no overreach debug using Console ONLY commands where possible + think about our solution innovatively and suggest ‘outside the box’ where it is warranted + BEST PRACTICE (professional app like I worked for Google, Apple or Microsoft)”

Standard format notes for Copilot SQL related Prompts:
please rewrite the SQL using my standard: 
“Use my Synergy SQL standard”
LEFT JOIN ST_Production.dbo.CurrentStudentIEPServicesFB iep ON std.StudentID = iep.StudentID
of one line and then for "AND" / "OR" drop those down to next line with indetation

Additionally I like my select code to look like:
SELECT s.StudentID ,iep.Minutes

and lastly my WHERE clause criteria to be always started with 

WHERE 1=1
AND {This Condition} .....

Use my Synergy SQL standard:

- Leading commas in SELECT
- JOINs on a single line
- WHERE clause always begins with:                                                                    
WHERE 1=1
- AND conditions on a new indented line
- OR conditions grouped and indented
- Compact ORDER BY style
- Preserve existing aliases
- Do not reformat to common SQL style
