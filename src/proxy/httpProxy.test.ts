import { afterEach, describe, expect, it } from "bun:test";
import { HttpProxyHandler } from "./httpProxy";
import { UpstreamRouter } from "../routing";
import type { LavalinkProxyConfig } from "../types";

const originalFetch = globalThis.fetch;
afterEach(() => {
    globalThis.fetch = originalFetch;
});

function makeConfig(): LavalinkProxyConfig {
    return {
        server: {
            port: 2332,
            host: "127.0.0.1",
            password: "secret",
            upstreamRequestTimeoutMs: 500,
            maxInFlightRequests: 10,
        },
        dragonfly: {
            enabled: false,
            url: "redis://127.0.0.1:6379",
            keyPrefix: "test",
            searchTtlSeconds: 60,
            trackTtlSeconds: 60,
            lyricsTtlSeconds: 60,
            maxCachedEntries: 0,
        },
        eventHub: { enabled: false, path: "/proxy/events", authToken: "secret", defaultTimeoutMs: 100 },
        remapping: { enabled: true, maxRecursionDepth: 1, preRequest: [], postRequestOnFail: [] },
        upstreams: { default: { id: "default", url: "http://127.0.0.1:2333", password: "upstream" } },
        logging: { debug: false, logHits: false, logMisses: false, logRoutes: false, logFallbacks: false },
    };
}

function createHandler(config = makeConfig()) {
    let clears = 0;
    let writes = 0;
    const cache = {
        isConnected: false,
        stats: {},
        get: async () => null,
        set: async () => { writes++; },
        clear: async () => ++clears,
        getLearnedRoute: async () => null,
        setLearnedRoute: async () => undefined,
        delLearnedRoute: async () => undefined,
    };
    const eventHub = { connectedClientCount: 0, callHandler: async () => null };
    const handler = new HttpProxyHandler(
        config,
        cache as any,
        new UpstreamRouter(config),
        eventHub as any
    );
    return { handler, getClears: () => clears, getWrites: () => writes };
}

function request(path: string, options: RequestInit = {}): Request {
    const headers = new Headers(options.headers);
    headers.set("authorization", "secret");
    return new Request(`http://proxy${path}`, { ...options, headers });
}

describe("HTTP proxy controls and coalescing", () => {
    it("keeps health minimal/public and protects stats", async () => {
        const { handler } = createHandler();
        expect((await handler.handleRequest(new Request("http://proxy/proxy/health"))).status).toBe(200);
        expect((await handler.handleRequest(new Request("http://proxy/proxy/stats"))).status).toBe(401);
        expect((await handler.handleRequest(request("/proxy/stats"))).status).toBe(200);
    });

    it("exposes an authenticated combined monitoring snapshot", async () => {
        const { handler } = createHandler();
        expect((await handler.handleRequest(new Request("http://proxy/proxy/monitoring"))).status).toBe(401);

        const response = await handler.handleRequest(request("/proxy/monitoring"));
        const body = await response.json() as {
            service: string;
            health: { status: string; cacheReady: boolean };
            stats: { cacheConnected: boolean; configuredUpstreams: string[] };
            traces: unknown[];
        };

        expect(response.status).toBe(200);
        expect(body.service).toBe("lavalink-dragonfly-proxy");
        expect(body.health.status).toBe("ok");
        expect(body.health.cacheReady).toBe(true);
        expect(body.stats.cacheConnected).toBe(false);
        expect(body.stats.configuredUpstreams).toEqual(["default"]);
        expect(Array.isArray(body.traces)).toBe(true);

        const tracesRes = await handler.handleRequest(request("/proxy/traces?limit=10"));
        expect(tracesRes.status).toBe(200);
        const tracesBody = await tracesRes.json() as { traces: unknown[] };
        expect(Array.isArray(tracesBody.traces)).toBe(true);
    });

    it("makes cache clearing an authenticated POST with real deletion", async () => {
        const { handler, getClears } = createHandler();
        expect((await handler.handleRequest(request("/proxy/cache/clear"))).status).toBe(405);
        const response = await handler.handleRequest(request("/proxy/cache/clear", { method: "POST" }));
        expect(response.status).toBe(200);
        expect(getClears()).toBe(1);
    });

    it("coalesces concurrent identical loadtracks misses", async () => {
        const { handler } = createHandler();
        let calls = 0;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        globalThis.fetch = (async () => {
            calls++;
            await gate;
            return Response.json({
                loadType: "track",
                data: { encoded: "real_backend_encoded_track", info: {} },
            });
        }) as unknown as typeof fetch;

        const path = "/v4/loadtracks?identifier=ytsearch%3Atest";
        const first = handler.handleRequest(request(path));
        const second = handler.handleRequest(request(path));
        release();
        const [firstResponse, secondResponse] = await Promise.all([first, second]);

        expect(firstResponse.status).toBe(200);
        expect(secondResponse.status).toBe(200);
        expect(calls).toBe(1);
        expect(secondResponse.headers.get("x-proxy-coalesced")).toBe("HIT");
    });

    it("rejects malformed nested load results without throwing", async () => {
        const { handler, getWrites } = createHandler();
        globalThis.fetch = (async () => Response.json({ loadType: "search", data: null })) as unknown as typeof fetch;

        const response = await handler.handleRequest(request("/v4/loadtracks?identifier=ytsearch%3Atest"));
        const body = await response.json() as { data: { cause?: string } };

        expect(response.status).toBe(502);
        expect(body.data.cause).toContain("Invalid Lavalink load result");
        expect(getWrites()).toBe(0);
    });

    it("does not return structurally valid tracks with unusable encodings", async () => {
        const { handler, getWrites } = createHandler();
        globalThis.fetch = (async () => Response.json({
            loadType: "track",
            data: { encoded: "x", info: {} },
        })) as unknown as typeof fetch;

        const response = await handler.handleRequest(request("/v4/loadtracks?identifier=ytsearch%3Atest"));
        const body = await response.json() as { data: { cause?: string } };

        expect(response.status).toBe(502);
        expect(body.data.cause).toContain("non-playable encoded tracks");
        expect(getWrites()).toBe(0);
    });

    it("does not cache or return tracks from an incompatible encoding scope", async () => {
        const config = makeConfig();
        config.upstreams.default.encodingScope = "lavalink-main";
        config.upstreams.nodelink = {
            id: "nodelink",
            url: "http://127.0.0.1:2334",
            password: "upstream",
            encodingScope: "nodelink",
        };
        config.remapping.preRequest = [{ name: "route-nodelink", match: "^ytsearch:", routeToNode: "nodelink" }];
        const { handler, getWrites } = createHandler(config);
        globalThis.fetch = (async () => Response.json({
            loadType: "track",
            data: { encoded: "nodelink_encoded_track", info: {} },
        })) as unknown as typeof fetch;

        const response = await handler.handleRequest(request("/v4/loadtracks?identifier=ytsearch%3Atest"));
        const body = await response.json() as { data: { cause?: string } };

        expect(response.status).toBe(502);
        expect(body.data.cause).toContain("incompatible with playback scope");
        expect(getWrites()).toBe(0);
    });

    it("intercepts direct identifier in player PATCH and resolves encoded track", async () => {
        const { handler } = createHandler();
        let lastUpstreamBody: any = null;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("/v4/loadtracks")) {
                return Response.json({
                    loadType: "track",
                    data: {
                        encoded: "resolved_direct_playable_encoded_base64_track_data",
                        info: { title: "Test Song", author: "Artist" },
                    },
                });
            }
            if (url.includes("/players/123456")) {
                lastUpstreamBody = JSON.parse(String(init?.body || "{}"));
                return Response.json({ guildId: "123456", track: lastUpstreamBody.track });
            }
            return Response.json({});
        }) as unknown as typeof fetch;

        const response = await handler.handleRequest(request("/v4/sessions/session1/players/123456", {
            method: "PATCH",
            body: JSON.stringify({
                track: {
                    identifier: "dzsearch:Shape of You",
                    userData: { requesterId: "987654" },
                },
                volume: 80,
            }),
        }));

        expect(response.status).toBe(200);
        expect(response.headers.get("x-proxy-direct-playback")).toBe("RESOLVED");
        expect(lastUpstreamBody).not.toBeNull();
        expect(lastUpstreamBody.track.encoded).toBe("resolved_direct_playable_encoded_base64_track_data");
        expect(lastUpstreamBody.track.userData.requesterId).toBe("987654");
    });

    it("handles batch prefetch of upcoming tracks", async () => {
        const { handler } = createHandler();
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/v4/loadtracks")) {
                return Response.json({
                    loadType: "track",
                    data: {
                        encoded: "prefetched_playable_track_encoded_string_123",
                        info: { title: "Track", author: "Artist" },
                    },
                });
            }
            return Response.json({});
        }) as unknown as typeof fetch;

        const response = await handler.handleRequest(request("/proxy/cache/prefetch", {
            method: "POST",
            body: JSON.stringify({
                identifiers: ["ytsearch:song1", "ytsearch:song2"],
            }),
        }));

        expect(response.status).toBe(200);
        const body = await response.json() as { status: string; prefetched: number; results: any[] };
        expect(body.status).toBe("ok");
        expect(body.prefetched).toBe(2);
        expect(body.results[0].status).toBe("ok");
    });

    it("handles decode tracks with cache integration", async () => {
        const { handler } = createHandler();
        let decodeCalls = 0;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (url.includes("/v4/decodetrack")) {
                decodeCalls++;
                return Response.json({
                    identifier: "track_id_123",
                    title: "Decoded Title",
                    author: "Decoded Author",
                });
            }
            return Response.json({});
        }) as unknown as typeof fetch;

        const res1 = await handler.handleRequest(request("/v4/decodetrack?encodedTrack=sample_encoded"));
        expect(res1.status).toBe(200);
        expect(decodeCalls).toBe(1);
    });

    it("serves live configuration snapshot via GET /proxy/config", async () => {
        const { handler } = createHandler();
        const response = await handler.handleRequest(request("/proxy/config"));
        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.server.port).toBe(2332);
        expect(body.remapping.enabled).toBe(true);
        expect(body.upstreams.default.id).toBe("default");
    });

    it("updates configuration live at runtime via PATCH /proxy/config", async () => {
        const { handler } = createHandler();
        let notifiedConfig: any = null;
        handler.onConfigUpdated = (cfg) => {
            notifiedConfig = cfg;
        };

        const response = await handler.handleRequest(request("/proxy/config", {
            method: "PATCH",
            body: JSON.stringify({
                mode: "temporary",
                server: { primaryPlaybackNode: "nodelink_backup" },
                remapping: { deezerYtmBridgeEnabled: true, maskSourceToRequested: true },
            }),
        }));

        expect(response.status).toBe(200);
        const body = await response.json() as any;
        expect(body.success).toBe(true);
        expect(body.mode).toBe("temporary");
        expect(body.config.server.primaryPlaybackNode).toBe("nodelink_backup");
        expect(body.config.remapping.deezerYtmBridgeEnabled).toBe(true);
        expect(notifiedConfig?.server?.primaryPlaybackNode).toBe("nodelink_backup");
    });

    it("routes playback to designated primaryPlaybackNode and playerRouting rules", () => {
        const config = makeConfig();
        config.upstreams.nodelink = { id: "nodelink_node", url: "http://127.0.0.1:2334" };
        config.upstreams.vip_node = { id: "vip_lavalink", url: "http://127.0.0.1:2335" };
        config.server.primaryPlaybackNode = "nodelink";
        config.server.playerRouting = [
            { guildId: "999999999", routeToNode: "vip_node" },
            { guildIdMatch: "^vip_", routeToNode: "vip_node" },
        ];

        const { handler } = createHandler(config);

        // 1. Guild ID match -> VIP node
        expect(handler.getPlaybackNode("/v4/sessions/sess1/players/999999999").id).toBe("vip_lavalink");
        expect(handler.getPlaybackNode("/v4/sessions/sess1/players/vip_guild_123").id).toBe("vip_lavalink");

        // 2. Unmatched guild ID -> primary playback node (nodelink)
        expect(handler.getPlaybackNode("/v4/sessions/sess1/players/123456").id).toBe("nodelink_node");
        expect(handler.getPlaybackNode().id).toBe("nodelink_node");
    });
});
