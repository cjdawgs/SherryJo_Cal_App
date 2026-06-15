
from datetime import datetime, timezone
from dateutil.relativedelta import relativedelta
from sqlalchemy.orm import Session
import requests
from app.routers import events
from app.services.graph_client import GraphClient
from app.services.google_calendar_service import GoogleCalendarService
from app.models import Event
from app.services.external_calendar_service import ExternalCalendarService
from app.services.multi_account_oauth_service import (
    MultiAccountOAuthService,
    ensure_valid_token,
    safe_commit
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

# ==================================================
# 🧠 GOLD STANDARD: CANONICAL PROVIDERS (CORE CONTRACT)
# --------------------------------------------------
# PURPOSE:
# One single provider identity across ENTIRE system
#
# WHY:
# Prevents:
# - "outlook" vs "microsoft" drift
# - broken filters
# - broken sync keys
#
# RULE:
# EVERYTHING must resolve to these values
# ==================================================
CANONICAL_PROVIDERS = ["google", "microsoft", "apple", "local"]

def normalize_provider(p: str) -> str:
    """
    ✅ Canonical provider normalization
    - Handles aliases
    - Handles noise (None, whitespace)
    - Returns ONLY known canonical values
    """

    if not p:
        return "other"

    p = str(p).lower().strip()

    # ✅ MICROSOFT FAMILY
    if p in {"outlook", "office365", "microsoft", "ms", "msft"}:
        return "microsoft"

    # ✅ APPLE FAMILY
    if p in {"icloud", "caldav", "apple", "mac"}:
        return "apple"

    # ✅ GOOGLE FAMILY
    if p in {"google", "gmail"}:
        return "google"

    # ✅ LOCAL EVENTS
    if p in {"local", "internal"}:
        return "local"

    return p


def build_event_id(e: dict) -> str:
    """
    ✅ SINGLE SOURCE OF TRUTH for event identity
    - provider normalized
    - external_id normalized
    """

    provider = normalize_provider(e.get("source"))
    ext_id = str(e.get("external_id", "")).strip()

    return f"{provider}:{ext_id}"

def build_account_key(provider: str, email: str) -> str:
    provider = normalize_provider(provider)
    email = (email or "").lower().strip()
    return f"{provider}:{email}"


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
        
        print("🧠 NORMALIZE INPUT COUNT:",
            len(google_events), "primary |",
            len(ms_events), "ms")

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
            #print("🟦 MS EVENT RAW:", e.get("id"))
            #print("🧪 MS BEFORE:", e)

        # ✅ SINGLE NORMALIZATION PIPELINE (THIS FIXES EVERYTHING)
        for e in all_events:

            # ==================================================
            # 🔬 SURGICAL FIX — PROVIDER NORMALIZATION
            # --------------------------------------------------
            # FORCE ALL EVENTS INTO CANONICAL PROVIDER SPACE
            # ==================================================
            # ==================================================
            # 🔬 SAFE PROVIDER DETECTION (CRITICAL FIX)
            # ==================================================
            raw_provider = (
                e.get("provider")
                or e.get("source")
                or ("microsoft" if "subject" in e else None)
            )

            if not isinstance(raw_provider, str):
                raw_provider = ""

            provider = normalize_provider(raw_provider)

            # ✅ DEBUG (REMOVE LATER)
            #print("🧪 PROVIDER NORMALIZED →", provider)
            
            # ==================================================
            # 🔬 SURGICAL FIX — ACCOUNT EMAIL CONTRACT
            # --------------------------------------------------
            # ALWAYS use account_email (frontend depends on this)
            # ==================================================
            account_email = (
                e.get("account_email")
                or e.get("account")
                or "local"   # ✅ CRITICAL FIX
            ).lower().strip()

            #print("🧪 ACCOUNT NORMALIZED →", account_email)

            start = self._safe_datetime(e.get("start"))
            end = self._safe_datetime(e.get("end"))

            unified.append({
                "external_id": str(e.get("id")),

                "title": (
                    e.get("summary") or
                    e.get("subject") or
                    "Untitled Event"
                ),
                # ==================================================
                # 🔬 SURGICAL FIX — DATE CONSISTENCY
                # --------------------------------------------------
                # ENSURE ALL DATES ARE ISO STRINGS
                # (frontend safeParseDate expects this)
                # ==================================================
                "start": (
                    start.isoformat() if isinstance(start, datetime) else start
                ),
                "end": (
                    end.isoformat() if isinstance(end, datetime) else end
                ),
                # ==================================================
                "source": provider,
                "provider": provider,
                # ✅ REQUIRED BY FRONTEND
                "account_email": account_email,
                # ✅ SINGLE SOURCE KEY
                "account_key": f"{provider}:{account_email}",
                "color": ACCOUNT_COLORS.get(provider, ACCOUNT_COLORS["other"])
            })
            
        sources = [e["source"] for e in unified]

        #print("🚀 FINAL SOURCE BREAKDOWN:",{s: sources.count(s) for s in set(sources)})
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
    
    def get_events_from_db(self, db, user, start_date, end_date):

        events = db.query(Event).filter(
            Event.owner_id == user.id,
            Event.start_time >= start_date,
            Event.start_time <= end_date
        ).all()
        
        return [
            {
                "id": ev.id,
                "external_id": ev.externalId,
                "title": ev.title,
                "start": ev.start_time.isoformat(),
                "end": ev.end_time.isoformat() if ev.end_time else None,

                # ✅ CANONICAL SOURCE
                "source": ev.source or "local",

                # ✅ KEEP FOR LEGACY COMPAT
                "account_email": getattr(ev, "account_email", "local"),

                # ✅ GOLD STANDARD: SINGLE SOURCE OF TRUTH
                "account_key": build_account_key(
                    ev.source or "local",
                    getattr(ev, "account_email", "local")
                )
            }
            for ev in events
        ]
        
    def fetch_all_events(self, db, user, start_date=None, end_date=None):
        """
        ✅ NEW: RANGE-AWARE FETCH
        
        If no range provided → default to FAST monthly window
        """

        google_events = []
        ms_events = []
        apple_events = []


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

            log_info("📦 Using default 90-day range")
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
            
            #/**************************************************************
            #* ✅ SKIP SYSTEM / HOLIDAY CALENDARS (CRITICAL FIX)
            #* MUST RUN BEFORE ANY TOKEN OR API CALL
            #**************************************************************/
            email = (acc.account_email or "").lower()

            if "holiday" in email or "@group.v.calendar.google.com" in email:
                log_info(f"⏭ Skipping system calendar: {email}")
                continue


            #print("🧪 ACCOUNT CHECK:",
            #    acc.provider,
            #    acc.account_email,
            #    acc.access_token)
            # ==================================================
            # ✅ ACCOUNT PROCESSING START
            # ==================================================
            log_info(f"🔄 Processing: {acc.provider} | {acc.account_email}")

            token = ensure_valid_token(db, acc)

            if not token:
                log_error(f"🚫 No token: {acc.account_email}")

                acc.status = "error"

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
                        #/**************************************************************
                        #* ✅ FILTER GOOGLE SYSTEM CALENDARS (REAL FIX)
                        #**************************************************************/
                        calendar_id = (
                            e.get("organizer", {}).get("email") or
                            e.get("creator", {}).get("email") or
                            ""
                        ).lower()

                        if "holiday" in calendar_id or "@group.v.calendar.google.com" in calendar_id:
                            log_debug(f"⏭ Skipping holiday event: {calendar_id}")
                            continue
                        
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
                            
                            # Apple MUST provide account_email or frontend breaks
                            # ==================================================
                            e["account_email"] = acc.account_email
                            e["account"] = acc.account_email  # backward compatibility
                            e["provider"] = "apple"
                            e["source"] = "apple"

                            apple_events.append(e)
                            added += 1

                    log_info(f"   🍎 Apple events in range: {added}")
                    
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

                                "account_email": acc.account_email,

                                # ==================================================
                                # 🔬 SURGICAL FIX — FORCE PROVIDER TAG
                                # ==================================================
                                "provider": "microsoft",
                                "source": "microsoft",
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
        total_apple = len(apple_events)
        total_ms = len(ms_events)

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

        
        #/**************************************************************
        # ✅ MERGE APPLE INTO GOOGLE PIPE (NORMALIZER EXPECTS 2 LISTS)
        # Keep normalize() unchanged (low-risk surgery)
        #*************************************************************/
        combined_primary = google_events + apple_events

        return {
            "events": self._normalize(combined_primary, ms_events),

            "account_status": account_status
        }

    # ==================================================
    # ✅ SYNC ENGINE (FIXED + INSIDE CLASS)
    # ==================================================
    def sync_all(self, db: Session, user):

        result = self.fetch_all_events(db, user)

        events = result.get("events", []) if isinstance(result, dict) else []

        if not isinstance(events, list):
            log_error("❌ Invalid events payload structure")
            return {"created": 0, "updated": 0}
        created = updated = 0

        
        for e in events:

            if not isinstance(e, dict):
                log_debug(f"⚠️ Skipping invalid event: {e}")
                continue

            external_id = build_event_id(e)
            
            # ✅ guard against bad data
            if ":" not in external_id or external_id.endswith(":"):
                continue

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
                    owner_id=user.id,

                    # ✅ CRITICAL — REQUIRED FOR PALETTE MATCHING
                    account_email=e.get("account_email"),

                    # ✅ OPTIONAL BUT POWERFUL (future-proof)
                    color=e.get("color")
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

        # ==================================================
        # ✅ HARD DELETE — REMOVE ORPHANED EVENTS
        # ==================================================
        existing_events = db.query(Event).filter(
            Event.owner_id == user.id
        ).all()

        # build set of valid external IDs from fresh fetch
        incoming_ids = set(
            build_event_id(e)
            for e in events
            if e.get("external_id")
        )

        deleted = 0

        for ev in existing_events:

            ev_source = str(ev.source) if ev.source is not None else None
            ev_external_id = str(ev.externalId) if ev.externalId is not None else None

            # ✅ NEVER DELETE LOCAL EVENTS
            if ev_source == "local":
                continue

            if ev_external_id and ev_external_id not in incoming_ids:
                db.delete(ev)
                deleted += 1

        log_info(f"🗑 Deleted stale external events: {deleted}")
        
        db.commit()

        return {
            "created": created,
            "updated": updated
        }
