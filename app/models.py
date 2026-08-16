
# --------------------------------------------------
# ✅ IMPORTS
# --------------------------------------------------

from sqlalchemy import Column, Integer, String, DateTime, Date, Float, Boolean, ForeignKey, JSON, UniqueConstraint
from sqlalchemy.ext.hybrid import hybrid_property
from sqlalchemy.orm import relationship
from datetime import datetime, timezone

from app.database import Base
from app.utils.crypto import seal, unseal
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
    tag_color_settings = relationship(
        "EventTagColorSetting",
        back_populates="owner",
        cascade="all, delete-orphan"
    )

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

    # ✅ TOKEN STORAGE (encrypted at rest — see app/utils/crypto.py)
    # The physical columns keep their original names; the `access_token` /
    # `refresh_token` attributes seal on write and unseal on read, so every
    # existing call site works unchanged.
    access_token_encrypted = Column("access_token", String, nullable=False)
    refresh_token_encrypted = Column("refresh_token", String, nullable=True)

    @hybrid_property
    def access_token(self):
        return unseal(self.access_token_encrypted)

    @access_token.setter
    def access_token(self, value):
        self.access_token_encrypted = seal(value)

    @access_token.expression
    def access_token(cls):
        # SQL-level comparisons only ever target the plaintext sentinels
        # ("admin-placeholder-token", "__REAUTH_REQUIRED__"), which are never
        # sealed, so comparing against the raw column stays correct.
        return cls.access_token_encrypted

    @hybrid_property
    def refresh_token(self):
        return unseal(self.refresh_token_encrypted)

    @refresh_token.setter
    def refresh_token(self, value):
        self.refresh_token_encrypted = seal(value)

    @refresh_token.expression
    def refresh_token(cls):
        return cls.refresh_token_encrypted

    # ✅ ✅ CRITICAL FIX (THIS FIXES YOUR ERROR)
    token_expires_at = Column(DateTime(timezone=True), nullable=True)

    # ✅ OPTIONAL METADATA
    display_name = Column(String, nullable=True)
    provider_id = Column(String, nullable=True, index=True)

    # ✅ ACCOUNT FLAGS
    is_primary = Column(Boolean, default=False, index=True)
    sync_enabled = Column(Boolean, default=True)
    is_service_provider = Column(Boolean, default=False, nullable=False, index=True)
    color = Column(String, nullable=True)

    # ✅ USER-OWNED SYNC SETTINGS
    sync_frequency_minutes = Column(Integer, default=5, nullable=False)
    sync_range_days = Column(Integer, default=30, nullable=False)
    last_manual_refresh_at = Column(DateTime(timezone=True), nullable=True)
    sync_claimed_until = Column(DateTime(timezone=True), nullable=True)

    # ✅ SYNC TRACKING
    last_sync = Column(DateTime(timezone=True), nullable=True)
    last_sync_success = Column(DateTime(timezone=True), nullable=True)
    last_sync_failure = Column(DateTime(timezone=True), nullable=True)
    last_error = Column(String, nullable=True)
    status = Column(String, default="ok")

    # ✅ INCREMENTAL SYNC STATE
    # Stores per-calendar sync tokens so subsequent syncs only fetch changes.
    # Google:    {"primary": "token...", "cal@gmail.com": "token..."}
    # Microsoft: {"delta_link": "https://graph.microsoft.com/v1.0/..."}
    sync_token = Column(JSON, nullable=True)

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
    recurrence = Column(JSON, nullable=True)

    # ✅ OWNER
    owner_id = Column(Integer, ForeignKey("users.id"), index=True)
    owner = relationship("User", back_populates="events")

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc)
    )

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
    
    # ==================================================
    # ✅ CANONICAL ACCOUNT IDENTITY (CRITICAL)
    # ==================================================
    account_email = Column(String, nullable=True, index=True)

    # ==================================================
    # ✅ EVENT COLOR (PALETTE SUPPORT)
    # ==================================================
    color = Column(String, nullable=True)
    color_enabled = Column(Boolean, default=False, nullable=False)

    # ✅ UX metadata for event form enhancements
    tags = Column(JSON, nullable=True)

    # ✅ Sticky note payload tied to each event
    # shape: { content, color, createdAt, updatedAt }
    sticky_note = Column(JSON, nullable=True)

    # ✅ Multi-sticky payload support
    # shape: [{ content, color, createdAt, updatedAt }, ...]
    sticky_notes = Column(JSON, nullable=True)

    # ✅ MULTI-PROVIDER SUPPORT
    external_ids = Column(JSON, nullable=True)

    # ✅ INCREMENTAL SYNC TOKENS (per-provider state)
    # Google:    {"primary": "nextSyncToken_abc", "cal2@gmail.com": "nextSyncToken_xyz"}
    # Microsoft: {"delta_link": "https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=..."}
    # Apple:     not used (CalDAV has no delta API)


class EventTagColorSetting(Base):
    __tablename__ = "event_tag_color_settings"
    __table_args__ = (
        UniqueConstraint("owner_id", "tag_key", name="uq_event_tag_color_owner_tag"),
    )

    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    owner = relationship("User", back_populates="tag_color_settings")
    tag_key = Column(String, index=True, nullable=False)
    label = Column(String, nullable=False)
    color = Column(String, nullable=True)
    enabled = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc)
    )


class DateStickyNote(Base):
    __tablename__ = "date_sticky_notes"
    __table_args__ = (
        UniqueConstraint("owner_id", "date", name="uq_date_sticky_owner_date"),
    )

    id = Column(Integer, primary_key=True, index=True)
    owner_id = Column(Integer, ForeignKey("users.id"), index=True, nullable=False)
    date = Column(String, index=True, nullable=False)  # YYYY-MM-DD
    sticky_notes = Column(JSON, nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc)
    )


class WorkerWriteReceipt(Base):
    __tablename__ = "worker_write_receipts"

    owner_id = Column(Integer, ForeignKey("users.id"), primary_key=True)
    idempotency_key = Column(String(200), primary_key=True)
    operation = Column(String(100), nullable=False)
    request_hash = Column(String(64), nullable=False)
    response_body = Column(JSON, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)


# --------------------------------------------------
# ✅ TV DIAGNOSTIC LOG TABLE
# --------------------------------------------------

class TVDiagLog(Base):
    """
    Persistent log of TV sleep-guard and lifecycle events beaconed from
    the TV dashboard JS.  Written to Supabase/Postgres so it is accessible
    from any device, regardless of which FireStick or server instance sent it.

    device_id  — stable UUID stored in the TV's localStorage (survives reboots)
    device_ua  — User-Agent string captured server-side (identifies FireStick model)
    """

    __tablename__ = "tv_diag_log"

    id            = Column(Integer, primary_key=True, index=True)
    ts_server     = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), index=True)
    user_id       = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    device_id     = Column(String, nullable=True, index=True)   # localStorage UUID, stable per device
    device_ua     = Column(String, nullable=True)               # User-Agent (e.g. "Silk/…" for FireStick)
    event         = Column(String, nullable=False)
    details       = Column(String, nullable=True)
    ts_client     = Column(String, nullable=True)               # ISO timestamp from JS
    elapsed_min   = Column(Integer, nullable=True)
    visibility    = Column(String, nullable=True)
    guard_enabled = Column(Boolean, nullable=True)
    guard_timeout = Column(Integer, nullable=True)


class SyncEfficiencyDailyRollup(Base):
    """Daily rollup snapshots for sync efficiency and provider-cache metrics."""

    __tablename__ = "sync_efficiency_daily_rollups"
    __table_args__ = (
        UniqueConstraint("snapshot_date", name="uq_sync_efficiency_snapshot_date"),
    )

    id = Column(Integer, primary_key=True, index=True)
    snapshot_date = Column(Date, nullable=False, index=True)
    week_start_date = Column(Date, nullable=False, index=True)

    changes = Column(Integer, nullable=False, default=0)
    no_changes = Column(Integer, nullable=False, default=0)
    total_cycles = Column(Integer, nullable=False, default=0)
    change_ratio = Column(Float, nullable=True)
    no_change_ratio = Column(Float, nullable=True)

    google_cache_hits = Column(Integer, nullable=False, default=0)
    google_cache_misses = Column(Integer, nullable=False, default=0)
    google_cache_total_lookups = Column(Integer, nullable=False, default=0)
    google_cache_hit_ratio = Column(Float, nullable=True)
    google_cache_entries = Column(Integer, nullable=False, default=0)

    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class SyncOperationLedger(Base):
    """Durable scheduler operation ledger for replay-safe async migration."""

    __tablename__ = "sync_operation_ledger"
    __table_args__ = (
        UniqueConstraint("operation_key", name="uq_sync_operation_ledger_operation_key"),
    )

    id = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    operation_key = Column(String(200), nullable=False, index=True)
    operation_type = Column(String(100), nullable=False, index=True)
    owner_user_id = Column(Integer, ForeignKey("users.id"), nullable=True, index=True)
    status = Column(String(32), nullable=False, default="pending", index=True)
    attempt_count = Column(Integer, nullable=False, default=1)
    request_payload = Column(JSON, nullable=True)
    result_payload = Column(JSON, nullable=True)
    error_type = Column(String, nullable=True)
    error_message = Column(String, nullable=True)
    started_at = Column(DateTime(timezone=True), nullable=True)
    finished_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


class AppRuntimeSecret(Base):
    """Encrypted app-level runtime secrets persisted for restart-safe bootstrap."""

    __tablename__ = "app_runtime_secrets"

    id = Column(Integer, primary_key=True, index=True)
    key_name = Column(String, unique=True, nullable=False, index=True)
    secret_value = Column(String, nullable=False)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class WebSocketTicket(Base):
    """Short-lived, single-use credential for a WebSocket handshake."""

    __tablename__ = "websocket_tickets"

    id = Column(Integer, primary_key=True, index=True)
    token_hash = Column(String(64), unique=True, index=True, nullable=False)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False)
    expires_at = Column(DateTime(timezone=True), index=True, nullable=False)
    consumed_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False)
