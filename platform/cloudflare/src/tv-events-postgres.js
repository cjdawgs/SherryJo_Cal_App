const ACCOUNT_LEGEND_SQL = `
    SELECT provider, account_email, color, sync_enabled
    FROM public.oauth_accounts
    WHERE user_id = public.worker_app_user_id()
    ORDER BY provider, account_email, id
`;

const COLORS = { google: "#34a853", microsoft: "#2563eb", apple: "#ef4444", local: "#7ca3af" };

function providerName(value) {
    const provider = String(value || "").trim().toLowerCase();
    if (["gmail", "google"].includes(provider)) return "google";
    if (["outlook", "office365", "ms", "msft", "microsoft"].includes(provider)) return "microsoft";
    if (["icloud", "caldav", "apple"].includes(provider)) return "apple";
    return provider || "local";
}

export async function executeTvAccountLegendRead(adapter, userId) {
    const result = await adapter.runWithIdentity(userId, (client) => client.query(ACCOUNT_LEGEND_SQL));
    const seen = new Set();
    return result.rows.flatMap((row) => {
        const provider = providerName(row.provider);
        const accountEmail = String(row.account_email || "").trim().toLowerCase();
        if (!accountEmail || accountEmail.endsWith("@example.com")) return [];
        const key = `${provider}:${accountEmail}`;
        if (seen.has(key)) return [];
        seen.add(key);
        return [{ provider, accountEmail, account_key: key, color: row.color || COLORS[provider] || "#999999", syncEnabled: Boolean(row.sync_enabled) }];
    });
}