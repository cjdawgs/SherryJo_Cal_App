from sqlalchemy.orm import Session
from app.models import OAuthAccount
from app.services.multi_account_oauth_service import ensure_valid_token, normalize_provider


def _get_token(db: Session, user_id: int, provider: str, account_email: str):
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
    Handles new format {"google:user@gmail.com": "raw_id"} and
    legacy format {"google": "raw_id"}.
    """
    for id_key, raw_id in (external_ids or {}).items():
        if not raw_id or str(raw_id).startswith("fb:"):
            continue
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
        Update event locally and propagate to ALL provider accounts in external_ids.
        Provider failures are non-fatal.
        """
        if "title" in updates:
            event.title = updates["title"]
        if "start_time" in updates:
            event.start_time = updates["start_time"]
        if "end_time" in updates:
            event.end_time = updates["end_time"]
        db.commit()

        fallback_email = getattr(event, "account_email", None) or ""
        for provider, acct_email, raw_id in _iter_write_back_targets(event.external_ids, fallback_email):
            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    continue
                if provider == "google":
                    google_service.update_event(token=token, event_id=raw_id,
                                                updates=updates, account_email=acct_email or None)
                elif provider == "microsoft":
                    graph_client.update_event(token=token, event_id=raw_id, updates=updates)
            except Exception as e:
                print(f"WARNING: {provider} write-back update failed for {acct_email}: {e}")
        return event

    def delete_event(self, db: Session, event, google_service, graph_client, user):
        """
        Delete event from ALL provider accounts, then from local DB.
        Provider failures are non-fatal.
        """
        fallback_email = getattr(event, "account_email", None) or ""
        for provider, acct_email, raw_id in _iter_write_back_targets(event.external_ids, fallback_email):
            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    continue
                if provider == "google":
                    google_service.delete_event(token=token, event_id=raw_id,
                                                account_email=acct_email or None)
                elif provider == "microsoft":
                    graph_client.delete_event(token=token, event_id=raw_id)
            except Exception as e:
                print(f"WARNING: {provider} write-back delete failed for {acct_email}: {e}")
        db.delete(event)
        db.commit()
        return True

    def push_to_providers(self, db: Session, event, google_service, graph_client, user) -> int:
        """
        Push current local event state to ALL linked provider accounts.
        Does NOT modify the local DB. Used exclusively by the Publish action.
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
                    google_service.update_event(token=token, event_id=raw_id,
                                                updates=updates, account_email=acct_email or None)
                    pushed += 1
                elif provider == "microsoft":
                    graph_client.update_event(token=token, event_id=raw_id, updates=updates)
                    pushed += 1
            except Exception as e:
                print(f"WARNING: push_to_providers failed for {provider}:{acct_email}: {e}")
        return pushed
