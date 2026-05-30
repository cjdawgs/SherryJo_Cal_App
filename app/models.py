
# --------------------------------------------------
# ✅ IMPORTS
# --------------------------------------------------

from sqlalchemy import Column, Integer, String, DateTime, Boolean, ForeignKey, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

from app.database import Base
import uuid


# --------------------------------------------------
# ✅ ROLE CONSTANTS
# --------------------------------------------------

class Roles:
    ADMIN = "admin"
    STAFF = "staff"


# --------------------------------------------------
# ✅ USER TABLE
# --------------------------------------------------

class User(Base):
    """
    ✅ PURPOSE:
    - Core app user
    - Authentication + ownership of data

    ✅ NOTE:
    We KEEP legacy token fields for now (safe),
    but they are NO LONGER USED for calendar sync.
    """

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True)

    username = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False)

    role = Column(String, default=Roles.STAFF, nullable=False)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # ✅ RELATIONSHIPS
    events = relationship("Event", back_populates="owner")
    tasks = relationship("Task", back_populates="owner")

    # ⚠️ LEGACY TOKEN STORAGE (NO LONGER USED — SAFE TO REMOVE LATER)
    google_access_token = Column(String, nullable=True)
    google_refresh_token = Column(String, nullable=True)
    google_token_expires = Column(Integer, nullable=True)

    ms_access_token = Column(String, nullable=True)
    ms_refresh_token = Column(String, nullable=True)
    ms_token_expires = Column(Integer, nullable=True)

    # ✅ OPTIONAL DISPLAY EMAILS
    google_email = Column(String, nullable=True)
    ms_email = Column(String, nullable=True)

    # ✅ NEW: MULTI-ACCOUNT SUPPORT (THIS IS WHAT WE USE NOW)
    oauth_accounts = relationship(
        "OAuthAccount",
        back_populates="user",
        cascade="all, delete-orphan"
    )


# --------------------------------------------------
# ✅ OAUTH ACCOUNT TABLE (CRITICAL FIXED VERSION)
# --------------------------------------------------

class OAuthAccount(Base):
    """
    ✅ THIS TABLE POWERS YOUR ENTIRE SYSTEM

    ✅ EACH ROW = ONE CONNECTED ACCOUNT
    (Google or Microsoft)

    ✅ IMPORTANT FIX:
    token_expires_at is now DateTime (NOT float)
    → this removes your crash completely
    """

    __tablename__ = "oauth_accounts"

    id = Column(Integer, primary_key=True, index=True)

    # ✅ USER LINK
    user_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    user = relationship("User", back_populates="oauth_accounts")

    # ✅ PROVIDER
    provider = Column(String, index=True, nullable=False)  # "google" or "microsoft"

    # ✅ ACCOUNT IDENTITY
    account_email = Column(String, nullable=False)

    # ✅ TOKEN STORAGE
    access_token = Column(String, nullable=False)
    refresh_token = Column(String, nullable=True)

    # ✅ ✅ CRITICAL FIX (THIS FIXES YOUR ERROR)
    token_expires_at = Column(DateTime(timezone=True), nullable=True)

    # ✅ OPTIONAL METADATA
    display_name = Column(String, nullable=True)
    provider_id = Column(String, nullable=True, index=True)

    # ✅ ACCOUNT FLAGS
    is_primary = Column(Boolean, default=False, index=True)
    sync_enabled = Column(Boolean, default=True)

    # ✅ SYNC TRACKING
    last_sync = Column(DateTime(timezone=True), nullable=True)

    # ✅ TIMESTAMPS
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc)
    )

    def __repr__(self):
        return f"<OAuthAccount user={self.user_id} provider={self.provider} email={self.account_email}>"


# --------------------------------------------------
# ✅ TASK TABLE
# --------------------------------------------------

class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)

    title = Column(String, nullable=False)
    description = Column(String)

    completed = Column(Boolean, default=False)

    owner_id = Column(Integer, ForeignKey("users.id"))
    owner = relationship("User", back_populates="tasks")

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))


# --------------------------------------------------
# ✅ NOTE TABLE
# --------------------------------------------------

class Note(Base):
    __tablename__ = "notes"

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))

    date = Column(String)
    content = Column(String)

    color = Column(String, default="yellow")

    # ✅ UI POSITIONING
    x = Column(Integer, default=120)
    y = Column(Integer, default=120)

    event_id = Column(Integer, ForeignKey("events.id"), nullable=True)
    event = relationship("Event", back_populates="notes")


# --------------------------------------------------
# ✅ EVENT TABLE
# --------------------------------------------------

class Event(Base):
    __tablename__ = "events"

    id = Column(Integer, primary_key=True, index=True)

    # ✅ CORE DATA
    title = Column(String, nullable=False)
    description = Column(String)

    start_time = Column(DateTime(timezone=True), nullable=False)
    end_time = Column(DateTime(timezone=True))

    # ✅ OWNER
    owner_id = Column(Integer, ForeignKey("users.id"), index=True)
    owner = relationship("User", back_populates="events")

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))

    # ✅ STATUS
    status = Column(String, default="pending")

    # ✅ RELATIONSHIP
    notes = relationship(
        "Note",
        back_populates="event",
        cascade="all, delete-orphan"
    )

    # ✅ EXTERNAL SYNC
    externalId = Column(String, index=True)
    source = Column(String, default="local", index=True)

    # ✅ MULTI-PROVIDER SUPPORT
    external_ids = Column(JSON, nullable=True)
