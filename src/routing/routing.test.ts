import { describe, expect, it } from "bun:test";
import { UpstreamRouter, classifyIdentifier } from "./index";
import type { LavalinkProxyConfig } from "../types";

function makeConfig(): LavalinkProxyConfig {
    return {
        server: { port: 2332, host: "127.0.0.1", password: "test" },
        dragonfly: {
            enabled: false,
            url: "redis://127.0.0.1:6379",
            keyPrefix: "test",
            searchTtlSeconds: 60,
            trackTtlSeconds: 60,
            lyricsTtlSeconds: 60,
            maxCachedEntries: 0,
        },
        eventHub: { enabled: false, path: "/proxy/events", authToken: "test", defaultTimeoutMs: 100 },
        remapping: { enabled: true, maxRecursionDepth: 4, preRequest: [], postRequestOnFail: [] },
        upstreams: {
            default: { id: "default", url: "http://127.0.0.1:2333", password: "test" },
            nodelink: { id: "nodelink", url: "http://127.0.0.1:2334", password: "test" },
        },
        logging: { debug: false, logHits: false, logMisses: false, logRoutes: false, logFallbacks: false },
    };
}

describe("upstream routing", () => {
    it("composes global cleanup and a later node-routing rule", async () => {
        const config = makeConfig();
        config.remapping.preRequest = [
            { name: "clean", transformerName: "cleanUrlTracking" },
            { name: "youtube-node", match: "youtube\\.com", routeToNode: "nodelink" },
        ];
        const result = await new UpstreamRouter(config).applyPreRequest(
            "https://www.youtube.com/watch?v=qeMFqkcPYcg&si=tracking"
        );
        expect(result.transformedIdentifier).not.toContain("si=");
        expect(result.targetNode.id).toBe("nodelink");
        expect(result.isRemapped).toBe(true);
    });

    it("recomputes cache category after a prefix rewrite", async () => {
        const config = makeConfig();
        config.remapping.preRequest = [
            { name: "spotify-to-deezer", prefix: "spsearch:", rewritePrefix: "dzsearch:" },
        ];
        const result = await new UpstreamRouter(config).applyPreRequest("spsearch:Adele Hello");
        expect(result.transformedIdentifier).toBe("dzsearch:Adele Hello");
        expect(result.cacheCategory).toBe("search");
    });

    it("can match a direct original identifier after pre-transformation", async () => {
        const config = makeConfig();
        config.remapping.preRequest = [
            { name: "youtube-to-search", match: "youtube\\.com", transformerName: "youtubeUrlToSearch" },
        ];
        config.remapping.postRequestOnFail = [
            { name: "direct-fallback", match: "youtube\\.com", routeToFallbackFn: true, eventHubHandler: "resolve", encodingScope: "default" },
        ];
        const router = new UpstreamRouter(config);
        const original = "https://www.youtube.com/watch?v=qeMFqkcPYcg";
        const pre = await router.applyPreRequest(original);
        const fallback = await router.getNextFallback(pre.transformedIdentifier, {
            originalIdentifier: original,
            message: "source failed",
            isEmpty: false,
            loadType: "error",
        });
        expect(pre.transformedIdentifier).toBe("ytsearch:qeMFqkcPYcg");
        expect(fallback?.isEventHub).toBe(true);
        expect(fallback?.encodingScope).toBe("default");
    });

    it("skips non-node fallbacks without explicit encoding provenance", async () => {
        const config = makeConfig();
        config.remapping.postRequestOnFail = [{
            name: "unscoped-worker",
            match: "^ytsearch:",
            routeToFallbackFn: true,
            eventHubHandler: "resolve",
        }];
        const fallback = await new UpstreamRouter(config).getNextFallback("ytsearch:test", {
            originalIdentifier: "ytsearch:test",
            message: "source failed",
            isEmpty: false,
        });
        expect(fallback).toBeNull();
    });

    it("applies specific error filters", async () => {
        const config = makeConfig();
        config.remapping.postRequestOnFail = [
            {
                name: "youtube-auth",
                match: "^ytsearch:",
                onErrors: ["sign in"],
                onLoadTypes: ["error"],
                targetPrefix: "scsearch:",
            },
        ];
        const router = new UpstreamRouter(config);
        const fallback = await router.getNextFallback("ytsearch:test", {
            originalIdentifier: "ytsearch:test",
            message: "Please sign in to continue",
            isEmpty: false,
            loadType: "error",
        });
        expect(fallback?.nextIdentifier).toBe("scsearch:test");

        const noFallback = await router.getNextFallback("ytsearch:test", {
            originalIdentifier: "ytsearch:test",
            message: "unrelated error",
            isEmpty: false,
            loadType: "error",
        });
        expect(noFallback).toBeNull();
    });

    it("applies status predicates to empty-result fallbacks", async () => {
        const config = makeConfig();
        config.remapping.postRequestOnFail = [{
            name: "empty-500-only",
            match: "^ytsearch:",
            fallbackOnEmpty: true,
            onLoadTypes: ["empty"],
            onHttpStatuses: [500],
            targetPrefix: "scsearch:",
        }];
        const router = new UpstreamRouter(config);
        const failure = {
            originalIdentifier: "ytsearch:test",
            message: "",
            isEmpty: true,
            loadType: "empty" as const,
        };

        expect(await router.getNextFallback("ytsearch:test", { ...failure, httpStatus: 200 })).toBeNull();
        expect((await router.getNextFallback("ytsearch:test", { ...failure, httpStatus: 500 }))?.nextIdentifier)
            .toBe("scsearch:test");
    });

    it("classifies plugin search prefixes without treating direct URLs as search", () => {
        expect(classifyIdentifier("amsearch:artist song")).toBe("search");
        expect(classifyIdentifier("https://open.spotify.com/track/id")).toBe("track");
        expect(classifyIdentifier("lyrics:artist song")).toBe("lyrics");
    });
});
