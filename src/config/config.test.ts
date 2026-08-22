import { describe, expect, it } from "bun:test";
import { validateConfig } from "./index";
import type { LavalinkProxyConfig } from "../types";

function makeConfig(): LavalinkProxyConfig {
    return {
        server: { port: 2332, host: "127.0.0.1", password: "secret" },
        dragonfly: {
            enabled: false,
            url: "redis://127.0.0.1:6379",
            keyPrefix: "test",
            searchTtlSeconds: 60,
            trackTtlSeconds: 60,
            lyricsTtlSeconds: 60,
            maxCachedEntries: 0,
        },
        eventHub: { enabled: true, path: "/proxy/events", authToken: "secret", defaultTimeoutMs: 100 },
        remapping: { enabled: true, maxRecursionDepth: 4, preRequest: [], postRequestOnFail: [] },
        upstreams: {
            default: { id: "default", url: "http://127.0.0.1:2333", password: "upstream" },
        },
        logging: { debug: false, logHits: false, logMisses: false, logRoutes: false, logFallbacks: false },
    };
}

describe("configuration security validation", () => {
    it("requires authentication when Event Hub is enabled", () => {
        const config = makeConfig();
        config.eventHub.authToken = "";
        expect(() => validateConfig(config)).toThrow("eventHub.authToken must not be empty");
    });
});
