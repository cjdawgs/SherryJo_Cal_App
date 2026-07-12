from sqlalchemy.orm import Session
from app.models import OAuthAccount
from app.services.multi_account_oauth_service import ensure_valid_token, normalize_provider


def _get_token(db: Session, user_id: int, provider: str, account_email: str) -> str | None:
    """Return a valid access token for the given provider + account, or None."""
    account_email_lower = (account_email or "").lower().strip()
    account = db.query(OAuthAccount).filter(
        OAuthAccount.user_id == user_id,
        OAuthAccount.provider == provider,
        OAuthAccount.account_email == account_email_lower,
    ).first()
    if not account:
        account = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
        ).first()
    if not account:
        return None
    return ensure_valid_token(db, account)


def _iter_write_back_targets(external_ids: dict, fallback_account_email: str):
    """
    Yield (provider, account_email, raw_id) for every write-back target.

    Handles both:
      New format: {"google:user@gmail.com": "raw_id"}
      Legacy format: {"google": "raw_id"}   (no account email in key)
    """
    for id_key, raw_id in (external_ids or {}).items():
        if not raw_id or str(raw_id).startswith("fb:"):
            continue  # synthetic fallback IDs are not real provider IDs

        if ":" in id_key:
            provider_part, email_part = id_key.split(":", 1)
            provider = normalize_provider(provider_part)
            acct_email = email_part
        else:
            provider = normalize_provider(id_key)
            acct_email = fallback_account_email or ""

        if provider not in ("google", "microsoft"):
            continue

        yield provider, acct_email, raw_id


class EventActions:

    def update_event(self, db: Session, event, updates, google_service, graph_client, user):
        """
        Update event locally and propagate to ALL provider accounts recorded
        in external_ids.  Tokens resolved via OAuthAccount.  Provider failures
        are non-fatal — local update always wins.
        """

        # ── STEP 1: LOCAL DATABASE ──────────────────────────────────────────
        if "title" in updates:
            event.title = updates["title"]
        if "start_time" in updates:
            event.start_time = updates["start_time"]
        if "end_time" in updates:
            event.end_time = updates["end_time"]
        db.commit()

        # ── STEP 2: ALL PROVIDER ACCOUNTS ──────────────────────────────────
        fallback_email = getattr(event, "account_email", None) or ""
        for provider, acct_email, raw_id in _iter_write_back_targets(event.external_ids, fallback_email):
            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    continue
                if provider == "google":
                    google_service.update_event(
                        token=token,
                        event_id=raw_id,
                        updates=updates,
                        account_email=acct_email or None,
                    )
                elif provider == "microsoft":
                    graph_client.update_event(
                        token=token,
                        event_id=raw_id,
                        updates=updates,
                    )
            except Exception as e:
                print(f"⚠️ {provider} write-back update failed for {acct_email} (non-fatal): {e}")

        return event

    def delete_event(self, db: Session, event, google_service, graph_client, user):
        """
        Delete event from ALL provider accounts, then from local DB.
        Provider failures are non-fatal — local delete always completes.
        """

        # ── STEP 1: ALL PROVIDER ACCOUNTS ──────────────────────────────────
        fallback_email = getattr(event, "account_email", None) or ""
        for provider, acct_email, raw_id in _iter_write_back_targets(event.external_ids, fallback_email):
            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    continue
                if provider == "google":
                    google_service.delete_event(
                        token=token,
                        event_id=raw_id,
                        account_email=acct_email or None,
                    )
                elif provider == "microsoft":
                    graph_client.delete_event(
                        token=token,
                        event_id=raw_id,
                    )
            except Exception as e:
                print(f"⚠️ {provider} write-back delete failed for {acct_email} (non-fatal): {e}")

        # ── STEP 2: LOCAL DATABASE ──────────────────────────────────────────
        db.delete(event)
        db.commit()

        return True

    def push_to_providers(self, db: Session, event, google_service, graph_client, user) -> int:
        """
        Push the current local event state to ALL linked provider accounts
        WITHOUT modifying the local DB.  Used by the Publish action.
        Returns the number of provider accounts successfully updated.
        """
        updates = {"title": event.title}
        if event.start_time:
            updates["start_time"] = event.start_time
        if event.end_time:
            updates["end_time"] = event.end_time

        pushed = 0
        fallback_email = getattr(event, "account_email", None) or ""
        for provider, acct_email, raw_id in _iter_write_back_targets(event.external_ids, fallback_email):
            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    continue
                if provider == "google":
                    google_service.update_event(
                        token=token,
                        event_id=raw_id,
                        updates=updates,
                        account_email=acct_email or None,
                    )
                    pushed += 1
                elif provider == "microsoft":
                    graph_client.update_event(
                        token=token,
                        event_id=raw_id,
                        updates=updates,
                    )
                    pushed += 1
            except Exception as e:
                print(f"⚠️ push_to_providers failed for {provider}:{acct_email}: {e}")

        return pushed


def _get_token(db: Session, user_id: int, provider: str, account_email: str) -> str | None:
    """Return a valid access token for the given provider + account, or None."""
    account_email_lower = (account_email or "").lower().strip()
    account = db.query(OAuthAccount).filter(
        OAuthAccount.user_id == user_id,
        OAuthAccount.provider == provider,
        OAuthAccount.account_email == account_email_lower,
    ).first()
    if not account:
        # Fallback: any account for this provider belonging to the user
        account = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
        ).first()
    if not account:
        return None
    return ensure_valid_token(db, account)


class EventActions:

    def update_event(self, db: Session, event, updates, google_service, graph_client, user):
        """
        Update event locally and propagate to providers.
        Tokens resolved via OAuthAccount (not legacy User fields).
        Provider failures are non-fatal — local update always wins.
        """

        # ===============================
        # STEP 1: UPDATE LOCAL DATABASE
        # ===============================
        if "title" in updates:
            event.title = updates["title"]

        if "start_time" in updates:
            event.start_time = updates["start_time"]

        if "end_time" in updates:
            event.end_time = updates["end_time"]

        db.commit()

        account_email = getattr(event, "account_email", None) or ""

        # ===============================
        # STEP 2: UPDATE GOOGLE
        # ===============================
        if event.external_ids and "google" in event.external_ids:
            try:
                token = _get_token(db, user.id, "google", account_email)
                if token:
                    google_service.update_event(
                        token=token,
                        event_id=event.external_ids["google"],
                        updates=updates,
                        account_email=account_email or None,
                    )
            except Exception as e:
                print(f"⚠️ Google write-back failed (non-fatal): {e}")

        # ===============================
        # STEP 3: UPDATE MICROSOFT
        # ===============================
        ms_id = None
        if event.external_ids:
            ms_id = (
                event.external_ids.get("microsoft")
                or event.external_ids.get("outlook")
            )

        if ms_id:
            try:
                token = _get_token(db, user.id, "microsoft", account_email)
                if token:
                    graph_client.update_event(
                        token=token,
                        event_id=ms_id,
                        updates=updates,
                    )
            except Exception as e:
                print(f"⚠️ Microsoft write-back failed (non-fatal): {e}")

        return event

    def delete_event(self, db: Session, event, google_service, graph_client, user):
        """
        Delete event from providers, then from local DB.
        Provider failures are non-fatal — local delete always completes.
        """

        account_email = getattr(event, "account_email", None) or ""

        # =============================================================
        # STEP 1: DELETE FROM GOOGLE
        # =============================================================
        if event.external_ids and "google" in event.external_ids:
            try:
                token = _get_token(db, user.id, "google", account_email)
                if token:
                    google_service.delete_event(
                        token=token,
                        event_id=event.external_ids["google"],
                        account_email=account_email or None,
                    )
            except Exception as e:
                print(f"⚠️ Google delete write-back failed (non-fatal): {e}")

        # =============================================================
        # STEP 2: DELETE FROM MICROSOFT
        # =============================================================
        ms_id = None
        if event.external_ids:
            ms_id = (
                event.external_ids.get("microsoft")
                or event.external_ids.get("outlook")
            )

        if ms_id:
            try:
                token = _get_token(db, user.id, "microsoft", account_email)
                if token:
                    graph_client.delete_event(
                        token=token,
                        event_id=ms_id,
                    )
            except Exception as e:
                print(f"⚠️ Microsoft delete write-back failed (non-fatal): {e}")

        # =============================================================
        # STEP 3: DELETE FROM DATABASE
        # =============================================================
        db.delete(event)
        db.commit()

        return True
        """
        ✅ PURPOSE:
        Update event BOTH:
        - locally (your database)
        - remotely (Google + Outlook)

        ✅ WHY THIS IS IMPORTANT:
        This is what makes your app a "controller" of calendars
        """

        # ===============================
        # ✅ STEP 1: UPDATE LOCAL DATABASE
        # ===============================
        if "title" in updates:
            event.title = updates["title"]

        if "start_time" in updates:
            event.start_time = updates["start_time"]

        if "end_time" in updates:
            event.end_time = updates["end_time"]

        db.commit()

        # ===============================
        # ✅ STEP 2: UPDATE GOOGLE
        # ===============================
        # Only if event came from Google
        if event.external_ids and "google" in event.external_ids:

            google_service.update_event(
                token=user.google_access_token,
                event_id=event.external_ids["google"],
                updates=updates
            )

        # ===============================
        # ✅ STEP 3: UPDATE MICROSOFT (SAFE + CANONICAL)
        # ===============================
        # --------------------------------------------------
        # PURPOSE:
        # Handle BOTH legacy ("outlook") and canonical ("microsoft")
        #
        # WHY:
        # Your system is migrating to "microsoft"
        # but older DB entries may still use "outlook"
        # --------------------------------------------------

        ms_id = None

        if event.external_ids:
            ms_id = (
                event.external_ids.get("microsoft")  # ✅ NEW STANDARD
                or event.external_ids.get("outlook")  # ✅ LEGACY FALLBACK
            )

        # ✅ ONLY RUN IF FOUND
        if ms_id:
            print("🧪 MICROSOFT UPDATE →", ms_id)  # ✅ DEBUG

            graph_client.update_event(
                token=user.ms_access_token,
                event_id=ms_id,
                updates=updates
            )

        return event


    def delete_event(self, db, event, google_service, graph_client, user):
        """
        ✅ PURPOSE:
        Delete an event across ALL systems

        ✅ WHAT HAPPENS:
        1. Delete from Google
        2. Delete from Outlook
        3. Delete from local DB
        """

        # =============================================================
        # ✅ STEP 1: DELETE FROM GOOGLE
        # =============================================================
        if event.external_ids and "google" in event.external_ids:

            google_service.delete_event(
                token=user.google_access_token,
                event_id=event.external_ids["google"]
            )

        # =============================================================
        # ✅ STEP 2: DELETE FROM MICROSOFT (SAFE + CANONICAL)
        # =============================================================
        ms_id = None

        if event.external_ids:
            ms_id = (
                event.external_ids.get("microsoft")
                or event.external_ids.get("outlook")
            )

        if ms_id:
            print("🧪 MICROSOFT DELETE →", ms_id)  # ✅ DEBUG

            graph_client.delete_event(
                token=user.ms_access_token,
                event_id=ms_id
            )

        # =============================================================
        # ✅ STEP 3: DELETE FROM DATABASE
        # =============================================================
        db.delete(event)
        db.commit()

        return True