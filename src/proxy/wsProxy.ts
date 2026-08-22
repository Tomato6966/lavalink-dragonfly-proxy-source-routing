import type { LavalinkProxyConfig, UpstreamNodeConfig, ProxyWebSocket } from "../types";

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

export class WebSocketProxyHandler {
    private config: LavalinkProxyConfig;

    constructor(config: LavalinkProxyConfig) {
        this.config = config;
    }

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
    }

    public onOpen(ws: ProxyWebSocket, requestHeaders: Record<string, string>): void {
        const primaryName = this.config.server.primaryPlaybackNode;
        const defaultNode: UpstreamNodeConfig =
            primaryName && this.config.upstreams[primaryName]?.enabled !== false
                ? this.config.upstreams[primaryName]
                : this.config.upstreams.default;
        const upstreamUrl = defaultNode.wsUrl || `${defaultNode.url.replace(/^http/, "ws").replace(/\/$/, "")}/v4/websocket`;
        const upstreamHeaders: Record<string, string> = {
            Authorization: defaultNode.password || this.config.server.password,
            "User-Id": requestHeaders["user-id"] || "0",
            "Client-Name": requestHeaders["client-name"] || "LavalinkDragonflyProxy/2",
        };
        if (requestHeaders["session-id"]) upstreamHeaders["Session-Id"] = requestHeaders["session-id"];

        ws.data.messageQueue = [];
        ws.data.messageQueueBytes = 0;
        ws.data.isUpstreamOpen = false;

        try {
            const upstream = new (WebSocket as any)(upstreamUrl, { headers: upstreamHeaders });
            ws.data.upstreamWs = upstream;
            ws.data.upstreamConnectTimer = setTimeout(() => {
                if (!ws.data.isUpstreamOpen) {
                    upstream.close(1013, "Upstream connection timeout");
                    ws.close(1013, "Upstream connection timeout");
                }
            }, defaultNode.requestTimeoutMs ?? this.config.server.upstreamRequestTimeoutMs ?? 10_000);

            upstream.onopen = () => {
                ws.data.isUpstreamOpen = true;
                if (ws.data.upstreamConnectTimer) clearTimeout(ws.data.upstreamConnectTimer);
                const queue = ws.data.messageQueue || [];
                for (const item of queue) upstream.send(item);
                ws.data.messageQueue = [];
                ws.data.messageQueueBytes = 0;
                console.log(`[${formatTimestamp()}] [Proxy:WS] Upstream connected`);
            };

            upstream.onmessage = (event: MessageEvent) => {
                if (this.config.logging.debug) {
                    try {
                        const parsed = JSON.parse(String(event.data));
                        console.log(`[${formatTimestamp()}] [Proxy:WS] upstream op=${parsed.op || "unknown"}`);
                    } catch {
                        console.log(`[${formatTimestamp()}] [Proxy:WS] upstream binary payload`);
                    }
                }
                if (ws.readyState !== 1) return;
                const sent = ws.send(event.data);
                if (sent === 0) {
                    upstream.close(1013, "Downstream unavailable");
                    ws.close(1013, "Backpressure limit");
                }
            };

            upstream.onclose = (event: CloseEvent) => {
                if (ws.data.upstreamConnectTimer) clearTimeout(ws.data.upstreamConnectTimer);
                if (ws.readyState === 1) {
                    const code = sanitizeWebSocketCloseCode(event.code, 1011);
                    ws.close(code, String(event.reason || "Upstream closed").slice(0, 120));
                }
            };

            upstream.onerror = (error: ErrorEvent) => {
                console.error(`[${formatTimestamp()}] [Proxy:WS] Upstream error:`, error.message || "unknown error");
            };
        } catch (error) {
            console.error(`[${formatTimestamp()}] [Proxy:WS] Connect failed:`, error instanceof Error ? error.message : error);
            ws.close(1011, "Upstream connection failed");
        }
    }

    public onMessage(ws: ProxyWebSocket, message: string | Buffer): void {
        const upstream = ws.data.upstreamWs;
        const size = payloadSize(message);
        const maxMessages = this.config.server.websocketMaxQueueMessages ?? 256;
        const maxBytes = this.config.server.websocketMaxQueueBytes ?? 1024 * 1024;

        if (ws.data.isUpstreamOpen && upstream?.readyState === 1) {
            if (upstream.bufferedAmount + size > maxBytes) {
                upstream.close(1013, "Client overload");
                ws.close(1013, "Upstream backpressure");
                return;
            }
            upstream.send(message);
            return;
        }

        const queue = ws.data.messageQueue || (ws.data.messageQueue = []);
        const queuedBytes = ws.data.messageQueueBytes ?? 0;
        if (queue.length >= maxMessages || queuedBytes + size > maxBytes) {
            upstream?.close(1013, "Client queue overflow");
            ws.close(1013, "Upstream unavailable");
            return;
        }
        queue.push(message);
        ws.data.messageQueueBytes = queuedBytes + size;
    }

    public onClose(ws: ProxyWebSocket, code: number, reason: string): void {
        if (ws.data.upstreamConnectTimer) clearTimeout(ws.data.upstreamConnectTimer);
        const upstream = ws.data.upstreamWs;
        if (upstream && (upstream.readyState === 0 || upstream.readyState === 1)) {
            upstream.close(sanitizeWebSocketCloseCode(code, 1000), reason.slice(0, 120));
        }
        ws.data.messageQueue = [];
        ws.data.messageQueueBytes = 0;
    }
}
