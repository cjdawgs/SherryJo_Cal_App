# ==================================================
# TEST TOKEN HANDLER (AUTH / TOKEN LOGIC)
# ==================================================

"""
These tests verify:

✅ Tokens are stored correctly
✅ Expiration timestamps are created
✅ Expired tokens trigger refresh automatically

These are pure unit tests — no API, DB, or external calls
"""

from app.auth.token_handler import TokenHandler
import time


# ==================================================
# TEST: STORE TOKENS
# ==================================================

def test_store_tokens():
    """
    Ensure tokens are stored properly and expiration is calculated.
    """

    handler = TokenHandler()

    handler.store_tokens({
        "access_token": "abc",
        "refresh_token": "xyz",
        "expires_in": 3600
    })

    # ✅ Access token saved
    assert handler.token_data["access_token"] == "abc"

    # ✅ Expiration timestamp created
    assert "expires_at" in handler.token_data

    # ✅ Expiration is in the future
    assert handler.token_data["expires_at"] > time.time()


# ==================================================
# TEST: EXPIRED TOKEN TRIGGERS REFRESH
# ==================================================

def test_token_expiration_triggers_refresh():
    """
    If token is expired, handler should call refresh and return new token.
    """

    handler = TokenHandler()

    handler.store_tokens({
        "access_token": "old",
        "refresh_token": "refresh",
        "expires_in": -10  # ✅ already expired
    })

    # ✅ Mock refresh (simulate API returning new token)
    handler.refresh_access_token = lambda *args, **kwargs: "new_token"

    token = handler.get_access_token()

    # ✅ EXPECT refreshed token
    assert token == "new_token"