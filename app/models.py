# --------------------------------------------------
# IMPORTS
# --------------------------------------------------

from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey, Float, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, UTC

from app.database import Base
import uuid


# --------------------------------------------------
# ROLE CONSTANTS
# --------------------------------------------------

class Roles:
    ADMIN = "admin"
    STAFF = "staff"


# --------------------------------------------------
# USER TABLE
# --------------------------------------------------

class User(Base):
    __tablename__ = "users"

# ✅ PRIMARY KEY
    id = Column(Integer, primary_key=True, index=True)


    username = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)

    role = Column(String, default=Roles.STAFF, nullable=False)

    created_at = Column(DateTime, default=lambda: datetime.now(UTC))

    events = relationship("Event", back_populates="owner")
    tasks = relationship("Task", back_populates="owner")
    
    # ==========================================================
    # ✅ GOOGLE TOKENS
    # ==========================================================
    google_access_token = Column(String, nullable=True, index=True)
    google_refresh_token = Column(String, nullable=True)
    google_token_expires = Column(Float, nullable=True)

    
    # ==========================================================
    # ✅ MICROSOFT TOKENS
    # ==========================================================
    ms_access_token = Column(String, nullable=True, index=True)
    ms_refresh_token = Column(String, nullable=True)
    ms_token_expires = Column(Float, nullable=True)

    # ==========================================================
    # ✅ ✅ NEW: PROVIDER EMAILS (REAL ACCOUNT IDENTITY)
    # ==========================================================
    # These store the ACTUAL email from Google / Microsoft
    # DO NOT add index — not needed for lookups

    google_email = Column(String, nullable=True)
    ms_email = Column(String, nullable=True)

    # ✅ NEW: Relationship to multiple OAuth accounts
    oauth_accounts = relationship("OAuthAccount", back_populates="user", cascade="all, delete-orphan")


# ==================================================
# ✅ NEW: OAUTH ACCOUNT TABLE (MULTI-ACCOUNT SUPPORT)
# ==================================================
class OAuthAccount(Base):
    """
    Supports multiple OAuth accounts per user.
    Each row = one connected Google or Microsoft account.
    
    Example:
    - User 1 has 2 Google accounts + 1 Microsoft account → 3 rows
    - User 2 has 1 Google account → 1 row
    """
    __tablename__ = "oauth_accounts"

    id = Column(Integer, primary_key=True, index=True)
    
    # Foreign key to users table
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    user = relationship("User", back_populates="oauth_accounts")
    
    # Provider type: "google" or "microsoft"
    provider = Column(String, index=True, nullable=False)  # "google" or "microsoft"
    
    # Account email (the actual email from the provider)
    # e.g., "sherryjo@gmail.com" or "sherryjo@outlook.com"
    account_email = Column(String, nullable=False)
    
    # Tokens
    access_token = Column(String, nullable=False)
    refresh_token = Column(String, nullable=True)
    token_expires_at = Column(Float, nullable=True)  # Unix timestamp
    
    # Display name (optional, from user info)
    display_name = Column(String, nullable=True)
    
    # Provider-specific ID (Google ID, Azure Object ID, etc.)
    provider_id = Column(String, nullable=True, index=True)
    
    # Is this the primary account for the user? (can query by this)
    is_primary = Column(Boolean, default=False, index=True)
    
    # Sync status
    last_sync = Column(DateTime, nullable=True)
    sync_enabled = Column(Boolean, default=True)
    
    created_at = Column(DateTime, default=lambda: datetime.now(UTC))
    updated_at = Column(DateTime, default=lambda: datetime.now(UTC), onupdate=lambda: datetime.now(UTC))
    
    # Composite index for fast lookups
    def __repr__(self):
        return f"<OAuthAccount user={self.user_id} provider={self.provider} email={self.account_email}>"


# --------------------------------------------------
# TASK TABLE
# --------------------------------------------------

class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)

    title = Column(String, nullable=False)
    description = Column(String)

    completed = Column(Boolean, default=False)

    owner_id = Column(Integer, ForeignKey("users.id"))

    created_at = Column(DateTime, default=lambda: datetime.now(UTC))

    owner = relationship("User", back_populates="tasks")


# --------------------------------------------------
# ✅ NOTE TABLE (UPDATED FOR STICKY NOTE POSITIONING)
# --------------------------------------------------

class Note(Base):
    __tablename__ = "notes"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    date = Column(String)
    content = Column(String)

    color = Column(String, default="yellow")

    # ✅ NEW (STEP 10): for floating position
    x = Column(Integer, default=120)
    y = Column(Integer, default=120)

    event_id = Column(Integer, ForeignKey("events.id"), nullable=True)

    event = relationship("Event", back_populates="notes")


# --------------------------------------------------
# EVENT TABLE
# --------------------------------------------------

class Event(Base):
    __tablename__ = "events"

    id = Column(Integer, primary_key=True, index=True)

    # ✅ CORE EVENT DATA
    title = Column(String, nullable=False)
    description = Column(String)

    start_time = Column(DateTime, nullable=False)
    end_time = Column(DateTime)

    # ✅ USER OWNERSHIP (ALREADY CORRECT ✅)
    owner_id = Column(Integer, ForeignKey("users.id"), index=True)
    owner = relationship("User", back_populates="events")

    created_at = Column(DateTime, default=lambda: datetime.now(UTC))

    # ✅ STATUS / LOCAL STATE
    status = Column(String, default="pending")

    # ✅ RELATIONSHIPS
    notes = relationship(
        "Note",
        back_populates="event",
        cascade="all, delete-orphan"
    )

    # ✅ EXTERNAL INTEGRATION FIELDS (UNCHANGED)
    externalId = Column(String, nullable=True, index=True)
    lastSyncVersion = Column(String, nullable=True)
    calendarId = Column(String, nullable=True)
    source = Column(String, default="local", index=True)
    
    
    # ✅ NEW: store provider IDs (Google + Outlook)
    # Example:
    # {
    #   "google": "abc123",
    #   "outlook": "xyz789"
    # }
    external_ids = Column(JSON, nullable=True)
