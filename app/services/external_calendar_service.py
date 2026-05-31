"""
External Calendar Integration Service
------------------------------------
Supports:
- Apple iCloud (CalDAV)
- Google Calendar (via existing graph_client-style pattern if extended)

SAFE DESIGN:
- Does NOT modify existing models
- Returns normalized event objects for internal use
- Can be plugged into routers/services later
"""
    
from datetime import datetime, timezone
from typing import List, Dict, Any
import logging

# Optional dependencies (install if not already present)
try:
    import caldav
except ImportError:
    caldav = None

logger = logging.getLogger(__name__)


class ExternalCalendarService:
    """
    Service to fetch events from external providers
    """

    def __init__(self):
        pass
    
    # --------------------------------------------------
    # ✅ VALIDATE ICLOUD CREDENTIALS (REQUIRED FIX)
    # --------------------------------------------------
    def validate_icloud_credentials(
        self,
        url: str,
        username: str,
        password: str
    ) -> bool:
        """
        ✅ PURPOSE:
        Validate Apple credentials BEFORE saving

        ✅ CRITICAL RULES:
        - MUST NEVER raise exception
        - MUST return True / False only
        - MUST be lightweight (no event fetch)
        """

        if caldav is None:
            logger.error("❌ caldav not installed")
            return False

        try:
            client = caldav.DAVClient(
                url=url,
                username=username,
                password=password
            )

            # ✅ LIGHTWEIGHT check (NO events)
            principal = client.principal()

            if not principal:
                logger.warning("❌ No principal returned")
                return False

            logger.info(f"✅ Apple credentials valid: {username}")
            return True

        except Exception as e:
            # ✅ NEVER crash API
            logger.error(f"❌ Apple validation failed: {e}")
            return False


    # --------------------------------------------------
    # ICLOUD / CALDAV
    # --------------------------------------------------
    def fetch_icloud_events(
        self,
        url: str,
        username: str,
        password: str
    ) -> List[Dict[str, Any]]:

        if caldav is None:
            raise ImportError("caldav package is not installed")

        try:
            client = caldav.DAVClient(
                url=url,
                username=username,
                password=password
            )

            principal = client.principal()
            calendars = principal.calendars()

            results = []

            for calendar in calendars:
                events = calendar.events()

                for event in events:
                    try:
                        vobj = getattr(event, "vobject_instance", None)

                        if not vobj or not hasattr(vobj, "vevent"):
                            logger.warning("⚠️ Skipping event (no vevent)")
                            continue

                        vevent = vobj.vevent

                        parsed_start = self._parse_date(getattr(vevent, "dtstart", None))
                        parsed_end = self._parse_date(getattr(vevent, "dtend", None))

                        # ✅ DEBUG (keep for now)
                        print("🧪 APPLE NORMALIZED:", getattr(vevent, "summary", ""), parsed_start)

                        
                        if not parsed_start:
                            parsed_start = parsed_end  # fallback for some Apple events

                        if not parsed_start:
                            continue


                        results.append(self._normalize_event({
                            "title": str(getattr(vevent, "summary", "")).replace("<SUMMARY{}", "").replace(">", ""),
                            "start": parsed_start,
                            "end": parsed_end,
                            "description": str(getattr(vevent, "description", "")),
                            "source": "apple"
                        }))

                    except Exception as e:
                        logger.warning(f"Skipping malformed iCloud event: {e}")

            return results  # ✅ INSIDE try block

        except Exception as e:
            logger.error(f"iCloud fetch failed: {e}")
            return []
        
    # --------------------------------------------------
    # APPLE (PLACEHOLDER FOR YOUR IMPLEMENTATION)
    # --------------------------------------------------
    @staticmethod
    def fetch_apple_calendar_events(account):
        """
        ✅ Apple → iCloud bridge
        ✅ Uses existing CalDAV implementation
        ✅ Minimal, safe integration
        """

        try:
            service = ExternalCalendarService()

            # ✅ You will need these fields on account
            # ✅ FIX: use stored credentials correctly
            url = account.access_token          # caldav_url
            username = account.account_email
            password = account.refresh_token    # app_password


            # ✅ SAFETY: do not break pipeline
            if not url or not username or not password:
                logger.warning("⚠️ Apple account missing CalDAV credentials")
                return []

            return service.fetch_icloud_events(
                url=url,
                username=username,
                password=password
            )
            
            
        except Exception as e:
            logger.error(f"❌ Apple calendar fetch failed: {e}")
            return []
    
    # --------------------------------------------------
    # GOOGLE (PLACEHOLDER FOR YOUR IMPLEMENTATION)
    # --------------------------------------------------
    def fetch_google_events(
        self,
        access_token: str
    ) -> List[Dict[str, Any]]:
        """
        Fetch Google calendar events

        NOTE:
        Your project already has graph_client.py.
        You can mirror its pattern for Google API calls.

        This function is intentionally safe + non-breaking.
        """

        # Placeholder design — integrate later with Google API
        logger.info("Google Calendar fetch not yet fully implemented")

        return []

    # --------------------------------------------------
    # NORMALIZATION
    # --------------------------------------------------
    def _normalize_event(self, raw: Dict[str, Any]) -> Dict[str, Any]:
        """
        ✅ Convert external event → format expected by CalendarService

        ⚠️ CRITICAL:
        CalendarService expects:
        - summary
        - start
        - end
        - id

        NOT:
        - title
        - start_time
        """

        return {
            # ✅ Provide stable ID (fallback if missing)
            "id": raw.get("id", f"apple-{hash(str(raw))}"),

            # ✅ MATCH Google/Microsoft field
            "summary": raw.get("title", ""),
            "subject": raw.get("title", ""),

            # ✅ Keep optional metadata
            "description": raw.get("description", ""),

            # ✅ CRITICAL FIX — match pipeline expectations
            "start": raw.get("start"),
            "end": raw.get("end"),

            # ✅ REQUIRED downstream
            "source": raw.get("source", "external"),
        }


    def _parse_date(self, date_obj):
        if not date_obj:
            return None

        try:
            value = date_obj.value

            # ✅ CASE 1: datetime (normal timed events)
            if isinstance(value, datetime):
                if value.tzinfo is None:
                    value = value.replace(tzinfo=timezone.utc)
                else:
                    value = value.astimezone(timezone.utc)
                return value

            # ✅ CASE 2: date (ALL-DAY events — VERY COMMON IN APPLE)
            if hasattr(value, "year") and hasattr(value, "month") and hasattr(value, "day"):
                return datetime(
                    value.year,
                    value.month,
                    value.day,
                    0, 0, 0,
                    tzinfo=timezone.utc
                )

            return None

        except Exception:
            return None


# --------------------------------------------------
# OPTIONAL: MERGE + IMPORT HELPER
# --------------------------------------------------

def merge_external_events(*event_lists):
    result = []

    for lst in event_lists:
        if not lst:
            continue
        result.extend(lst)

    return result


# --------------------------------------------------
# FUTURE SAFE HOOK
# --------------------------------------------------
def import_into_internal(events: List[Dict[str, Any]]):
    """
    Stub for importing into your DB later

    IMPORTANT:
    - Does NOT write to DB yet (avoids breaking current system)
    - Wire this into your existing Event model/service

    Example future use:
        from app.models.event_model import Event
        db.add(...)
    """

    logger.info(f"{len(events)} events ready for import")