"""add admin-authorized TV refresh request function"""

from alembic import op


revision = "av000u66iii88"
down_revision = "as999s44ggg66"
branch_labels = None
depends_on = None

WORKER_ROLE = "worker_calendar_reader"
FUNCTION_SIGNATURE = "public.worker_request_tv_refresh(text)"


def upgrade_statements() -> tuple[str, ...]:
    return (
        """CREATE OR REPLACE FUNCTION public.worker_request_tv_refresh(p_device_id text)
        RETURNS TABLE(target_user_id integer, target_device_id text, requested_at timestamptz)
        LANGUAGE plpgsql
        SECURITY DEFINER
        SET search_path = ''
        AS $$
        DECLARE
            v_actor_id integer := public.worker_app_user_id();
            v_target_user_id integer;
            v_requested_at timestamptz := pg_catalog.now();
        BEGIN
            IF v_actor_id IS NULL OR NOT public.worker_app_is_admin() THEN
                RAISE EXCEPTION 'admin only' USING ERRCODE = '42501';
            END IF;
            IF p_device_id IS NULL OR pg_catalog.btrim(p_device_id) = ''
                OR p_device_id = 'unknown' OR pg_catalog.length(p_device_id) > 64 THEN
                RAISE EXCEPTION 'a known TV device must be selected' USING ERRCODE = '22023';
            END IF;

            SELECT diagnostic.user_id INTO v_target_user_id
            FROM public.tv_diag_log AS diagnostic
            WHERE diagnostic.device_id = p_device_id
              AND diagnostic.user_id IS NOT NULL
            ORDER BY diagnostic.ts_server DESC
            LIMIT 1;

            IF v_target_user_id IS NULL THEN
                RAISE EXCEPTION 'no account is associated with this TV device' USING ERRCODE = 'P0002';
            END IF;

            INSERT INTO public.tv_user_state (
                user_id, remote_refresh_requested_at, remote_refresh_device_id
            ) VALUES (
                v_target_user_id, v_requested_at, p_device_id
            )
            ON CONFLICT (user_id) DO UPDATE SET
                remote_refresh_requested_at = EXCLUDED.remote_refresh_requested_at,
                remote_refresh_device_id = EXCLUDED.remote_refresh_device_id,
                updated_at = EXCLUDED.remote_refresh_requested_at;

            RETURN QUERY SELECT v_target_user_id, p_device_id, v_requested_at;
        END
        $$""",
        f"REVOKE ALL ON FUNCTION {FUNCTION_SIGNATURE} FROM PUBLIC",
        f"GRANT EXECUTE ON FUNCTION {FUNCTION_SIGNATURE} TO {WORKER_ROLE}",
    )


def downgrade_statements() -> tuple[str, ...]:
    return (
        f"REVOKE EXECUTE ON FUNCTION {FUNCTION_SIGNATURE} FROM {WORKER_ROLE}",
        f"DROP FUNCTION IF EXISTS {FUNCTION_SIGNATURE}",
    )


def upgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        for statement in upgrade_statements():
            op.execute(statement)


def downgrade() -> None:
    if op.get_bind().dialect.name == "postgresql":
        for statement in downgrade_statements():
            op.execute(statement)