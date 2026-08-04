from app import main


def test_schema_patch_statements_cover_current_event_columns():
    required_snippets = [
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS sticky_notes JSONB",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS sticky_note JSONB",
        "ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence JSONB",
        "ALTER TABLE events ADD COLUMN recurrence JSON",
        "ALTER TABLE date_sticky_notes ADD COLUMN IF NOT EXISTS sticky_notes JSONB",
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ",
        # Incremental sync token — must exist as an unconditional patch
        "ALTER TABLE oauth_accounts ADD COLUMN IF NOT EXISTS sync_token JSONB",
    ]

    # Read module file to verify SQL patch statements are present.
    with open(main.__file__, "r", encoding="utf-8") as f:
        code = f.read()

    for snippet in required_snippets:
        assert snippet in code
