import time
from datetime import datetime, timedelta
from dateutil.relativedelta import relativedelta
from sqlalchemy.orm import Session

from app.services.graph_client import GraphClient
from app.services.google_calendar_service import GoogleCalendarService
from app.auth.token_handler import TokenHandler
from app.models import Event
from app.services.multi_account_oauth_service import MultiAccountOAuthService


SAFE_DELETE = False  # ✅ change to True later in production

ACCOUNT_COLORS = {
    "google": "#4285F4",
    "outlook": "#0078D4"
}


class CalendarService:

    def __init__(self):
        self.graph = GraphClient()
        self.google = GoogleCalendarService()
        self.ms_handler = TokenHandler()

    # ==================================================
    # GOOGLE TOKEN
    # ==================================================
    def _get_valid_google_token(self, db, user):

        if not user.google_access_token:
            return None

        if user.google_token_expires and time.time() >= user.google_token_expires:

            if not user.google_refresh_token:
                return None

            new_token = self.google.refresh_token(user.google_refresh_token)

            user.google_access_token = new_token["access_token"]
            user.google_token_expires = time.time() + new_token.get("expires_in", 3600)

            db.commit()

        return user.google_access_token

    # ==================================================
    # MICROSOFT TOKEN
    # ==================================================
    def _get_valid_ms_token(self, db, user):

        if not user.ms_access_token:
            return None

        if user.ms_token_expires and time.time() >= user.ms_token_expires:
            self.ms_handler.refresh_access_token(db, user)

        return user.ms_access_token

    # ==================================================
    # NORMALIZATION
    # ==================================================
    def _normalize(self, google_events, ms_events):

        unified = []

        for e in google_events:
            unified.append({
                "external_id": e.get("id"),
                "title": e.get("summary") or "Untitled Event",
                "start": self._normalize_time(
                    e.get("start", {}).get("dateTime") or e.get("start", {}).get("date")
                ),
                "end": self._normalize_time(
                    e.get("end", {}).get("dateTime") or e.get("end", {}).get("date")
                ),
                "source": "google",
                "account": e.get("account"),
                "color": ACCOUNT_COLORS["google"]

            })

        for e in ms_events:
            unified.append({
                "external_id": e.get("id"),
                "title": (e.get("subject") or "").strip() or "Untitled Event",
                "start": self._normalize_time(e.get("start", {}).get("dateTime")),
                "end": self._normalize_time(e.get("end", {}).get("dateTime")),
                "source": "outlook",
                "account": e.get("account"),
                "color": ACCOUNT_COLORS["outlook"]

            })

        return unified

    # ==================================================
    # FETCH EVENTS
    # ==================================================
    def fetch_all_events(self, db, user):
        google_events = []
        ms_events = []
        
        
        # ==================================================
        # ✅ SMART DATE LOOKBACK (ADD THIS BLOCK)
        # ==================================================
        now = datetime.utcnow()

        if now.month > 6:
            # ✅ July–Dec → from Jan 1 of current year
            start_date = datetime(now.year, 1, 1)
            # Future limit = end of current year
            future_limit = datetime(now.year, 12, 31, 23, 59, 59)

        else:
            # ✅ Jan–June → last 90 days
            start_date = now - relativedelta(months=6)
            # Future limit = 6 months ahead
            future_limit = now + relativedelta(months=6)

        print(f"✅ Fetching events starting from: {start_date}")
        print(f"✅ Fetching events ending at: {future_limit}")

        # ✅ get ALL accounts
        accounts = MultiAccountOAuthService.get_all_sync_enabled_accounts(db, user.id)
        
        print(f"✅ TOTAL ACCOUNTS FOUND: {len(accounts)}")

        for acc in accounts:
            print(f"👉 {acc.provider}: {acc.account_email}")

            try:
                # =========================
                # GOOGLE ACCOUNTS
                # =========================
                if acc.provider == "google":
                    if not acc.access_token:
                        continue

                    events = self.google.fetch_events(
                        acc.access_token,
                        start_date=start_date,
                        end_date=future_limit
                    )

                    filtered = []

                    for e in events:
                        start_val = (
                            e.get("start", {}).get("dateTime")
                            or e.get("start", {}).get("date")
                        )

                        if not start_val:
                            continue

                        try:
                            dt = datetime.fromisoformat(start_val.replace("Z", ""))

                            if start_date <= dt <= future_limit:
                                e["account"] = acc.account_email
                                filtered.append(e)

                        except Exception as err:
                            print("⚠️ Google parse error:", err)

                    google_events.extend(filtered)

                # =========================
                # MICROSOFT ACCOUNTS
                # =========================
                elif acc.provider == "microsoft":
                    if not acc.access_token:
                        continue

                    data = self.graph.get_events_with_token(acc.access_token)

                    filtered = []

                    for e in data.get("value", []):
                        start_val = e.get("start", {}).get("dateTime")

                        if not start_val:
                            continue

                        try:
                            dt = datetime.fromisoformat(start_val.replace("Z", ""))

                            if start_date <= dt <= future_limit:
                                e["account"] = acc.account_email
                                filtered.append(e)

                        except Exception as err:
                            print("⚠️ MS parse error:", err)

                    ms_events.extend(filtered)

            except Exception as e:
                print(f"❌ Failed account {acc.account_email}: {e}")

    # ==================================================
    # SYNC ENGINE
    # ==================================================
    def sync_all(self, db: Session, user):

        raw_events = self.fetch_all_events(db, user) or []
        events = self._deduplicate(raw_events)


        incoming_ids = set()
        created = updated = deleted = 0

        for e in events:
            fp = self._fingerprint(e)
            incoming_ids.add(fp)

            existing = db.query(Event).filter(
                Event.externalId == fp,
                Event.owner_id == user.id
            ).first()

            start = self._parse_datetime(e["start"])
            end = self._parse_datetime(e["end"])

            if not start:
                continue

            # ===========================
            # CREATE
            # ===========================
            if not existing:
                db.add(Event(
                    title=(e["title"] or "Untitled Event")[:255],
                    start_time=start,
                    end_time=end,
                    source=e["source"],
                    externalId=fp,

                    # ✅ CRITICAL FIX
                    external_ids={
                        e["source"]: e["external_id"]
                    },

                    owner_id=user.id
                ))
                created += 1
                continue

            # ===========================
            # UPDATE
            # ===========================
            changed = False

            if existing.title != e["title"]:
                existing.title = e["title"]
                changed = True

            if existing.start_time != start:
                existing.start_time = start
                changed = True

            if existing.end_time != end:
                existing.end_time = end
                changed = True

            # ✅ merge external IDs
            if existing.external_ids:
                existing.external_ids[e["source"]] = e["external_id"]
            else:
                existing.external_ids = {e["source"]: e["external_id"]}

            if changed:
                updated += 1

        # ===========================
        # DELETE (SAFE)
        # ===========================
        db_events = db.query(Event).filter(
            Event.owner_id == user.id
        ).all()

        for ev in db_events:
            if ev.externalId not in incoming_ids:

                if SAFE_DELETE:
                    db.delete(ev)
                    deleted += 1
                else:
                    print(f"⚠️ Skip delete (safe mode): {ev.id}")

        db.commit()

        return {
            "created": created,
            "updated": updated,
            "deleted": deleted,
            "total": len(incoming_ids),
        }

    # ==================================================
    # UTIL
    # ==================================================
    def _parse_datetime(self, value):
        try:
            return datetime.fromisoformat(value)
        except:
            return None

    def _fingerprint(self, e):
        return f"{(e['title'] or '').strip().lower()}|{e['start']}|{e['end']}"

    def _deduplicate(self, events):
        seen = {}
        result = []

        for e in events:
            key = self._fingerprint(e)
            if key not in seen:
                seen[key] = e
                result.append(e)
            else:
                seen[key]["source"] += f",{e['source']}"

        return result

    def _normalize_time(self, value):
        if not value:
            return ""

        try:
            value = value.replace("Z", "")
            dt = datetime.fromisoformat(value)
            return dt.strftime("%Y-%m-%d %H:%M")
        except:
            return value