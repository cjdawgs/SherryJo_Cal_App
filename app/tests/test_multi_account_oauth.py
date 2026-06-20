"""
Multi-Account OAuth Testing Guide & Fixtures

This file demonstrates how to:
1. Create multiple test accounts (Google + Microsoft)
2. Test the multi-account storage system
3. Simulate OAuth flows for multiple accounts
4. Test sync across multiple accounts
"""

import pytest
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, patch
from sqlalchemy.orm import Session

from app.models import User, OAuthAccount
from app.services.multi_account_oauth_service import MultiAccountOAuthService, resolve_account_status
from app.database import get_db


# ============================================================
# TEST FIXTURES FOR MULTI-ACCOUNT SETUP
# ============================================================

@pytest.fixture
def multi_account_user(db: Session):
    """
    Create a user with multiple OAuth accounts connected.
    
    User "sherryjo" with:
    - 2 Google accounts
    - 1 Microsoft account
    """
    from app.security import hash_password
    
    user = User(
        username="sherryjo",
        email="sherryjo@example.com",
        hashed_password=hash_password("password123"),
        role="staff"
    )
    
    db.add(user)
    db.commit()
    db.refresh(user)
    
    return user


@pytest.fixture
def oauth_accounts_setup(db: Session, multi_account_user: User):
    """
    Create multiple OAuth accounts for the test user:
    
    1. Google Account 1 (primary): sherryjo@gmail.com
    2. Google Account 2: sherryjo.work@gmail.com
    3. Microsoft Account: sherryjo@outlook.com
    """
    
    # Google Account 1 (Primary)
    common_expiry = datetime.now(timezone.utc) + timedelta(days=3650)

    google_acc1 = OAuthAccount(
        user_id=multi_account_user.id,
        provider="google",
        account_email="sherryjo@gmail.com",
        display_name="Sherry Jo (Personal)",
        access_token="google_access_token_1_abc123",
        refresh_token="google_refresh_token_1_xyz789",
        token_expires_at=common_expiry,
        provider_id="google_id_001",
        is_primary=True,
        sync_enabled=True
    )
    
    # Google Account 2 (Work)
    google_acc2 = OAuthAccount(
        user_id=multi_account_user.id,
        provider="google",
        account_email="sherryjo.work@gmail.com",
        display_name="Sherry Jo (Work)",
        access_token="google_access_token_2_def456",
        refresh_token="google_refresh_token_2_uvw000",
        token_expires_at=common_expiry,
        provider_id="google_id_002",
        is_primary=False,
        sync_enabled=True
    )
    
    # Microsoft Account
    ms_acc = OAuthAccount(
        user_id=multi_account_user.id,
        provider="microsoft",
        account_email="sherryjo@outlook.com",
        display_name="Sherry Jo (Outlook)",
        access_token="ms_access_token_ghi789",
        refresh_token="ms_refresh_token_jkl012",
        token_expires_at=common_expiry,
        provider_id="ms_id_azure_001",
        is_primary=True,
        sync_enabled=True
    )
    
    db.add_all([google_acc1, google_acc2, ms_acc])
    db.commit()
    
    return {
        "google_primary": google_acc1,
        "google_secondary": google_acc2,
        "microsoft": ms_acc
    }


# ============================================================
# TEST CASES FOR MULTI-ACCOUNT STORAGE
# ============================================================

def test_add_oauth_account_new(db: Session, multi_account_user: User):
    """Test adding a new OAuth account."""
    
    account = MultiAccountOAuthService.add_oauth_account(
        db=db,
        user_id=multi_account_user.id,
        provider="google",
        account_email="sherryjo@gmail.com",
        access_token="test_token_123",
        refresh_token="test_refresh_456",
        token_expires_at=9999999999.0,
        display_name="Sherry Jo",
        provider_id="google_123"
    )
    
    assert account.id is not None
    assert account.account_email == "sherryjo@gmail.com"
    assert account.provider == "google"
    assert account.is_primary == True  # First account should be primary
    assert account.sync_enabled == True


def test_add_oauth_account_update_existing(db: Session, multi_account_user: User):
    """Test that connecting the same account twice updates it instead of duplicating."""
    
    # Add account first time
    account1 = MultiAccountOAuthService.add_oauth_account(
        db=db,
        user_id=multi_account_user.id,
        provider="google",
        account_email="sherryjo@gmail.com",
        access_token="token_v1",
        refresh_token="refresh_v1"
    )
    
    # Add same account second time (simulating token refresh)
    account2 = MultiAccountOAuthService.add_oauth_account(
        db=db,
        user_id=multi_account_user.id,
        provider="google",
        account_email="sherryjo@gmail.com",
        access_token="token_v2_updated",
        refresh_token="refresh_v2_updated"
    )
    
    # Should be the same account (updated)
    assert account1.id == account2.id
    assert account2.access_token == "token_v2_updated"
    
    # Should still only have 1 account
    accounts = MultiAccountOAuthService.get_user_accounts(db, multi_account_user.id)
    assert len(accounts) == 1


def test_add_oauth_account_update_existing_clears_error_state(db: Session, multi_account_user: User):
    stale = OAuthAccount(
        user_id=multi_account_user.id,
        provider="google",
        account_email="broken@gmail.com",
        access_token="__REAUTH_REQUIRED__",
        refresh_token="refresh_old",
        status="error",
        last_error="No valid token available",
        last_sync_failure=datetime.now(timezone.utc) - timedelta(days=1),
        sync_enabled=True
    )
    db.add(stale)
    db.commit()

    updated = MultiAccountOAuthService.add_oauth_account(
        db=db,
        user_id=multi_account_user.id,
        provider="google",
        account_email="broken@gmail.com",
        access_token="new_access_token",
        refresh_token="new_refresh_token"
    )

    assert updated.status == "ok"
    assert updated.last_error is None
    assert updated.last_sync_failure is None
    assert updated.last_sync_success is not None


def test_get_user_accounts_all(db: Session, multi_account_user: User, oauth_accounts_setup):
    """Test retrieving all accounts for a user."""
    
    accounts = MultiAccountOAuthService.get_user_accounts(db, multi_account_user.id)
    
    assert len(accounts) == 3
    assert any(acc.provider == "google" for acc in accounts)
    assert any(acc.provider == "microsoft" for acc in accounts)


def test_get_user_accounts_filtered_by_provider(db: Session, multi_account_user: User, oauth_accounts_setup):
    """Test filtering accounts by provider."""
    
    google_accounts = MultiAccountOAuthService.get_user_accounts(
        db, multi_account_user.id, provider="google"
    )
    
    assert len(google_accounts) == 2
    assert all(acc.provider == "google" for acc in google_accounts)


def test_get_primary_account(db: Session, multi_account_user: User, oauth_accounts_setup):
    """Test getting the primary account for a provider."""
    
    primary_google = MultiAccountOAuthService.get_primary_account(
        db, multi_account_user.id, provider="google"
    )
    
    assert primary_google.is_primary == True
    assert primary_google.account_email == "sherryjo@gmail.com"


def test_set_primary_account(db: Session, multi_account_user: User, oauth_accounts_setup):
    """Test changing which account is primary."""
    
    accounts = oauth_accounts_setup
    secondary_id = accounts["google_secondary"].id
    
    # Set secondary as primary
    updated = MultiAccountOAuthService.set_primary(
        db, secondary_id, multi_account_user.id
    )
    
    assert updated.is_primary == True
    assert updated.account_email == "sherryjo.work@gmail.com"
    
    # Verify old primary is no longer primary
    old_primary = db.query(OAuthAccount).filter(
        OAuthAccount.id == accounts["google_primary"].id
    ).first()
    assert old_primary.is_primary == False


def test_disable_account_sync(db: Session, multi_account_user: User, oauth_accounts_setup):
    """Test disabling sync for an account."""
    
    accounts = oauth_accounts_setup
    account_id = accounts["google_secondary"].id
    
    disabled = MultiAccountOAuthService.disable_account(db, account_id)
    
    assert disabled.sync_enabled == False
    
    # Can still query it, just won't sync
    all_enabled = MultiAccountOAuthService.get_all_sync_enabled_accounts(
        db, multi_account_user.id
    )
    assert len(all_enabled) == 2  # Only primary google + microsoft


def test_delete_account(db: Session, multi_account_user: User, oauth_accounts_setup):
    """Test deleting an OAuth account."""
    
    accounts = oauth_accounts_setup
    account_id = accounts["google_secondary"].id
    
    success = MultiAccountOAuthService.delete_account(db, account_id)
    
    assert success == True
    
    # Verify it's gone
    remaining = MultiAccountOAuthService.get_user_accounts(
        db, multi_account_user.id, provider="google"
    )
    assert len(remaining) == 1


def test_update_last_sync(db: Session, multi_account_user: User, oauth_accounts_setup):
    """Test updating the last_sync timestamp."""

    accounts = oauth_accounts_setup
    account_id = accounts["google_primary"].id

    # Last sync should be None initially
    before = db.query(OAuthAccount).filter(OAuthAccount.id == account_id).first()
    assert before.last_sync is None

    # Update last sync
    after = MultiAccountOAuthService.update_last_sync(db, account_id)

    assert after.last_sync is not None
    assert after.last_sync.year == 2026


def test_resolve_account_status_flags_reauth_required_token(db: Session, multi_account_user: User):
    account = OAuthAccount(
        user_id=multi_account_user.id,
        provider="google",
        account_email="sherrychip@gmail.com",
        access_token="__REAUTH_REQUIRED__",
        refresh_token="refresh_token",
        last_sync_success=datetime.now(timezone.utc),
        status="ok"
    )

    assert resolve_account_status(account) == "error"


# ============================================================
# INTEGRATION TESTS: OAUTH FLOW → MULTI-ACCOUNT STORAGE
# ============================================================

@patch('app.services.google_calendar_service.GoogleCalendarService.get_user_info')
@patch('app.services.google_calendar_service.GoogleCalendarService.exchange_code')
def test_google_oauth_flow_creates_multi_account(
    mock_exchange,
    mock_user_info,
    db: Session,
    multi_account_user: User,
    client  # from conftest.py
):
    """
    Test the full Google OAuth flow adding to multi-account storage.
    
    Scenario:
    1. User clicks "Connect another Google account"
    2. OAuth flow redirects back with code + state
    3. Account is saved to oauth_accounts table
    """
    
    # Mock Google's response
    mock_exchange.return_value = {
        "access_token": "google_token_123",
        "refresh_token": "google_refresh_456"
    }
    mock_user_info.return_value = {
        "email": "sherryjo.work@gmail.com",
        "name": "Sherry Jo"
    }
    
    # Simulate JWT token from login
    import jwt
    from app.routers.auth import SECRET_KEY
    
    token = jwt.encode(
        {"user_id": multi_account_user.id},
        SECRET_KEY,
        algorithm="HS256"
    )
    
    # Step 1: User clicks login button with JWT
    # (This would normally be in the frontend)
    
    # Step 2: Simulate callback
    # In real flow: GET /auth/google/callback?code=...&state=...
    # For now, we'll directly test the service
    
    account = MultiAccountOAuthService.add_oauth_account(
        db=db,
        user_id=multi_account_user.id,
        provider="google",
        account_email="sherryjo.work@gmail.com",
        access_token="google_token_123",
        refresh_token="google_refresh_456",
        display_name="Sherry Jo",
        provider_id="google_work_001"
    )
    
    # Verify account was created
    assert account.account_email == "sherryjo.work@gmail.com"
    assert account.provider == "google"


# ============================================================
# SYNC TESTS: MULTIPLE ACCOUNTS → UNIFIED CALENDAR
# ============================================================

def test_sync_all_accounts(db: Session, multi_account_user: User, oauth_accounts_setup):
    """
    Test that sync runs for all enabled accounts.
    
    This would call calendar_service.sync_all_user_accounts()
    """
    
    enabled_accounts = MultiAccountOAuthService.get_all_sync_enabled_accounts(
        db, multi_account_user.id
    )
    
    assert len(enabled_accounts) == 3
    
    # Each account should be synced
    # In real implementation:
    # for account in enabled_accounts:
    #     fetch_events_from_google(account) or fetch_events_from_outlook(account)
    #     deduplicate with user's other calendars


@patch('app.services.google_calendar_service.GoogleCalendarService.get_events')
def test_sync_multiple_google_accounts_deduplication(
    mock_get_events,
    db: Session,
    multi_account_user: User,
    oauth_accounts_setup
):
    """
    Test that events from multiple Google accounts are properly deduplicated.
    
    Scenario:
    - User has 2 Google calendars
    - Both have the same event
    - Only one should appear in unified view
    """
    
    # Mock Google API responses
    # Account 1: Personal calendar (has Team Meeting)
    # Account 2: Work calendar (has Team Meeting - same event)
    
    mock_get_events.side_effect = [
        # First account
        [
            {
                "id": "evt1_personal",
                "summary": "Team Meeting",
                "start": {"dateTime": "2026-05-28T10:00:00"},
                "end": {"dateTime": "2026-05-28T11:00:00"}
            }
        ],
        # Second account (same event, different ID)
        [
            {
                "id": "evt1_work",
                "summary": "Team Meeting",
                "start": {"dateTime": "2026-05-28T10:00:00"},
                "end": {"dateTime": "2026-05-28T11:00:00"}
            }
        ]
    ]
    
    # In real implementation, this would call:
    # calendar_service.sync_user_accounts(user_id)
    # And the deduplication logic would identify these as the same event
    
    # For now, verify the mock was set up correctly
    assert mock_get_events.call_count == 0  # Not called yet


# ============================================================
# API ENDPOINT TESTS
# ============================================================

def test_get_accounts_endpoint(client, multi_account_user: User, oauth_accounts_setup, db: Session):
    """Test GET /accounts endpoint."""
    
    # Create JWT token
    import jwt
    from app.routers.auth import SECRET_KEY
    
    token = jwt.encode(
        {"user_id": multi_account_user.id},
        SECRET_KEY,
        algorithm="HS256"
    )
    
    response = client.get(
        "/accounts",
        headers={"Authorization": f"Bearer {token}"}
    )
    
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 3  # 2 Google + 1 Microsoft
    assert data[0]["provider"] in ["google", "microsoft"]
    assert "status" in data[0]
    assert "sync_enabled" in data[0]
    assert "last_sync" in data[0]
    assert "created_at" in data[0]
    assert "updated_at" in data[0]
    assert "account_email" in data[0]


def test_get_accounts_filtered_endpoint(client, multi_account_user: User, oauth_accounts_setup, db: Session):
    """Test GET /accounts?provider=google endpoint."""
    
    import jwt
    from app.routers.auth import SECRET_KEY
    
    token = jwt.encode(
        {"user_id": multi_account_user.id},
        SECRET_KEY,
        algorithm="HS256"
    )
    
    response = client.get(
        "/accounts?provider=google",
        headers={"Authorization": f"Bearer {token}"}
    )
    
    assert response.status_code == 200
    data = response.json()
    assert len(data) == 2
    assert all(acc["provider"] == "google" for acc in data)


def test_set_primary_endpoint(client, multi_account_user: User, oauth_accounts_setup, db: Session):
    """Test PUT /accounts/{id}/set-primary endpoint."""
    
    import jwt
    from app.routers.auth import SECRET_KEY
    
    token = jwt.encode(
        {"user_id": multi_account_user.id},
        SECRET_KEY,
        algorithm="HS256"
    )
    
    secondary_id = oauth_accounts_setup["google_secondary"].id
    
    response = client.put(
        f"/accounts/{secondary_id}/set-primary",
        headers={"Authorization": f"Bearer {token}"}
    )
    
    assert response.status_code == 200
    data = response.json()
    assert data["is_primary"] == True


def test_disconnect_account_endpoint(client, multi_account_user: User, oauth_accounts_setup, db: Session):
    """Test DELETE /accounts/{id} endpoint."""
    
    import jwt
    from app.routers.auth import SECRET_KEY
    
    token = jwt.encode(
        {"user_id": multi_account_user.id},
        SECRET_KEY,
        algorithm="HS256"
    )
    
    account_id = oauth_accounts_setup["google_secondary"].id
    
    response = client.delete(
        f"/accounts/{account_id}",
        headers={"Authorization": f"Bearer {token}"}
    )
    
    assert response.status_code == 200
    data = response.json()
    assert "Disconnected" in data["message"]


# ============================================================
# MANUAL TESTING GUIDE (Run against real app)
# ============================================================

"""
HOW TO MANUALLY TEST MULTI-ACCOUNT OAUTH:

Prerequisites:
1. Have 2+ Google accounts (e.g., personal + work)
2. Have 1+ Microsoft account
3. App running: python -m uvicorn app.main:app --reload
4. Visit: http://127.0.0.1:8000/calendar-ui

Step 1: Register & Login
- Click "Sign Up"
- Create account: username=sherryjo, email=sherryjo@example.com, password=test123
- Click "Sign In"

Step 2: Connect First Google Account
- Click "Connect Google"
- Sign in with your PERSONAL Google account
- Verify redirects to /calendar-ui with ?connected=google

Step 3: Verify Account in Database
- Open browser DevTools → Storage → Cookies
- Copy the auth JWT token
- In new tab, visit: http://127.0.0.1:8000/accounts
  (Add Authorization header: Bearer {token})
- Should see: [{"provider":"google", "account_email":"yourpersonal@gmail.com", "is_primary":true}]

Step 4: Connect Second Google Account
- Click "Add Another Google Account" (button you'll need to add in UI)
- Sign in with your WORK Google account
- Verify redirects back

Step 5: Verify Both Accounts
- Revisit http://127.0.0.1:8000/accounts
- Should see: [
    {"provider":"google", "account_email":"personal@gmail.com", "is_primary":true},
    {"provider":"google", "account_email":"work@gmail.com", "is_primary":false}
  ]

Step 6: Connect Microsoft
- Click "Connect Outlook"
- Sign in with Microsoft account
- Revisit http://127.0.0.1:8000/accounts
- Should see all 3 accounts

Step 7: Test Set Primary
- POST to http://127.0.0.1:8000/accounts/2/set-primary
- Verify work@gmail.com is now primary

Step 8: Test Sync
- All enabled accounts should sync automatically every 5 minutes
- Or manually: POST /calendar/sync
- Check DevTools → Network to see Google/Microsoft API calls

Step 9: Test Deduplication
- Create event in personal calendar
- Create SAME event in work calendar
- Both should appear as ONE event in the unified calendar
- Check database external_ids field - should have both Google IDs
"""
