import type {
    EventHubConfig,
    RpcRequestMessage,
    RpcResponseMessage,
    RpcHandshakeMessage,
    ProxyWebSocket,
    LavalinkLoadResult,
} from "../types";
import { isLavalinkLoadResult } from "../validation/lavalink";

interface PendingRpc {
    id: string;
    handler: string;
    targetClientId: string;
    resolve: (data: LavalinkLoadResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

export class EventHubManager {
    private config: EventHubConfig;
    private readonly clients = new Map<string, ProxyWebSocket>();
    private readonly pendingRpcs = new Map<string, PendingRpc>();
    private rpcCounter = 0;

    constructor(config: EventHubConfig) {
        this.config = config;
    }

    public updateConfig(newConfig: EventHubConfig): void {
        this.config = newConfig;
    }

    public get connectedClientCount(): number {
        return this.clients.size;
    }

    public get pendingRpcCount(): number {
        return this.pendingRpcs.size;
    }

    public onOpen(ws: ProxyWebSocket): void {
        const { clientId, name } = ws.data;
        this.clients.set(clientId, ws);
        console.log(`[EventHub] Client connected: ${name || "Worker"} (${clientId})`);
        ws.send(JSON.stringify({
            type: "connected",
            clientId,
            serverTime: Date.now(),
            message: "Connected to Lavalink proxy Event Hub",
        }));
    }

    public onMessage(ws: ProxyWebSocket, message: string | Buffer): void {
        try {
            const rawText = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");
            const msg = JSON.parse(rawText) as Record<string, unknown>;

            if (msg.type === "handshake") {
                const handshake = msg as unknown as RpcHandshakeMessage;
                const handlers = Array.isArray(handshake.handlers)
                    ? handshake.handlers.filter((handler) => typeof handler === "string" && handler.length <= 100).slice(0, 100)
                    : [];
                ws.data.handlers = new Set(handlers);
                if (typeof handshake.clientName === "string" && handshake.clientName.length <= 100) {
                    ws.data.name = handshake.clientName;
                }
                return;
            }

            if (msg.type === "rpc_response") {
                const response = msg as unknown as RpcResponseMessage;
                const pending = this.pendingRpcs.get(response.id);
                if (!pending) return;
                if (pending.targetClientId !== ws.data.clientId) {
                    console.warn(`[EventHub] Ignored RPC response ${response.id} from the wrong client`);
                    return;
                }

                clearTimeout(pending.timer);
                this.pendingRpcs.delete(response.id);
                if (response.success && isLavalinkLoadResult(response.data)) {
                    pending.resolve(response.data);
                } else {
                    const message = typeof response.error === "string" ? response.error : "Client RPC returned an invalid load result";
                    pending.reject(new Error(message));
                }
                return;
            }

            if (msg.type === "ping") {
                ws.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
            }
        } catch (error) {
            console.error(`[EventHub] Invalid message from ${ws.data.clientId}:`, error instanceof Error ? error.message : error);
        }
    }

    public onClose(ws: ProxyWebSocket, code: number, _reason: string): void {
        this.clients.delete(ws.data.clientId);
        for (const [id, pending] of this.pendingRpcs) {
            if (pending.targetClientId !== ws.data.clientId) continue;
            clearTimeout(pending.timer);
            this.pendingRpcs.delete(id);
            pending.reject(new Error("Event Hub client disconnected"));
        }
        console.log(`[EventHub] Client disconnected: ${ws.data.name || ws.data.clientId} (${code})`);
    }

    public async callHandler(
        handlerName: string,
        payload: {
            identifier: string;
            originalIdentifier: string;
            attempt: number;
            lastError?: string;
            context?: Record<string, unknown>;
        },
        timeoutMs?: number
    ): Promise<LavalinkLoadResult | null> {
        if (!this.config.enabled || this.clients.size === 0) return null;

        const eligible = Array.from(this.clients.values()).filter(
            (ws) => ws.readyState === 1 && (ws.data.handlers?.has(handlerName) || ws.data.handlers?.has("*"))
        );
        if (!eligible.length) return null;

        const loadByClient = new Map<string, number>();
        for (const pending of this.pendingRpcs.values()) {
            loadByClient.set(pending.targetClientId, (loadByClient.get(pending.targetClientId) ?? 0) + 1);
        }
        eligible.sort((left, right) =>
            (loadByClient.get(left.data.clientId) ?? 0) - (loadByClient.get(right.data.clientId) ?? 0)
        );
        const targetClient = eligible[0];
        const rpcId = `rpc_${Date.now()}_${++this.rpcCounter}`;
        const timeout = timeoutMs ?? this.config.defaultTimeoutMs ?? 3000;

        return new Promise<LavalinkLoadResult | null>((resolve) => {
            const timer = setTimeout(() => {
                this.pendingRpcs.delete(rpcId);
                resolve(null);
            }, timeout);

            this.pendingRpcs.set(rpcId, {
                id: rpcId,
                handler: handlerName,
                targetClientId: targetClient.data.clientId,
                resolve,
                reject: () => resolve(null),
                timer,
            });

            const request: RpcRequestMessage = {
                type: "rpc_request",
                id: rpcId,
                handler: handlerName,
                data: payload,
                timeoutMs: timeout,
            };

            try {
                targetClient.send(JSON.stringify(request));
            } catch {
                clearTimeout(timer);
                this.pendingRpcs.delete(rpcId);
                resolve(null);
            }
        });
    }

    public close(): void {
        for (const pending of this.pendingRpcs.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error("Event Hub shutting down"));
        }
        this.pendingRpcs.clear();
        for (const client of this.clients.values()) client.close(1001, "Server shutting down");
        this.clients.clear();
    }
}
