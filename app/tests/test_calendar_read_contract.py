import json
from datetime import datetime
from pathlib import Path

from app.application.calendar_read import CalendarReadQuery, CalendarReadUseCase


FIXTURE_PATH = Path(__file__).parent / "fixtures" / "calendar_read_contract.json"


class FixtureCalendarReadPort:
    def __init__(self, fixture: dict):
        self.fixture = fixture
        self.received_query = None

    def list_events(self, query: CalendarReadQuery) -> list[dict]:
        self.received_query = query
        return self.fixture["events"]

    def list_account_statuses(self, user_id: int) -> dict[str, str]:
        assert user_id == self.fixture["query"]["user_id"]
        return self.fixture["account_status"]


def test_calendar_read_fixture_matches_exact_platform_neutral_contract():
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    query_data = fixture["query"]
    query = CalendarReadQuery(
        user_id=query_data["user_id"],
        start=datetime.fromisoformat(query_data["start"]),
        end=datetime.fromisoformat(query_data["end"]),
        dedup_enabled=query_data["dedup_enabled"],
    )
    port = FixtureCalendarReadPort(fixture)

    result = CalendarReadUseCase(port).execute(query)

    assert result == fixture["expected"]
    assert port.received_query == query