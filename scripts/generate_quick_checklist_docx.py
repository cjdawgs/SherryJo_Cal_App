import os
from datetime import datetime

from docx_builder import build_docx


if __name__ == "__main__":
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    paragraphs = [
        "SherryJo Calendar App - Quick Operator Checklist",
        f"Generated: {now}",
        "",
        "1) Pre-Deploy",
        "- Pull latest main branch.",
        "- Run local checks:",
        "  set PYTHONPATH=.&& python -m pytest app/tests/test_transaction_recovery.py app/tests/test_schema_health.py app/tests/test_date_sticky_api.py -q",
        "",
        "2) Optional Live Supabase E2E",
        "- set PYTHONPATH=.&& set RUN_SUPABASE_E2E=1&& set SHERRYJO_E2E_DB_URL=<postgres_url>&& python -m pytest app/tests/test_supabase_e2e_optional.py -q",
        "",
        "3) Commit + Push",
        "- git status --short",
        "- git add <files>",
        "- git commit -m \"<message>\"",
        "- git push origin main",
        "",
        "4) Render Deploy Automation",
        "- set RENDER_API_KEY=<token>",
        "- set RENDER_SERVICE_ID=srv-d8sfeke8bjmc738bhgm0",
        "- set APP_BASE_URL=https://sherryjo-cal-app.onrender.com",
        "- python scripts\\render_deploy_and_verify.py",
        "",
        "5) Required Post-Deploy Checks",
        "- GET /health -> 200",
        "- GET /health/schema -> 200",
        "- Authenticated POST /calendar/sync -> 200 with JSON",
        "- Authenticated GET /calendar/unified -> 200",
        "- Authenticated GET /calendar/date-sticky -> 200",
        "",
        "6) If Sync Fails with InFailedSqlTransaction",
        "- Confirm latest deploy includes transaction rollback/retry fix commits.",
        "",
        "7) If Sync Fails with UndefinedColumn",
        "- Confirm startup schema auto-repair has deployed.",
        "- Or run manual SQL (ALTER TABLE ... ADD COLUMN IF NOT EXISTS) from the full runbook.",
    ]

    out = os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "docs",
        "SherryJo_Calendar_Quick_Operator_Checklist.docx",
    )
    build_docx(out, paragraphs)
    print(out)
