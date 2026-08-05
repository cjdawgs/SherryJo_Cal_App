from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.models import SyncOperationLedger

logger = logging.getLogger(__name__)

SYNC_OPERATION_TYPE = "scheduler_sync"
SYNC_ROLLUP_OPERATION_TYPE = "scheduler_rollup"
SYNC_TV_DIAG_PRUNE_OPERATION_TYPE = "scheduler_tv_diag_prune"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def begin_sync_operation(
    db,
    *,
    operation_key: str,
    owner_user_id: int | None,
    operation_type: str = SYNC_OPERATION_TYPE,
    request_payload: dict[str, Any] | None = None,
) -> str | None:
    """Create or resume a durable sync operation record.

    This is intentionally fail-open so scheduler execution is never blocked by
    observability persistence issues.
    """
    if not operation_key:
        return None
    if not hasattr(db, "query") or not hasattr(db, "commit"):
        return None

    now = _utcnow()
    try:
        row = (
            db.query(SyncOperationLedger)
            .filter(SyncOperationLedger.operation_key == operation_key)
            .first()
        )

        if row is None:
            row = SyncOperationLedger(
                operation_key=operation_key,
                operation_type=operation_type,
                owner_user_id=owner_user_id,
                status="running",
                attempt_count=1,
                request_payload=request_payload,
                started_at=now,
                finished_at=None,
            )
            if hasattr(db, "add"):
                db.add(row)
        else:
            row.operation_type = operation_type
            row.owner_user_id = owner_user_id
            row.status = "running"
            row.attempt_count = int(row.attempt_count or 0) + 1
            row.request_payload = request_payload
            row.started_at = now
            row.finished_at = None
            row.error_type = None
            row.error_message = None

        row.updated_at = now
        db.commit()
        return row.id
    except Exception as exc:
        if hasattr(db, "rollback"):
            db.rollback()
        logger.warning("[SYNC] operation ledger begin failed: %s", exc)
        return None


def complete_sync_operation(
    db,
    *,
    operation_id: str | None,
    status: str,
    result_payload: dict[str, Any] | None = None,
    error: Exception | None = None,
    max_attempts: int = 3,
) -> None:
    """Mark a ledger row completed with success/failure metadata (fail-open)."""
    if not operation_id:
        return
    if not hasattr(db, "query") or not hasattr(db, "commit"):
        return

    now = _utcnow()
    try:
        row = db.query(SyncOperationLedger).filter(SyncOperationLedger.id == operation_id).first()
        if row is None:
            return

        if error is not None and status == "failed":
            attempts = int(row.attempt_count or 1)
            row.status = "dead_letter" if attempts >= max(1, int(max_attempts or 1)) else "retry_pending"
        else:
            row.status = status
        row.result_payload = result_payload
        row.finished_at = now
        row.updated_at = now
        if error is None:
            row.error_type = None
            row.error_message = None
        else:
            row.error_type = type(error).__name__
            row.error_message = str(error)

        db.commit()
    except Exception as exc:
        if hasattr(db, "rollback"):
            db.rollback()
        logger.warning("[SYNC] operation ledger completion failed: %s", exc)


def is_operation_dead_letter(db, *, operation_key: str) -> bool:
    """Return True when an operation key is already dead-lettered.

    This check is intentionally fail-open to avoid blocking scheduler execution
    when observability persistence is unavailable.
    """
    if not operation_key:
        return False
    if not hasattr(db, "query"):
        return False
    try:
        row = (
            db.query(SyncOperationLedger)
            .filter(SyncOperationLedger.operation_key == operation_key)
            .first()
        )
        return bool(row and str(getattr(row, "status", "")).lower() == "dead_letter")
    except Exception as exc:
        logger.warning("[SYNC] operation ledger dead-letter lookup failed: %s", exc)
        return False
