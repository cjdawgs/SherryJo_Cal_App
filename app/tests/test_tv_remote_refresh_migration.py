import os
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from uuid import uuid4

import pytest
from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, text


ROOT = Path(__file__).resolve().parents[2]
PATH = ROOT / "alembic" / "versions" / "ar998r44eee22_add_tv_remote_refresh_request.py"
SPEC = spec_from_file_location("tv_remote_refresh_migration", PATH)
MIGRATION = module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MIGRATION)


@pytest.mark.parametrize("existing_columns", [(), ("timestamp",), ("device",), ("timestamp", "device")])
@pytest.mark.parametrize("existing_policy", [False, True])
def test_upgrade_preserves_preexisting_tv_state(monkeypatch, existing_columns, existing_policy):
    database_url = os.getenv("TEST_MIGRATION_DATABASE_URL")
    if not database_url:
        pytest.skip("Set TEST_MIGRATION_DATABASE_URL to a disposable migrated PostgreSQL database")

    engine = create_engine(database_url)
    with engine.connect() as connection:
        transaction = connection.begin()
        try:
            connection.execute(text("DROP POLICY IF EXISTS worker_tv_state_admin ON public.tv_user_state"))
            connection.execute(text(
                "ALTER TABLE public.tv_user_state DROP COLUMN IF EXISTS remote_refresh_requested_at, "
                "DROP COLUMN IF EXISTS remote_refresh_device_id"
            ))
            if "timestamp" in existing_columns:
                connection.execute(text(
                    "ALTER TABLE public.tv_user_state ADD COLUMN remote_refresh_requested_at timestamptz"
                ))
            if "device" in existing_columns:
                connection.execute(text(
                    "ALTER TABLE public.tv_user_state ADD COLUMN remote_refresh_device_id varchar(64)"
                ))
            if existing_policy:
                connection.execute(text(
                    "CREATE POLICY worker_tv_state_admin ON public.tv_user_state "
                    "FOR ALL TO worker_calendar_reader USING (false) WITH CHECK (false)"
                ))

            identifier = uuid4().hex
            user_id = connection.execute(text(
                "INSERT INTO public.users (username, email, hashed_password, role) "
                "VALUES (:name, :email, 'test', 'staff') RETURNING id"
            ), {"name": identifier, "email": f"{identifier}@example.invalid"}).scalar_one()
            connection.execute(text(
                "INSERT INTO public.tv_user_state (user_id, selected_date) VALUES (:id, '2026-01-02')"
            ), {"id": user_id})
            if "timestamp" in existing_columns:
                connection.execute(text(
                    "UPDATE public.tv_user_state SET remote_refresh_requested_at = '2026-01-03 04:05:06+00' "
                    "WHERE user_id = :id"
                ), {"id": user_id})
            if "device" in existing_columns:
                connection.execute(text(
                    "UPDATE public.tv_user_state SET remote_refresh_device_id = 'existing-device' "
                    "WHERE user_id = :id"
                ), {"id": user_id})

            monkeypatch.setattr(MIGRATION, "op", Operations(MigrationContext.configure(connection)))
            MIGRATION.upgrade()

            state = connection.execute(text(
                "SELECT selected_date::text, "
                "remote_refresh_requested_at = '2026-01-03 04:05:06+00'::timestamptz, "
                "remote_refresh_device_id "
                "FROM public.tv_user_state WHERE user_id = :id"
            ), {"id": user_id}).one()
            assert state[0] == "2026-01-02"
            assert state[1] is (True if "timestamp" in existing_columns else None)
            assert state[2] == ("existing-device" if "device" in existing_columns else None)
            policy = connection.execute(text(
                "SELECT qual, with_check, roles, cmd, permissive FROM pg_policies WHERE schemaname = 'public' "
                "AND tablename = 'tv_user_state' AND policyname = 'worker_tv_state_admin'"
            )).one()
            assert policy.qual == "worker_app_is_admin()"
            assert policy.with_check == "worker_app_is_admin()"
            assert policy.roles == ["worker_calendar_reader"]
            assert policy.cmd == "ALL"
            assert policy.permissive == "PERMISSIVE"
        finally:
            transaction.rollback()
            engine.dispose()
