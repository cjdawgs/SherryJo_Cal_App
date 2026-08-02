import { Client } from "pg";

import { PostgresCalendarReadAdapter } from "./calendar-read-postgres.js";

export const CALENDAR_READ_HYPERDRIVE_BINDING = "HYPERDRIVE_RLS_NO_CACHE";

export function createHyperdriveCalendarReadAdapter(
    env,
    { ClientClass = Client, accountStatusProvider } = {},
) {
    const hyperdrive = env?.[CALENDAR_READ_HYPERDRIVE_BINDING];
    if (!hyperdrive?.connectionString) {
        throw new Error(`${CALENDAR_READ_HYPERDRIVE_BINDING} is not configured`);
    }

    return new PostgresCalendarReadAdapter({
        createClient: (options) => new ClientClass(options),
        connectionString: hyperdrive.connectionString,
        accountStatusProvider,
    });
}