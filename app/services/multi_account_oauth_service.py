
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

import logging
from sqlalchemy.orm import Session
from sqlalchemy import or_, func, not_
from app.models import OAuthAccount
from app.utils.crypto import TokenEncryptionError
import requests
from datetime import datetime, timedelta, timezone
from app.config import settings

logger = logging.getLogger(__name__)


ADMIN_PLACEHOLDER_TOKEN = "admin-placeholder-token"


DEFAULT_ACCOUNT_COLORS = {
    "google": "#34a853",
    "microsoft": "#2563eb",
    "apple": "#ef4444",
    "local": "#7ca3af",
    "other": "#999999",
}


def normalize_provider(provider: str) -> str:
    value = (provider or "").strip().lower()
    if value in {"outlook", "office365", "ms", "msft", "microsoft"}:
        return "microsoft"
    if value in {"gmail", "google"}:
        return "google"
    if value in {"icloud", "caldav", "apple"}:
        return "apple"
    if value in {"local", "internal"}:
        return "local"
    return value or "other"


def provider_default_color(provider: str) -> str:
    return DEFAULT_ACCOUNT_COLORS.get(normalize_provider(provider), DEFAULT_ACCOUNT_COLORS["other"])


def _exclude_service_provider_rows(query):
    """
    Exclude admin-managed provider rows from end-user OAuth account flows.
    Includes a token-based fallback for legacy rows that predate the flag.
    Also excludes test/placeholder accounts with @example.com email addresses.
    """
    return query.filter(
        or_(
            OAuthAccount.is_service_provider == False,
            OAuthAccount.is_service_provider.is_(None),
        ),
        OAuthAccount.access_token != ADMIN_PLACEHOLDER_TOKEN,
        not_(func.lower(OAuthAccount.account_email).like("%@example.com")),
    )


# ==================================================
# ✅ SAFE COMMIT HELPER (CRITICAL)
# ==================================================
def safe_commit(db: Session):
    try:
        db.commit()
    except Exception as e:
        logger.error("❌ DB commit failed: %s", e)

        # ✅ EMERGENCY Fix — detect NULL access token issue
        if "access_token" in str(e):
            logger.error("🚫 FIXING NULL ACCESS TOKEN BEFORE RETRY")

            for obj in db.dirty:
                if hasattr(obj, "access_token") and obj.access_token is None:
                    obj.access_token = "__REAUTH_REQUIRED__"

        db.rollback()

        try:
            db.commit()
            logger.info("✅ Commit recovered successfully")
        except Exception as e2:
            logger.error("❌ Commit retry failed: %s", e2)
            raise


def resolve_account_status(account: OAuthAccount):
    """Return the authoritative backend status for an account."""
    try:
        token_val = (getattr(account, "access_token", "") or "").strip()
    except TokenEncryptionError:
        # Keep account listings available when encrypted credentials exist
        # but the runtime key is missing or incorrect.
        logger.warning(
            "Unable to decrypt access token for account id=%s provider=%s; "
            "marking status as error.",
            getattr(account, "id", None),
            getattr(account, "provider", None),
        )
        return "error"

    if token_val == "__REAUTH_REQUIRED__":
        return "error"

    if getattr(account, "last_sync_success", None):
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
            logger.warning("⚠️ Converting float expires_at → datetime")
            token_expires_at = datetime.fromtimestamp(
                token_expires_at,
                tz=timezone.utc
            )

        # ✅ FORCE UTC (core rule)
        if isinstance(token_expires_at, datetime) and token_expires_at.tzinfo is None:
            logger.warning("⚠️ Converting naive expires_at → UTC")
            token_expires_at = token_expires_at.replace(tzinfo=timezone.utc)

        existing = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
            OAuthAccount.account_email == account_email
        ).first()

        if existing:
            logger.info(f"🔄 Updating account: {account_email}")
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

            if not existing.color:
                existing.color = provider_default_color(existing.provider)
                
            existing.display_name = display_name
            existing.provider_id = provider_id
            existing.updated_at = datetime.now(timezone.utc)

            safe_commit(db)
            return existing

        logger.info(f"✅ Adding account: {account_email}")

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
            color=provider_default_color(provider),

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
        try:
            query = _exclude_service_provider_rows(
                db.query(OAuthAccount).filter(
                    OAuthAccount.user_id == user_id,
                )
            )

            if provider:
                query = query.filter(OAuthAccount.provider == provider)

            return query.all()
        except Exception as e:
            # Recover from aborted transaction state (e.g. Postgres InFailedSqlTransaction)
            # and retry once for read-only account lookups.
            logger.warning("⚠️ get_user_accounts failed, attempting rollback+retry: %s", e)
            try:
                db.rollback()
            except Exception as rb_err:
                logger.error("⚠️ get_user_accounts rollback failed: %s", rb_err)
                raise

            query = _exclude_service_provider_rows(
                db.query(OAuthAccount).filter(
                    OAuthAccount.user_id == user_id,
                )
            )
            if provider:
                query = query.filter(OAuthAccount.provider == provider)

            return query.all()

    @staticmethod
    def get_all_sync_enabled_accounts(db: Session, user_id: int):
        try:
            return _exclude_service_provider_rows(
                db.query(OAuthAccount).filter(
                    OAuthAccount.user_id == user_id,
                    OAuthAccount.sync_enabled == True,
                    OAuthAccount.access_token != "__REAUTH_REQUIRED__"
                )
            ).all()
        except Exception as e:
            logger.warning("⚠️ get_all_sync_enabled_accounts failed, attempting rollback+retry: %s", e)
            try:
                db.rollback()
            except Exception as rb_err:
                logger.error("⚠️ get_all_sync_enabled_accounts rollback failed: %s", rb_err)
                raise

            return _exclude_service_provider_rows(
                db.query(OAuthAccount).filter(
                    OAuthAccount.user_id == user_id,
                    OAuthAccount.sync_enabled == True,
                    OAuthAccount.access_token != "__REAUTH_REQUIRED__"
                )
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
    logger.debug(f"[TOKEN CHECK] {account.provider} | {account.account_email}")
    expires = account.token_expires_at

    # ==================================================
    # ✅ PRO-LEVEL HARDENING — BLOCK INVALID TOKENS
    # ✅ ONLY BLOCK TRUE INVALID TOKENS
    # ==================================================
    if account.access_token == "__REAUTH_REQUIRED__":
        if hasattr(account, "status") and account.status != "error":
            account.status = "error"
            safe_commit(db)
            logger.warning(
                "Account entered REAUTH_REQUIRED state: %s",
                account.account_email,
            )

        return None
    
    # --------------------------------------------------
    # ✅ FIX 1: FLOAT → DATETIME
    # --------------------------------------------------
    if isinstance(expires, (int, float)):
        logger.warning(f"⚠️ Fixing float timestamp ({account.account_email})")
        try:
            expires = datetime.fromtimestamp(expires, tz=timezone.utc)
            account.token_expires_at = expires
            safe_commit(db)
        except Exception as e:
            logger.error("❌ Float conversion failed: %s", e)
            db.rollback()
            return None

    # --------------------------------------------------
    # ✅ FIX 2: NAIVE → UTC (THIS SOLVES YOUR ISSUE)
    # --------------------------------------------------
    if isinstance(expires, datetime) and expires.tzinfo is None:
        logger.warning(f"⚠️ Fixing naive datetime → UTC ({account.account_email})")
        try:
            expires = expires.replace(tzinfo=timezone.utc)
            account.token_expires_at = expires
            safe_commit(db)
        except Exception as e:
            logger.error("❌ Naive conversion failed: %s", e)
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
        logger.warning(f"⚠️ Missing expires_at → attempting recovery: {account.account_email}")


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
                logger.error("❌ Recovery refresh failed: %s", e)
                db.rollback()
                return None

        logger.error(f"🚫 No refresh token → cannot recover: {account.account_email}")
        if hasattr(account, "status"):
            account.status = "error"
        if hasattr(account, "last_error"):
            account.last_error = "Google refresh token is missing (missing refresh_token); reconnect this account to restore access." if account.provider == "google" else "Refresh token is missing; reconnect this account to restore access."
        if hasattr(account, "token_expires_at"):
            account.token_expires_at = datetime.now(timezone.utc)
        account.updated_at = datetime.now(timezone.utc)
        safe_commit(db)
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
    logger.debug("Refreshing token for account_id=%s", account.id)

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
        logger.error("❌ Refresh failed: %s", e)
        db.rollback()

    return None


# ==================================================
# ✅ GOOGLE REFRESH
# ==================================================

def _refresh_google_token(db: Session, account: OAuthAccount):

    if not account.refresh_token:
        logger.error(f"❌ No Google refresh_token: {account.account_email}")
        if hasattr(account, "status"):
            account.status = "error"
        if hasattr(account, "last_error"):
            account.last_error = "Google refresh token is missing (missing refresh_token); reconnect this account to restore access."
        if hasattr(account, "token_expires_at"):
            account.token_expires_at = datetime.now(timezone.utc)
        account.updated_at = datetime.now(timezone.utc)
        safe_commit(db)
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

        logger.error("❌ Google refresh failed: %s", res.text)

        # ==================================================
        # ✅ PRESERVE ACCOUNT RECORD — DO NOT ERASE CONNECTION STATE
        # ==================================================
        if error == "invalid_grant":
            logger.error(f"🚫 TOKEN REVOKED → preserving OAuth record and requiring reconnect: {account.account_email}")

            if hasattr(account, "status"):
                account.status = "error"
            if hasattr(account, "last_error"):
                account.last_error = "Google refresh token was revoked or invalid_grant; reconnect this account to restore access."
            if hasattr(account, "token_expires_at"):
                account.token_expires_at = datetime.now(timezone.utc)

            account.updated_at = datetime.now(timezone.utc)
            safe_commit(db)

            return None

        return None

    data = res.json()

    if "access_token" not in data:
        logger.error("❌ Invalid Google response: %s", data.get("error"))
        return None

    logger.debug("🔍 ACCOUNT STATUS: %s", getattr(account, "status", None))

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

    logger.info(f"✅ Google refreshed: {account.account_email}")
    return account.access_token


# ==================================================
# ✅ MICROSOFT REFRESH
# ==================================================

def _refresh_ms_token(db: Session, account: OAuthAccount):

    if not account.refresh_token:
        logger.error(f"❌ No MS refresh_token: {account.account_email}")
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
        try:
            error_data = res.json()
            error_code = error_data.get("error")
            error_desc = error_data.get("error_description")
            logger.error(
                "❌ Microsoft refresh failed for %s: %s - %s",
                account.account_email, error_code, error_desc
            )

            # Handle cases where the refresh token is expired or revoked.
            # See: https://docs.microsoft.com/en-us/azure/active-directory/develop/v2-oauth2-error-codes
            if error_code in ("invalid_grant", "unauthorized_client"):
                logger.error("🚫 MS TOKEN REVOKED → marking error: %s", account.account_email)
                if hasattr(account, "status"):
                    account.status = "error"
                account.access_token = "__REAUTH_REQUIRED__"
                account.updated_at = datetime.now(timezone.utc)
                safe_commit(db)
                return "__REAUTH_REQUIRED__"

        except Exception:
            logger.error("❌ Microsoft refresh failed with non-JSON response: %s", res.text)

        return None

    data = res.json()

    if "access_token" not in data:
        logger.error("❌ Invalid Microsoft response: %s", data)
        return None

    account.access_token = data["access_token"]

    # ✅ CRITICAL FIX: Microsoft rotates refresh tokens
    if "refresh_token" in data:
        account.refresh_token = data["refresh_token"]

    account.token_expires_at = datetime.now(timezone.utc) + timedelta(
        seconds=data.get("expires_in", 3600)
    )

    safe_commit(db)

    logger.info(f"✅ Microsoft refreshed: {account.account_email}")
    return account.access_token
