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

from datetime import datetime
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
    # ICLOUD / CALDAV
    # --------------------------------------------------
    def fetch_icloud_events(
        self,
        url: str,
        username: str,
        password: str
    ) -> List[Dict[str, Any]]:
        """
        Fetch events from iCloud via CalDAV

        Args:
            url: CalDAV URL (iCloud endpoint)
            username: Apple ID email
            password: App-specific password

        Returns:
            Normalized event list
        """

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
                        vevent = event.vobject_instance.vevent

                        results.append(self._normalize_event({
                            "title": str(getattr(vevent, "summary", "")),
                            "start": self._parse_date(getattr(vevent, "dtstart", None)),
                            "end": self._parse_date(getattr(vevent, "dtend", None)),
                            "description": str(getattr(vevent, "description", "")),
                            "source": "icloud"
                        }))

                    except Exception as e:
                        logger.warning(f"Skipping malformed iCloud event: {e}")

            return results

        except Exception as e:
            logger.error(f"iCloud fetch failed: {e}")
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
        Convert external event into internal schema-compatible dict
        """

        return {
            "title": raw.get("title", ""),
            "description": raw.get("description", ""),
            "start_time": raw.get("start"),
            "end_time": raw.get("end"),
            "source": raw.get("source", "external"),
            "created_at": datetime.utcnow()
        }

    def _parse_date(self, date_obj):
        """
        Safely parse CalDAV date formats
        """
        if not date_obj:
            return None

        try:
            return date_obj.value
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