import type { LavalinkProxyConfig, ProxyWebSocket } from "../types";
import { UpstreamNodePool } from "../routing/nodePool";

function formatTimestamp(): string {
    const date = new Date();
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function payloadSize(message: string | Buffer | ArrayBuffer | Uint8Array): number {
    if (typeof message === "string") return Buffer.byteLength(message);
    return message.byteLength;
}

export function sanitizeWebSocketCloseCode(code: number, fallback: number): number {
    const forbidden = new Set([1004, 1005, 1006]);
    const isRegisteredProtocolCode = code >= 1000 && code <= 1014 && !forbidden.has(code);
    const isApplicationCode = code >= 3000 && code <= 4999;
    return Number.isInteger(code) && (isRegisteredProtocolCode || isApplicationCode) ? code : fallback;
}

/**
 * WebSocketProxyHandler: Multiplexed, Multi-Node Upstream WebSocket Proxy
 * 
 * Supports both single-node and 100+ node cluster topologies.
 * - Multiplexes incoming player and track events (TrackEnd, Stuck, VoiceUpdates) across all cluster nodes.
 * - Routes downstream client messages using Guild ID affinity to the target node.
 */
export class WebSocketProxyHandler {
    private config: LavalinkProxyConfig;
    public readonly nodePool: UpstreamNodePool;

    constructor(config: LavalinkProxyConfig, nodePool?: UpstreamNodePool) {
        this.config = config;
        this.nodePool = nodePool || new UpstreamNodePool(config);
    }

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
        this.nodePool.updateConfig(newConfig);
    }

    public onOpen(ws: ProxyWebSocket, requestHeaders: Record<string, string>): void {
        const primaryNode = this.nodePool.getDefaultNode();
        const allNodes = this.nodePool.getHealthyNodes(n => n.enabled !== false);
        const nodesToConnect = allNodes.length > 0 ? allNodes : [primaryNode];

        ws.data.messageQueue = [];
        ws.data.messageQueueBytes = 0;
        ws.data.isUpstreamOpen = false;
        ws.data.upstreamSockets = new Map<string, WebSocket>();
        ws.data.upstreamConnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

        let hasForwardedReady = false;

        for (const node of nodesToConnect) {
            const isPrimary = node.id === primaryNode.id || node.url === primaryNode.url;
            const upstreamUrl = node.wsUrl || `${node.url.replace(/^http/, "ws").replace(/\/$/, "")}/v4/websocket`;
            const upstreamHeaders: Record<string, string> = {
                Authorization: node.password || this.config.server.password,
                "User-Id": requestHeaders["user-id"] || "0",
                "Client-Name": requestHeaders["client-name"] || "LavalinkDragonflyProxy/2",
            };
            if (requestHeaders["session-id"]) upstreamHeaders["Session-Id"] = requestHeaders["session-id"];

            try {
                const upstream = new (WebSocket as any)(upstreamUrl, { headers: upstreamHeaders });
                ws.data.upstreamSockets.set(node.id, upstream);
                if (isPrimary) {
                    ws.data.upstreamWs = upstream;
                }

                const connectTimer = setTimeout(() => {
                    if (!ws.data.isUpstreamOpen && isPrimary) {
                        upstream.close(1013, "Upstream connection timeout");
                        ws.close(1013, "Upstream connection timeout");
                    }
                }, node.requestTimeoutMs ?? this.config.server.upstreamRequestTimeoutMs ?? 10_000);

                ws.data.upstreamConnectTimers.set(node.id, connectTimer);

                upstream.onopen = () => {
                    if (isPrimary) {
                        ws.data.isUpstreamOpen = true;
                        if (ws.data.upstreamConnectTimer) clearTimeout(ws.data.upstreamConnectTimer);
                        const queue = ws.data.messageQueue || [];
                        for (const item of queue) upstream.send(item);
                        ws.data.messageQueue = [];
                        ws.data.messageQueueBytes = 0;
                    }
                    const timer = ws.data.upstreamConnectTimers?.get(node.id);
                    if (timer) clearTimeout(timer);
                    if (this.config.logging.debug) {
                        console.log(`[${formatTimestamp()}] [Proxy:WS] Node connected: ${node.id}`);
                    }
                };

                upstream.onmessage = (event: MessageEvent) => {
                    if (ws.readyState !== 1) return;
                    let op: string | undefined;
                    try {
                        const parsed = JSON.parse(String(event.data));
                        op = parsed.op;
                    } catch {}

                    // Session ready handling: ensure primary session ID is established once from primary node
                    if (op === "ready") {
                        if (isPrimary && !hasForwardedReady) {
                            hasForwardedReady = true;
                            ws.send(event.data);
                        }
                        return;
                    }

                    // Forward all player events and updates from any cluster node
                    const sent = ws.send(event.data);
                    if (sent === 0 && isPrimary) {
                        upstream.close(1013, "Downstream unavailable");
                        ws.close(1013, "Backpressure limit");
                    }
                };

                upstream.onclose = (event: CloseEvent) => {
                    const timer = ws.data.upstreamConnectTimers?.get(node.id);
                    if (timer) clearTimeout(timer);
                    if (isPrimary && ws.readyState === 1) {
                        const code = sanitizeWebSocketCloseCode(event.code, 1011);
                        ws.close(code, String(event.reason || "Primary upstream closed").slice(0, 120));
                    }
                };

                upstream.onerror = (error: ErrorEvent) => {
                    if (this.config.logging.debug) {
                        console.error(`[${formatTimestamp()}] [Proxy:WS] Node error (${node.id}):`, error.message || "unknown error");
                    }
                };
            } catch (error) {
                console.error(`[${formatTimestamp()}] [Proxy:WS] Connect failed for ${node.id}:`, error instanceof Error ? error.message : error);
                if (isPrimary) {
                    ws.close(1011, "Upstream connection failed");
                }
            }
        }
    }

    public onMessage(ws: ProxyWebSocket, message: string | Buffer): void {
        const size = payloadSize(message);
        const maxMessages = this.config.server.websocketMaxQueueMessages ?? 256;
        const maxBytes = this.config.server.websocketMaxQueueBytes ?? 1024 * 1024;

        let targetGuildId: string | undefined;
        try {
            if (typeof message === "string") {
                const parsed = JSON.parse(message);
                if (parsed.guildId) targetGuildId = String(parsed.guildId);
            }
        } catch {}

        let targetSocket = ws.data.upstreamWs;
        if (targetGuildId && ws.data.upstreamSockets) {
            const targetNode = this.nodePool.getNodeForPlayback(targetGuildId);
            const matchingSocket = ws.data.upstreamSockets.get(targetNode.id);
            if (matchingSocket && matchingSocket.readyState === 1) {
                targetSocket = matchingSocket;
            }
        }

        if (targetSocket && targetSocket.readyState === 1) {
            if (targetSocket.bufferedAmount + size > maxBytes) {
                targetSocket.close(1013, "Client overload");
                ws.close(1013, "Upstream backpressure");
                return;
            }
            targetSocket.send(message);
            return;
        }

        const queue = ws.data.messageQueue || (ws.data.messageQueue = []);
        const queuedBytes = ws.data.messageQueueBytes ?? 0;
        if (queue.length >= maxMessages || queuedBytes + size > maxBytes) {
            targetSocket?.close(1013, "Client queue overflow");
            ws.close(1013, "Upstream unavailable");
            return;
        }
        queue.push(message);
        ws.data.messageQueueBytes = queuedBytes + size;
    }

    public onClose(ws: ProxyWebSocket, code: number, reason: string): void {
        if (ws.data.upstreamConnectTimer) clearTimeout(ws.data.upstreamConnectTimer);
        if (ws.data.upstreamConnectTimers) {
            for (const timer of ws.data.upstreamConnectTimers.values()) {
                clearTimeout(timer);
            }
            ws.data.upstreamConnectTimers.clear();
        }

        if (ws.data.upstreamSockets) {
            for (const socket of ws.data.upstreamSockets.values()) {
                if (socket.readyState === 0 || socket.readyState === 1) {
                    socket.close(sanitizeWebSocketCloseCode(code, 1000), reason.slice(0, 120));
                }
            }
            ws.data.upstreamSockets.clear();
        } else if (ws.data.upstreamWs) {
            const upstream = ws.data.upstreamWs;
            if (upstream.readyState === 0 || upstream.readyState === 1) {
                upstream.close(sanitizeWebSocketCloseCode(code, 1000), reason.slice(0, 120));
            }
        }

        ws.data.messageQueue = [];
        ws.data.messageQueueBytes = 0;
    }
}
