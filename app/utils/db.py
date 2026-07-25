"""Database lookup helpers shared by routers."""

import logging
from typing import Any, Optional, Type, TypeVar

from fastapi import HTTPException
from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)

ModelType = TypeVar("ModelType")


def get_or_404(
    db: Session,
    model: Type[ModelType],
    record_id: Any,
    detail: str,
    id_field: str = "id",
) -> ModelType:
    """Fetch a row by id or raise a 404 with ``detail``."""
    record = db.query(model).filter(getattr(model, id_field) == record_id).first()
    if not record:
        raise HTTPException(status_code=404, detail=detail)
    return record


def get_owned_or_404(
    db: Session,
    model: Type[ModelType],
    record_id: Any,
    owner_id: Any,
    detail: str,
    owner_field: str = "user_id",
    id_field: str = "id",
) -> ModelType:
    """Fetch a row belonging to ``owner_id`` or raise a 404 with ``detail``."""
    record = (
        db.query(model)
        .filter(
            getattr(model, id_field) == record_id,
            getattr(model, owner_field) == owner_id,
        )
        .first()
    )
    if not record:
        raise HTTPException(status_code=404, detail=detail)
    return record


def safe_rollback(db: Session, context: Optional[str] = None) -> None:
    """Roll back a session, swallowing failures so error paths stay usable."""
    try:
        db.rollback()
    except Exception as rollback_error:  # pragma: no cover - defensive
        if context:
            logger.error("[%s] Rollback failed: %s", context, rollback_error)
