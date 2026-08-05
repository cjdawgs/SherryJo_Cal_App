// Upserts an OAuth account row with Fernet-encrypted provider tokens.
// Requires the unique index uq_oauth_account_user_provider_email (migration bb981v22nnn55).

import { fernetEncrypt } from "./fernet.js";

export const OAUTH_UPSERT_SQL = `
    INSERT INTO public.oauth_accounts
        (user_id, provider, account_email, access_token, refresh_token,
         token_expires_at, display_name, provider_id, is_service_provider)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)
    ON CONFLICT (user_id, provider, account_email) DO UPDATE SET
        access_token      = EXCLUDED.access_token,
        refresh_token     = COALESCE(EXCLUDED.refresh_token, oauth_accounts.refresh_token),
        token_expires_at  = EXCLUDED.token_expires_at,
        display_name      = EXCLUDED.display_name,
        provider_id       = COALESCE(EXCLUDED.provider_id, oauth_accounts.provider_id)
`;

export async function executeOAuthAccountUpsert(adapter, {
    userId,
    provider,
    accountEmail,
    accessToken,
    refreshToken,
    tokenExpiresAt,
    displayName,
    providerId,
    tokenEncryptionKey,
}) {
    const encryptedAccess = await fernetEncrypt(accessToken, tokenEncryptionKey);
    const encryptedRefresh = refreshToken ? await fernetEncrypt(refreshToken, tokenEncryptionKey) : null;
    const expiresIso = tokenExpiresAt ? new Date(tokenExpiresAt * 1000).toISOString() : null;

    await adapter.runWithIdentity(userId, (client) =>
        client.query(OAUTH_UPSERT_SQL, [
            userId, provider, accountEmail,
            encryptedAccess, encryptedRefresh, expiresIso,
            displayName || accountEmail, providerId || null,
        ]),
    );
}
