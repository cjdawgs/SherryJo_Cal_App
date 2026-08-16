import { Client } from "pg";

export const LOGIN_USER_SQL = "SELECT * FROM public.worker_find_login_user($1)";
export const REGISTER_USER_SQL = "SELECT * FROM public.worker_register_user($1, $2, $3, $4)";

export class NativeAuthPostgresAdapter {
    constructor({ createClient, connectionString }) {
        this.createClient = createClient;
        this.connectionString = connectionString;
    }

    async run(operation) {
        const client = this.createClient({ connectionString: this.connectionString });
        await client.connect();
        try {
            return await operation(client);
        } finally {
            await client.end();
        }
    }

    async findLoginUser(identifier) {
        const result = await this.run((client) => client.query(LOGIN_USER_SQL, [identifier]));
        return result.rows[0] || null;
    }

    async registerUser({ username, email, hashedPassword, role }) {
        const result = await this.run((client) => client.query(
            REGISTER_USER_SQL,
            [username, email, hashedPassword, role],
        ));
        return result.rows[0];
    }
}

export function createNativeAuthPostgresAdapter(env, { ClientClass = Client } = {}) {
    const hyperdrive = env?.HYPERDRIVE_RLS_NO_CACHE;
    if (!hyperdrive?.connectionString) {
        throw new Error("HYPERDRIVE_RLS_NO_CACHE is not configured");
    }
    return new NativeAuthPostgresAdapter({
        createClient: (options) => new ClientClass(options),
        connectionString: hyperdrive.connectionString,
    });
}