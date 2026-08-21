import type { LavalinkProxyConfig, UpstreamNodeConfig, ProxyWebSocket } from "../types";

function formatTimestamp(): string {
    const d = new Date();
    const pad = (n: number, z = 2) => String(n).padStart(z, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

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

        console.log(`[${formatTimestamp()}] [Proxy:WS] Connecting to upstream Lavalink (${upstreamWsUrl})...`);

        ws.data.messageQueue = [];
        ws.data.isUpstreamOpen = false;

        try {
            const upstream = new (WebSocket as any)(upstreamWsUrl, {
                headers: upstreamHeaders,
            });

            ws.data.upstreamWs = upstream;

            upstream.onopen = () => {
                ws.data.isUpstreamOpen = true;
                console.log(`[${formatTimestamp()}] [Proxy:WS] Upstream WebSocket connected.`);
                const queue = ws.data.messageQueue || [];
                while (queue.length > 0) {
                    const item = queue.shift();
                    if (item) upstream.send(item);
                }
            };

            upstream.onmessage = (event: any) => {
                const ts = formatTimestamp();
                try {
                    const parsed = JSON.parse(event.data);
                    if (parsed.op === "playerUpdate") {
                        // Keep player updates quiet unless debug
                        if (this.config.logging.debug) {
                            console.log(`[${ts}] [Proxy:WS:Upstream -> Client] playerUpdate: guildId=${parsed.guildId} pos=${parsed.state?.position}ms`);
                        }
                    } else if (parsed.op === "event") {
                        console.log(`[${ts}] [Proxy:WS:Upstream -> Client] Event: type=${parsed.type} guildId=${parsed.guildId}`);
                    } else if (parsed.op === "ready") {
                        console.log(`[${ts}] [Proxy:WS:Upstream -> Client] Ready: sessionId=${parsed.sessionId} resumed=${parsed.resumed}`);
                    } else if (this.config.logging.debug) {
                        console.log(`[${ts}] [Proxy:WS:Upstream -> Client] op=${parsed.op}`);
                    }
                } catch {
                    if (this.config.logging.debug) {
                        console.log(`[${ts}] [Proxy:WS:Upstream -> Client] raw message`);
                    }
                }

                if (ws.readyState === 1) {
                    ws.send(event.data);
                }
            };

            upstream.onclose = (event: any) => {
                console.log(`[${formatTimestamp()}] [Proxy:WS] Upstream closed: code=${event.code} reason="${event.reason}"`);
                if (ws.readyState === 1) {
                    ws.close(event.code, event.reason);
                }
            };

            upstream.onerror = (err: any) => {
                console.error(`[${formatTimestamp()}] [Proxy:WS] Upstream error:`, err?.message || err);
            };
        } catch (err: any) {
            console.error(`[${formatTimestamp()}] [Proxy:WS] Failed to connect to upstream WebSocket:`, err?.message);
            ws.close(1011, "Upstream Connection Failed");
        }
    }

    public onMessage(ws: ProxyWebSocket, message: string | Buffer): void {
        const upstream = ws.data.upstreamWs;
        const ts = formatTimestamp();

        try {
            const raw = typeof message === "string" ? message : Buffer.from(message).toString("utf-8");
            const parsed = JSON.parse(raw);
            console.log(`[${ts}] [Proxy:WS:Client -> Upstream] op=${parsed.op || "unknown"}`);
        } catch {
            if (this.config.logging.debug) {
                console.log(`[${ts}] [Proxy:WS:Client -> Upstream] payload`);
            }
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
        console.log(`[${formatTimestamp()}] [Proxy:WS] Client session ended: code=${code}`);
    }
}
