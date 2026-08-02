"""SQLAlchemy-backed adapter for the bounded calendar read use case."""

from __future__ import annotations

import logging
from types import SimpleNamespace

from app.application.calendar_read import CalendarReadQuery
from app.services.calendar_service import CalendarService, normalize_provider
from app.services.multi_account_oauth_service import MultiAccountOAuthService, resolve_account_status


logger = logging.getLogger(__name__)


class SQLAlchemyCalendarReadAdapter:
    def __init__(self, db, calendar_service: CalendarService):
        self.db = db
        self.calendar_service = calendar_service

    def list_events(self, query: CalendarReadQuery) -> list[dict]:
        try:
            events = self.calendar_service.get_events_from_db(
                self.db,
                SimpleNamespace(id=query.user_id),
                query.start,
                query.end,
                dedup_enabled=query.dedup_enabled,
            )
            logger.debug("[UNIFIED] loaded %s database events", len(events))
            return events
        except Exception as exc:
            logger.error("[UNIFIED] events fetch failed: %s", exc)
            return []

    def list_account_statuses(self, user_id: int) -> dict[str, str]:
        try:
            accounts = MultiAccountOAuthService.get_user_accounts(self.db, user_id)
        except Exception as exc:
            logger.error("[UNIFIED] account status block failed: %s", exc)
            return {}

        statuses = {}
        for account in accounts:
            try:
                provider = normalize_provider(account.provider)
                account_email = (account.account_email or "").lower().strip()
                statuses[f"{provider}:{account_email}"] = resolve_account_status(account)
            except Exception as exc:
                logger.error("[UNIFIED] account status failed: %s", exc)
        return statuses