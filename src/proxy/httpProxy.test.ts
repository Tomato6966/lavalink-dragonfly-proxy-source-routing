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
});
