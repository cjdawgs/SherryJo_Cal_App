
from datetime import datetime, timezone
from dateutil.relativedelta import relativedelta
from sqlalchemy.orm import Session
import requests
from app.routers import events
from app.services.graph_client import GraphClient
from app.services.google_calendar_service import GoogleCalendarService
from app.models import Event
from app.services.multi_account_oauth_service import (
    MultiAccountOAuthService,
    ensure_valid_token
)
import pytz

SAFE_DELETE = False

ACCOUNT_COLORS = {
    "google": "#1f9d55",
    "microsoft": "#1d4ed8",
    "apple": "#ef4444",
    "other": "#eab308"  
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

            return self._ensure_utc(dt)


        except Exception:
            return None


    def _safe_datetime(self, val):
        if isinstance(val, dict):
            return val.get("dateTime") or val.get("date")
        return val

    # ==================================================
    # ✅ NORMALIZATION
    # ==================================================
    def _normalize(self, google_events, ms_events):
        unified = []

        # ✅ combine everything FIRST
        all_events = []

        for e in google_events:
            e["provider"] = "google"
            e["source"] = "google"
            all_events.append(e)

        for e in ms_events:
            e["provider"] = "microsoft"
            e["source"] = "microsoft"
            all_events.append(e)

        # ✅ SINGLE NORMALIZATION PIPELINE (THIS FIXES EVERYTHING)
        for e in all_events:

            provider = (e.get("provider") or "other").lower()
            account = (e.get("account") or "").lower()

            start = self._safe_datetime(e.get("start"))
            end = self._safe_datetime(e.get("end"))

            unified.append({
                "external_id": e.get("id"),

                "title": (
                    e.get("summary") or
                    e.get("subject") or
                    "Untitled Event"
                ),

                "start": start,
                "end": end,

                "source": provider,
                "provider": provider,

                "account": account,
                "account_key": f"{provider}:{account}",

                "color": ACCOUNT_COLORS.get(provider, ACCOUNT_COLORS["other"])
            })

        return unified

    # ==================================================
    # ✅ ENSURE UTC (FINAL FIX - CORRECT)
    # ==================================================
    def _ensure_utc(self, dt):
        """
        ✅ Ensures datetime is always timezone-aware (UTC)

        - None → stays None
        - naive datetime → converted to UTC
        - aware datetime → unchanged
        """

        if not dt:
            return None

        # ✅ Convert naive → UTC
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)

        return dt

    # ==================================================
    # ✅ FETCH EVENTS (FIXED)
    # ==================================================
    @staticmethod

    def map_ms_tz(tz_name):
        if not tz_name:
            return pytz.utc

        if "Eastern" in tz_name:
            return pytz.timezone("US/Eastern")
        if "Central" in tz_name:
            return pytz.timezone("US/Central")
        if "Mountain" in tz_name:
            return pytz.timezone("US/Mountain")
        if "Pacific" in tz_name:
            return pytz.timezone("US/Pacific")

        return pytz.utc
    def fetch_all_events(self, db, user, start_date=None, end_date=None):
        """
        ✅ NEW: RANGE-AWARE FETCH
        
        If no range provided → default to FAST monthly window
        """

        google_events = []
        ms_events = []

        now = datetime.now(timezone.utc)

        # ✅ ENSURE RANGE EXISTS
        if not start_date or not end_date:
            start_date = now - relativedelta(days=30)
            end_date = now + relativedelta(days=30)
            print("⚡ Using DEFAULT 30-day window")
        else:
            print("✅ Using UI-provided range")

        # ✅ ✅ NORMALIZE ONCE (CRITICAL IMPROVEMENT)
        safe_start = self._ensure_utc(start_date)
        safe_end = self._ensure_utc(end_date)

        print(f"✅ Fetch window: {safe_start} → {safe_end}")


        # ✅ GET ALL SYNC-ENABLED ACCOUNTS
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
                        end_date=end_date
                    ) or []

                    print(f"✅ Google returned: {len(events)}")

                    for e in events:
                        start_val = (
                            e.get("start", {}).get("dateTime")
                            or e.get("start", {}).get("date")
                        )

                        dt = self._to_utc(start_val)
                        dt = self._ensure_utc(dt)

                        if not dt:
                            continue

                        # ✅ CLEAN SAFE COMPARISON
                        if safe_start <= dt <= safe_end:
                            e["account"] = acc.account_email
                            google_events.append(e)

                    print(f"✅ Google added: {len(google_events)}")
                    
                # ========================
                # APPLE (SURGICAL ADD ✅)
                # ========================
                elif acc.provider == "apple":

                    """
                    ✅ Phase 1 Apple support
                    ✅ Safe: does not break pipeline
                    ✅ Reuses normalization system
                    """

                    try:
                        from app.services.external_calendar_service import ExternalCalendarService

                        events = ExternalCalendarService.fetch_apple_calendar_events(acc) or []

                        print(f"✅ Apple returned: {len(events)}")

                        for e in events:
                            start_val = e.get("start")

                            dt = self._to_utc(start_val)
                            dt = self._ensure_utc(dt)

                            if not dt:
                                continue

                            if safe_start <= dt <= safe_end:
                                e["account"] = acc.account_email
                                e["provider"] = "apple"
                                e["source"] = "apple"

                                # ✅ IMPORTANT: reuse existing pipeline
                                google_events.append(e)

                        print(f"✅ Apple added: {len(google_events)}")

                    except Exception as err:
                        print(f"❌ Apple sync failed: {err}")

                # ========================
                # MICROSOFT
                # ========================
                elif acc.provider == "microsoft":

                    url = "https://graph.microsoft.com/v1.0/me/calendarView"

                    params = {
                        "startDateTime": start_date.isoformat().replace("+00:00", "Z"),
                        "endDateTime": end_date.isoformat().replace("+00:00", "Z")
                    }

                    events = []

                    while url:
                        res = requests.get(
                            url,
                            headers={"Authorization": f"Bearer {token}"},
                            params=params
                        )

                        print("🔐 MS STATUS:", res.status_code)

                        if res.status_code != 200:
                            print("❌ MS ERROR:", res.text)
                            break

                        data = res.json()

                        batch = data.get("value", [])
                        events.extend(batch)

                        url = data.get("@odata.nextLink")
                        params = None

                    print(f"✅ Microsoft expanded instances: {len(events)}")

                    for e in events:
                        start_obj = e.get("start", {})
                        dt_str = start_obj.get("dateTime")
                        tz_name = start_obj.get("timeZone")

                        dt = None

                        if dt_str:
                            try:
                                dt_naive = datetime.fromisoformat(dt_str)

                                if tz_name:
                                    tz = self.map_ms_tz(tz_name)
                                    
                                    dt = tz.localize(dt_naive).astimezone(timezone.utc)
                                else:
                                    dt = dt_naive.replace(tzinfo=timezone.utc)

                            except Exception as err:
                                print("❌ TZ PARSE ERROR:", err)

                        if not dt:
                            continue

                        print("🧪 CHECK:", dt, "| RANGE:", safe_start, safe_end)

                        if safe_start <= dt <= safe_end:

                            end_obj = e.get("end", {})
                            end_str = end_obj.get("dateTime")
                            end_tz = end_obj.get("timeZone")

                            end_dt = None

                            if end_str:
                                try:
                                    end_naive = datetime.fromisoformat(end_str)

                                    if end_tz:
                                        tz = self.map_ms_tz(end_tz)

                                        try:
                                            end_dt = tz.localize(end_naive).astimezone(timezone.utc)
                                        except:
                                            end_dt = end_naive.replace(tzinfo=timezone.utc)

                                    else:
                                        end_dt = end_naive.replace(tzinfo=timezone.utc)

                                except Exception as err:
                                    print("❌ END TZ ERROR:", err)

                            ms_events.append({
                                "id": e.get("id"),
                                "subject": e.get("subject"),
                                "start": dt.isoformat(),
                                "end": end_dt.isoformat() if end_dt else None,
                                "account": acc.account_email
                            })

                    print(f"✅ FINAL MICROSOFT EVENTS: {len(ms_events)}")
                    print("🔵 MICROSOFT SAMPLE:", ms_events[:2])

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
