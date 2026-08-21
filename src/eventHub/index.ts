import type {
    EventHubConfig,
    RpcRequestMessage,
    RpcResponseMessage,
    RpcHandshakeMessage,
    ProxyWebSocket,
    LavalinkLoadResult,
} from "../types";

interface PendingRpc {
    id: string;
    handler: string;
    resolve: (data: LavalinkLoadResult) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class EventHubManager {
    private config: EventHubConfig;
    private clients: Map<string, ProxyWebSocket> = new Map();
    private pendingRpcs: Map<string, PendingRpc> = new Map();
    private rpcCounter: number = 0;

    constructor(config: EventHubConfig) {
        this.config = config;
    }

    public updateConfig(newConfig: EventHubConfig): void {
        this.config = newConfig;
    }

    public get connectedClientCount(): number {
        return this.clients.size;
    }

    public onOpen(ws: ProxyWebSocket): void {
        const { clientId, name } = ws.data;
        this.clients.set(clientId, ws);
        console.log(`[EventHub] Client connected: ${name || "Worker"} (${clientId}) [Active: ${this.clients.size}]`);

        ws.send(
            JSON.stringify({
                type: "connected",
                clientId,
                serverTime: Date.now(),
                message: "Connected to Lavalink Native Bun Event Hub",
            })
        );
    }

    public onMessage(ws: ProxyWebSocket, message: string | Buffer): void {
        try {
            const rawText = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");
            const msg = JSON.parse(rawText);

            // 1. Handshake
            if (msg.type === "handshake") {
                const handshake = msg as RpcHandshakeMessage;
                if (Array.isArray(handshake.handlers)) {
                    ws.data.handlers = new Set(handshake.handlers);
                    if (handshake.clientName) ws.data.name = handshake.clientName;
                    console.log(`[EventHub] Client ${ws.data.name} registered handlers: [${Array.from(ws.data.handlers).join(", ")}]`);
                }
                return;
            }

            // 2. RPC Response
            if (msg.type === "rpc_response") {
                const rpcResponse = msg as RpcResponseMessage;
                const pending = this.pendingRpcs.get(rpcResponse.id);
                if (pending) {
                    clearTimeout(pending.timer);
                    this.pendingRpcs.delete(rpcResponse.id);

                    if (rpcResponse.success && rpcResponse.data) {
                        pending.resolve(rpcResponse.data);
                    } else {
                        pending.reject(new Error(rpcResponse.error || "Client RPC returned failure"));
                    }
                }
                return;
            }

            // 3. Heartbeat
            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
                return;
            }
        } catch (err: any) {
            console.error(`[EventHub] Invalid JSON from client ${ws.data.clientId}:`, err?.message);
        }
    }

    public onClose(ws: ProxyWebSocket, code: number, reason: string): void {
        this.clients.delete(ws.data.clientId);
        console.log(`[EventHub] Client disconnected: ${ws.data.name || ws.data.clientId} (${code}) [Remaining: ${this.clients.size}]`);
    }

    /**
     * Dispatch an RPC call to a connected client
     */
    public async callHandler(
        handlerName: string,
        payload: {
            identifier: string;
            originalIdentifier: string;
            attempt: number;
            lastError?: string;
            context?: Record<string, any>;
        },
        timeoutMs?: number
    ): Promise<LavalinkLoadResult | null> {
        if (!this.config.enabled || this.clients.size === 0) {
            return null;
        }

        const eligibleClients = Array.from(this.clients.values()).filter(
            (ws) => ws.readyState === 1 && (ws.data.handlers?.has(handlerName) || ws.data.handlers?.has("*"))
        );

        if (eligibleClients.length === 0) {
            console.warn(`[EventHub] No connected clients registered for handler "${handlerName}"`);
            return null;
        }

        const targetClient = eligibleClients[Math.floor(Math.random() * eligibleClients.length)];
        const rpcId = `rpc_${Date.now()}_${++this.rpcCounter}`;
        const timeout = timeoutMs || this.config.defaultTimeoutMs || 3000;

        return new Promise<LavalinkLoadResult | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pendingRpcs.delete(rpcId);
                console.warn(`[EventHub] RPC "${handlerName}" timed out after ${timeout}ms (Query: "${payload.identifier}")`);
                resolve(null);
            }, timeout);

            this.pendingRpcs.set(rpcId, {
                id: rpcId,
                handler: handlerName,
                resolve: (data) => resolve(data),
                reject: (err) => {
                    console.warn(`[EventHub] RPC "${handlerName}" failed: ${err.message}`);
                    resolve(null);
                },
                timer,
            });

            const rpcRequest: RpcRequestMessage = {
                type: "rpc_request",
                id: rpcId,
                handler: handlerName,
                data: payload,
                timeoutMs: timeout,
            };

            try {
                targetClient.send(JSON.stringify(rpcRequest));
            } catch (err: any) {
                clearTimeout(timer);
                this.pendingRpcs.delete(rpcId);
                console.error(`[EventHub] Failed to send RPC to client ${targetClient.data.name}:`, err.message);
                resolve(null);
            }
        });
    }
}
