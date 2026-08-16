import { Client } from "pg";

const PAIRING_ALPHABET = "ACDEFGHJKMNPQRTUVWXYZ";
const PAIRING_TTL_MS = 10 * 60 * 1000;

export class InvalidPairingCodeError extends Error {}

function normalizedCode(value) {
    const compact = String(value || "").replaceAll(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (compact.length !== 8 || [...compact].some((character) => !PAIRING_ALPHABET.includes(character))) {
        throw new InvalidPairingCodeError("Invalid or expired pairing code");
    }
    return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

function randomCode(randomValues = (bytes) => crypto.getRandomValues(bytes)) {
    const characters = [];
    while (characters.length < 8) {
        const bytes = randomValues(new Uint8Array(16));
        for (const byte of bytes) {
            if (byte >= Math.floor(256 / PAIRING_ALPHABET.length) * PAIRING_ALPHABET.length) continue;
            characters.push(PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]);
            if (characters.length === 8) break;
        }
    }
    return normalizedCode(characters.join(""));
}

async function codeHash(code) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedCode(code)));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function pairingClientFingerprint(request) {
    return String(request.headers.get("cf-connecting-ip") || request.headers.get("x-real-ip") || "").trim() || null;
}

export class TvPairingPostgresAdapter {
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

    async create({ userId, hash, expiresAt, clientFingerprint }) {
        return this.run(async (client) => {
            await client.query("BEGIN");
            try {
                await client.query("SELECT set_config('app.user_id', $1, true)", [String(userId)]);
                await client.query(
                    "SELECT public.worker_create_tv_pairing_code($1, $2, $3)",
                    [hash, expiresAt, clientFingerprint],
                );
                await client.query("COMMIT");
            } catch (error) {
                await client.query("ROLLBACK");
                throw error;
            }
        });
    }

    async redeem(hash) {
        const result = await this.run((client) => client.query(
            "SELECT * FROM public.worker_redeem_tv_pairing_code($1)",
            [hash],
        ));
        return result.rows[0] || null;
    }

    async autoRedeem(clientFingerprint) {
        const result = await this.run((client) => client.query(
            "SELECT * FROM public.worker_auto_redeem_tv_pairing_code($1)",
            [clientFingerprint],
        ));
        return result.rows[0] || null;
    }
}

export function createTvPairingPostgresAdapter(env, { ClientClass = Client } = {}) {
    const hyperdrive = env?.HYPERDRIVE_RLS_NO_CACHE;
    if (!hyperdrive?.connectionString) throw new Error("HYPERDRIVE_RLS_NO_CACHE is not configured");
    return new TvPairingPostgresAdapter({
        createClient: (options) => new ClientClass(options),
        connectionString: hyperdrive.connectionString,
    });
}

export async function createTvPairingCode(adapter, {
    userId,
    clientFingerprint = null,
    now = new Date(),
    randomValues,
} = {}) {
    const pairingCode = randomCode(randomValues);
    const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
    await adapter.create({
        userId,
        hash: await codeHash(pairingCode),
        expiresAt,
        clientFingerprint,
    });
    return { pairingCode, expiresAt: expiresAt.toISOString(), expiresIn: PAIRING_TTL_MS / 1000 };
}

export async function redeemTvPairingCode(adapter, pairingCode) {
    const result = await adapter.redeem(await codeHash(pairingCode));
    if (!result) throw new InvalidPairingCodeError("Invalid or expired pairing code");
    return { userId: Number(result.user_id), clientFingerprint: result.client_fingerprint || null };
}

export async function autoRedeemTvPairingCode(adapter, clientFingerprint) {
    if (!clientFingerprint) throw new InvalidPairingCodeError("Auto-pair unavailable");
    const result = await adapter.autoRedeem(clientFingerprint);
    if (!result) throw new InvalidPairingCodeError("Auto-pair unavailable");
    return { userId: Number(result.user_id), clientFingerprint: result.client_fingerprint || null };
}