/**
 * Example Event Hub RPC Client for Lavalink Dragonfly Proxy
 * 
 * Uses Lavalink v4 Track & Response Builders to cheaply and safely construct
 * track payloads for fallback queries.
 * 
 * Usage:
 *   bun run examples/client-eventhub-example.ts
 */

import { buildEmptyResult } from "../src/builders";
import type { LavalinkLoadResult } from "../src/types";

interface RpcRequestMessage {
    type: "rpc_request";
    id: string;
    handler: string;
    data: {
        identifier: string;
        originalIdentifier: string;
        attempt: number;
        lastError?: string;
    };
    timeoutMs: number;
}

class LavalinkProxyEventHubClient {
    private url: string;
    private authToken: string;
    private clientName: string;
    private ws: WebSocket | null = null;
    private handlers: Map<string, (data: any) => Promise<LavalinkLoadResult>> = new Map();

    constructor(options: { url: string; authToken: string; clientName?: string }) {
        this.url = options.url;
        this.authToken = options.authToken;
        this.clientName = options.clientName || "MivatorBotWorker";
    }

    public registerHandler(handlerName: string, fn: (data: any) => Promise<LavalinkLoadResult>): void {
        this.handlers.set(handlerName, fn);
        console.log(`[Client] Registered handler: "${handlerName}"`);
    }

    public connect(): void {
        console.log(`[Client] Connecting to Event Hub at ${this.url}...`);
        const ws = new (WebSocket as any)(this.url, {
            headers: {
                Authorization: this.authToken,
                "Client-Name": this.clientName,
            },
        });
        this.ws = ws;

        ws.onopen = () => {
            console.log(`[Client] Connected! Sending handshake...`);
            ws.send(
                JSON.stringify({
                    type: "handshake",
                    clientName: this.clientName,
                    handlers: Array.from(this.handlers.keys()),
                })
            );
        };

        ws.onmessage = async (event: any) => {
            try {
                const msg = JSON.parse(event.data.toString());

                if (msg.type === "connected") {
                    console.log(`[Client] Handshake acknowledged: ${msg.message}`);
                    return;
                }

                if (msg.type === "rpc_request") {
                    await this.handleRpcRequest(msg as RpcRequestMessage);
                    return;
                }
            } catch (err: any) {
                console.error("[Client] Failed to handle message:", err.message);
            }
        };

        ws.onclose = (event: any) => {
            console.warn(`[Client] Disconnected (${event.code}). Reconnecting in 3s...`);
            setTimeout(() => this.connect(), 3000);
        };

        ws.onerror = (err: any) => {
            console.error("[Client] WebSocket error:", err);
        };
    }

    private async handleRpcRequest(req: RpcRequestMessage): Promise<void> {
        console.log(`[Client:RPC] Received request #${req.id} for handler "${req.handler}" (Query: "${req.data.identifier}")`);
        const handlerFn = this.handlers.get(req.handler);

        if (!handlerFn) {
            this.ws?.send(
                JSON.stringify({
                    type: "rpc_response",
                    id: req.id,
                    success: false,
                    error: `Handler "${req.handler}" not registered on this client`,
                })
            );
            return;
        }

        try {
            const result = await handlerFn(req.data);
            this.ws?.send(
                JSON.stringify({
                    type: "rpc_response",
                    id: req.id,
                    success: true,
                    data: result,
                })
            );
            console.log(`[Client:RPC] Responded to #${req.id}`);
        } catch (err: any) {
            console.error(`[Client:RPC] Handler error for #${req.id}:`, err.message);
            this.ws?.send(
                JSON.stringify({
                    type: "rpc_response",
                    id: req.id,
                    success: false,
                    error: err.message,
                })
            );
        }
    }
}

// -------------------------------------------------------------
// Sample Client Setup with Response Builders
// -------------------------------------------------------------
const client = new LavalinkProxyEventHubClient({
    url: "ws://127.0.0.1:2332/proxy/events",
    authToken: "youshallnotpass",
    clientName: "CustomMusicWorker-1",
});

// Handler 1: Resolve through a real compatible backend so the encoded track is playable.
client.registerHandler("resolveFallbackTrack", async (data) => {
    const upstream = process.env.FALLBACK_UPSTREAM_URL || "http://127.0.0.1:2333";
    const password = process.env.FALLBACK_UPSTREAM_PASSWORD || "youshallnotpass";
    const url = new URL("/v4/loadtracks", upstream);
    url.searchParams.set("identifier", data.identifier);
    const response = await fetch(url, {
        headers: { Authorization: password, Accept: "application/json" },
        signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`Fallback backend returned HTTP `);
    return await response.json() as LavalinkLoadResult;
});

// Handler 2: Spotify Scraper Fallback
client.registerHandler("spotifyScraper", async (data) => {
    return buildEmptyResult();
});

client.connect();
