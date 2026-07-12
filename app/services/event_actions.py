from sqlalchemy.orm import Session
from app.models import OAuthAccount
from app.services.multi_account_oauth_service import ensure_valid_token


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