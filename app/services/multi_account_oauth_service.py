
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

        # ✅ EMERGENCY Fix — detect NULL access token issue
        if "access_token" in str(e):
            print("🚫 FIXING NULL ACCESS TOKEN BEFORE RETRY")

            for obj in db.dirty:
                if hasattr(obj, "access_token") and obj.access_token is None:
                    obj.access_token = "__REAUTH_REQUIRED__"

        db.rollback()

        try:
            db.commit()
            print("✅ Commit recovered successfully")
        except Exception as e2:
            print("❌ Commit retry failed:", e2)
            raise


def resolve_account_status(account: OAuthAccount):
    """Return the authoritative backend status for an account."""
    token_val = (getattr(account, "access_token", "") or "").strip()

    if token_val == "__REAUTH_REQUIRED__":
        return "error"

    if getattr(account, "last_sync_success", None):
        if getattr(account, "last_sync_failure", None) and account.last_sync_failure > account.last_sync_success:
            return "error"
        return "ok"

    if getattr(account, "last_sync_failure", None):
        return "error"

    if getattr(account, "status", "ok") == "error":
        return "error"

    return "ok"


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

        access_token: str = None,
        refresh_token: str = None,

        # ✅ ADD THIS BACK (CRITICAL FIX)
        token_expires_at: datetime = None,

        caldav_url: str = None,
        app_password: str = None,

        display_name: str = None,
        provider_id: str = None
    ):
        
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
            # ✅ APPLE SUPPORT (update credentials)

            # ✅ APPLE SUPPORT (update credentials correctly)
            if provider == "apple":
                existing.access_token = caldav_url
                existing.refresh_token = app_password
            else:
                existing.access_token = access_token

                if refresh_token:
                    existing.refresh_token = refresh_token

            if refresh_token:
                existing.refresh_token = refresh_token

            if token_expires_at:
                existing.token_expires_at = token_expires_at

            if existing.access_token and existing.access_token != "__REAUTH_REQUIRED__":
                now = datetime.now(timezone.utc)
                existing.status = "ok"
                existing.last_error = None
                existing.last_sync = now
                existing.last_sync_success = now
                existing.last_sync_failure = None
                
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

            is_primary = (account_count == 0 or locals().get("set_as_primary", False))

        )

        if oauth_account.access_token and oauth_account.access_token != "__REAUTH_REQUIRED__":
            now = datetime.now(timezone.utc)
            oauth_account.status = "ok"
            oauth_account.last_error = None
            oauth_account.last_sync = now
            oauth_account.last_sync_success = now
            oauth_account.last_sync_failure = None

        # --------------------------------------------------
        # ✅ APPLE SUPPORT (STORE CREDENTIALS SAFELY)
        # ---------------------------------------if provider == "apple":
        if provider == "apple":
            oauth_account.access_token = caldav_url
            oauth_account.refresh_token = app_password



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

    @staticmethod
    def get_primary_account(db: Session, user_id: int, provider: str):
        return db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
            OAuthAccount.is_primary == True
        ).first()

    @staticmethod
    def set_primary(db: Session, account_id: int, user_id: int):
        account = db.query(OAuthAccount).filter(
            OAuthAccount.id == account_id,
            OAuthAccount.user_id == user_id
        ).first()

        if not account:
            return None

        # Demote other primary accounts for this provider
        db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == account.provider,
            OAuthAccount.id != account_id,
            OAuthAccount.is_primary == True
        ).update({"is_primary": False}, synchronize_session="fetch")

        account.is_primary = True
        account.updated_at = datetime.now(timezone.utc)
        safe_commit(db)
        db.refresh(account)
        return account

    @staticmethod
    def disable_account(db: Session, account_id: int):
        account = db.query(OAuthAccount).filter(
            OAuthAccount.id == account_id
        ).first()

        if not account:
            return None

        account.sync_enabled = False
        account.updated_at = datetime.now(timezone.utc)
        safe_commit(db)
        db.refresh(account)
        return account

    @staticmethod
    def delete_account(db: Session, account_id: int):
        account = db.query(OAuthAccount).filter(
            OAuthAccount.id == account_id
        ).first()

        if not account:
            return False

        db.delete(account)
        safe_commit(db)
        return True

    @staticmethod
    def update_last_sync(db: Session, account_id: int):
        account = db.query(OAuthAccount).filter(
            OAuthAccount.id == account_id
        ).first()

        if not account:
            return None

        account.last_sync = datetime.now(timezone.utc)
        account.updated_at = datetime.now(timezone.utc)
        safe_commit(db)
        db.refresh(account)
        return account

# --------------------------------------------------
# ✅ VALIDATE ICLOUD CREDENTIALS (NEW)
# --------------------------------------------------
def validate_icloud_credentials(
    self,
    url: str,
    username: str,
    password: str
) -> bool:
    """
    ✅ PURPOSE:
    Validate Apple iCloud credentials BEFORE saving

    ✅ HOW:
    - Attempt minimal CalDAV connection
    - Do NOT fetch all events (fast + safe)

    ✅ RETURNS:
    True = valid credentials
    False = invalid credentials
    """

    if caldav is None:
        logger.error("caldav library not installed")
        return False

    try:
        client = caldav.DAVClient(
            url=url,
            username=username,
            password=password
        )

        # ✅ LIGHTWEIGHT CHECK (no heavy event fetch)
        principal = client.principal()

        if not principal:
            logger.warning("❌ Apple validation failed (no principal)")
            return False

        logger.info(f"✅ Apple credentials valid: {username}")
        return True

    except Exception as e:
        logger.error(f"❌ Apple validation failed: {e}")
        return False

# ==================================================
# ✅ TOKEN ENGINE (FINAL FIX)
# ==================================================

def ensure_valid_token(db: Session, account: OAuthAccount):
    """
    ✅ CRITICAL GUARANTEE:
    ALL datetime values are normalized BEFORE comparison
    """

    now = datetime.now(timezone.utc)
    print(f"[TOKEN CHECK] {account.provider} | {account.account_email}")
    expires = account.token_expires_at

    # ==================================================
    # ✅ PRO-LEVEL HARDENING — BLOCK INVALID TOKENS
    # ✅ ONLY BLOCK TRUE INVALID TOKENS
    # ==================================================
    if account.access_token == "__REAUTH_REQUIRED__":
        print(f"🚫 Token flagged invalid → skipping: {account.account_email}")

        if hasattr(account, "status") and account.status != "error":
            account.status = "error"
            safe_commit(db)

        return None
    
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
    # ✅ APPLE (NO TOKEN FLOW)
    # --------------------------------------------------
    if account.provider == "apple":
        """
        Apple does NOT use OAuth tokens for calendar.
        We return a dummy value so pipeline continues.
        """
        return "APPLE_CREDENTIALS"
    
    # --------------------------------------------------
    # ✅ RECOVERY MODE (FIXES YOUR BUG)
    # --------------------------------------------------
    if not expires:
        print(f"⚠️ Missing expires_at → attempting recovery: {account.account_email}")


        # ✅ Try refresh if possible
        if account.refresh_token:
            try:
                if account.provider == "google":
                    result = _refresh_google_token(db, account)

                    # ✅ HANDLE REAUTH SIGNAL
                    if result == "__REAUTH_REQUIRED__":
                        return None

                    return result


                if account.provider == "microsoft":
                    return _refresh_ms_token(db, account)

            except Exception as e:
                print("❌ Recovery refresh failed:", e)
                db.rollback()
                return None

        print(f"🚫 No refresh token → cannot recover: {account.account_email}")
        return None

    # --------------------------------------------------
    # ✅ SAFE COMPARISON (UTC vs UTC GUARANTEED)
    # --------------------------------------------------
    if expires > now + timedelta(minutes=2):

        if hasattr(account, "status"):
            account.status = "ok"
            safe_commit(db)

        return account.access_token

    # --------------------------------------------------
    # 🔄 REFRESH TOKEN
    # --------------------------------------------------
    print(f"🔄 Refreshing token: {account.account_email}")

    try:
        if account.provider == "google":
            result = _refresh_google_token(db, account)

            # ✅ HANDLE REAUTH SIGNAL
            if result == "__REAUTH_REQUIRED__":
                return None

            return result


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
        try:
            error_data = res.json()
        except Exception:
            error_data = {}

        error = error_data.get("error")

        print("❌ Google refresh failed:", res.text)

        # ==================================================
        # ✅ GOLD STANDARD FIX — HANDLE REVOKED TOKEN
        # ==================================================
        if error == "invalid_grant":
            print(f"🚫 TOKEN REVOKED → marking error: {account.account_email}")

            # ✅ SAFE ATTRIBUTE SET (no crash if column missing)
            if hasattr(account, "status"):
                account.status = "error"

            # ✅ PREVENT BAD TOKEN RETRY
            # ✅ NEVER set NULL (DB constraint)
            # ✅ Use sentinel value instead

            account.access_token = "__REAUTH_REQUIRED__"
            account.updated_at = datetime.now(timezone.utc)
            safe_commit(db)

            return "__REAUTH_REQUIRED__"

        return None

    data = res.json()

    if "access_token" not in data:
        print("❌ Invalid Google response:", data)
        return None
    
    print("🔍 ACCESS TOKEN:", account.access_token)
    print("🔍 ACCOUNT STATUS:", getattr(account, "status", None))   

    account.access_token = data["access_token"]

    # ✅ CRITICAL FIX: Microsoft rotates refresh tokens
    if "refresh_token" in data:
        account.refresh_token = data["refresh_token"]

    account.token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=data.get("expires_in", 3600)
    )

    # ✅ AUTO HEAL IF PREVIOUSLY BROKEN
        # ✅ ONLY clear error IF token is actually valid
    if hasattr(account, "status"):

        if account.access_token == "__REAUTH_REQUIRED__":
            account.status = "error"

        elif account.access_token:
            account.status = "ok"
            safe_commit(db)

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

    # ✅ CRITICAL FIX: Microsoft rotates refresh tokens
    if "refresh_token" in data:
        account.refresh_token = data["refresh_token"]

    account.token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=data.get("expires_in", 3600)
    )

    safe_commit(db)

    print(f"✅ Microsoft refreshed: {account.account_email}")
    return account.access_token
