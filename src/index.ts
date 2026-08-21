import type { WsClientData } from "./types";
import { loadConfig } from "./config";
import { DragonflyCacheManager } from "./cache";
import { UpstreamRouter } from "./routing";
import { HttpProxyHandler } from "./proxy/httpProxy";
import { WebSocketProxyHandler } from "./proxy/wsProxy";
import { EventHubManager } from "./eventHub";

export * from "./types";
export * from "./builders";
export * from "./cache";
export * from "./routing";
export * from "./eventHub";
export * from "./transformers";

async function main() {
    console.log("=================================================");
    console.log("⚡ Lavalink Dragonfly Proxy & Native Bun Engine");
    console.log("=================================================");

    const config = await loadConfig();
    console.log(`[Config] Loaded configuration for server port ${config.server.port}`);

    const cacheManager = new DragonflyCacheManager(config.dragonfly);
    const router = new UpstreamRouter(config);
    const eventHub = new EventHubManager(config.eventHub);
    const httpHandler = new HttpProxyHandler(config, cacheManager, router, eventHub);
    const wsProxy = new WebSocketProxyHandler(config);

    const pendingUpgradeHeaders: Map<string, Record<string, string>> = new Map();

    const server = Bun.serve<WsClientData>({
        port: config.server.port,
        hostname: config.server.host,
        async fetch(req, server) {
            const urlObj = new URL(req.url);

            // 1. Upgrade WebSocket for Event Hub RPC
            if (config.eventHub.enabled && urlObj.pathname === (config.eventHub.path || "/proxy/events")) {
                const token = urlObj.searchParams.get("token") || req.headers.get("authorization");
                if (config.eventHub.authToken && token !== config.eventHub.authToken) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const clientId = `client_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
                const upgraded = server.upgrade(req, {
                    data: {
                        type: "event_hub",
                        clientId,
                        name: req.headers.get("client-name") || "Worker",
                        handlers: new Set(["*"]),
                    },
                });

                if (upgraded) return undefined;
                return new Response("Upgrade failed", { status: 400 });
            }

            // 2. Upgrade WebSocket for Lavalink Player/Voice Passthrough
            if (urlObj.pathname === "/v4/websocket" || req.headers.get("upgrade")?.toLowerCase() === "websocket") {
                const clientAuth = req.headers.get("authorization");
                if (config.server.password && clientAuth !== config.server.password) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const clientId = `session_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
                const headersObj: Record<string, string> = {};
                req.headers.forEach((val, key) => (headersObj[key.toLowerCase()] = val));
                pendingUpgradeHeaders.set(clientId, headersObj);

                const upgraded = server.upgrade(req, {
                    data: {
                        type: "lavalink_passthrough",
                        clientId,
                    },
                });

                if (upgraded) return undefined;
                return new Response("Upgrade failed", { status: 400 });
            }

            // 3. Handle REST Requests
            try {
                return await httpHandler.handleRequest(req);
            } catch (err: any) {
                console.error("[Server:Error] Unhandled request error:", err);
                return Response.json({ error: "Internal Server Error" }, { status: 500 });
            }
        },
        websocket: {
            open(ws) {
                if (ws.data.type === "event_hub") {
                    eventHub.onOpen(ws);
                } else if (ws.data.type === "lavalink_passthrough") {
                    const headers = pendingUpgradeHeaders.get(ws.data.clientId) || {};
                    pendingUpgradeHeaders.delete(ws.data.clientId);
                    wsProxy.onOpen(ws, headers);
                }
            },
            message(ws, message) {
                if (ws.data.type === "event_hub") {
                    eventHub.onMessage(ws, message);
                } else if (ws.data.type === "lavalink_passthrough") {
                    wsProxy.onMessage(ws, message);
                }
            },
            close(ws, code, reason) {
                if (ws.data.type === "event_hub") {
                    eventHub.onClose(ws, code, reason);
                } else if (ws.data.type === "lavalink_passthrough") {
                    wsProxy.onClose(ws, code, reason);
                }
            },
        },
    });

    console.log(`[Proxy] Native Bun Server running on http://${server.hostname}:${server.port}`);
    console.log(`[Proxy] Default Upstream: ${config.upstreams.default.url}`);
    if (Object.keys(config.upstreams).length > 1) {
        console.log(`[Proxy] Additional Upstreams: ${Object.keys(config.upstreams).filter((k) => k !== "default").join(", ")}`);
    }
    console.log(`[Proxy] Event Hub RPC: ${config.eventHub.enabled ? `ENABLED (${config.eventHub.path})` : "DISABLED"}`);
    console.log(`[Proxy] Multi-Stage Remapping: ${config.remapping.enabled ? `ENABLED (Max Depth: ${config.remapping.maxRecursionDepth})` : "DISABLED"}`);
    console.log(`[Proxy] Dragonfly Cache: ${config.dragonfly.enabled ? `ENABLED (Max: ${config.dragonfly.maxCachedEntries})` : "DISABLED"}`);
    console.log("=================================================\n");

    const shutdown = () => {
        console.log("\n[Proxy] Shutting down gracefully...");
        server.stop(true);
        console.log("[Proxy] Native Bun Server stopped.");
        process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

main().catch((err) => {
    console.error("[Fatal] Failed to start Lavalink Native Proxy:", err);
    process.exit(1);
});
