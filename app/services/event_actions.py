from sqlalchemy.orm import Session
import logging
from app.models import OAuthAccount
from app.services.multi_account_oauth_service import ensure_valid_token, normalize_provider

logger = logging.getLogger(__name__)


def _get_token(db: Session, user_id: int, provider: str, account_email: str):
    """Return a valid access token for the given provider + account, or None."""
    account_email_lower = (account_email or "").lower().strip()
    query = db.query(OAuthAccount).filter(
        OAuthAccount.user_id == user_id,
        OAuthAccount.provider == provider,
    )

    candidates = []
    if account_email_lower:
        candidates = query.filter(OAuthAccount.account_email == account_email_lower).all()

    if account_email_lower and not candidates:
        return None

    if not candidates:
        candidates = db.query(OAuthAccount).filter(
            OAuthAccount.user_id == user_id,
            OAuthAccount.provider == provider,
        ).all()

    def _rank(account: OAuthAccount):
        token_value = (getattr(account, "access_token", "") or "").strip()
        return (
            1 if getattr(account, "status", None) == "ok" else 0,
            1 if token_value and token_value != "__REAUTH_REQUIRED__" else 0,
            1 if getattr(account, "last_sync_success", None) else 0,
            int(getattr(account, "id", 0) or 0),
        )

    for account in sorted(candidates, key=_rank, reverse=True):
        if (getattr(account, "access_token", "") or "").strip() == "__REAUTH_REQUIRED__":
            continue
        token = ensure_valid_token(db, account)
        if token:
            return token

    return None


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


def _normalize_target_keys(event, selected_account_keys=None):
    normalized = set()
    if selected_account_keys:
        for key in selected_account_keys:
            if not isinstance(key, str) or ":" not in key:
                continue
            provider_part, email_part = key.split(":", 1)
            provider = normalize_provider(provider_part)
            account_email = (email_part or "").lower().strip()
            if provider and account_email:
                normalized.add(f"{provider}:{account_email}")
    if normalized:
        return normalized

    external_ids = dict(getattr(event, "external_ids", None) or {})
    return {
        f"{normalize_provider(provider_part)}:{(email_part or '').lower().strip()}"
        for raw_key in external_ids.keys()
        if isinstance(raw_key, str) and ":" in raw_key
        for provider_part, email_part in [raw_key.split(":", 1)]
        if normalize_provider(provider_part) in ("google", "microsoft") and (email_part or "").strip()
    }


def _build_publish_updates(event):
    updates = {"title": event.title, "description": event.description or ""}
    if event.start_time:
        updates["start_time"] = event.start_time
    if event.end_time:
        updates["end_time"] = event.end_time
    return updates


def _is_update_success(result):
    if isinstance(result, bool):
        return result
    if isinstance(result, int):
        return 200 <= result < 300
    if result is None:
        return True
    return bool(result)


def _is_missing_provider_event(result):
    return isinstance(result, int) and result in {404, 410}


def _is_retryable_microsoft_create_error(exc: Exception) -> bool:
    message = str(exc or "").lower()
    retryable_markers = (
        "invalidauthenticationtoken",
        "token expired",
        "temporarily unavailable",
        "gateway timeout",
        "request timeout",
        "timeout",
        "service unavailable",
        "too many requests",
        "503",
        "504",
        "429",
    )
    return any(marker in message for marker in retryable_markers)


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
                logger.warning(f"WARNING: {provider} write-back update failed for {acct_email}: {e}")
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
                logger.warning(f"WARNING: {provider} write-back delete failed for {acct_email}: {e}")
        db.delete(event)
        db.commit()
        return True

    def push_to_providers(self, db: Session, event, google_service, graph_client, user, selected_account_keys=None) -> dict:
        """
        Push current local event state to ALL linked provider accounts.
        Does NOT modify the local DB. Used exclusively by the Publish action.
        Creates missing provider copies for selected supported accounts.
        Returns per-account publish details.
        """
        updates = _build_publish_updates(event)
        external_ids = dict(getattr(event, "external_ids", None) or {})
        targets = _normalize_target_keys(event, selected_account_keys=selected_account_keys)

        pushed = 0
        created = 0
        affected_accounts = []
        warnings = []
        account_results = []

        if not targets:
            warnings.append(f"No publishable targets resolved for event {getattr(event, 'id', 'unknown')}")
            return {
                "updated": 0,
                "created": 0,
                "affected_accounts": [],
                "warnings": warnings,
                "account_results": [],
            }

        for target_key in sorted(targets):
            provider, acct_email = target_key.split(":", 1)
            provider = normalize_provider(provider)
            raw_id = external_ids.get(target_key)
            target_result = {
                "target_key": target_key,
                "provider": provider,
                "account_email": acct_email,
                "linked": bool(raw_id),
                "action": "update" if raw_id else "create",
                "ok": False,
                "status": "pending",
                "message": "",
            }

            if provider not in ("google", "microsoft"):
                target_result["status"] = "unsupported"
                target_result["message"] = f"Publish not supported for {target_key}"
                account_results.append(target_result)
                warnings.append(target_result["message"])
                continue

            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    target_result["status"] = "no_token"
                    target_result["message"] = f"No valid token for {target_key}"
                    account_results.append(target_result)
                    warnings.append(target_result["message"])
                    continue

                if raw_id:
                    if provider == "google":
                        update_result = google_service.update_event(token=token, event_id=raw_id,
                                                                    updates=updates, account_email=acct_email or None)
                    elif provider == "microsoft":
                        update_result = graph_client.update_event(token=token, event_id=raw_id, updates=updates)

                    if _is_update_success(update_result):
                        pushed += 1
                        affected_accounts.append(target_key)
                        target_result["ok"] = True
                        target_result["status"] = "updated"
                        target_result["message"] = f"Updated {target_key}"
                        account_results.append(target_result)
                        continue

                    if not _is_missing_provider_event(update_result):
                        target_result["status"] = "update_failed"
                        target_result["message"] = f"Update failed for {target_key} (status {update_result})"
                        account_results.append(target_result)
                        warnings.append(target_result["message"])
                        continue

                    external_ids.pop(target_key, None)
                    raw_id = None
                    target_result["action"] = "recreate"

                new_raw_id = None
                create_error = None
                if provider == "google":
                    new_raw_id = google_service.create_event(token=token, event_payload=updates,
                                                             account_email=acct_email or None)
                elif provider == "microsoft":
                    try:
                        new_raw_id = graph_client.create_event(token=token, event_payload=updates)
                    except Exception as exc:
                        create_error = exc
                        if _is_retryable_microsoft_create_error(exc):
                            retry_token = _get_token(db, user.id, provider, acct_email)
                            if retry_token and retry_token != token:
                                logger.info("Retrying Microsoft create for %s after token refresh.", target_key)
                                new_raw_id = graph_client.create_event(token=retry_token, event_payload=updates)
                                create_error = None
                            else:
                                logger.info("Microsoft create retry skipped for %s; no newer token available.", target_key)
                        if create_error is not None:
                            raise create_error

                if new_raw_id:
                    external_ids[target_key] = new_raw_id
                    created += 1
                    affected_accounts.append(target_key)
                    target_result["ok"] = True
                    target_result["status"] = "created"
                    target_result["message"] = f"Created {target_key}"
                else:
                    target_result["status"] = "create_failed"
                    target_result["message"] = f"Create failed for {target_key}: provider returned no event id"
                    warnings.append(target_result["message"])
                account_results.append(target_result)
            except Exception as e:
                logger.warning(f"WARNING: push_to_providers failed for {provider}:{acct_email}: {e}")
                target_result["status"] = "failed"
                target_result["message"] = f"Publish failed for {target_key}: {e}"
                account_results.append(target_result)
                warnings.append(target_result["message"])

        if external_ids != (getattr(event, "external_ids", None) or {}):
            event.external_ids = external_ids
            db.commit()

        return {
            "updated": pushed,
            "created": created,
            "affected_accounts": sorted(set(affected_accounts)),
            "warnings": warnings,
            "account_results": account_results,
        }

    def delete_external_targets(self, db: Session, user, external_ids: dict, google_service, graph_client) -> dict:
        deleted = 0
        affected_accounts = []
        warnings = []

        for provider, acct_email, raw_id in _iter_write_back_targets(external_ids or {}, ""):
            target_key = f"{provider}:{(acct_email or '').lower().strip()}"

            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    warnings.append(f"No valid token for {target_key}")
                    continue

                if provider == "google":
                    google_service.delete_event(token=token, event_id=raw_id, account_email=acct_email or None)
                elif provider == "microsoft":
                    graph_client.delete_event(token=token, event_id=raw_id)
                else:
                    warnings.append(f"Delete publish not supported for {target_key}")
                    continue

                deleted += 1
                affected_accounts.append(target_key)
            except Exception as e:
                logger.warning(f"WARNING: delete publish failed for {target_key}: {e}")
                warnings.append(f"Delete failed for {target_key}: {e}")

        return {
            "deleted": deleted,
            "affected_accounts": sorted(set(affected_accounts)),
            "warnings": warnings,
        }
