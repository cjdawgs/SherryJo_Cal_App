from sqlalchemy.orm import Session
import hashlib
import logging
import uuid
from datetime import datetime, timezone
from app.models import Event, OAuthAccount, SyncOperationLedger
from app.services.multi_account_oauth_service import ensure_valid_token, normalize_provider

logger = logging.getLogger(__name__)

PUBLISH_OPERATION_TYPE = "calendar_publish"
PUBLISH_DELETE_OPERATION_TYPE = "calendar_publish_delete"


def _publish_operation_key(user_id: int, event_id: int, target_key: str) -> str:
    return f"calendar-publish:user:{user_id}:event:{event_id}:target:{target_key}"


def _publish_delete_operation_key(user_id: int, target_key: str, provider_event_id: str) -> str:
    value = f"{user_id}:{target_key}:{provider_event_id}".encode("utf-8")
    return f"calendar-publish-delete:{hashlib.sha256(value).hexdigest()[:32]}"


def _provider_create_identity(user_id: int, event_id: int, target_key: str, provider: str) -> str:
    digest = bytearray(hashlib.sha256(f"{user_id}:{event_id}:{target_key}".encode("utf-8")).digest())
    if provider == "google":
        alphabet = "0123456789abcdefghijklmnopqrstuv"
        return "sj" + "".join(alphabet[value & 31] for value in digest)[:24]
    digest[6] = (digest[6] & 0x0F) | 0x50
    digest[8] = (digest[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(digest[:16])))


def _queue_publish_target(db: Session, user_id: int, event_id: int, target_key: str) -> None:
    operation_key = _publish_operation_key(user_id, event_id, target_key)
    row = db.query(SyncOperationLedger).filter(SyncOperationLedger.operation_key == operation_key).first()
    if row is None:
        row = SyncOperationLedger(
            operation_key=operation_key,
            operation_type=PUBLISH_OPERATION_TYPE,
            owner_user_id=user_id,
            status="pending",
            attempt_count=0,
        )
        db.add(row)
    row.operation_type = PUBLISH_OPERATION_TYPE
    row.owner_user_id = user_id
    row.status = "pending"
    row.request_payload = {"event_id": event_id, "target_key": target_key}
    row.result_payload = None
    row.error_type = None
    row.error_message = None
    row.finished_at = None
    row.updated_at = datetime.now(timezone.utc)
    db.commit()


def _finish_publish_target(
    db: Session,
    user_id: int,
    event_id: int,
    target_key: str,
    *,
    succeeded: bool,
    result: dict | None = None,
    error: str = "",
) -> None:
    row = db.query(SyncOperationLedger).filter(
        SyncOperationLedger.operation_key == _publish_operation_key(user_id, event_id, target_key),
        SyncOperationLedger.owner_user_id == user_id,
    ).first()
    if row is None:
        return
    if row.status == "succeeded" and not succeeded:
        return
    now = datetime.now(timezone.utc)
    row.status = "succeeded" if succeeded else "retry_pending"
    row.attempt_count = int(row.attempt_count or 0) + 1
    row.result_payload = result
    row.error_type = None if succeeded else "ProviderPublishError"
    row.error_message = None if succeeded else str(error or "Publish failed")[:1000]
    row.started_at = row.started_at or now
    row.finished_at = now if succeeded else None
    row.updated_at = now
    db.commit()


def _queue_publish_delete(db: Session, user_id: int, target_key: str, provider_event_id: str) -> None:
    operation_key = _publish_delete_operation_key(user_id, target_key, provider_event_id)
    row = db.query(SyncOperationLedger).filter(SyncOperationLedger.operation_key == operation_key).first()
    if row is None:
        row = SyncOperationLedger(
            operation_key=operation_key,
            operation_type=PUBLISH_DELETE_OPERATION_TYPE,
            owner_user_id=user_id,
            status="pending",
            attempt_count=0,
        )
        db.add(row)
    row.status = "pending"
    row.request_payload = {"target_key": target_key, "provider_event_id": provider_event_id}
    row.result_payload = None
    row.error_type = None
    row.error_message = None
    row.finished_at = None
    row.updated_at = datetime.now(timezone.utc)
    db.commit()


def _finish_publish_delete(
    db: Session,
    user_id: int,
    target_key: str,
    provider_event_id: str,
    *,
    succeeded: bool,
    error: str = "",
) -> None:
    row = db.query(SyncOperationLedger).filter(
        SyncOperationLedger.operation_key == _publish_delete_operation_key(user_id, target_key, provider_event_id),
        SyncOperationLedger.owner_user_id == user_id,
    ).first()
    if row is None:
        return
    if row.status == "succeeded" and not succeeded:
        return
    now = datetime.now(timezone.utc)
    row.status = "succeeded" if succeeded else "retry_pending"
    row.attempt_count = int(row.attempt_count or 0) + 1
    row.result_payload = {"deleted": True} if succeeded else None
    row.error_type = None if succeeded else "ProviderDeleteError"
    row.error_message = None if succeeded else str(error or "Delete failed")[:1000]
    row.started_at = row.started_at or now
    row.finished_at = now if succeeded else None
    row.updated_at = now
    db.commit()


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


def _set_account_publish_status(db: Session, user_id: int, provider: str, account_email: str, *, ok: bool, message: str = "") -> None:
    """Reflect publish write outcome on the account row so UI remediation is accurate."""
    normalized_email = (account_email or "").lower().strip()
    query = db.query(OAuthAccount).filter(
        OAuthAccount.user_id == user_id,
        OAuthAccount.provider == provider,
    )
    if normalized_email:
        query = query.filter(OAuthAccount.account_email == normalized_email)

    account = query.order_by(OAuthAccount.id.desc()).first()
    if not account:
        return

    now = datetime.now(timezone.utc)
    if ok:
        account.status = "ok"
        account.last_error = None
        account.last_sync_success = now
        account.last_sync_failure = None
    else:
        account.status = "error"
        account.last_error = str(message or "Publish failed")[:512]
        account.last_sync_failure = now

    db.commit()


class EventActions:

    def replay_pending_publishes(self, db: Session, user, target_key: str, google_service, graph_client) -> dict:
        normalized_targets = _normalize_target_keys(type("Target", (), {"external_ids": {}})(), [target_key])
        if len(normalized_targets) != 1:
            raise ValueError("A valid Google or Microsoft target_key is required")
        normalized_target = next(iter(normalized_targets))
        rows = db.query(SyncOperationLedger).filter(
            SyncOperationLedger.owner_user_id == user.id,
            SyncOperationLedger.operation_type.in_((PUBLISH_OPERATION_TYPE, PUBLISH_DELETE_OPERATION_TYPE)),
            SyncOperationLedger.status.in_(("pending", "retry_pending")),
        ).order_by(SyncOperationLedger.created_at, SyncOperationLedger.operation_key).all()
        pending_rows = [
            row for row in rows
            if str((row.request_payload or {}).get("target_key") or "").lower() == normalized_target
        ]
        event_ids = sorted({
            int((row.request_payload or {}).get("event_id"))
            for row in pending_rows
            if str((row.request_payload or {}).get("event_id") or "").isdigit()
            and row.operation_type == PUBLISH_OPERATION_TYPE
        })
        pending_deletes = [
            row for row in pending_rows
            if row.operation_type == PUBLISH_DELETE_OPERATION_TYPE
            and (row.request_payload or {}).get("provider_event_id")
        ]
        if not event_ids and not pending_deletes:
            return {"status": "success", "replayed": 0, "published": 0, "created": 0, "failed": 0, "warnings": []}

        events = db.query(Event).filter(Event.owner_id == user.id, Event.id.in_(event_ids)).all()
        found_ids = {event.id for event in events}
        for row in pending_rows:
            if row.operation_type != PUBLISH_OPERATION_TYPE:
                continue
            event_id = int((row.request_payload or {}).get("event_id") or 0)
            if event_id not in found_ids:
                row.status = "dead_letter"
                row.error_type = "EventNotFound"
                row.error_message = "Local event no longer exists"
                row.finished_at = datetime.now(timezone.utc)
        db.commit()

        published = 0
        created = 0
        failed = 0
        warnings = []
        account_results = []
        for row in pending_deletes:
            payload = row.request_payload or {}
            delete_result = self.delete_external_targets(
                db,
                user,
                {normalized_target: payload["provider_event_id"]},
                google_service,
                graph_client,
            )
            deleted_count = int(delete_result.get("deleted") or 0)
            failed += 0 if deleted_count else 1
            warnings.extend(delete_result.get("warnings") or [])
        for event in events:
            result = self.push_to_providers(
                db, event, google_service, graph_client, user,
                selected_account_keys=[normalized_target],
            )
            event_successes = int(result.get("updated") or 0) + int(result.get("created") or 0)
            published += 1 if event_successes else 0
            created += int(result.get("created") or 0)
            failed += 0 if event_successes else 1
            warnings.extend(result.get("warnings") or [])
            account_results.extend(result.get("account_results") or [])

        return {
            "status": "success",
            "replayed": len(event_ids) + len(pending_deletes),
            "published": published,
            "created": created,
            "deleted": sum(1 for row in pending_deletes if row.status == "succeeded"),
            "failed": failed,
            "warnings": warnings,
            "account_results": account_results,
        }

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
        succeeded_targets = []

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

            _queue_publish_target(db, user.id, event.id, target_key)
            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    target_result["status"] = "no_token"
                    target_result["message"] = f"No valid token for {target_key}"
                    account_results.append(target_result)
                    warnings.append(target_result["message"])
                    _finish_publish_target(
                        db, user.id, event.id, target_key,
                        succeeded=False, error=target_result["message"],
                    )
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
                        _set_account_publish_status(db, user.id, provider, acct_email, ok=True)
                        succeeded_targets.append((target_key, target_result.copy()))
                        account_results.append(target_result)
                        continue

                    if not _is_missing_provider_event(update_result):
                        target_result["status"] = "update_failed"
                        target_result["message"] = f"Update failed for {target_key} (status {update_result})"
                        _set_account_publish_status(db, user.id, provider, acct_email, ok=False, message=target_result["message"])
                        account_results.append(target_result)
                        warnings.append(target_result["message"])
                        _finish_publish_target(
                            db, user.id, event.id, target_key,
                            succeeded=False, error=target_result["message"],
                        )
                        continue

                    external_ids.pop(target_key, None)
                    raw_id = None
                    target_result["action"] = "recreate"

                new_raw_id = None
                create_error = None
                create_identity = _provider_create_identity(user.id, event.id, target_key, provider)
                if provider == "google":
                    new_raw_id = google_service.create_event(token=token, event_payload=updates,
                                                             account_email=acct_email or None,
                                                             create_identity=create_identity)
                elif provider == "microsoft":
                    try:
                        new_raw_id = graph_client.create_event(
                            token=token, event_payload=updates, raise_on_error=True,
                            transaction_id=create_identity,
                        )
                    except Exception as exc:
                        create_error = exc
                        if _is_retryable_microsoft_create_error(exc):
                            retry_token = _get_token(db, user.id, provider, acct_email)
                            if retry_token and retry_token != token:
                                logger.info("Retrying Microsoft create for %s after token refresh.", target_key)
                                new_raw_id = graph_client.create_event(
                                    token=retry_token, event_payload=updates, raise_on_error=True,
                                    transaction_id=create_identity,
                                )
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
                    _set_account_publish_status(db, user.id, provider, acct_email, ok=True)
                    succeeded_targets.append((target_key, target_result.copy()))
                else:
                    target_result["status"] = "create_failed"
                    target_result["message"] = f"Create failed for {target_key}: provider returned no event id"
                    _set_account_publish_status(db, user.id, provider, acct_email, ok=False, message=target_result["message"])
                    warnings.append(target_result["message"])
                    _finish_publish_target(
                        db, user.id, event.id, target_key,
                        succeeded=False, error=target_result["message"],
                    )
                account_results.append(target_result)
            except Exception as e:
                logger.warning(f"WARNING: push_to_providers failed for {provider}:{acct_email}: {e}")
                target_result["status"] = "failed"
                target_result["message"] = f"Publish failed for {target_key}: {e}"
                _set_account_publish_status(db, user.id, provider, acct_email, ok=False, message=target_result["message"])
                account_results.append(target_result)
                warnings.append(target_result["message"])
                _finish_publish_target(
                    db, user.id, event.id, target_key,
                    succeeded=False, error=target_result["message"],
                )

        if external_ids != (getattr(event, "external_ids", None) or {}):
            event.external_ids = external_ids
            db.commit()

        for target_key, target_result in succeeded_targets:
            _finish_publish_target(
                db, user.id, event.id, target_key,
                succeeded=True,
                result={"action": target_result["status"], "provider_event_id": external_ids.get(target_key)},
            )

        return {
            "updated": pushed,
            "created": created,
            "affected_accounts": sorted(set(affected_accounts)),
            "warnings": warnings,
            "account_results": account_results,
        }

    def delete_external_targets(self, db: Session, user, external_ids: dict, google_service, graph_client) -> dict:
        deleted = 0
        failed = 0
        affected_accounts = []
        warnings = []

        for provider, acct_email, raw_id in _iter_write_back_targets(external_ids or {}, ""):
            target_key = f"{provider}:{(acct_email or '').lower().strip()}"
            _queue_publish_delete(db, user.id, target_key, str(raw_id))

            try:
                token = _get_token(db, user.id, provider, acct_email)
                if not token:
                    message = f"No valid token for {target_key}"
                    failed += 1
                    warnings.append(message)
                    _finish_publish_delete(
                        db, user.id, target_key, str(raw_id), succeeded=False, error=message,
                    )
                    continue

                if provider == "google":
                    delete_status = google_service.delete_event(
                        token=token, event_id=raw_id, account_email=acct_email or None,
                    )
                elif provider == "microsoft":
                    delete_status = graph_client.delete_event(token=token, event_id=raw_id)
                else:
                    warnings.append(f"Delete publish not supported for {target_key}")
                    continue

                if delete_status is not None and delete_status not in (200, 204, 404, 410):
                    raise RuntimeError(f"Provider delete returned status {delete_status}")

                deleted += 1
                affected_accounts.append(target_key)
                _finish_publish_delete(db, user.id, target_key, str(raw_id), succeeded=True)
            except Exception as e:
                failed += 1
                logger.warning(f"WARNING: delete publish failed for {target_key}: {e}")
                message = f"Delete failed for {target_key}: {e}"
                warnings.append(message)
                _finish_publish_delete(
                    db, user.id, target_key, str(raw_id), succeeded=False, error=message,
                )

        return {
            "deleted": deleted,
            "failed": failed,
            "affected_accounts": sorted(set(affected_accounts)),
            "warnings": warnings,
        }
