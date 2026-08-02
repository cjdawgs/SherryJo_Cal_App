"""Platform-neutral bounded calendar read use case and port."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Protocol


@dataclass(frozen=True)
class CalendarReadQuery:
    user_id: int
    start: datetime
    end: datetime
    dedup_enabled: bool = True


class CalendarReadPort(Protocol):
    def list_events(self, query: CalendarReadQuery) -> list[dict]: ...

    def list_account_statuses(self, user_id: int) -> dict[str, str]: ...


class CalendarReadUseCase:
    def __init__(self, port: CalendarReadPort):
        self.port = port

    def execute(self, query: CalendarReadQuery) -> dict:
        events = list(self.port.list_events(query))
        account_event_totals: dict[str, int] = {}
        for event in events:
            account_key = event.get("account_key")
            if account_key:
                account_event_totals[account_key] = account_event_totals.get(account_key, 0) + 1

        return {
            "events": events,
            "account_status": dict(self.port.list_account_statuses(query.user_id)),
            "account_event_totals": account_event_totals,
        }