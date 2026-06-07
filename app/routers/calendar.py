
# ==================================================
# IMPORTS
# ==================================================

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session
from datetime import datetime, timedelta, timezone

from app.database import get_db
from app.models import Event, Note, OAuthAccount
from app.deps import get_current_user

from app.services.calendar_service import CalendarService
from app.services.multi_account_oauth_service import MultiAccountOAuthService, ensure_valid_token



print("✅ CALENDAR ROUTER FILE LOADED")

router = APIRouter(prefix="/calendar", tags=["calendar"])

calendar_service = CalendarService()

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


# ==================================================
# ✅ SYNC ENDPOINT (SEPARATE FUNCTION)
# ==================================================

@router.post("/sync")
def sync_calendar(
    request: Request,
    db: Session = Depends(get_db),
    current_user = Depends(get_current_user)
):

    account_key = request.query_params.get("account")

    print("🧠 SYNC REQUEST:", account_key)

    accounts = MultiAccountOAuthService.get_user_accounts(
        db, current_user.id
    )

    if account_key:
        print("🎯 Filtering to single account:", account_key)

        try:
            provider, email = account_key.split(":", 1)

            accounts = [
                acc for acc in accounts
                if acc.provider == provider and acc.account_email == email
            ]

        except Exception as e:
            print(f"❌ fetch_all_events failed: {e}")
            return {
                "events": [],
                "account_status": {}
            }

    if not accounts:
        return {"status": "no_accounts"}

    # ✅ YOUR EXISTING SYNC LOOP GOES HERE
    # ✅ TRACK PER-ACCOUNT RESULTS
    results = []

    for account in accounts:

        print(f"[UNIFIED] Checking account: {account.account_email}")

        # ==================================================
        # ✅ CRITICAL FIX — TOKEN VALIDATION PIPELINE
        # ==================================================
        token = ensure_valid_token(db, account)

        if not token:
            print(f"[UNIFIED] 🚫 Skipping (no token): {account.account_email}")

            # ✅ 🔴 FINAL FIX — mark error HERE
            if hasattr(account, "status") and account.status != "error":
                account.status = "error"
                safe_commit(db)

            continue

        key = f"{account.provider}:{account.account_email}"

        try:
            print("🔄 Processing:", account.provider, "|", account.account_email)

            # ✅ CALL YOUR EXISTING SYNC LOGIC HERE
            calendar_service.sync_account(db, account)  # or whatever you use

            results.append({
                "key": key,
                "status": "ok"
            })

        except Exception as e:
            print("❌ Sync failed:", key, e)

            results.append({
                "key": key,
                "status": "error",
                "error": str(e)
            })

    return {
        "status": "success",
        "results": results
    }


# ==================================================
# ✅ UNIFIED CALENDAR (FINAL CLEAN VERSION)
# ==================================================

@router.get("/unified")
def get_unified_calendar(
    range_days: int = Query(30),
    start: str = Query(None),
    end: str = Query(None),

    db: Session = Depends(get_db),
    current_user=Depends(get_current_user)
):

    now = datetime.utcnow()

    # ==================================================
    # ✅ NEW: SUPPORT FULLCALENDAR RANGE
    # ==================================================
    if start and end:
        try:
            start_date = datetime.fromisoformat(start)
            end_date = datetime.fromisoformat(end)

            print(f"✅ FULLCAL RANGE: {start_date} → {end_date}")

        except Exception as e:
            print("❌ Invalid start/end, falling back:", e)

            start_date = now - timedelta(days=range_days)
            end_date = now + timedelta(days=range_days)

    else:
        start_date = now - timedelta(days=range_days)
        end_date = now + timedelta(days=range_days)

        print(f"✅ RANGE WINDOW: ±{range_days} days")


    # ------------------------------------------
    # STEP 1: FETCH EXTERNAL EVENTS
    # ------------------------------------------
    try:
        result = calendar_service.fetch_all_events(
            db,
            current_user,
            start_date=start_date,
            end_date=end_date
        )

        # ✅ CRITICAL: normalize shape ONCE
        if isinstance(result, dict):
            events = result.get("events", [])
            account_status = result.get("account_status", {})
        else:
            events = result or []
            account_status = {}

    except Exception as e:
        print(f"❌ fetch_all_events failed: {e}")
        events = []
        account_status = {}

    print(f"✅ External events fetched: {len(events)}")

    # ✅ Normalize + CLEAN ONCE (CRITICAL FIX)
    clean_events = []

    for e in events:
        if not isinstance(e, dict):
            print("⚠️ Skipping malformed event:", e)
            continue

        e["_start_dt"] = to_dt(e.get("start"))
        e["_end_dt"] = to_dt(e.get("end"))

        clean_events.append(e)

    events = clean_events

    # ------------------------------------------
    # STEP 2: ADD LOCAL EVENTS
    # ------------------------------------------
    db_events = db.query(Event).filter(
        Event.owner_id == current_user.id,
        Event.end_time >= start_date,
        Event.start_time <= end_date
    ).all()

    for e in db_events:

        # ✅ Skip synced external copies
        if e.externalId:
            continue

        events.append({
            "id": e.id,
            "external_id": None,
            "title": e.title,
            "start": to_iso(e.start_time),
            "end": to_iso(e.end_time),

            "source": "local",
            "provider": "local",

            "account": "local",
            "account_key": "local:local",

            "color": "#666666",
            "conflict": False,

            "_start_dt": to_dt(e.start_time),
            "_end_dt": to_dt(e.end_time)
        })

    # ------------------------------------------
    # STEP 3: DEDUPE (CORRECT PLACE ✅)
    # ------------------------------------------
    seen = set()
    unique_events = []

    for e in events:
        key = (
            e.get("external_id"),
            e.get("source"),              # ✅ CRITICAL FIX
            str(e.get("_start_dt"))
        )

        if key in seen:
            continue

        seen.add(key)
        unique_events.append(e)

    events = unique_events

    # ------------------------------------------
    # STEP 4: SORT
    # ------------------------------------------
    FAR_FUTURE = datetime(9999, 1, 1, tzinfo=timezone.utc)

    def sort_key(e):
        return e.get("_start_dt") or FAR_FUTURE

    events.sort(key=sort_key)

    # ------------------------------------------
    # STEP 5: CONFLICT DETECTION
    # ------------------------------------------
    for i in range(len(events)):
        events[i]["conflict"] = False

        for j in range(len(events)):
            if i == j:
                continue

            s1 = events[i].get("_start_dt")
            e1 = events[i].get("_end_dt")
            s2 = events[j].get("_start_dt")
            e2 = events[j].get("_end_dt")

            if not all([s1, e1, s2, e2]):
                continue

            if s1 < e2 and e1 > s2:
                events[i]["conflict"] = True

    # ✅ FINAL CLEAN OUTPUT (RESTORE ISO VALUES)
    for e in events:
        e["start"] = to_iso(e.get("_start_dt"))
        e["end"] = to_iso(e.get("_end_dt"))

        e.pop("_start_dt", None)
        e.pop("_end_dt", None)

    # ------------------------------------------
    # ✅ STEP 6: BUILD ACCOUNT STATUS MAP (NEW)
    # ------------------------------------------
    print("🔥 BUILDING account_status...")
    accounts = MultiAccountOAuthService.get_user_accounts(
        db, current_user.id
    )

    print("🔥 USING NEW ACCOUNT STATUS LOGIC")
    
    account_status = {}

    for acc in accounts:
        key = f"{acc.provider}:{(acc.account_email or '').lower().strip()}"

        print("🔥 TOKEN VALUE:", acc.account_email, acc.access_token)


        # ✅ CRITICAL FIX — TRUST TOKEN STATE FIRST
        if acc.access_token == "__REAUTH_REQUIRED__":
            account_status[key] = "error"
        else:
            account_status[key] = getattr(acc, "status", "ok")

    print("🔥 FINAL account_status:", account_status)

    # ------------------------------------------
    # ✅ FINAL RESPONSE (NEW STRUCTURE)
    # ------------------------------------------
    return {
        "events": events,
        "account_status": account_status
    }
