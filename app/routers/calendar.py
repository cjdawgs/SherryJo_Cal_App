
# ==================================================
# IMPORTS
# ==================================================
from sqlalchemy import func   # ✅ add this import at top if not already there
import os

from fastapi import APIRouter, Depends, Query, Request, HTTPException
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone

from app.database import get_db
from app.models import Event, Note, OAuthAccount, DateStickyNote
from app.deps import get_current_user, require_admin

from app.services.calendar_service import CalendarService, normalize_provider
from app.services.multi_account_oauth_service import (
    MultiAccountOAuthService,
    ensure_valid_token,
    resolve_account_status
)
from app.services.event_actions import EventActions
from app.services.google_calendar_service import GoogleCalendarService
from app.services.graph_client import GraphClient



print("✅ CALENDAR ROUTER FILE LOADED")

router = APIRouter(prefix="/calendar", tags=["calendar"])

calendar_service = CalendarService()
_event_actions = EventActions()
_google_service = GoogleCalendarService()
_graph_client = GraphClient()

# ==================================================
# ✅ SAFE HELPERS (TOP LEVEL — NOT INSIDE ANY FUNCTION)
# ==================================================


def to_dt(val):
    if not val:
        return None

    if isinstance(val, datetime):
        return val if val.tzinfo else val.replace(tzinfo=timezone.utc)

    if isinstance(val, str):
        try:
            dt = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)
        except:
            return None

    return None


def to_iso(val):
    if not val:
        return None
    return val if isinstance(val, str) else val.isoformat()


def normalize_tags(value):
    if not value:
        return []
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    return []


def normalize_sticky_note(payload):
    if not isinstance(payload, dict):
        return None

    content = str(payload.get("content") or "").strip()
    color = str(payload.get("color") or "#F7E68A").strip()
    created_at = payload.get("createdAt")
    updated_at = payload.get("updatedAt")

    if not content:
        return None

    now_iso = datetime.now(timezone.utc).isoformat()

    return {
        "content": content,
        "color": color,
        "createdAt": created_at or now_iso,
        "updatedAt": updated_at or now_iso
    }


def normalize_sticky_notes(payload):
    if payload is None:
        return []

    if isinstance(payload, dict):
        one = normalize_sticky_note(payload)
        return [one] if one else []

    if not isinstance(payload, list):
        return []

    out = []
    for item in payload:
        normalized = normalize_sticky_note(item)
        if normalized:
            out.append(normalized)

    return out


def serialize_date_sticky(item: DateStickyNote):
    sticky_notes = normalize_sticky_notes(getattr(item, "sticky_notes", None))
    return {
        "id": item.id,
        "date": item.date,
        "sticky_notes": sticky_notes,
        "count": len(sticky_notes),
        "updated_at": to_iso(getattr(item, "updated_at", None)),
    }


def serialize_event(event: Event):
    account_email = getattr(event, "account_email", None) or "local"
    source = event.source or "local"

    sticky_notes = normalize_sticky_notes(getattr(event, "sticky_notes", None))
    if not sticky_notes and event.sticky_note:
        legacy = normalize_sticky_note(event.sticky_note)
        if legacy:
            sticky_notes = [legacy]

    return {
        "id": event.id,
        "external_id": event.externalId,
        "title": event.title,
        "description": event.description or "",
        "start": to_iso(event.start_time),
        "end": to_iso(event.end_time),
        "start_time": to_iso(event.start_time),
        "end_time": to_iso(event.end_time),
        "color": event.color,
        "tags": event.tags or [],
        "sticky_note": sticky_notes[0] if sticky_notes else None,
        "sticky_notes": sticky_notes,
        "created_at": to_iso(event.created_at),
        "updated_at": to_iso(getattr(event, "updated_at", None)),
        "source": source,
        "account_email": account_email,
        "account_key": f"{normalize_provider(source)}:{account_email.lower().strip()}",
        "extendedProps": {
            "backendId": event.id,
            "source": normalize_provider(source),
            "account": account_email,
            "account_key": f"{normalize_provider(source)}:{account_email.lower().strip()}",
            "description": event.description or "",
            "tags": event.tags or [],
            "eventColor": event.color,
            "stickyNote": sticky_notes[0] if sticky_notes else None,
            "stickyNotes": sticky_notes,
            "createdAt": to_iso(event.created_at),
            "updatedAt": to_iso(getattr(event, "updated_at", None))
        }
    }




# ==================================================
# ✅ DEBUG ROUTE — DB COUNT BY USER (TEMP)
# ==================================================

@router.get("/debug/db-count")
def debug_db_count(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    try:
        total = db.query(Event).count()

        by_user = (
            db.query(Event.owner_id, func.count())
            .group_by(Event.owner_id)
            .all()
        )

        print("🧪 TOTAL EVENTS IN DB:", total)
        print("🧪 EVENTS BY USER:", by_user)

        return {
            "total": total,
            "by_user": by_user
        }

    except Exception as e:
        print("❌ DEBUG ROUTE ERROR:", str(e))
        return {
            "error": str(e)
        }
        
@router.post("/debug/wipe-user-events")
def wipe_user_events(
    db: Session = Depends(get_db),
    current_user=Depends(require_admin)
):
    deleted = db.query(Event).filter(
        Event.owner_id == current_user.id
    ).delete(synchronize_session=False)

    db.commit()

    remaining = db.query(Event).count()

    print("🔥 DELETED ROWS:", deleted)
    print("🧪 TOTAL AFTER WIPE:", remaining)

    return {
        "deleted": deleted,
        "remaining": remaining
    }

# ==================================================
# ✅ Post Event (SEPARATE FUNCTION)
# ==================================================
@router.post("/event")
async def create_event(
    request: Request,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    data = await request.json()

    title = (data.get("title") or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="title is required")

    start_time = to_dt(data.get("start_time"))
    end_time = to_dt(data.get("end_time"))  

    if not start_time:
        raise HTTPException(status_code=422, detail="start_time is required")

    sticky_notes = normalize_sticky_notes(
        data.get("sticky_notes") or data.get("stickyNotes")
    )
    if not sticky_notes:
        sticky_notes = normalize_sticky_notes(data.get("sticky_note") or data.get("stickyNote"))
    sticky_note = sticky_notes[0] if sticky_notes else None

    event = Event(
        title=title,
        description=(data.get("description") or "").strip(),
        start_time=start_time,
        end_time=end_time,
        owner_id=current_user.id,
        source=data.get("source") or "local",
        account_email=data.get("account_email") or "local",
        color=data.get("color"),
        tags=normalize_tags(data.get("tags")),
        sticky_note=sticky_note,
        sticky_notes=sticky_notes
    )

    db.add(event)
    db.commit()
    db.refresh(event)

    return {"status": "ok", "event": serialize_event(event)}


@router.put("/event/{event_id}")
async def update_event(
    event_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    event = db.query(Event).filter(
        Event.id == event_id,
        Event.owner_id == current_user.id
    ).first()

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    data = await request.json()

    # ── Conflict guard ──────────────────────────────────────────────────
    # If the client sends its known updated_at timestamp and the DB has a
    # newer one (scheduler wrote in the meantime), reject with 409 so the
    # UI can show a conflict prompt instead of silently losing edits.
    client_updated_at = to_dt(data.get("client_updated_at"))
    server_updated_at = getattr(event, "updated_at", None)
    if client_updated_at and server_updated_at:
        srv = server_updated_at if server_updated_at.tzinfo else server_updated_at.replace(tzinfo=timezone.utc)
        cli = client_updated_at if client_updated_at.tzinfo else client_updated_at.replace(tzinfo=timezone.utc)
        if cli < srv:
            raise HTTPException(
                status_code=409,
                detail={
                    "conflict": True,
                    "message": "Event was updated by another process. Reload and try again.",
                    "server_updated_at": srv.isoformat(),
                },
            )
    # ───────────────────────────────────────────────────────────────────

    provider_updates = {}  # track fields to propagate to providers

    if "title" in data:
        title = (data.get("title") or "").strip()
        if not title:
            raise HTTPException(status_code=422, detail="title cannot be empty")
        event.title = title
        provider_updates["title"] = title

    if "description" in data:
        event.description = (data.get("description") or "").strip()

    if "start_time" in data:
        start_time = to_dt(data.get("start_time"))
        if not start_time:
            raise HTTPException(status_code=422, detail="start_time is invalid")
        event.start_time = start_time
        provider_updates["start_time"] = start_time

    if "end_time" in data:
        event.end_time = to_dt(data.get("end_time"))
        provider_updates["end_time"] = event.end_time

    if "color" in data:
        event.color = data.get("color")

    if "tags" in data:
        event.tags = normalize_tags(data.get("tags"))

    if "sticky_notes" in data or "stickyNotes" in data or "sticky_note" in data or "stickyNote" in data:
        sticky_notes = normalize_sticky_notes(
            data.get("sticky_notes") or data.get("stickyNotes")
        )
        if (not sticky_notes) and ("sticky_note" in data or "stickyNote" in data):
            sticky_notes = normalize_sticky_notes(data.get("sticky_note") or data.get("stickyNote"))

        event.sticky_notes = sticky_notes
        event.sticky_note = sticky_notes[0] if sticky_notes else None

    event.updated_at = datetime.now(timezone.utc)

    db.commit()
    db.refresh(event)

    # Write-back to providers is intentionally NOT done here.
    # Edits stay local until the user explicitly clicks Publish.

    return {"status": "ok", "event": serialize_event(event)}


@router.delete("/event/{event_id}")
def delete_event(
    event_id: int,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    event = db.query(Event).filter(
        Event.id == event_id,
        Event.owner_id == current_user.id
    ).first()

    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Write-back to providers is intentionally NOT done here.
    # Deletions stay local until the user explicitly clicks Publish.

    db.delete(event)
    db.commit()

    return {"status": "ok", "deleted": event_id}


@router.get("/date-sticky")
def list_date_sticky_notes(
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    try:
        rows = db.query(DateStickyNote).filter(
            DateStickyNote.owner_id == current_user.id
        ).all()

        return {
            "status": "ok",
            "items": [serialize_date_sticky(row) for row in rows]
        }
    except Exception as e:
        # Keep frontend stable when migration is not yet applied in production.
        print("⚠️ [DATE_STICKY] list failed, returning empty set:", e)
        return {
            "status": "ok",
            "items": []
        }


@router.get("/date-sticky/{date_key}")
def get_date_sticky_note(
    date_key: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    try:
        row = db.query(DateStickyNote).filter(
            DateStickyNote.owner_id == current_user.id,
            DateStickyNote.date == date_key
        ).first()

        if not row:
            return {"status": "ok", "item": {"date": date_key, "sticky_notes": [], "count": 0}}

        return {"status": "ok", "item": serialize_date_sticky(row)}
    except Exception as e:
        print("⚠️ [DATE_STICKY] get failed, returning empty item:", e)
        return {"status": "ok", "item": {"date": date_key, "sticky_notes": [], "count": 0}}


@router.put("/date-sticky/{date_key}")
async def upsert_date_sticky_note(
    date_key: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    try:
        data = await request.json()
        sticky_notes = normalize_sticky_notes(data.get("sticky_notes") or data.get("stickyNotes"))

        row = db.query(DateStickyNote).filter(
            DateStickyNote.owner_id == current_user.id,
            DateStickyNote.date == date_key
        ).first()

        if not sticky_notes:
            if row:
                db.delete(row)
                db.commit()
            return {"status": "ok", "item": {"date": date_key, "sticky_notes": [], "count": 0}}

        if not row:
            row = DateStickyNote(
                owner_id=current_user.id,
                date=date_key,
                sticky_notes=sticky_notes,
            )
            db.add(row)
        else:
            row.sticky_notes = sticky_notes
            row.updated_at = datetime.now(timezone.utc)

        db.commit()
        db.refresh(row)
        return {"status": "ok", "item": serialize_date_sticky(row)}
    except Exception as e:
        print("❌ [DATE_STICKY] upsert failed:", e)
        try:
            db.rollback()
        except Exception:
            pass
        return {
            "status": "error",
            "message": "Date sticky persistence unavailable on server",
            "item": {"date": date_key, "sticky_notes": [], "count": 0}
        }


@router.delete("/date-sticky/{date_key}")
def delete_date_sticky_note(
    date_key: str,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    try:
        row = db.query(DateStickyNote).filter(
            DateStickyNote.owner_id == current_user.id,
            DateStickyNote.date == date_key
        ).first()

        if row:
            db.delete(row)
            db.commit()

        return {"status": "ok", "deleted": date_key}
    except Exception as e:
        print("⚠️ [DATE_STICKY] delete failed:", e)
        try:
            db.rollback()
        except Exception:
            pass
        return {"status": "ok", "deleted": date_key}

# ==================================================
# ✅ SYNC ENDPOINT (SEPARATE FUNCTION)
# ==================================================

@router.post("/sync")
def sync_calendar(
    dedup: bool = True,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):
    """
    ✅ Phase 3: FULL SYNC (DB hydration)
    - Calls sync_all()
    - Populates DB from external providers
    - No per-account loops
    """

    try:
        print("🔥 FULL SYNC TRIGGERED")

        db_url = str(getattr(db.bind, "url", "UNKNOWN"))
        print("🧪 [SYNC] DB FILE:", db_url)
        print("🧪 [SYNC] WORKING DIR:", os.getcwd())

        try:
            print("🧪 [SYNC] DB COUNT AT START:", db.query(Event).count())
        except Exception as count_err:
            print("⚠️ [SYNC] DB count check failed:", count_err)
            try:
                db.rollback()
                print("🧯 [SYNC] Session rollback after count failure")
            except Exception as rb_err:
                print("⚠️ [SYNC] Rollback after count failure failed:", rb_err)

        # Use the user-configured sync window to keep requests bounded and avoid upstream timeouts.
        sync_accounts = MultiAccountOAuthService.get_all_sync_enabled_accounts(db, current_user.id)
        configured_days = [
            int(getattr(acc, "sync_range_days", 30) or 30)
            for acc in sync_accounts
        ]
        window_days = max(1, min(max(configured_days) if configured_days else 30, 365))

        now_utc = datetime.now(timezone.utc)
        start_date = now_utc - timedelta(days=window_days)
        end_date = now_utc + timedelta(days=window_days)

        print(f"🧪 [SYNC] USING WINDOW DAYS: {window_days}")
        print(f"🧪 [SYNC] RANGE: {start_date.isoformat()} -> {end_date.isoformat()}")

        result = calendar_service.sync_all(
            db,
            current_user,
            start_date=start_date,
            end_date=end_date,
            dedup_enabled=dedup,
        )

        print("🔥 SYNC RESULT:", result)

        return {
            "status": "success",
            "result": result,
            "range_days": window_days,
            "range_start": start_date.isoformat(),
            "range_end": end_date.isoformat(),
        }

    except Exception as e:
        print("❌ SYNC FAILED:", str(e))
        try:
            db.rollback()
        except Exception:
            pass

        return {
            "status": "error",
            "message": str(e)
        }

# ==================================================
# ✅ PUBLISH — push all canonical local events to provider accounts
# ==================================================

@router.post("/publish")
async def publish_to_providers(
    request: Request,
    db: Session = Depends(get_db),
    current_user=Depends(get_current_user),
):
    """
    Push local edits to provider accounts.
    Scope: only the event_ids provided by the client (modified this session).
    If no event_ids supplied, publishes ALL events with external_ids.
    Never triggered by Sync — user must click Publish explicitly.
    """
    try:
        body = await request.json()
    except Exception:
        body = {}

    event_ids_raw = body.get("event_ids", None)  # None = key absent (publish all)
    if event_ids_raw is not None and len(event_ids_raw) == 0:
        # Client sent an explicit empty list — no edits tracked, nothing to do
        return {"status": "success", "published": 0, "failed": 0,
                "message": "No modified events to publish — make edits first"}

    event_ids = [int(i) for i in (event_ids_raw or [])
                 if str(i).lstrip("-").replace(".", "", 1).isdigit()]

    if event_ids:
        events_to_publish = (
            db.query(Event)
            .filter(
                Event.owner_id == current_user.id,
                Event.id.in_(event_ids),
                Event.external_ids.isnot(None),
            )
            .all()
        )
    else:
        events_to_publish = (
            db.query(Event)
            .filter(
                Event.owner_id == current_user.id,
                Event.external_ids.isnot(None),
            )
            .all()
        )

    if not events_to_publish:
        return {"status": "success", "published": 0, "failed": 0,
                "message": "No modified events with provider links to publish"}

    # Compute dynamic date range from the modified events
    starts = [e.start_time for e in events_to_publish if e.start_time]
    range_start = min(starts).date().isoformat() if starts else None
    range_end   = max(starts).date().isoformat() if starts else None

    # Collect the unique account keys that will be touched
    affected_accounts: set = set()
    for ev in events_to_publish:
        for id_key in (ev.external_ids or {}):
            # id_key is "provider:email" or legacy "provider"
            provider_part = id_key.split(":")[0] if ":" in id_key else id_key
            if provider_part in ("google", "microsoft", "apple"):
                affected_accounts.add(id_key)

    published = 0
    failed    = 0

    for event in events_to_publish:
        try:
            pushed = _event_actions.push_to_providers(
                db, event, _google_service, _graph_client, current_user
            )
            if pushed > 0:
                published += 1
        except Exception as e:
            print(f"⚠️ Publish failed for event {event.id}: {e}")
            failed += 1

    return {
        "status": "success",
        "published":          published,
        "failed":             failed,
        "total_events":       len(events_to_publish),
        "affected_accounts":  sorted(affected_accounts),
        "range_start":        range_start,
        "range_end":          range_end,
    }


# ==================================================
# ✅ UNIFIED CALENDAR (FINAL CLEAN VERSION)
# ==================================================

@router.get("/unified")
def get_unified_calendar(
    range_days: int = Query(30),
    start: str = Query(None),
    end: str = Query(None),
    dedup: bool = Query(True),

    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):
    now = datetime.now(timezone.utc)

    db_url = str(getattr(db.bind, "url", "UNKNOWN"))
    print("🧪 [SYNC] DB FILE:", db_url)
    print("🧪 [UNIFIED] WORKING DIR:", os.getcwd())

    try:
        print("🧪 [UNIFIED] DB ROW COUNT:", db.query(Event).count())
    except Exception as e:
        print("⚠️ [UNIFIED] DB row count check failed:", e)
        try:
            db.rollback()
            print("🧯 [UNIFIED] Session rollback after row-count failure")
        except Exception as rb_err:
            print("⚠️ [UNIFIED] Rollback after row-count failure failed:", rb_err)

    # ==================================================
    # ✅ SUPPORT FULLCALENDAR RANGE (WITH SAFE PARSING)
    # ==================================================
    def _parse_iso(val: str):
        if not val:
            return None
        try:
            parsed = datetime.fromisoformat(val.replace("Z", "+00:00"))
            return parsed.astimezone(timezone.utc)
        except Exception:
            return None

    start_date = None
    end_date = None

    if start and end:
        start_date = _parse_iso(start)
        end_date = _parse_iso(end)
        if start_date and end_date:
            print(f"✅ FULLCAL RANGE: {start_date} → {end_date}")
        else:
            print("❌ Invalid start/end, falling back")

    if not start_date or not end_date:
        start_date = now - timedelta(days=range_days)
        end_date = now + timedelta(days=range_days)
        print(f"✅ RANGE WINDOW: ±{range_days} days")

    events = []
    account_event_totals = {}
    account_status = {}

    try:
        # ✅ FAST READ PATH
        events = calendar_service.get_events_from_db(
            db,
            current_user,
            start_date,
            end_date,
            dedup_enabled=dedup,
        )

        for ev in events:
            key = ev.get("account_key")
            if not key:
                continue
            account_event_totals[key] = account_event_totals.get(key, 0) + 1

        print(f"⚡ FAST DB EVENTS: {len(events)}")

    except Exception as e:
        print("❌ [UNIFIED] events fetch failed:", e)
        events = []
        account_event_totals = {}

    try:
        accounts = MultiAccountOAuthService.get_user_accounts(db, current_user.id)

        for acc in accounts:
            try:
                provider = normalize_provider(acc.provider)
                key = f"{provider}:{(acc.account_email or '').lower().strip()}"
                account_status[key] = resolve_account_status(acc)
            except Exception as inner:
                print("⚠️ [UNIFIED] account status failed:", inner)

    except Exception as e:
        print("❌ [UNIFIED] account status block failed:", e)
        account_status = {}

    return {
        "events": events,
        "account_status": account_status,
        "account_event_totals": account_event_totals
    }