
"""
Multi-Account OAuth Service (FINAL - HARDENED + UTC SAFE)

✅ PURPOSE:
- Manage OAuth tokens safely
- Ensure tokens are always valid before API use

✅ GUARANTEES:
- No DB crashes (rollback-safe)
- No float → datetime failures
- No naive datetime comparison errors
- Safe token refresh lifecycle

✅ DESIGN:
CalendarService → ensure_valid_token → API client
"""

from sqlalchemy.orm import Session
from app.models import OAuthAccount
import requests
from datetime import datetime, timedelta, timezone
from app.config import settings


# ==================================================
# ✅ SAFE COMMIT HELPER (CRITICAL)
# ==================================================

def safe_commit(db: Session):
    try:
        db.commit()
    except Exception as e:
        print("❌ DB commit failed:", e)
        db.rollback()
        raise


# ==================================================
# ✅ MAIN ACCOUNT SERVICE
# ==================================================

class MultiAccountOAuthService:

    @staticmethod
    def add_oauth_account(
        db: Session,
        user_id: int,
        provider: str,
        account_email: str,
        access_token: str,
        refresh_token: str = None,
        token_expires_at: datetime = None,
        display_name: str = None,
        provider_id: str = None,
        set_as_primary: bool = False
    ) -> OAuthAccount:

        # ✅ FLOAT → DATETIME
        if isinstance(token_expires_at, (int, float)):
            print("⚠️ Converting float expires_at → datetime")
            token_expires_at = datetime.fromtimestamp(
                token_expires_at,
                tz=timezone.utc
            )

        # ✅ FORCE UTC (core rule)
        if isinstance(token_expires_at, datetime) and token_expires_at.tzinfo is None:
            print("⚠️ Converting naive expires_at → UTC")
            token_expires_at = token_expires_at.replace(tzinfo=timezone.utc)

        existing = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
            OAuthAccount.account_email == account_email
        ).first()

        if existing:
            print(f"🔄 Updating account: {account_email}")

            existing.access_token = access_token

            if refresh_token:
                existing.refresh_token = refresh_token

            if token_expires_at:
                existing.token_expires_at = token_expires_at

            existing.display_name = display_name
            existing.provider_id = provider_id
            existing.updated_at = datetime.now(timezone.utc)

            safe_commit(db)
            return existing

        print(f"✅ Adding account: {account_email}")

        account_count = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider
        ).count()

        oauth_account = OAuthAccount(
            user_id=user_id,
            provider=provider,
            account_email=account_email,
            access_token=access_token,
            refresh_token=refresh_token,
            token_expires_at=token_expires_at,
            display_name=display_name,
            provider_id=provider_id,
            is_primary=(account_count == 0 or set_as_primary)
        )

        db.add(oauth_account)
        safe_commit(db)
        db.refresh(oauth_account)

        return oauth_account

    @staticmethod
    def get_user_accounts(db: Session, user_id: int, provider: str = None):
        query = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id
        )

        if provider:
            query = query.filter(OAuthAccount.provider == provider)

        return query.all()

    @staticmethod
    def get_all_sync_enabled_accounts(db: Session, user_id: int):
        return db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.sync_enabled == True
        ).all()


# ==================================================
# ✅ TOKEN ENGINE (FINAL FIX)
# ==================================================

def ensure_valid_token(db: Session, account: OAuthAccount):
    """
    ✅ CRITICAL GUARANTEE:
    ALL datetime values are normalized BEFORE comparison
    """

    now = datetime.now(timezone.utc)

    expires = account.token_expires_at

    # --------------------------------------------------
    # ✅ FIX 1: FLOAT → DATETIME
    # --------------------------------------------------
    if isinstance(expires, (int, float)):
        print(f"⚠️ Fixing float timestamp ({account.account_email})")
        try:
            expires = datetime.fromtimestamp(expires, tz=timezone.utc)
            account.token_expires_at = expires
            safe_commit(db)
        except Exception as e:
            print("❌ Float conversion failed:", e)
            db.rollback()
            return None

    # --------------------------------------------------
    # ✅ FIX 2: NAIVE → UTC (THIS SOLVES YOUR ISSUE)
    # --------------------------------------------------
    if isinstance(expires, datetime) and expires.tzinfo is None:
        print(f"⚠️ Fixing naive datetime → UTC ({account.account_email})")
        try:
            expires = expires.replace(tzinfo=timezone.utc)
            account.token_expires_at = expires
            safe_commit(db)
        except Exception as e:
            print("❌ Naive conversion failed:", e)
            db.rollback()
            return None

    # --------------------------------------------------
    # ❌ INVALID ACCOUNT
    # --------------------------------------------------
    if not expires:
        print(f"❌ Missing expires_at: {account.account_email}")
        return None

    # --------------------------------------------------
    # ✅ SAFE COMPARISON (UTC vs UTC GUARANTEED)
    # --------------------------------------------------
    if expires > now + timedelta(minutes=2):

        if not account.access_token:
            print(f"❌ Missing access_token: {account.account_email}")
            return None

        return account.access_token

    # --------------------------------------------------
    # 🔄 REFRESH TOKEN
    # --------------------------------------------------
    print(f"🔄 Refreshing token: {account.account_email}")

    try:
        if account.provider == "google":
            return _refresh_google_token(db, account)

        if account.provider == "microsoft":
            return _refresh_ms_token(db, account)

    except Exception as e:
        print("❌ Refresh failed:", e)
        db.rollback()

    return None


# ==================================================
# ✅ GOOGLE REFRESH
# ==================================================

def _refresh_google_token(db: Session, account: OAuthAccount):

    if not account.refresh_token:
        print(f"❌ No Google refresh_token: {account.account_email}")
        return None

    res = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "client_id": settings.GOOGLE_CLIENT_ID,
            "client_secret": settings.GOOGLE_CLIENT_SECRET,
            "refresh_token": account.refresh_token,
            "grant_type": "refresh_token"
        }
    )

    if res.status_code != 200:
        print("❌ Google refresh failed:", res.text)
        return None

    data = res.json()

    if "access_token" not in data:
        print("❌ Invalid Google response:", data)
        return None

    account.access_token = data["access_token"]
    account.token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=data.get("expires_in", 3600)
    )

    safe_commit(db)

    print(f"✅ Google refreshed: {account.account_email}")
    return account.access_token


# ==================================================
# ✅ MICROSOFT REFRESH
# ==================================================

def _refresh_ms_token(db: Session, account: OAuthAccount):

    if not account.refresh_token:
        print(f"❌ No MS refresh_token: {account.account_email}")
        return None

    res = requests.post(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        data={
            "client_id": settings.MS_CLIENT_ID,
            "client_secret": settings.MS_CLIENT_SECRET,
            "refresh_token": account.refresh_token,
            "grant_type": "refresh_token"
        }
    )

    if res.status_code != 200:
        print("❌ Microsoft refresh failed:", res.text)
        return None

    data = res.json()

    if "access_token" not in data:
        print("❌ Invalid Microsoft response:", data)
        return None

    account.access_token = data["access_token"]
    account.token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=data.get("expires_in", 3600)
    )

    safe_commit(db)

    print(f"✅ Microsoft refreshed: {account.account_email}")
    return account.access_token
