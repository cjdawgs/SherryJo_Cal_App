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
