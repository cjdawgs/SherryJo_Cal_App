"""
Multi-Account OAuth Service

Handles storing and managing multiple OAuth accounts for a user.
Works with both Google and Microsoft providers.
"""

from sqlalchemy.orm import Session
from datetime import datetime, UTC
from app.models import OAuthAccount


class MultiAccountOAuthService:
    """Service for managing multiple OAuth accounts per user."""
    
    @staticmethod
    def add_oauth_account(
        db: Session,
        user_id: int,
        provider: str,  # "google" or "microsoft"
        account_email: str,
        access_token: str,
        refresh_token: str = None,
        token_expires_at: float = None,
        display_name: str = None,
        provider_id: str = None,
        set_as_primary: bool = False
    ) -> OAuthAccount:
        """
        Add a new OAuth account for a user.
        
        If this is the first account for this provider, sets it as primary.
        """
        # Check if account already connected
        existing = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
            OAuthAccount.account_email == account_email
        ).first()
        
        if existing:
            # Update existing account
            existing.access_token = access_token
            existing.refresh_token = refresh_token
            existing.token_expires_at = token_expires_at
            existing.display_name = display_name
            existing.provider_id = provider_id
            existing.updated_at = datetime.now(UTC)
            db.commit()
            return existing
        
        # Check if this should be primary (first account for provider)
        account_count = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider
        ).count()
        
        is_primary = (account_count == 0) or set_as_primary
        
        # Create new account
        oauth_account = OAuthAccount(
            user_id=user_id,
            provider=provider,
            account_email=account_email,
            access_token=access_token,
            refresh_token=refresh_token,
            token_expires_at=token_expires_at,
            display_name=display_name,
            provider_id=provider_id,
            is_primary=is_primary
        )
        
        db.add(oauth_account)
        db.commit()
        db.refresh(oauth_account)
        
        return oauth_account
    
    @staticmethod
    def get_user_accounts(db: Session, user_id: int, provider: str = None) -> list[OAuthAccount]:
        """
        Get all OAuth accounts for a user.
        Optionally filter by provider ("google" or "microsoft").
        """
        query = db.query(OAuthAccount).filter(OAuthAccount.user_id == user_id)
        
        if provider:
            query = query.filter(OAuthAccount.provider == provider)
        
        return query.order_by(OAuthAccount.is_primary.desc()).all()
    
    @staticmethod
    def get_primary_account(db: Session, user_id: int, provider: str) -> OAuthAccount:
        """Get the primary OAuth account for a user/provider combo."""
        return db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
            OAuthAccount.is_primary == True
        ).first()
    
    @staticmethod
    def get_all_sync_enabled_accounts(db: Session, user_id: int) -> list[OAuthAccount]:
        """Get all sync-enabled OAuth accounts for a user."""
        return db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.sync_enabled == True
        ).all()
    
    @staticmethod
    def disable_account(db: Session, account_id: int) -> OAuthAccount:
        """Disable an OAuth account (don't sync it)."""
        account = db.query(OAuthAccount).filter(OAuthAccount.id == account_id).first()
        if account:
            account.sync_enabled = False
            db.commit()
        return account
    
    @staticmethod
    def delete_account(db: Session, account_id: int) -> bool:
        """Delete an OAuth account."""
        account = db.query(OAuthAccount).filter(OAuthAccount.id == account_id).first()
        if account:
            db.delete(account)
            db.commit()
            return True
        return False
    
    @staticmethod
    def set_primary(db: Session, account_id: int, user_id: int) -> OAuthAccount:
        """Set an account as primary for its provider."""
        account = db.query(OAuthAccount).filter(
            OAuthAccount.id == account_id,
            OAuthAccount.user_id == user_id
        ).first()
        
        if not account:
            return None
        
        # Unset other primary accounts for this provider
        db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == account.provider,
            OAuthAccount.id != account_id
        ).update({"is_primary": False})
        
        account.is_primary = True
        db.commit()
        
        return account
    
    @staticmethod
    def update_last_sync(db: Session, account_id: int) -> OAuthAccount:
        """Update the last_sync timestamp for an account."""
        account = db.query(OAuthAccount).filter(OAuthAccount.id == account_id).first()
        if account:
            account.last_sync = datetime.now(UTC)
            db.commit()
        return account
