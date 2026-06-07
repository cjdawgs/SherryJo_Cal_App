
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

# ==================================================
# ✅ LOGGING SYSTEM (STANDARDIZED - PRODUCTION SAFE)
# ==================================================
import os

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")  # DEBUG | INFO | ERROR


def log_debug(msg: str):
    if LOG_LEVEL == "DEBUG":
        print(f"[DEBUG] {msg}")


def log_info(msg: str):
    print(f"[INFO] {msg}")


def log_error(msg: str):
    print(f"[ERROR] {msg}")

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

        
        # ✅ Preserve original provider if already set (Apple compatibility)
        for e in google_events:
            if not e.get("provider"):
                e["provider"] = "google"
            if not e.get("source"):
                e["source"] = "google"

            all_events.append(e)

        # ✅ Preserve provider/source if already set (future-safe)
        for e in ms_events:
            if not e.get("provider"):
                e["provider"] = "microsoft"
            if not e.get("source"):
                e["source"] = "microsoft"

            all_events.append(e)

        # ✅ SINGLE NORMALIZATION PIPELINE (THIS FIXES EVERYTHING)
        for e in all_events:

            provider = (e.get("provider") or "other").lower()
            account = (e.get("account") or e.get("account_email") or "").lower()


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


        # ==================================================
        # ✅ RANGE INITIALIZATION (STANDARDIZED LOGGING)
        # ==================================================
        now = datetime.now(timezone.utc)

        if not start_date or not end_date:
            
            # ==================================================
            # ✅ FIX: EXPANDED DEFAULT RANGE (USER-REALISTIC)
            # ==================================================
            # ✅ WHY:
            # - 30 days is too narrow for real-world calendars
            # - Apple calendars contain historical + recurring events
            # - Google calendars often sparse outside near-term
            start_date = now - relativedelta(days=90)
            end_date = now + relativedelta(days=90)

            log_info("📦 Using default 30-day range")
        else:
            log_info("📥 Using UI-provided range")

        # ✅ ✅ NORMALIZE ONCE (CRITICAL IMPROVEMENT)
        safe_start = self._ensure_utc(start_date)
        safe_end = self._ensure_utc(end_date)

        # ✅ GET ALL SYNC-ENABLED ACCOUNTS
        accounts = MultiAccountOAuthService.get_all_sync_enabled_accounts(db, user.id)

        # ==================================================
        # ✅ FETCH SUMMARY (CLEAN + READABLE) - Debug
        # ==================================================

        log_info(f"📅 Fetch window: {safe_start.date()} → {safe_end.date()}")
        log_info(f"👤 Accounts found: {len(accounts)}")


        for acc in accounts:

            print("🧪 ACCOUNT CHECK:",
                acc.provider,
                acc.account_email,
                acc.access_token)
            # ==================================================
            # ✅ ACCOUNT PROCESSING START
            # ==================================================
            log_info(f"🔄 Processing: {acc.provider} | {acc.account_email}")

            token = ensure_valid_token(db, acc)

            if not token:
                print("🚫 Skipping (no token):", acc.account_email)

                # ✅ FORCE ERROR STATE (keeps UI + backend in sync)
                acc.status = "error"
                db.commit()

                continue
                # ✅ 🔴 THIS IS THE MISSING PIECE
                if hasattr(acc, "status") and acc.status != "error":
                    acc.status = "error"
                    from app.services.multi_account_oauth_service import safe_commit
                    safe_commit(db)

                continue

            try:
                # ==================================================
                # ✅ PROVIDER ROUTING (FAIL SAFE)
                # ==================================================
                if acc.provider not in ["google", "apple", "microsoft"]:
                    log_error(f"Unknown provider: {acc.provider}")
                    continue
                
                # ==================================================
                # ✅ GOOGLE FETCH + FILTER
                # ==================================================
                if acc.provider == "google":

                    events = self.google.fetch_events(
                    access_token=token,
                    account_email=acc.account_email,
                    start_date=start_date,
                    end_date=end_date
                ) or []

                    log_debug(f"Google raw count: {len(events)}")

                    added = 0

                    for e in events:
                        start_val = (
                            e.get("start", {}).get("dateTime")
                            or e.get("start", {}).get("date")
                        )

                        dt = self._to_utc(start_val)
                        dt = self._ensure_utc(dt)

                        if not dt:
                            continue

                        #if safe_start <= dt <= safe_end:
                        # ==================================================
                        # ✅ FIX: ENSURE GOOGLE EVENTS HAVE PROVIDER METADATA
                        # ==================================================
                        # ✅ WHY:
                        # - Summary + normalization depend on provider/source
                        # - Without this → events counted as "other"

                        #if safe_start <= dt <= safe_end:
                        if True:
                            e["account"] = acc.account_email
                            e["account_email"] = acc.account_email  # ✅ CRITICAL
                            # ✅ CRITICAL FIX
                            e["provider"] = "google"
                            e["source"] = "google"

                            google_events.append(e)
                            added += 1

                    log_info(f"   🟢 Google events in range: {added}")
                    
                    # ==================================================
                    # ✅ GOOGLE DEBUG VISIBILITY
                    # ==================================================
                    log_info(f"🟢 Google RAW fetched: {len(events)}")


                # ==================================================
                # ✅ APPLE FETCH + FILTER (CALDAV)
                #   ✅ Phase 1 Apple support
                #   ✅ Safe: does not break pipeline
                #   ✅ Reuses normalization system
                # ==================================================
                elif acc.provider == "apple":

                    from app.services.external_calendar_service import ExternalCalendarService
                    events = ExternalCalendarService.fetch_apple_calendar_events(acc) or []
                    log_debug(f"Apple raw count: {len(events)}")
                    added = 0
                    
                    # ✅ WHY:
                    # Apple data spans MANY years and is not "window-based"

                    apple_start = datetime(1900, 1, 1, tzinfo=timezone.utc)
                    apple_end = datetime(2100, 1, 1, tzinfo=timezone.utc)

                    for e in events:
                        
                        # ==================================================
                        # ✅ FIX: ROBUST APPLE DATETIME HANDLING
                        # ==================================================
                        # ✅ WHY:
                        # Apple events may already be datetime OR string
                        # We must safely handle both without losing data

                        dt = e.get("start")

                        # ✅ Case 1: already datetime → just normalize
                        if isinstance(dt, datetime):
                            dt = self._ensure_utc(dt)

                        # ✅ Case 2: string → convert
                        elif isinstance(dt, str):
                            dt = self._to_utc(dt)

                        # ✅ Invalid case
                        else:
                            log_debug(f"Skipped Apple event (invalid start): {dt}")
                            continue

                        # ✅ Final safety check
                        if not dt:
                            log_debug("Skipped Apple event after conversion (None)")
                            continue

                        log_debug(f"✅ Apple dt parsed: {dt}")
                        
                        if apple_start <= dt <= apple_end:
                            e["account"] = acc.account_email
                            e["provider"] = "apple"
                            e["source"] = "apple"

                            google_events.append(e)
                            added += 1

                    log_info(f"   🍎 Apple events in range: {added}")
                    log_debug(f"Apple raw start type: {type(e.get('start'))}")

                # ==================================================
                # ✅ MICROSOFT FETCH + PAGINATION
                # ==================================================

                elif acc.provider == "microsoft":
                    url = "https://graph.microsoft.com/v1.0/me/calendarView"
                    params = {
                        "startDateTime": start_date.isoformat().replace("+00:00", "Z"),
                        "endDateTime": end_date.isoformat().replace("+00:00", "Z")
                    }
                    events = []

                    
                    # ✅ PAGINATED FETCH
                    while url:

                        res = requests.get(
                            url,
                            headers={"Authorization": f"Bearer {token}"},
                            params=params
                        )

                        log_debug(f"MS status: {res.status_code}")

                        if res.status_code != 200:
                            log_error(f"Microsoft API error: {res.status_code}")
                            break

                        data = res.json()

                        batch = data.get("value", [])
                        events.extend(batch)

                        url = data.get("@odata.nextLink")
                        params = None

                    
                    log_debug(f"Microsoft raw events: {len(events)}")

                    # ==================================================
                    # ✅ MICROSOFT DATE NORMALIZATION + FILTER
                    # ==================================================
                    added = 0
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
                                log_debug(f"MS start parse error: {err}")

                        if not dt:
                            continue

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
                                    log_debug(f"MS end parse error: {err}")

                            ms_events.append({
                                "id": e.get("id"),
                                "subject": e.get("subject"),
                                "start": dt.isoformat(),
                                "end": end_dt.isoformat() if end_dt else None,
                                "account_email": acc.account_email,  # ✅ CRITICAL FIX
                            
                            })
                            added += 1
                    log_info(f"   🟦 Microsoft events in range: {added}")

            # ==================================================
            # ✅ ACCOUNT ERROR HANDLING (STANDARDIZED)
            # ==================================================
            except Exception as e:
                log_error(f"Account failed ({acc.account_email}): {e}")
                continue

        
        # ==================================================
        # ✅ FINAL FETCH SUMMARY (PROVIDER-AWARE)
        # ==================================================

        total_google = len([e for e in google_events if e.get("source") == "google"])
        total_apple  = len([e for e in google_events if e.get("source") == "apple"])
        total_ms     = len(ms_events)

        total = total_google + total_apple + total_ms

        log_info("✅ Fetch complete")
        log_info(f"📊 Google: {total_google}")
        log_info(f"📊 Apple:  {total_apple}")
        log_info(f"📊 MSFT:   {total_ms}")
        log_info(f"📊 TOTAL:  {total}")

        accounts = MultiAccountOAuthService.get_user_accounts(db, user.id)

        account_status = {
            f"{acc.provider}:{(acc.account_email or '').lower().strip()}": getattr(acc, "status", "ok")
            for acc in accounts
        }

        return {
            "events": self._normalize(google_events, ms_events),
            "account_status": account_status
        }

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
