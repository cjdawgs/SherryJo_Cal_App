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
    
from datetime import datetime, timedelta, timezone
from typing import List, Dict, Any
import logging

from app.utils import ensure_utc

# Optional dependencies (install if not already present)
try:
    import caldav
except ImportError:
    caldav = None

try:
    import vobject
except ImportError:
    vobject = None

logger = logging.getLogger(__name__)


class ExternalCalendarService:
    """
    Service to fetch events from external providers
    """

    def __init__(self):
        pass
    
    def _extract_vevent(self, event):
        """Return a VEVENT-like object from diverse CalDAV event wrappers."""
        vobj = getattr(event, "vobject_instance", None)
        if callable(vobj):
            try:
                vobj = vobj()
            except Exception:
                vobj = None

        if vobj is not None and hasattr(vobj, "vevent"):
            return vobj.vevent

        # Some backends expose raw ICS text instead of vobject_instance.
        raw_ics = getattr(event, "data", None)
        if isinstance(raw_ics, str) and raw_ics.strip() and vobject is not None:
            try:
                parsed = vobject.readOne(raw_ics)
                if hasattr(parsed, "vevent"):
                    return parsed.vevent
            except Exception as e:
                logger.warning(f"⚠️ Apple ICS parse failed: {e}")

        return None

    # --------------------------------------------------
    # ✅ VALIDATE ICLOUD CREDENTIALS (REQUIRED FIX)
    # --------------------------------------------------
    def validate_icloud_credentials_detailed(
        self,
        url: str,
        username: str,
        password: str
    ):
        """
        Returns (is_valid, message) with actionable diagnostics.
        """

        if caldav is None:
            logger.error("❌ caldav not installed")
            return False, "Server missing caldav dependency"

        if not url or not username or not password:
            return False, "Apple ID email, App Password, and CalDAV URL are required"

        try:
            client = caldav.DAVClient(
                url=url,
                username=username,
                password=password
            )

            principal = client.principal()
            if not principal:
                return False, "No CalDAV principal returned from Apple"

            calendars = principal.calendars() or []
            if not calendars:
                return False, "Authenticated, but no iCloud calendars found (enable Calendar in iCloud settings)"

            logger.info(f"✅ Apple credentials valid: {username}")
            return True, "✅ Connection successful"

        except Exception as e:
            raw = str(e)
            lowered = raw.lower()
            logger.error(f"❌ Apple validation failed: {raw}")

            if "401" in lowered or "unauthorized" in lowered or "invalid credentials" in lowered:
                return False, "Apple rejected credentials (check Apple ID email + App Password)"
            if "403" in lowered or "forbidden" in lowered:
                return False, "Apple access forbidden (verify app-specific password and iCloud Calendar access)"
            if "ssl" in lowered or "certificate" in lowered:
                return False, "SSL/TLS error reaching Apple CalDAV"
            if "timed out" in lowered or "timeout" in lowered:
                return False, "Connection timed out reaching Apple CalDAV"

            return False, f"Apple CalDAV error: {raw}"

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

        ok, _message = self.validate_icloud_credentials_detailed(url, username, password)
        return ok


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

            search_start = datetime.now(timezone.utc) - timedelta(days=90)
            search_end   = datetime.now(timezone.utc) + timedelta(days=90)

            for calendar in calendars:
                try:
                    # Apple can under-return with plain events(); date_search is more reliable.
                    events = calendar.date_search(
                        start=search_start,
                        end=search_end,
                        expand=True
                    )
                except Exception as e:
                    logger.warning(f"⚠️ Apple date_search fallback to events(): {e}")
                    events = calendar.events()

                logger.info(f"🍎 Apple calendar fetch count: {len(events)}")

                skipped_missing_vevent = 0
                skipped_missing_start = 0

                for event in events:
                    try:
                        vevent = self._extract_vevent(event)

                        if not vevent:
                            skipped_missing_vevent += 1
                            continue

                        parsed_start = self._parse_date(getattr(vevent, "dtstart", None))
                        parsed_end = self._parse_date(getattr(vevent, "dtend", None))

                        # ✅ DEBUG (keep for now)
                        #print("🧪 APPLE NORMALIZED:", getattr(vevent, "summary", ""), parsed_start)

                        
                        if not parsed_start:
                            parsed_start = parsed_end  # fallback for some Apple events

                        if not parsed_start:
                            skipped_missing_start += 1
                            continue


                        uid_obj = getattr(vevent, "uid", None)
                        uid = getattr(uid_obj, "value", None) if uid_obj else None

                        summary_obj = getattr(vevent, "summary", None)
                        summary = getattr(summary_obj, "value", summary_obj)

                        description_obj = getattr(vevent, "description", None)
                        description = getattr(description_obj, "value", description_obj)

                        results.append(self._normalize_event({
                            "id": str(uid) if uid else None,
                            "title": str(summary or ""),
                            "start": parsed_start,
                            "end": parsed_end,
                            "description": str(description or ""),
                            "source": "apple"
                        }))

                    except Exception as e:
                        logger.warning(f"Skipping malformed iCloud event: {e}")

                if skipped_missing_vevent:
                    logger.warning(f"⚠️ Apple skipped (missing vevent): {skipped_missing_vevent}")
                if skipped_missing_start:
                    logger.warning(f"⚠️ Apple skipped (missing start): {skipped_missing_start}")

            return results  # ✅ INSIDE try block

        except Exception as e:
            logger.error(f"iCloud fetch failed: {e}")
            return []
        
    @staticmethod
    def fetch_apple_calendar_events(account):
        """
        Bridge from OAuthAccount row → fetch_icloud_events().
        Reads CalDAV URL from access_token and app-password from refresh_token.
        """
        try:
            service = ExternalCalendarService()
            url = account.access_token          # CalDAV URL stored here
            username = account.account_email
            password = account.refresh_token    # App Password stored here

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
        """Normalize caldav/vobject values (native or ``.value`` wrapped) to UTC."""
        if not date_obj:
            return None

        try:
            parsed = ensure_utc(date_obj)
            if parsed is not None:
                return parsed

            return ensure_utc(getattr(date_obj, "value", None))

        except Exception as e:
            logger.warning(f"⚠️ Apple date parse failed for {type(date_obj)}: {e}")
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