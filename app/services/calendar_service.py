

import logging
from datetime import datetime, timezone, timedelta

import hashlib

from concurrent.futures import ThreadPoolExecutor, as_completed

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

    safe_commit,

    resolve_account_status,

    normalize_provider,

)

from app.utils import ensure_utc, parse_iso_datetime


import pytz

logger = logging.getLogger(__name__)



SAFE_DELETE = False



ACCOUNT_COLORS = {

    "google": "#1f9d55",

    "microsoft": "#1d4ed8",

    "apple": "#ef4444",

    "other": "#eab308"  

}



# ==================================================

# âœ… LOGGING SYSTEM (STANDARDIZED - PRODUCTION SAFE)

# ==================================================

import os






CANONICAL_PROVIDERS = ["google", "microsoft", "apple", "local"]





def build_event_id(e: dict) -> str:

    """

    âœ… SINGLE SOURCE OF TRUTH for event identity

    - provider normalized

    - external_id normalized

    - account_email normalized (prevents cross-account collisions)

    """



    provider = normalize_provider(e.get("source"))

    ext_id = str(e.get("external_id", "")).strip()

    account_email = str(e.get("account_email", "")).lower().strip()



    return f"{provider}:{account_email}:{ext_id}"



def build_account_key(provider: str, email: str) -> str:

    provider = normalize_provider(provider)

    email = (email or "").lower().strip()

    return f"{provider}:{email}"





def build_fallback_external_id(provider: str, account_email: str, title: str, start_val) -> str:

    """Build a stable fallback ID when provider payload omits event ID."""

    safe_provider = normalize_provider(provider)

    safe_account = (account_email or "").lower().strip()

    safe_title = (title or "Untitled Event").strip()



    if isinstance(start_val, datetime):

        if start_val.tzinfo is None:

            safe_start = start_val.replace(tzinfo=timezone.utc).isoformat()

        else:

            safe_start = start_val.astimezone(timezone.utc).isoformat()

    else:

        safe_start = str(start_val or "")



    return f"fb:{safe_provider}:{safe_account}:{safe_title}:{safe_start}"





def log_debug(msg: str):

    logger.debug("%s", msg)





def log_info(msg: str):

    logger.info("%s", msg)





def log_error(msg: str):

    logger.error("%s", msg)





# ==================================================

# âœ… PURE HTTP FETCH â€” thread-safe, no DB access

# Called from ThreadPoolExecutor in fetch_all_events.

# ==================================================

class ProviderAuthorizationError(RuntimeError):
    pass


def _fetch_account_http(config: dict, start_date, end_date) -> dict:

    """

    Fetch events for ONE account via its provider API.

    Receives a pre-built config dict (no SQLAlchemy session).

    Returns a result dict consumed by fetch_all_events Phase 3.

    """

    provider       = config["provider"]

    account_email  = config["account_email"]

    token          = config["token"]

    sync_state     = config.get("sync_token_state") or {}



    result = {

        "acc_id":           config["acc_id"],

        "provider":         provider,

        "account_email":    account_email,

        "events":           [],

        "cancelled_ids":    [],

        "new_sync_tokens":  {},

        "used_incremental": False,

        "raw_count":        0,

        "error":            None,

        "reauth_required":  False,

    }



    try:

        if provider == "google":

            _gcs = GoogleCalendarService()

            fetch_result = _gcs.fetch_events_v2(

                access_token=token,

                account_email=account_email,

                start_date=start_date,

                end_date=end_date,

                sync_token_state=sync_state,

            )

            raw_events          = fetch_result["events"]

            result["cancelled_ids"]    = fetch_result["cancelled_ids"]

            result["new_sync_tokens"]  = fetch_result["next_tokens"]

            result["used_incremental"] = fetch_result["used_incremental"]

            result["raw_count"]        = len(raw_events) + len(fetch_result["cancelled_ids"])



            # Tag events with account metadata

            for e in raw_events:

                calendar_id = (

                    (e.get("organizer") or {}).get("email") or

                    (e.get("creator")   or {}).get("email") or ""

                ).lower()

                if "holiday" in calendar_id or "@group.v.calendar.google.com" in calendar_id:

                    continue

                e["account_email"] = account_email

                e["account"]       = account_email

                e["provider"]      = "google"

                e["source"]        = "google"

                result["events"].append(e)



        elif provider == "apple":

            # Apple CalDAV â€” no incremental support

            from app.services.external_calendar_service import ExternalCalendarService as _ECS



            class _FakeAcc:

                def __init__(self, cfg):

                    self.access_token  = cfg["caldav_url"]

                    self.account_email = cfg["account_email"]

                    self.refresh_token = cfg["app_password"]



            raw_events = _ECS.fetch_apple_calendar_events(_FakeAcc(config)) or []

            result["raw_count"] = len(raw_events)



            apple_start = start_date or datetime(1900, 1, 1, tzinfo=timezone.utc)

            apple_end   = end_date   or datetime(2100, 1, 1, tzinfo=timezone.utc)



            for e in raw_events:

                dt = ensure_utc(e.get("start"))

                if dt is None:

                    continue



                if not (apple_start <= dt <= apple_end):

                    continue



                e["account_email"] = account_email

                e["account"]       = account_email

                e["provider"]      = "apple"

                e["source"]        = "apple"

                result["events"].append(e)



        elif provider == "microsoft":

            delta_link = sync_state.get("delta_link")

            ms_events, new_delta_link, cancelled = _fetch_ms_incremental(

                token=token,

                start_date=start_date,

                end_date=end_date,

                delta_link=delta_link,

            )

            result["raw_count"]        = len(ms_events) + len(cancelled)

            result["cancelled_ids"]    = cancelled

            result["new_sync_tokens"]  = {"delta_link": new_delta_link} if new_delta_link else {}

            result["used_incremental"] = bool(delta_link)

            result["events"]           = ms_events



    except ProviderAuthorizationError as exc:

        result["error"] = str(exc)

        result["reauth_required"] = True

    except Exception as exc:

        result["error"] = str(exc)



    return result





def _fetch_ms_incremental(token: str, start_date, end_date, delta_link: str = None):

    """

    Microsoft Graph calendarView with optional delta-link for incremental sync.

    Returns (events_list, new_delta_link, cancelled_ids_list).

    Falls back to full fetch when delta_link is missing or returns an error.

    """

    REQUEST_TIMEOUT = (5, 20)

    headers = {"Authorization": f"Bearer {token}"}

    events = []

    cancelled_ids = []

    new_delta_link = None



    def _full_fetch():

        url = "https://graph.microsoft.com/v1.0/me/calendarView/delta"

        params = {

            "startDateTime": start_date.isoformat().replace("+00:00", "Z") if start_date else None,

            "endDateTime":   end_date.isoformat().replace("+00:00", "Z")   if end_date   else None,

        }

        params = {k: v for k, v in params.items() if v}

        return url, params



    if delta_link:

        fetch_url, fetch_params = delta_link, None

    else:

        fetch_url, fetch_params = _full_fetch()



    retry_full = False

    while fetch_url:

        resp = requests.get(

            fetch_url,

            headers=headers,

            params=fetch_params if fetch_params else None,

            timeout=REQUEST_TIMEOUT,

        )

        fetch_params = None  # params only on first request



        if resp.status_code in (410, 400) and delta_link and not retry_full:

            # Delta link expired â€” fall back to full fetch

            fetch_url, fetch_params = _full_fetch()

            delta_link = None

            retry_full = True

            events = []

            cancelled_ids = []

            continue



        if resp.status_code != 200:

            try:

                error_payload = resp.json() or {}

            except Exception:

                error_payload = {}

            graph_error = error_payload.get("error") or {}

            error_code = graph_error.get("code") or f"HTTP {resp.status_code}"

            error_message = graph_error.get("message") or resp.text or "Microsoft Graph request failed"

            if resp.status_code in (401, 403):

                raise ProviderAuthorizationError(f"{error_code}: {error_message}")

            raise RuntimeError(f"Microsoft Graph {error_code}: {error_message}")



        data = resp.json()

        for item in data.get("value", []):

            if item.get("@removed"):

                raw_id = item.get("id")

                if raw_id:

                    cancelled_ids.append(raw_id)

            else:

                # Normalise MS event format expected downstream

                start_obj = item.get("start", {})

                end_obj   = item.get("end", {})

                dt_str    = start_obj.get("dateTime")

                tz_name   = start_obj.get("timeZone")

                if not dt_str:

                    continue

                try:

                    import pytz as _pytz

                    dt_naive = datetime.fromisoformat(dt_str)

                    if tz_name:

                        def _map(n):

                            if "Eastern"  in n: return _pytz.timezone("US/Eastern")

                            if "Central"  in n: return _pytz.timezone("US/Central")

                            if "Mountain" in n: return _pytz.timezone("US/Mountain")

                            if "Pacific"  in n: return _pytz.timezone("US/Pacific")

                            return _pytz.utc

                        dt = _map(tz_name).localize(dt_naive).astimezone(timezone.utc)

                    else:

                        dt = dt_naive.replace(tzinfo=timezone.utc)



                    end_dt = None

                    end_str = end_obj.get("dateTime")

                    if end_str:

                        end_naive = datetime.fromisoformat(end_str)

                        end_tz = end_obj.get("timeZone")

                        end_dt = (_map(end_tz).localize(end_naive).astimezone(timezone.utc)

                                  if end_tz else end_naive.replace(tzinfo=timezone.utc))

                except Exception:

                    continue



                events.append({

                    "id":            item.get("id"),

                    "subject":       item.get("subject"),

                    "start":         dt.isoformat(),

                    "end":           end_dt.isoformat() if end_dt else None,

                    "account_email": "",   # filled in by caller

                    "provider":      "microsoft",

                    "source":        "microsoft",

                })



        next_link  = data.get("@odata.nextLink")

        delta_out  = data.get("@odata.deltaLink")

        if delta_out:

            new_delta_link = delta_out

        fetch_url = next_link  # None when done



    return events, new_delta_link, cancelled_ids



class CalendarService:

    REQUEST_TIMEOUT = (5, 20)



    def __init__(self):

        self.graph = GraphClient()

        self.google = GoogleCalendarService()

    @staticmethod
    def is_all_day_span(start_value, end_value) -> bool:
        if not start_value or not end_value:
            return False

        start_naive = start_value.replace(tzinfo=None)
        end_naive = end_value.replace(tzinfo=None)

        return (
            start_naive.hour == 0 and start_naive.minute == 0 and start_naive.second == 0 and
            end_naive.hour == 0 and end_naive.minute == 0 and end_naive.second == 0 and
            end_naive >= start_naive and
            (end_naive - start_naive) <= timedelta(days=1)
        )

    @staticmethod
    def serialize_event_datetime(value, start_value=None, end_value=None):
        if not value:
            return None

        if isinstance(value, str):
            return value

        is_all_day = CalendarService.is_all_day_span(start_value, end_value)

        if value.tzinfo is None:
            if is_all_day:
                return value.isoformat()
            # Timed provider events are stored as naive UTC in SQLite; emit
            # explicit UTC offset so the browser renders local wall time.
            value = value.replace(tzinfo=timezone.utc)

        if is_all_day:
            # Keep all-day events anchored to wall-date across backends.
            # For aware values (typical in Postgres), normalize to UTC,
            # then emit a tz-free ISO midnight-style string.
            return value.astimezone(timezone.utc).replace(tzinfo=None).isoformat()

        return value.astimezone(timezone.utc).isoformat()



    # ==================================================

    # âœ… TIME SAFETY (CRITICAL FIX)

    # ==================================================

    def _to_utc(self, dt_str):

        """

        âœ… Always return UTC-aware datetime

        """

        return parse_iso_datetime(dt_str)





    def _safe_datetime(self, val):

        if isinstance(val, dict):

            return val.get("dateTime") or val.get("date")

        return val



    def _normalize_time(self, value):

        """

        Legacy helper kept for test/backward compatibility.

        """

        if value is None:

            return ""



        text = str(value).strip()

        if not text:

            return ""



        if text.endswith("Z"):

            text = text[:-1] + "+00:00"



        try:

            dt = datetime.fromisoformat(text)

            return dt.strftime("%Y-%m-%d %H:%M")

        except Exception:

            # date-only fallback and non-ISO safety

            return text.replace("T", " ")[:16] if "T" in text else text



    def _fingerprint(self, event: dict) -> str:

        """

        Legacy dedupe fingerprint used by historical tests.

        """

        title = str((event or {}).get("title") or "").strip().lower()

        start = self._normalize_time((event or {}).get("start"))

        end = self._normalize_time((event or {}).get("end"))

        raw = f"{title}|{start}|{end}"

        return hashlib.sha256(raw.encode("utf-8")).hexdigest()



    def _deduplicate(self, events):

        """

        Legacy merge behavior: duplicates combine source labels.

        """

        by_fp = {}

        for ev in events or []:

            fp = self._fingerprint(ev)

            src = str((ev or {}).get("source") or "").strip().lower()

            src = "outlook" if src == "microsoft" else src



            if fp not in by_fp:

                clone = dict(ev)

                clone["source"] = src

                by_fp[fp] = clone

                continue



            existing_sources = [s for s in str(by_fp[fp].get("source") or "").split(",") if s]

            if src and src not in existing_sources:

                existing_sources.append(src)

            by_fp[fp]["source"] = ",".join(existing_sources)



        return list(by_fp.values())



    # ==================================================

    # âœ… NORMALIZATION

    # ==================================================

    def _normalize(self, google_events, ms_events):

        unified = []

        

        logger.debug(

            "NORMALIZE INPUT COUNT: google=%s ms=%s",

            len(google_events), len(ms_events),

        )


        # âœ… combine everything FIRST

        all_events = []



        

        # âœ… Preserve original provider if already set (Apple compatibility)

        for e in google_events:

            if not e.get("provider"):

                e["provider"] = "google"

            if not e.get("source"):

                e["source"] = "google"



            all_events.append(e)



        # âœ… Preserve provider/source if already set (future-safe)

        for e in ms_events:

            if not e.get("provider"):

                e["provider"] = "microsoft"

            if not e.get("source"):

                e["source"] = "microsoft"



            all_events.append(e)

            #print("ðŸŸ¦ MS EVENT RAW:", e.get("id"))

            #print("ðŸ§ª MS BEFORE:", e)



        # âœ… SINGLE NORMALIZATION PIPELINE (THIS FIXES EVERYTHING)

        for e in all_events:



            # ==================================================

            # ðŸ”¬ SURGICAL FIX â€” PROVIDER NORMALIZATION

            # --------------------------------------------------

            # FORCE ALL EVENTS INTO CANONICAL PROVIDER SPACE

            # ==================================================

            # ==================================================

            # ðŸ”¬ SAFE PROVIDER DETECTION (CRITICAL FIX)

            # ==================================================

            raw_provider = (

                e.get("provider")

                or e.get("source")

                or ("microsoft" if "subject" in e else None)

            )



            if not isinstance(raw_provider, str):

                raw_provider = ""



            provider = normalize_provider(raw_provider)

            source_label = "outlook" if provider == "microsoft" else provider



            # âœ… DEBUG (REMOVE LATER)

            #print("ðŸ§ª PROVIDER NORMALIZED â†’", provider)

            

            # ==================================================

            # ðŸ”¬ SURGICAL FIX â€” ACCOUNT EMAIL CONTRACT

            # --------------------------------------------------

            # ALWAYS use account_email (frontend depends on this)

            # ==================================================

            account_email = (

                e.get("account_email")

                or e.get("account")

                or "local"   # âœ… CRITICAL FIX

            ).lower().strip()



            #print("ðŸ§ª ACCOUNT NORMALIZED â†’", account_email)



            start = self._safe_datetime(e.get("start"))

            end = self._safe_datetime(e.get("end"))

            title = (

                e.get("summary") or

                e.get("subject") or

                "Untitled Event"

            )



            raw_external_id = e.get("id")

            external_id = str(raw_external_id).strip() if raw_external_id is not None else ""

            if not external_id or external_id.lower() == "none":

                external_id = build_fallback_external_id(

                    provider=provider,

                    account_email=account_email,

                    title=title,

                    start_val=start,

                )



            unified.append({

                "external_id": external_id,



                "title": title,

                # ==================================================

                # ðŸ”¬ SURGICAL FIX â€” DATE CONSISTENCY

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

                "source": source_label,

                "provider": provider,

                # âœ… REQUIRED BY FRONTEND

                "account_email": account_email,

                # âœ… SINGLE SOURCE KEY

                "account_key": f"{provider}:{account_email}",

                "color": ACCOUNT_COLORS.get(provider, ACCOUNT_COLORS["other"])

            })

            

        sources = [e["source"] for e in unified]



        #print("ðŸš€ FINAL SOURCE BREAKDOWN:",{s: sources.count(s) for s in set(sources)})

        return unified



    # ==================================================

    # âœ… ENSURE UTC (FINAL FIX - CORRECT)

    # ==================================================

    def _ensure_utc(self, dt):

        """

        âœ… Ensures datetime is always timezone-aware (UTC)



        - None â†’ stays None

        - naive datetime â†’ converted to UTC

        - aware datetime â†’ unchanged

        """



        return ensure_utc(dt)



    # ==================================================

    # âœ… FETCH EVENTS (FIXED)

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

    

    def get_events_from_db(self, db, user, start_date, end_date, dedup_enabled: bool = True):



        events = db.query(Event).filter(

            Event.owner_id == user.id,

            Event.start_time >= start_date,

            Event.start_time <= end_date

        ).all()



        def _serialize_event(ev, provider_override=None, account_email_override=None):

            source = normalize_provider(provider_override or ev.source or "local")

            account_email = (account_email_override or getattr(ev, "account_email", None) or "local").lower().strip()

            return {

                "id": ev.id,

                "external_id": ev.externalId,

                "external_ids": dict(getattr(ev, "external_ids", None) or {}),

                "title": ev.title,

                "start": self.serialize_event_datetime(ev.start_time, ev.start_time, ev.end_time),

                "end": self.serialize_event_datetime(ev.end_time, ev.start_time, ev.end_time),

                "description": ev.description or "",

                "color": ev.color,

                "tags": ev.tags or [],

                "sticky_note": ev.sticky_note,

                "sticky_notes": ev.sticky_notes or [],

                "created_at": self.serialize_event_datetime(ev.created_at),

                "updated_at": self.serialize_event_datetime(getattr(ev, "updated_at", None)),

                "source": source,

                "account_email": account_email,

                "account_key": build_account_key(source, account_email)

            }



        serialized_events = []

        for ev in events:

            external_ids = dict(getattr(ev, "external_ids", None) or {})

            if not dedup_enabled and external_ids:

                emitted_keys = set()

                for account_key in external_ids.keys():

                    if not isinstance(account_key, str) or ":" not in account_key:

                        continue

                    provider, account_email = account_key.split(":", 1)

                    provider = normalize_provider(provider)

                    account_email = (account_email or "local").lower().strip()

                    normalized_key = build_account_key(provider, account_email)

                    if normalized_key in emitted_keys:

                        continue

                    serialized_events.append(

                        _serialize_event(ev, provider_override=provider, account_email_override=account_email)

                    )

                    emitted_keys.add(normalized_key)

                if emitted_keys:

                    continue



            serialized_events.append(_serialize_event(ev))



        per_account_counts = {}

        for ev in serialized_events:

            key = ev["account_key"]

            per_account_counts[key] = per_account_counts.get(key, 0) + 1



        log_info(f"[SYNC] DB VIEW ACCOUNT TOTALS | {per_account_counts}")



        return serialized_events

        

    def fetch_all_events(self, db, user, start_date=None, end_date=None, account_key: str = None):

        """

        3-phase parallel fetch.



        Phase 1 (sequential, DB):  resolve tokens, build per-account configs.

        Phase 2 (parallel, NO DB): HTTP calls to all providers concurrently.

        Phase 3 (sequential, DB):  write statuses + sync tokens back.

        """

        now = datetime.now(timezone.utc)

        if not start_date or not end_date:

            start_date = now - relativedelta(days=90)

            end_date   = now + relativedelta(days=90)

            log_info("[SYNC] Using default 90-day range")

        else:

            log_info("[SYNC] Using UI-provided range")



        safe_start = self._ensure_utc(start_date)

        safe_end   = self._ensure_utc(end_date)



        accounts = MultiAccountOAuthService.get_all_sync_enabled_accounts(db, user.id)
        account_key = (account_key or "").lower().strip() or None
        if account_key:
            accounts = [
                acc for acc in accounts
                if f"{normalize_provider(acc.provider)}:{(acc.account_email or '').lower().strip()}" == account_key
            ]

        log_info(f"[SYNC] Fetch window: {safe_start.date()} -> {safe_end.date()}")

        log_info(f"[SYNC] Accounts found: {len(accounts)}")



        # â”€â”€ Phase 1: Resolve tokens (sequential, DB) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        configs = []

        failed_accs = []

        sync_time = now



        for acc in accounts:

            email = (acc.account_email or "").lower()

            if "holiday" in email or "@group.v.calendar.google.com" in email:

                continue



            token = ensure_valid_token(db, acc)

            if not token:

                log_error(f"[SYNC] No token: {email}")

                acc.last_sync = sync_time

                acc.last_sync_failure = sync_time

                acc.last_error = "No valid token available"

                acc.status = "error"

                safe_commit(db)

                continue



            sync_state = dict(acc.sync_token or {})



            config = {

                "acc_id":           acc.id,

                "provider":         acc.provider,

                "account_email":    acc.account_email,

                "token":            token,

                "sync_token_state": sync_state,

            }

            if acc.provider == "apple":

                config["caldav_url"]   = acc.access_token

                config["app_password"] = acc.refresh_token



            configs.append(config)



        if not configs:

            return {

                "events": [],

                "account_status": {},

                "account_sync_totals": [],

                "cancelled_external_ids": [],

                "incremental_account_keys": set(),

            }



        # â”€â”€ Phase 2: Parallel HTTP fetch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        max_workers = min(8, len(configs))

        fetch_results = []



        with ThreadPoolExecutor(max_workers=max_workers) as pool:

            future_map = {

                pool.submit(_fetch_account_http, cfg, safe_start, safe_end): cfg

                for cfg in configs

            }

            for future in as_completed(future_map):

                try:

                    fetch_results.append(future.result())

                except Exception as exc:

                    cfg = future_map[future]

                    fetch_results.append({

                        "acc_id":           cfg["acc_id"],

                        "provider":         cfg["provider"],

                        "account_email":    cfg["account_email"],

                        "events":           [],

                        "cancelled_ids":    [],

                        "new_sync_tokens":  {},

                        "used_incremental": False,

                        "raw_count":        0,

                        "error":            str(exc),

                    })



        # â”€â”€ Phase 3: Aggregate + write DB statuses â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        google_events: list = []

        apple_events:  list = []

        ms_events:     list = []

        account_sync_totals: list = []

        cancelled_external_ids: list = []

        incremental_account_keys: set = set()



        # Build acc lookup by id for DB writes

        acc_by_id = {acc.id: acc for acc in accounts}



        for r in fetch_results:

            acc = acc_by_id.get(r["acc_id"])

            provider     = r["provider"]

            acct_email   = (r["account_email"] or "").lower().strip()

            account_key  = f"{normalize_provider(provider)}:{acct_email}"



            if r["error"]:

                log_error(f"Account failed ({acct_email}): {r['error']}")

                account_sync_totals.append({

                    "provider":      provider,

                    "account_email": acct_email,

                    "raw": 0, "in_range": 0,

                    "status": "error", "error": r["error"],

                })

                if acc:

                    if r.get("reauth_required"):

                        acc.access_token = "__REAUTH_REQUIRED__"

                    acc.last_sync         = sync_time

                    acc.last_sync_failure = sync_time

                    acc.last_error        = r["error"]

                    acc.status            = "error"

                    safe_commit(db)

                continue



            # Tag MS events with account_email (done here, not in thread)

            for e in r["events"]:

                if provider == "microsoft":

                    e["account_email"] = acct_email

                    e["account"]       = acct_email



            # Route to the right list for _normalize()

            if provider == "google":

                google_events.extend(r["events"])

            elif provider == "apple":

                apple_events.extend(r["events"])

            elif provider == "microsoft":

                ms_events.extend(r["events"])



            # Track cancelled events for sync_all deletion

            for raw_id in r["cancelled_ids"]:

                if raw_id:

                    eid = f"{normalize_provider(provider)}:{acct_email}:{raw_id}"

                    cancelled_external_ids.append(eid)



            if r["used_incremental"]:

                incremental_account_keys.add(account_key)



            in_range = len(r["events"])

            log_info(f"[SYNC] ACCOUNT TOTALS | {provider}:{acct_email} | raw={r['raw_count']} | in_range={in_range} | {'incremental' if r['used_incremental'] else 'full'}")

            account_sync_totals.append({

                "provider":      provider,

                "account_email": acct_email,

                "raw":           r["raw_count"],

                "in_range":      in_range,

                "status":        "ok",

            })



            if acc:

                # Store new incremental sync tokens back in DB

                if r["new_sync_tokens"]:

                    merged_tokens = dict(acc.sync_token or {})

                    merged_tokens.update(r["new_sync_tokens"])

                    acc.sync_token = merged_tokens



                acc.last_sync         = sync_time

                acc.last_sync_success = sync_time

                acc.last_sync_failure = None

                acc.last_error        = None

                acc.status            = "ok"

                safe_commit(db)



        total_g = len(google_events)

        total_a = len(apple_events)

        total_m = len(ms_events)

        log_info(f"[SYNC] Parallel fetch complete | Google:{total_g} Apple:{total_a} MS:{total_m}")



        all_accounts = MultiAccountOAuthService.get_user_accounts(db, user.id)

        account_status = {

            f"{acc.provider}:{(acc.account_email or '').lower().strip()}": resolve_account_status(acc)

            for acc in all_accounts

        }



        combined_primary = google_events + apple_events



        return {

            "events":                    self._normalize(combined_primary, ms_events),

            "account_status":            account_status,

            "account_sync_totals":       account_sync_totals,

            "cancelled_external_ids":    cancelled_external_ids,

            "incremental_account_keys":  incremental_account_keys,

        }





    # ==================================================

    # âœ… CROSS-ACCOUNT DEDUP PASS

    # ==================================================

    def _dedup_pass(self, db: Session, user_id: int) -> int:

        """

        Canonical Event Model

        â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

        After sync, collapse events that share the same title + start_time

        (rounded to the minute) into ONE canonical row.



        Rules:

        â€¢ ALL events (local + provider) are fingerprinted together.

        â€¢ An existing local canonical (source='local' with external_ids) wins.

        â€¢ ALL provider IDs are merged into canonical.external_ids so Publish

          reaches every account that originally held the event.

        â€¢ The canonical row keeps its original source/account_email for chip

          filter display; Publish scope is determined by external_ids, not source.

        â€¢ Subsequent syncs re-merge fresh provider rows into the existing

          canonical without losing user edits.

        """

        from collections import defaultdict

        import hashlib as _hs



        all_events = db.query(Event).filter(

            Event.owner_id == user_id,

        ).all()



        groups: dict = defaultdict(list)

        for ev in all_events:

            title_norm = (ev.title or "").strip().lower()

            if not title_norm:

                continue  # skip untitled placeholders

            if ev.start_time:

                dt = ev.start_time.replace(second=0, microsecond=0)

                dt_str = dt.isoformat()[:16]

            else:

                dt = None

                dt_str = ""

            # Golden rule: title + start_time + end_time must ALL match.
            # Two-field matching (title+start only) caused false-positive merges
            # where different events at the same time got collapsed.
            if ev.end_time:

                end_dt = ev.end_time.replace(second=0, microsecond=0)

                if (
                    dt is not None and
                    dt.hour == 0 and dt.minute == 0 and
                    end_dt.hour == 0 and end_dt.minute == 0
                ):
                    span = end_dt - dt
                    if timedelta(0) <= span <= timedelta(days=1):
                        end_dt = dt + timedelta(days=1)

                end_str = end_dt.isoformat()[:16]

            else:

                end_str = ""

            fp = _hs.md5(f"{title_norm}|{dt_str}|{end_str}".encode()).hexdigest()

            groups[fp].append(ev)



        merged_count = 0
        promoted_count = 0
        deleted_event_ids = set()

        for fp, group in groups.items():

            if len(group) <= 1:

                continue



            # Sort: existing local canonicals first (they win), then by created_at.

            # Normalise created_at to UTC-aware to prevent TypeError when

            # comparing naive and aware datetimes (SQLite stores naive).

            def _safe_dt(e):

                dt = e.created_at

                if dt is None:

                    return datetime(2000, 1, 1, tzinfo=timezone.utc)

                return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)



            group.sort(key=lambda e: (

                0 if (e.source == "local" and e.external_ids) else 1,

                _safe_dt(e),

            ))



            canonical = group[0]

            merged_ids = dict(canonical.external_ids or {})



            for dup in group[1:]:

                # Absorb all provider IDs from the duplicate

                for k, v in (dup.external_ids or {}).items():

                    if k not in merged_ids:

                        merged_ids[k] = v

                # Preserve description / color if canonical is missing it

                if not canonical.description and dup.description:

                    canonical.description = dup.description

                if not canonical.color and dup.color:

                    canonical.color = dup.color

                if dup.id is not None:

                    deleted_event_ids.add(dup.id)

                db.delete(dup)

                merged_count += 1



            # Promote to canonical: absorb all provider IDs, keep the

            # original source/account_email so the event continues to appear

            # under its original account chip filter in the frontend.

            # Write-back propagates to ALL accounts via external_ids.

            canonical.external_ids = merged_ids
            canonical.source = "local"
            canonical.account_email = "local"



        for ev in all_events:

            if ev.id in deleted_event_ids:

                continue

            if ev.source == "local" and (ev.account_email or "").lower().strip() == "local":

                continue

            if not getattr(ev, "external_ids", None):

                continue

            ev.source = "local"
            ev.account_email = "local"
            promoted_count += 1



        if merged_count or promoted_count:

            db.commit()

            log_info(f"[DEDUP] merged={merged_count} promoted={promoted_count} provider events into local canonical rows")



        return merged_count + promoted_count



    # ==================================================

    # âœ… SYNC ENGINE (FIXED + INSIDE CLASS)

    # ==================================================

    def sync_all(self, db: Session, user, start_date=None, end_date=None, dedup_enabled: bool = True, account_key: str = None):

        account_key          = (account_key or "").lower().strip() or None
        result               = self.fetch_all_events(db, user, start_date=start_date, end_date=end_date, account_key=account_key)
        account_sync_totals  = result.get("account_sync_totals", [])    if isinstance(result, dict) else []
        cancelled_eids       = result.get("cancelled_external_ids", []) if isinstance(result, dict) else []
        incremental_keys     = result.get("incremental_account_keys", set()) if isinstance(result, dict) else set()
        events               = result.get("events", [])                 if isinstance(result, dict) else []

        if not isinstance(events, list):
            log_error("Invalid events payload structure")
            return {"created": 0, "updated": 0, "deleted": 0, "deduped": 0, "account_sync_totals": []}

        created = updated = 0

        for e in events:
            if not isinstance(e, dict):
                continue
            external_id = build_event_id(e)
            if ":" not in external_id or external_id.endswith(":"):
                continue
            start = self._to_utc(e["start"])
            end   = self._to_utc(e["end"])
            if not start:
                continue
            existing = db.query(Event).filter(
                Event.externalId == external_id,
                Event.owner_id   == user.id,
            ).first()
            raw_ext_id   = e.get("external_id", "")
            provider     = normalize_provider(e.get("source", "local"))
            acct_email   = (e.get("account_email") or "").lower().strip()
            ext_id_key   = f"{provider}:{acct_email}" if acct_email else provider
            provider_ids = {ext_id_key: raw_ext_id} if raw_ext_id else {}
            if not existing:
                db.add(Event(
                    title=e["title"], start_time=start, end_time=end,
                    source=e["source"], externalId=external_id,
                    owner_id=user.id, account_email=e.get("account_email"),
                    color=e.get("color"), external_ids=provider_ids,
                ))
                created += 1
                continue
            changed = False
            if existing.start_time != start:
                existing.start_time = start; changed = True
            if existing.end_time != end:
                existing.end_time = end;     changed = True
            if provider_ids and existing.external_ids != provider_ids:
                merged = dict(existing.external_ids or {})
                merged.update(provider_ids)
                existing.external_ids = merged; changed = True
            if changed:
                updated += 1

        all_evs      = db.query(Event).filter(Event.owner_id == user.id).all()
        if account_key:
            all_evs = [
                ev for ev in all_evs
                if f"{normalize_provider(getattr(ev, 'source', None) or '')}:{(getattr(ev, 'account_email', None) or '').lower().strip()}" == account_key
            ]
        incoming_ids = set(build_event_id(e) for e in events if e.get("external_id"))
        deleted      = 0

        for ev in all_evs:
            ev_src = str(ev.source) if ev.source is not None else None
            ev_eid = str(ev.externalId) if ev.externalId is not None else None
            if ev_src == "local":
                continue
            ev_key = f"{normalize_provider(ev_src)}:{(getattr(ev, 'account_email', None) or '').lower().strip()}"
            if ev_key in incremental_keys:
                if ev_eid and ev_eid in cancelled_eids:
                    db.delete(ev); deleted += 1
            else:
                if ev_eid and ev_eid not in incoming_ids:
                    db.delete(ev); deleted += 1

        for eid in cancelled_eids:
            ev = db.query(Event).filter(
                Event.owner_id == user.id, Event.externalId == eid,
            ).first()
            if ev and ev.source != "local":
                db.delete(ev); deleted += 1

        log_info(f"Deleted stale/cancelled events: {deleted}")
        db.commit()

        deduped = self._dedup_pass(db, user.id) if dedup_enabled else 0
        if not dedup_enabled:
            log_info("Dedup DISABLED — all provider events kept separate")

        return {
            "created":             created,
            "updated":             updated,
            "deleted":             deleted,
            "deduped":             deduped,
            "account_sync_totals": account_sync_totals,
        }
