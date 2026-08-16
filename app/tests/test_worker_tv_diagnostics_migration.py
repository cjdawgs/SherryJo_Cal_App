from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "alembic" / "versions" / "ak991e11xxx55_add_worker_tv_diagnostics.py"
SPEC = spec_from_file_location("worker_tv_diagnostics_migration", PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


def test_tv_diagnostics_use_bounded_functions_without_table_grants():
    statements = "\n".join(MIGRATION.upgrade_statements()).lower()
    assert "jsonb_array_length(p_entries) > 50" in statements
    assert "security definer" in statements
    assert "worker_app_user_id()" in statements
    assert "admin only" in statements
    assert "limit 100" in statements
    assert "interval '60 minutes'" in statements
    assert "grant execute on function public.worker_record_tv_diagnostics" in statements
    assert "grant execute on function public.worker_read_tv_diagnostics" in statements
    assert "grant select" not in statements
    assert "grant insert" not in statements