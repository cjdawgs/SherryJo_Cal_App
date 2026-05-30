
from datetime import datetime, timezone
from dateutil.relativedelta import relativedelta
from sqlalchemy.orm import Session

from app.services.graph_client import GraphClient
from app.services.google_calendar_service import GoogleCalendarService
from app.models import Event
from app.services.multi_account_oauth_service import (
    MultiAccountOAuthService,
    ensure_valid_token
)

SAFE_DELETE = False

ACCOUNT_COLORS = {
    "google": "#4285F4",
    "outlook": "#0078D4"
}


class CalendarService:

    def __init__(self):
        self.graph = GraphClient()
        self.google = GoogleCalendarService()

    # ==================================================
    # ✅ TIME SAFETY (CRITICAL FIX)
    # ==================================================
    def _to_utc(self, dt_str):
        """
        ✅ Always return UTC-aware datetime
        """
        if not dt_str:
            return None

        try:
            # handle Z properly
            if dt_str.endswith("Z"):
                dt_str = dt_str.replace("Z", "+00:00")

            dt = datetime.fromisoformat(dt_str)

            # ensure timezone-aware
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)

            return dt

        except Exception:
            return None

    # ==================================================
    # ✅ NORMALIZATION
    # ==================================================
    def _normalize(self, google_events, ms_events):
        unified = []

        for e in google_events:
            unified.append({
                "external_id": e.get("id"),
                "title": e.get("summary") or "Untitled Event",
                "start": e.get("start"),
                "end": e.get("end"),
                "source": "google",
                "account": e.get("account"),
                "color": ACCOUNT_COLORS["google"]
            })

        for e in ms_events:
            unified.append({
                "external_id": e.get("id"),
                "title": (e.get("subject") or "").strip() or "Untitled Event",
                "start": e.get("start"),
                "end": e.get("end"),
                "source": "outlook",
                "account": e.get("account"),
                "color": ACCOUNT_COLORS["outlook"]
            })

        return unified

    # ==================================================
    # ✅ FETCH EVENTS (FIXED)
    # ==================================================
    def fetch_all_events(self, db, user):

        google_events = []
        ms_events = []

        now = datetime.now(timezone.utc)

        if now.month > 6:
            start_date = datetime(now.year, 1, 1, tzinfo=timezone.utc)
            future_limit = datetime(now.year, 12, 31, 23, 59, 59, tzinfo=timezone.utc)
        else:
            start_date = now - relativedelta(months=6)
            future_limit = now + relativedelta(months=6)

        print(f"✅ Fetch window: {start_date} → {future_limit}")

        accounts = MultiAccountOAuthService.get_all_sync_enabled_accounts(db, user.id)
        print(f"✅ Accounts found: {len(accounts)}")

        for acc in accounts:

            print(f"👉 Processing: {acc.provider} | {acc.account_email}")

            token = ensure_valid_token(db, acc)

            if not token:
                print(f"🚫 Skipped: {acc.account_email}")
                continue

            try:
                # ========================
                # GOOGLE
                # ========================
                if acc.provider == "google":

                    events = self.google.fetch_events(
                        token,
                        start_date=start_date,
                        end_date=future_limit
                    ) or []

                    print(f"✅ Google returned: {len(events)}")

                    for e in events:
                        start_val = (
                            e.get("start", {}).get("dateTime")
                            or e.get("start", {}).get("date")
                        )

                        dt = self._to_utc(start_val)

                        if not dt:
                            continue

                        if start_date <= dt <= future_limit:
                            e["start"] = dt.isoformat()
                            e["end"] = self._to_utc(
                                e.get("end", {}).get("dateTime")
                                or e.get("end", {}).get("date")
                            )
                            e["account"] = acc.account_email
                            google_events.append(e)

                # ========================
                # MICROSOFT
                # ========================
                elif acc.provider == "microsoft":

                    data = self.graph.get_events_with_token(token) or {}
                    events = data.get("value", [])

                    print(f"✅ Microsoft returned: {len(events)}")

                    for e in events:
                        start_val = e.get("start", {}).get("dateTime")

                        dt = self._to_utc(start_val)

                        if not dt:
                            continue

                        if start_date <= dt <= future_limit:
                            e["start"] = dt.isoformat()
                            e["end"] = self._to_utc(
                                e.get("end", {}).get("dateTime")
                            )
                            e["account"] = acc.account_email
                            ms_events.append(e)

            except Exception as e:
                print(f"❌ Account failed: {e}")

        return self._normalize(google_events, ms_events)

    # ==================================================
    # ✅ SYNC ENGINE (FIXED + INSIDE CLASS)
    # ==================================================
    def sync_all(self, db: Session, user):

        raw_events = self.fetch_all_events(db, user)
        created = updated = 0

        for e in raw_events:
            external_id = f"{e['source']}:{e['external_id']}"

            start = self._to_utc(e["start"])
            end = self._to_utc(e["end"])

            if not start:
                continue

            existing = db.query(Event).filter(
                Event.externalId == external_id,
                Event.owner_id == user.id
            ).first()

            if not existing:
                db.add(Event(
                    title=e["title"],
                    start_time=start,
                    end_time=end,
                    source=e["source"],
                    externalId=external_id,
                    owner_id=user.id
                ))
                created += 1
                continue

            changed = False

            if existing.start_time != start:
                existing.start_time = start
                changed = True

            if existing.end_time != end:
                existing.end_time = end
                changed = True

            if changed:
                updated += 1

        db.commit()

        return {
            "created": created,
            "updated": updated
        }
