export function assembleCalendarRead(events, accountStatus) {
    if (!Array.isArray(events)) {
        throw new TypeError("Calendar events must be an array");
    }
    if (!accountStatus || typeof accountStatus !== "object" || Array.isArray(accountStatus)) {
        throw new TypeError("Calendar account status must be an object");
    }

    const accountEventTotals = {};
    for (const event of events) {
        const accountKey = event?.account_key;
        if (typeof accountKey === "string" && accountKey) {
            accountEventTotals[accountKey] = (accountEventTotals[accountKey] || 0) + 1;
        }
    }

    return {
        events: [...events],
        account_status: { ...accountStatus },
        account_event_totals: accountEventTotals,
    };
}