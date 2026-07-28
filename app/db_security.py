"""Database-level security enforcement (Layer-1 Row Level Security).

The application self-migrates at startup (see ``app/main.py``), so RLS is
enforced here as well as in the Alembic revision ``h960a11ddd44`` — whichever
path a deployment uses, the schema ends up protected.

Enabling RLS without policies denies all access to non-owner roles. The backend
connects as the table owner and therefore bypasses RLS, so the running
application is unaffected; the public data API (PostgREST / anon key) is not.
"""

import logging
from sqlalchemy import inspect, text

from app.utils.crypto import encryption_enabled, seal

logger = logging.getLogger(__name__)

RLS_TABLES = (
    "users",
    "oauth_accounts",
    "events",
    "notes",
    "tasks",
    "date_sticky_notes",
    "event_tag_color_settings",
    "tv_diag_log",
    "app_runtime_secrets",
)

PUBLIC_API_ROLES = ("anon", "authenticated")

_REVOKE_ROLE_SQL = """
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '{role}') THEN
        REVOKE ALL ON ALL TABLES IN SCHEMA public FROM {role};
        REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM {role};
        REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM {role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM {role};
        ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM {role};
    END IF;
END $$;
"""


def rls_statements(existing_tables) -> list:
    """SQL required to bring the schema to the Layer-1 RLS baseline."""
    present = set(existing_tables)
    statements = [
        f'ALTER TABLE public."{table}" ENABLE ROW LEVEL SECURITY'
        for table in RLS_TABLES
        if table in present
    ]
    statements.extend(
        _REVOKE_ROLE_SQL.format(role=role) for role in PUBLIC_API_ROLES
    )
    return statements


def enforce_row_level_security(engine) -> dict:
    """Apply the Layer-1 RLS baseline. No-op on non-PostgreSQL engines."""
    if not engine.url.drivername.startswith("postgresql"):
        return {"status": "skipped", "reason": "not postgresql", "applied": 0}

    try:
        statements = rls_statements(inspect(engine).get_table_names())

        with engine.connect() as conn:
            for statement in statements:
                conn.execute(text(statement))
            conn.commit()

        logger.info(f"🔒 [RLS] Row Level Security enforced on {len(RLS_TABLES)} tables.")
        return {"status": "ok", "applied": len(statements)}

    except Exception as exc:
        # Never crash startup: a deployment whose DB role lacks ownership must
        # still boot, but the operator needs to see this loudly.
        logger.error(
            "❌ [RLS] Could not enforce Row Level Security — the database is "
            f"exposed to the public data API until this is fixed: {exc}"
        )
        return {"status": "error", "error": str(exc), "applied": 0}


def seal_stored_credentials(engine) -> dict:
    """Encrypt any ``oauth_accounts`` credential still stored in clear text.

    Tokens are sealed on write, so rows are normally converted the next time a
    provider token is refreshed. Apple accounts never refresh (the stored value
    is a permanent app password), so a sweep at startup is what guarantees no
    clear-text credential survives.
    """
    if not encryption_enabled():
        return {"status": "skipped", "reason": "no encryption key", "sealed": 0}

    try:
        if "oauth_accounts" not in inspect(engine).get_table_names():
            return {"status": "skipped", "reason": "table missing", "sealed": 0}

        sealed = 0
        with engine.connect() as conn:
            rows = conn.execute(
                text("SELECT id, access_token, refresh_token FROM oauth_accounts")
            ).fetchall()

            for row_id, access_token, refresh_token in rows:
                sealed_access = seal(access_token)
                sealed_refresh = seal(refresh_token)

                if sealed_access == access_token and sealed_refresh == refresh_token:
                    continue

                conn.execute(
                    text(
                        "UPDATE oauth_accounts "
                        "SET access_token = :access_token, refresh_token = :refresh_token "
                        "WHERE id = :id"
                    ),
                    {
                        "access_token": sealed_access,
                        "refresh_token": sealed_refresh,
                        "id": row_id,
                    },
                )
                sealed += 1

            conn.commit()

        if sealed:
            logger.info(f"🔐 [CRYPTO] Sealed credentials for {sealed} oauth_accounts row(s).")
        return {"status": "ok", "sealed": sealed}

    except Exception as exc:
        logger.error(f"❌ [CRYPTO] Credential sealing sweep failed: {exc}")
        return {"status": "error", "error": str(exc), "sealed": 0}
