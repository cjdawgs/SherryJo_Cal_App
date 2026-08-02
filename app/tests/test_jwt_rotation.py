import json

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from jose import jwt
from jose.exceptions import ExpiredSignatureError, JWTClaimsError, JWTError

from app.config import settings
from app.security import create_persistent_token, create_token, decode_asymmetric_token, decode_token


def _keypair() -> tuple[str, str]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    private_pem = private_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    public_pem = private_key.public_key().public_bytes(
        serialization.Encoding.PEM,
        serialization.PublicFormat.SubjectPublicKeyInfo,
    ).decode()
    return private_pem, public_pem


def _configure_asymmetric(monkeypatch, active_kid: str, private_key: str, public_keys: dict[str, str]):
    monkeypatch.setattr(settings, "jwt_private_key", private_key, raising=False)
    monkeypatch.setattr(settings, "jwt_active_kid", active_kid, raising=False)
    monkeypatch.setattr(settings, "jwt_public_keys_json", json.dumps(public_keys), raising=False)
    monkeypatch.setattr(settings, "jwt_issuer", "https://auth.sherryjo.test", raising=False)
    monkeypatch.setattr(settings, "jwt_audience", "sherryjo-calendar-test", raising=False)
    monkeypatch.setattr(settings, "jwt_clock_skew_seconds", 5, raising=False)
    monkeypatch.setattr(settings, "jwt_max_lifetime_seconds", 3600, raising=False)


def test_asymmetric_token_contains_required_claims(monkeypatch):
    private_key, public_key = _keypair()
    _configure_asymmetric(monkeypatch, "key-1", private_key, {"key-1": public_key})

    token = create_token(42)
    payload = decode_asymmetric_token(token)

    assert jwt.get_unverified_header(token) == {"alg": "RS256", "kid": "key-1", "typ": "JWT"}
    assert payload["sub"] == "42"
    assert payload["user_id"] == 42
    assert all(payload.get(claim) is not None for claim in ("iss", "aud", "iat", "nbf", "exp", "jti"))


def test_old_and_new_public_keys_overlap_then_old_key_retires(monkeypatch):
    old_private, old_public = _keypair()
    new_private, new_public = _keypair()
    _configure_asymmetric(monkeypatch, "old", old_private, {"old": old_public})
    old_token = create_token(7)

    _configure_asymmetric(
        monkeypatch,
        "new",
        new_private,
        {"old": old_public, "new": new_public},
    )
    new_token = create_token(7)
    assert decode_asymmetric_token(old_token)["user_id"] == 7
    assert decode_asymmetric_token(new_token)["user_id"] == 7

    monkeypatch.setattr(settings, "jwt_public_keys_json", json.dumps({"new": new_public}), raising=False)
    with pytest.raises(JWTError, match="unknown"):
        decode_asymmetric_token(old_token)
    assert decode_asymmetric_token(new_token)["user_id"] == 7


def test_worker_compatible_verifier_rejects_legacy_hs256(monkeypatch):
    monkeypatch.setattr(settings, "jwt_private_key", None, raising=False)
    monkeypatch.setattr(settings, "jwt_active_kid", None, raising=False)
    legacy_token = create_token(3)
    persistent_token = create_persistent_token(3)

    assert decode_token(legacy_token)["user_id"] == 3
    with pytest.raises(JWTError, match="must use RS256"):
        decode_asymmetric_token(legacy_token)
    with pytest.raises(JWTError, match="must use RS256"):
        decode_asymmetric_token(persistent_token)


def test_asymmetric_verifier_rejects_wrong_audience_and_expiry(monkeypatch):
    private_key, public_key = _keypair()
    _configure_asymmetric(monkeypatch, "key-1", private_key, {"key-1": public_key})
    token = create_token(9)

    monkeypatch.setattr(settings, "jwt_audience", "wrong-audience", raising=False)
    with pytest.raises(JWTClaimsError):
        decode_asymmetric_token(token)

    monkeypatch.setattr(settings, "jwt_audience", "sherryjo-calendar-test", raising=False)
    expired = create_token(9, minutes=-1)
    with pytest.raises(ExpiredSignatureError):
        decode_asymmetric_token(expired)


def test_asymmetric_verifier_rejects_excessive_lifetime(monkeypatch):
    private_key, public_key = _keypair()
    _configure_asymmetric(monkeypatch, "key-1", private_key, {"key-1": public_key})

    token = create_token(9, minutes=61)

    with pytest.raises(JWTClaimsError, match="lifetime"):
        decode_asymmetric_token(token)


def test_asymmetric_verifier_rejects_array_audience(monkeypatch):
    private_key, public_key = _keypair()
    _configure_asymmetric(monkeypatch, "key-1", private_key, {"key-1": public_key})
    valid_payload = jwt.get_unverified_claims(create_token(9))
    valid_payload["aud"] = ["sherryjo-calendar-test"]
    token = jwt.encode(valid_payload, private_key, algorithm="RS256", headers={"kid": "key-1"})

    with pytest.raises(JWTClaimsError, match="exact string"):
        decode_asymmetric_token(token)


@pytest.mark.parametrize("claim", ["iat", "nbf"])
def test_asymmetric_verifier_rejects_future_time_claims(monkeypatch, claim):
    private_key, public_key = _keypair()
    _configure_asymmetric(monkeypatch, "key-1", private_key, {"key-1": public_key})
    valid_payload = jwt.get_unverified_claims(create_token(9))
    valid_payload[claim] += 10
    if claim == "iat":
        valid_payload["nbf"] = valid_payload["iat"]
    token = jwt.encode(valid_payload, private_key, algorithm="RS256", headers={"kid": "key-1"})

    with pytest.raises(JWTClaimsError):
        decode_asymmetric_token(token)


@pytest.mark.parametrize(
    ("subject", "user_id"),
    [
        ("0", 0),
        ("09", 9),
        ("9", 10),
        ("not-a-user", "not-a-user"),
    ],
)
def test_asymmetric_verifier_rejects_invalid_identity(monkeypatch, subject, user_id):
    private_key, public_key = _keypair()
    _configure_asymmetric(monkeypatch, "key-1", private_key, {"key-1": public_key})
    valid_payload = jwt.get_unverified_claims(create_token(9))
    valid_payload.update({"sub": subject, "user_id": user_id})
    token = jwt.encode(
        valid_payload,
        private_key,
        algorithm="RS256",
        headers={"kid": "key-1"},
    )

    with pytest.raises(JWTClaimsError, match="subject"):
        decode_asymmetric_token(token)


def test_asymmetric_signing_configuration_fails_closed(monkeypatch):
    private_key, _public_key = _keypair()
    monkeypatch.setattr(settings, "jwt_private_key", private_key, raising=False)
    monkeypatch.setattr(settings, "jwt_active_kid", None, raising=False)

    with pytest.raises(JWTError, match="requires both"):
        create_token(1)