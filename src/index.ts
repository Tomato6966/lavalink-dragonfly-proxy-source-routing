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
export * from "./resolvers";

async function main(): Promise<void> {
    const config = await loadConfig();
    const cacheManager = new DragonflyCacheManager(config.dragonfly);
    const router = new UpstreamRouter(config);
    const eventHub = new EventHubManager(config.eventHub);
    const httpHandler = new HttpProxyHandler(config, cacheManager, router, eventHub);
    const wsProxy = new WebSocketProxyHandler(config);
    const pendingUpgradeHeaders = new Map<string, Record<string, string>>();

    const server = Bun.serve<WsClientData>({
        port: config.server.port,
        hostname: config.server.host,
        idleTimeout: 30,
        maxRequestBodySize: 16 * 1024 * 1024,
        async fetch(req, bunServer) {
            const url = new URL(req.url);

            if (config.eventHub.enabled && url.pathname === (config.eventHub.path || "/proxy/events")) {
                if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                    return new Response("WebSocket upgrade required", { status: 426 });
                }
                if (req.headers.get("authorization") !== config.eventHub.authToken) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const clientId = `client_${crypto.randomUUID()}`;
                const upgraded = bunServer.upgrade(req, {
                    data: {
                        type: "event_hub",
                        clientId,
                        name: req.headers.get("client-name") || "Worker",
                        handlers: new Set<string>(),
                    },
                });
                return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
            }

            if (url.pathname === "/v4/websocket") {
                if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
                    return new Response("WebSocket upgrade required", { status: 426 });
                }
                if (config.server.password && req.headers.get("authorization") !== config.server.password) {
                    return new Response("Unauthorized", { status: 401 });
                }

                const clientId = `session_${crypto.randomUUID()}`;
                const headers: Record<string, string> = {};
                req.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
                pendingUpgradeHeaders.set(clientId, headers);
                const upgraded = bunServer.upgrade(req, {
                    data: { type: "lavalink_passthrough", clientId },
                });
                if (!upgraded) pendingUpgradeHeaders.delete(clientId);
                return upgraded ? undefined : new Response("Upgrade failed", { status: 400 });
            }

            try {
                return await httpHandler.handleRequest(req);
            } catch (error) {
                console.error("[Server] Unhandled request error:", error);
                return Response.json({ error: "Internal Server Error" }, { status: 500 });
            }
        },
        websocket: {
            maxPayloadLength: 1024 * 1024,
            backpressureLimit: config.server.websocketMaxQueueBytes ?? 1024 * 1024,
            closeOnBackpressureLimit: true,
            sendPings: true,
            open(ws) {
                if (ws.data.type === "event_hub") {
                    eventHub.onOpen(ws);
                } else {
                    const headers = pendingUpgradeHeaders.get(ws.data.clientId) || {};
                    pendingUpgradeHeaders.delete(ws.data.clientId);
                    wsProxy.onOpen(ws, headers);
                }
            },
            message(ws, message) {
                if (ws.data.type === "event_hub") eventHub.onMessage(ws, message);
                else wsProxy.onMessage(ws, message);
            },
            close(ws, code, reason) {
                if (ws.data.type === "event_hub") eventHub.onClose(ws, code, reason);
                else wsProxy.onClose(ws, code, reason);
            },
        },
    });

    console.log(`[Proxy] Bun server listening on http://${server.hostname}:${server.port}`);
    console.log(`[Proxy] Default playback upstream: ${config.upstreams.default.id} (${config.upstreams.default.url})`);
    console.log(`[Proxy] Dragonfly cache: ${config.dragonfly.enabled ? "enabled" : "disabled"}`);
    console.log(`[Proxy] Event Hub: ${config.eventHub.enabled ? config.eventHub.path : "disabled"}`);

    let shuttingDown = false;
    const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log("[Proxy] Shutting down gracefully");
        eventHub.close();
        server.stop(true);
        await cacheManager.close();
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());
}

main().catch((error) => {
    console.error("[Fatal] Failed to start Lavalink proxy:", error);
    process.exit(1);
});
