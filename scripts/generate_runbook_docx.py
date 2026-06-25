import os
import zipfile
from datetime import datetime
from xml.sax.saxutils import escape


def make_document_xml(paragraphs):
    body_parts = []
    for p in paragraphs:
        text = escape(p)
        body_parts.append(
            f"<w:p><w:r><w:t xml:space=\"preserve\">{text}</w:t></w:r></w:p>"
        )

    body_xml = "".join(body_parts)

    return (
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>"
        "<w:document xmlns:wpc=\"http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas\" "
        "xmlns:mc=\"http://schemas.openxmlformats.org/markup-compatibility/2006\" "
        "xmlns:o=\"urn:schemas-microsoft-com:office:office\" "
        "xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" "
        "xmlns:m=\"http://schemas.openxmlformats.org/officeDocument/2006/math\" "
        "xmlns:v=\"urn:schemas-microsoft-com:vml\" "
        "xmlns:wp14=\"http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing\" "
        "xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" "
        "xmlns:w10=\"urn:schemas-microsoft-com:office:word\" "
        "xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" "
        "xmlns:w14=\"http://schemas.microsoft.com/office/word/2010/wordml\" "
        "xmlns:w15=\"http://schemas.microsoft.com/office/word/2012/wordml\" "
        "xmlns:wpg=\"http://schemas.microsoft.com/office/word/2010/wordprocessingGroup\" "
        "xmlns:wpi=\"http://schemas.microsoft.com/office/word/2010/wordprocessingInk\" "
        "xmlns:wne=\"http://schemas.microsoft.com/office/word/2006/wordml\" "
        "xmlns:wps=\"http://schemas.microsoft.com/office/word/2010/wordprocessingShape\" "
        "mc:Ignorable=\"w14 w15 wp14\">"
        f"<w:body>{body_xml}<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>"
        "<w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" "
        "w:header=\"708\" w:footer=\"708\" w:gutter=\"0\"/>"
        "<w:cols w:space=\"708\"/><w:docGrid w:linePitch=\"360\"/></w:sectPr></w:body></w:document>"
    )


def build_docx(output_path, paragraphs):
    content_types = """<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">
  <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>
  <Default Extension=\"xml\" ContentType=\"application/xml\"/>
  <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>
</Types>
""".strip()

    rels = """<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">
  <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>
</Relationships>
""".strip()

    document_xml = make_document_xml(paragraphs)

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("word/document.xml", document_xml)


if __name__ == "__main__":
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    paragraphs = [
        "SherryJo Calendar App - E2E, Schema, Git, and Render Deployment Runbook",
        f"Generated: {now}",
        "",
        "1) Purpose",
        "This document summarizes the exact workflow used to implement, validate, and deploy the sticky note enhancements and related reliability fixes.",
        "",
        "2) Key Files Added/Updated",
        "app/routers/calendar.py",
        "app/services/multi_account_oauth_service.py",
        "app/main.py",
        "app/static/calendar.js",
        "app/tests/test_schema_health.py",
        "app/tests/test_transaction_recovery.py",
        "app/tests/test_supabase_e2e_optional.py",
        "app/tests/test_postgres_schema_patch_sql.py",
        "scripts/render_deploy_and_verify.py",
        "",
        "3) Transaction-Recovery Fixes (Sync + Unified)",
        "- Added rollback safeguards in /calendar/sync and /calendar/unified when diagnostic DB queries fail.",
        "- Added rollback+retry logic in account read methods:",
        "  - MultiAccountOAuthService.get_user_accounts",
        "  - MultiAccountOAuthService.get_all_sync_enabled_accounts",
        "- Goal: prevent Postgres InFailedSqlTransaction from poisoning downstream queries.",
        "",
        "4) Startup Schema Auto-Repair for PostgreSQL (Supabase)",
        "At app startup, when using PostgreSQL, missing optional columns are automatically added with ALTER TABLE ... ADD COLUMN IF NOT EXISTS.",
        "",
        "Columns auto-repaired in oauth_accounts:",
        "- last_sync_success TIMESTAMPTZ",
        "- last_sync_failure TIMESTAMPTZ",
        "- last_error VARCHAR",
        "- status VARCHAR DEFAULT 'ok'",
        "- token_expires_at TIMESTAMPTZ",
        "- updated_at TIMESTAMPTZ",
        "- color VARCHAR",
        "",
        "Columns auto-repaired in events:",
        "- color VARCHAR",
        "- tags JSONB",
        "- sticky_note JSONB",
        "- sticky_notes JSONB",
        "- updated_at TIMESTAMPTZ",
        "",
        "Manual SQL Equivalent (if you ever need to run manually in Supabase SQL Editor):",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS last_sync_success TIMESTAMPTZ;",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS last_sync_failure TIMESTAMPTZ;",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS last_error VARCHAR;",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS status VARCHAR DEFAULT 'ok';",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS color VARCHAR;",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS color VARCHAR;",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS tags JSONB;",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS sticky_note JSONB;",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS sticky_notes JSONB;",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;",
        "",
        "5) Local and External E2E Test Workflow",
        "A) Local targeted regression tests",
        "Command:",
        "set PYTHONPATH=.&& python -m pytest app/tests/test_transaction_recovery.py app/tests/test_schema_health.py app/tests/test_date_sticky_api.py -q",
        "",
        "B) Optional live Supabase E2E test (read/write)",
        "Command:",
        "set PYTHONPATH=.&& set RUN_SUPABASE_E2E=1&& set SHERRYJO_E2E_DB_URL=<postgres_url>&& python -m pytest app/tests/test_supabase_e2e_optional.py -q",
        "",
        "What this E2E validates:",
        "- user register/login",
        "- /health/schema response",
        "- /calendar/date-sticky contract",
        "- /calendar/sync contract",
        "- /calendar/unified payload shape",
        "",
        "6) Git Commit + Push Automation Steps",
        "Branch: main",
        "Typical flow:",
        "1. git status --short",
        "2. git add <files>",
        "3. git commit -m \"<message>\"",
        "4. git push origin main",
        "",
        "Notable commits from this rollout:",
        "- e75af50 Harden sticky/sync APIs and add schema health + deploy verification",
        "- a3577ad Fix Render deploy script for async API responses",
        "- 32cb4ef Recover from aborted DB transactions during sync/account lookups",
        "- cdc2b91 Auto-repair missing Postgres event/oauth columns at startup",
        "",
        "7) Render Deploy Automation",
        "Script: scripts/render_deploy_and_verify.py",
        "",
        "Environment variables required:",
        "- RENDER_API_KEY",
        "- RENDER_SERVICE_ID",
        "- APP_BASE_URL",
        "",
        "Run command:",
        "set RENDER_API_KEY=<token>&& set RENDER_SERVICE_ID=<service_id>&& set APP_BASE_URL=<url>&& python scripts\\render_deploy_and_verify.py",
        "",
        "What the script does:",
        "- Triggers deploy via Render API",
        "- Polls deploy status until live",
        "- Executes post-deploy checks:",
        "  - GET /health (expects 200)",
        "  - GET /health/schema (expects 200)",
        "  - GET /calendar/date-sticky (expects non-500; auth may return 401)",
        "  - GET /calendar/sync (expects non-500; GET may return 405)",
        "",
        "8) Manual Post-Deploy Smoke Test (Authenticated)",
        "- Register temporary user",
        "- Login and acquire JWT",
        "- Call POST /calendar/sync with Authorization header",
        "- Call GET /calendar/unified with Authorization header",
        "- Call GET /calendar/date-sticky with Authorization header",
        "Expected: HTTP 200 and valid JSON payloads.",
        "",
        "9) Troubleshooting Quick Guide",
        "Issue: InFailedSqlTransaction in syncNow",
        "Action: verify rollback/retry fixes are deployed (commit 32cb4ef+).",
        "",
        "Issue: UndefinedColumn events.updated_at",
        "Action: ensure startup schema auto-repair is deployed (commit cdc2b91) or run manual ALTER TABLE SQL above.",
        "",
        "Issue: /health/schema returns 404",
        "Action: deployed revision is behind; deploy latest main and rerun render_deploy_and_verify.py.",
        "",
        "10) Notes for Future Script Changes",
        "- Keep Render API response parsing flexible (202 Accepted, nested list payloads).",
        "- Preserve non-500 semantics for protected route checks in post-deploy validation.",
        "- Keep E2E tests opt-in for live database by environment variable.",
    ]

    out = os.path.join(
        os.path.dirname(os.path.dirname(__file__)),
        "docs",
        "SherryJo_Calendar_Runbook_E2E_Deploy.docx",
    )
    build_docx(out, paragraphs)
    print(out)
