import type { LavalinkProxyConfig, UpstreamNodeConfig, ProxyWebSocket } from "../types";

export class WebSocketProxyHandler {
    private config: LavalinkProxyConfig;

    constructor(config: LavalinkProxyConfig) {
        this.config = config;
    }

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
    }

    public onOpen(ws: ProxyWebSocket, reqHeaders: Record<string, string>): void {
        const defaultNode: UpstreamNodeConfig = this.config.upstreams.default;
        const upstreamWsUrl = defaultNode.wsUrl || `${defaultNode.url.replace(/^http/, "ws")}/v4/websocket`;

        const upstreamHeaders: Record<string, string> = {
            Authorization: defaultNode.password || this.config.server.password,
            "User-Id": reqHeaders["user-id"] || "0",
            "Client-Name": reqHeaders["client-name"] || "LavalinkBunProxyClient/1.1",
        };

        if (reqHeaders["session-id"]) {
            upstreamHeaders["Session-Id"] = reqHeaders["session-id"];
        }

        console.log(`[Proxy:WS] Connecting to upstream Lavalink (${upstreamWsUrl})...`);

        ws.data.messageQueue = [];
        ws.data.isUpstreamOpen = false;

        try {
            const upstream = new (WebSocket as any)(upstreamWsUrl, {
                headers: upstreamHeaders,
            });

            ws.data.upstreamWs = upstream;

            upstream.onopen = () => {
                ws.data.isUpstreamOpen = true;
                console.log("[Proxy:WS] Upstream WebSocket connected.");
                const queue = ws.data.messageQueue || [];
                while (queue.length > 0) {
                    const item = queue.shift();
                    if (item) upstream.send(item);
                }
            };

            upstream.onmessage = (event: any) => {
                if (this.config.logging.debug) {
                    console.log(`[Proxy:WS:Upstream -> Client]`, event.data);
                }
                if (ws.readyState === 1) {
                    ws.send(event.data);
                }
            };

            upstream.onclose = (event: any) => {
                console.log(`[Proxy:WS] Upstream closed: ${event.code} - ${event.reason}`);
                if (ws.readyState === 1) {
                    ws.close(event.code, event.reason);
                }
            };

            upstream.onerror = (err: any) => {
                console.error("[Proxy:WS] Upstream error:", err?.message || err);
            };
        } catch (err: any) {
            console.error("[Proxy:WS] Failed to connect to upstream WebSocket:", err?.message);
            ws.close(1011, "Upstream Connection Failed");
        }
    }

    public onMessage(ws: ProxyWebSocket, message: string | Buffer): void {
        const upstream = ws.data.upstreamWs;
        if (this.config.logging.debug) {
            console.log(`[Proxy:WS:Client -> Upstream]`, message);
        }
        if (ws.data.isUpstreamOpen && upstream && upstream.readyState === 1) {
            upstream.send(message);
        } else {
            ws.data.messageQueue?.push(message);
        }
    }

    public onClose(ws: ProxyWebSocket, code: number, reason: string): void {
        const upstream = ws.data.upstreamWs;
        if (upstream && upstream.readyState === 1) {
            upstream.close(code, reason);
        }
        console.log(`[Proxy:WS] Client session ended: ${code}`);
    }
}
