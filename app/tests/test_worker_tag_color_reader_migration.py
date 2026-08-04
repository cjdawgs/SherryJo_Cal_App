import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
MIGRATION_PATH = ROOT / "alembic" / "versions" / "p969j00bbb33_add_worker_tag_color_reader.py"
MIGRATION_SPEC = importlib.util.spec_from_file_location("worker_tag_color_reader_migration", MIGRATION_PATH)
assert MIGRATION_SPEC and MIGRATION_SPEC.loader
MIGRATION = importlib.util.module_from_spec(MIGRATION_SPEC)
MIGRATION_SPEC.loader.exec_module(MIGRATION)


def test_worker_tag_color_reader_is_owner_scoped_and_read_only():
    statements = "\n".join(MIGRATION.upgrade_statements())

    assert "ALTER TABLE public.event_tag_color_settings ENABLE ROW LEVEL SECURITY" in statements
    assert "FOR SELECT" in statements
    assert "TO worker_calendar_reader" in statements
    assert "owner_id = public.worker_app_user_id()" in statements
    assert "GRANT SELECT" in statements
    assert "INSERT" not in statements
    assert "UPDATE" not in statements
    assert "DELETE" not in statements


def test_worker_tag_color_reader_grants_only_response_columns():
    statements = "\n".join(MIGRATION.upgrade_statements())

    for column in MIGRATION.TAG_COLOR_READ_COLUMNS:
        assert f'"{column}"' in statements