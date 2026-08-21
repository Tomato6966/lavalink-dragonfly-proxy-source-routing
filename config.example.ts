import type { LavalinkProxyConfig } from "./src/types";

/**
 * Type-safe Lavalink Dragonfly Proxy Configuration Template
 * 
 * Copy this file to `config.ts` or configure via `.env` variables.
 */
export const config: LavalinkProxyConfig = {
    server: {
        port: Number(process.env.PORT || process.env.PROXY_PORT || 2332),
        host: process.env.HOST || process.env.PROXY_HOST || "0.0.0.0",
        password: process.env.PASSWORD || process.env.PROXY_PASSWORD || "youshallnotpass",
    },
    dragonfly: {
        enabled: process.env.DRAGONFLY_ENABLED !== "false",
        url: process.env.DRAGONFLY_URL || process.env.REDIS_URL || "redis://127.0.0.1:6379",
        password: process.env.DRAGONFLY_PASSWORD || process.env.PASSWORD || "youshallnotpass",
        keyPrefix: process.env.DRAGONFLY_KEY_PREFIX || "lavalink_proxy",
        searchTtlSeconds: Number(process.env.SEARCH_TTL || 259200),
        trackTtlSeconds: Number(process.env.TRACK_TTL || 86400),
        lyricsTtlSeconds: Number(process.env.LYRICS_TTL || 604800),
        maxCachedEntries: Number(process.env.MAX_CACHED_ENTRIES || 100000),
    },
    eventHub: {
        enabled: process.env.EVENT_HUB_ENABLED !== "false",
        path: process.env.EVENT_HUB_PATH || "/proxy/events",
        authToken: process.env.EVENT_HUB_AUTH_TOKEN || process.env.PASSWORD || "youshallnotpass",
        defaultTimeoutMs: Number(process.env.EVENT_HUB_TIMEOUT_MS || 3000),
    },
    remapping: {
        enabled: true,
        maxRecursionDepth: Number(process.env.MAX_RECURSION_DEPTH || 4),
        preRequest: [
            {
                name: "cleanTracking",
                transformerName: "cleanUrlTracking",
            },
            {
                name: "spotifySearchToDeezer",
                prefix: "spsearch:",
                rewritePrefix: "dzsearch:",
            },
            {
                name: "youtubeUrlToIdentifier",
                match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
                transformerName: "youtubeUrlToIdentifier",
            },
        ],
        postRequestOnFail: [
            {
                name: "youtubeDirectLinkFailToSearch",
                match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
                onErrors: ["*"],
                targetPrefix: "ytsearch:",
                routeToNode: "default",
            },
            {
                name: "youtubeSearchFailToDeezer",
                match: "^ytsearch:",
                targetPrefix: "dzsearch:",
                routeToNode: "default",
            },
            {
                name: "deezerFailToEventHubWorker",
                match: "^dzsearch:",
                routeToFallbackFn: true,
                eventHubHandler: "resolveFallbackTrack",
                timeoutMs: 3500,
            },
            {
                name: "lastResortSoundCloud",
                match: "^.*$",
                targetPrefix: "scsearch:",
                routeToNode: "default",
            },
        ],
    },
    upstreams: {
        default: {
            id: "lavalink_main",
            url: process.env.UPSTREAM_DEFAULT_URL || "http://127.0.0.1:2333",
            wsUrl: process.env.UPSTREAM_DEFAULT_WS_URL || "ws://127.0.0.1:2333/v4/websocket",
            password: process.env.UPSTREAM_DEFAULT_PASSWORD || "youshallnotpass",
        },
        nodelink_node: {
            id: "nodelink_backup",
            url: process.env.UPSTREAM_NODELINK_URL || "http://127.0.0.1:2334",
            wsUrl: process.env.UPSTREAM_NODELINK_WS_URL || "ws://127.0.0.1:2334/v4/websocket",
            password: process.env.UPSTREAM_NODELINK_PASSWORD || "youshallnotpass",
        },
    },
    logging: {
        debug: process.env.LOG_DEBUG === "true",
        logHits: process.env.LOG_HITS !== "false",
        logMisses: process.env.LOG_MISSES !== "false",
        logRoutes: process.env.LOG_ROUTES !== "false",
        logFallbacks: process.env.LOG_FALLBACKS !== "false",
    },
};

export default config;
