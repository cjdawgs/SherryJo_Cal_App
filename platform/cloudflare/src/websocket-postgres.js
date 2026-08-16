const TICKET_TTL_SECONDS = 60;

function base64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function ticketHash(ticket) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ticket));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function issueWebSocketTicket(adapter, userId) {
    const ticket = base64Url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = new Date(Date.now() + TICKET_TTL_SECONDS * 1000);
    await adapter.runWithIdentity(userId, (client) => client.query(
        "SELECT public.worker_issue_websocket_ticket($1, $2)",
        [ticketHash(ticket), expiresAt],
    ));
    return { ticket, expires_at: expiresAt.toISOString(), expires_in_seconds: TICKET_TTL_SECONDS };
}

export async function consumeWebSocketTicket(adapter, ticket) {
    if (!ticket || ticket.length > 128) return false;
    const client = adapter.createClient({ connectionString: adapter.connectionString });
    try {
        await client.connect();
        const result = await client.query(
            "SELECT public.worker_consume_websocket_ticket($1) AS user_id",
            [await ticketHash(ticket)],
        );
        return Number.isInteger(result.rows[0]?.user_id);
    } finally {
        await client.end();
    }
}

export async function openNativeWebSocket(request, adapter, PairClass = WebSocketPair) {
    const ticket = new URL(request.url).searchParams.get("ticket");
    if (!(await consumeWebSocketTicket(adapter, ticket))) return new Response(null, { status: 403 });
    const pair = new PairClass();
    const client = pair[0]; const server = pair[1];
    server.accept();
    server.addEventListener("message", (event) => server.send(`Update: ${event.data}`));
    return new Response(null, { status: 101, webSocket: client });
}