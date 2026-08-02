# JWT asymmetric transition decision

Date: 2026-08-02  
Status: Opt-in implementation and rotation tests complete; production signing remains HS256.

## Context

The application currently signs and verifies HS256 JWTs with one Render secret. Normal tokens contain `user_id` and a one-hour `exp`; TV paths can issue persistent tokens without `exp`. Tokens do not currently bind issuer, audience, key ID, issued-at time, or not-before time.

Copying the HS256 secret to Cloudflare would let a Worker compromise mint administrator-equivalent application tokens. Worker-native authentication therefore requires asymmetric signing first.

## Decision

- Render remains the sole token signer.
- Use an asymmetric algorithm supported consistently by Python JOSE and Cloudflare Web Crypto. Prefer `RS256` for broad interoperability unless implementation tests justify `EdDSA`.
- Render and Cloudflare verify with public keys selected by `kid`; Cloudflare never receives a private key.
- New access tokens must contain `sub`, `iss`, `aud`, `iat`, `nbf`, `exp`, `jti`, and `kid`. Keep `user_id` only during compatibility migration if existing application code still requires it.
- Issuer and audience are exact allowlists, not values inferred from request headers.
- Access tokens remain short lived. Persistent no-expiry JWTs must not be accepted by Worker-native routes and should later be replaced with revocable device credentials.

## Migration sequence

1. Add configuration for issuer, audience, active private-key ID, private key, and a public verification keyring.
2. Add a verifier that accepts current HS256 tokens only on Render and new asymmetric tokens on Render. It must reject algorithm confusion, missing claims, unknown `kid`, wrong issuer/audience, expiry, future `nbf`/`iat`, and excessive clock skew.
3. Keep signing HS256 while verifier tests and deployment configuration are validated.
4. Publish the new public key to Render and Cloudflare configuration. Cloudflare routes remain proxy-only.
5. Switch Render signing to the new asymmetric key. Existing HS256 access tokens remain accepted by Render for no longer than their maximum lifetime plus configured skew.
6. Never grant Worker-native access to an HS256 token. During overlap, such requests continue to proxy to Render.
7. Remove HS256 verification after the overlap window and force reauthentication for any persistent legacy token class that cannot expire naturally.
8. Exercise add/verify/retire rotation with a second asymmetric key before approving Worker-native authentication.

## Verification requirements

- Valid active and overlap keys.
- Unknown, missing, duplicate, and retired `kid` values.
- `alg=none`, HS/RS confusion, and every non-allowlisted algorithm.
- Missing or wrong issuer/audience.
- Expired token, future `nbf`, future `iat`, excessive lifetime, and boundary clock skew.
- Missing `sub`, invalid user identifier, and revoked/disabled user.
- Legacy HS256 accepted only by the Render overlap verifier and rejected by Worker-native routes.
- Persistent legacy TV token rejected by Worker-native routes.

## Implementation evidence

`app/security.py` now supports Render-only RS256 signing when both `JWT_PRIVATE_KEY` and `JWT_ACTIVE_KID` are configured. `JWT_PUBLIC_KEYS_JSON` supplies the verification keyring, and the strict asymmetric verifier requires the documented claims while rejecting unknown keys and HS256 tokens. With asymmetric settings absent, existing HS256 issuance and verification remain unchanged; persistent TV tokens remain Render-only legacy tokens.

`app/tests/test_jwt_rotation.py` proves required claims, old/new public-key overlap, retired-key rejection, wrong-audience and expired-token rejection, incomplete configuration failure, and Worker-compatible rejection of access and persistent HS256 tokens. Production keys have not been generated or configured, and no production secret was rotated by this implementation.

`platform/cloudflare/src/jwt.js` independently verifies RS256 bearer tokens with Web Crypto and enforces the same exact issuer, audience, positive-integer identity, timestamp, key-ID, skew, and maximum-lifetime rules. Real-signature Worker tests cover accepted and rejected requests. No Worker-native route invokes this verifier yet, and no public verification key has been provisioned to Cloudflare.

## Rollback

During overlap, restore the previous active asymmetric signer and retain both public keys. If asymmetric verification fails before signing switches, keep HS256 signing on Render and leave Worker routes proxy-only. After HS256 retirement, rollback must use a retained asymmetric private key, not reintroduce the shared HS256 secret to Cloudflare.