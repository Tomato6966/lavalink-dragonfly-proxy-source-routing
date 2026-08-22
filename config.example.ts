import type { LavalinkProxyConfig, PostRequestOnFailRule } from "./src/types";

const proxyPassword = process.env.PASSWORD || process.env.PROXY_PASSWORD || "youshallnotpass";
const enableDistubeFallback = process.env.DISTUBE_YTSR_ENABLED !== "false";

const fallbackRules: PostRequestOnFailRule[] = [
    {
        name: "spotifyDirectMetadataFallback",
        match: "^(?:https?://open\\.spotify\\.com/(?:track|episode)/|spotify:(?:track|episode):)",
        metadataResolver: "spotifyUrlToYoutubeSearch",
        routeToNode: "default",
        timeoutMs: Number(process.env.SPOTIFY_METADATA_TIMEOUT_MS || 1800),
    },
    {
        name: "youtubeDirectLinkFailToSearch",
        match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
        onErrors: ["*"],
        targetPrefix: "ytsearch:",
        routeToNode: "default",
        timeoutMs: 1800,
    },
    {
        name: "youtubeSearchFailToDeezer",
        match: "^(?:yt|ytm)search:",
        targetPrefix: "dzsearch:",
        routeToNode: "default",
    },
    {
        name: "deezerFailToEventHubWorker",
        match: "^dzsearch:",
        routeToFallbackFn: true,
        eventHubHandler: "resolveFallbackTrack",
        timeoutMs: 2500,
        encodingScope: process.env.EVENT_HUB_ENCODING_SCOPE || "lavalink-main",
    },
    {
        name: "lastResortSoundCloud",
        match: "^(?:dz|sp|am|yt|ytm)search:",
        targetPrefix: "scsearch:",
        routeToNode: "default",
    },
];

if (enableDistubeFallback) {
    fallbackRules.push({
        name: "lastResortDistubeYoutubeSearch",
        match: "^(?:sc|dz|sp|am|yt|ytm)search:",
        metadataResolver: "distubeYoutubeSearch",
        routeToNode: "default",
        timeoutMs: Number(process.env.DISTUBE_YTSR_TIMEOUT_MS || 1800),
    });
}

/**
 * Copy to config.ts for host-specific policy. Keep the default playback node and
 * any search-fallback node codec/source compatible before mixing encoded tracks.
 */
export const config: LavalinkProxyConfig = {
    server: {
        port: Number(process.env.PORT || process.env.PROXY_PORT || 2332),
        host: process.env.HOST || process.env.PROXY_HOST || "127.0.0.1",
        password: proxyPassword,
        upstreamRequestTimeoutMs: Number(process.env.UPSTREAM_REQUEST_TIMEOUT_MS || 3500),
        maxLoadResultBytes: Number(process.env.MAX_LOAD_RESULT_BYTES || 8 * 1024 * 1024),
        maxInFlightRequests: Number(process.env.MAX_IN_FLIGHT_REQUESTS || 1000),
        websocketMaxQueueMessages: Number(process.env.WS_MAX_QUEUE_MESSAGES || 256),
        websocketMaxQueueBytes: Number(process.env.WS_MAX_QUEUE_BYTES || 1024 * 1024),
    },
    dragonfly: {
        enabled: process.env.DRAGONFLY_ENABLED !== "false",
        url: process.env.DRAGONFLY_URL || process.env.REDIS_URL || "redis://127.0.0.1:6379",
        password: process.env.DRAGONFLY_PASSWORD || undefined,
        keyPrefix: process.env.DRAGONFLY_KEY_PREFIX || "lavalink_proxy",
        searchTtlSeconds: Number(process.env.SEARCH_TTL || 2678400),
        trackTtlSeconds: Number(process.env.TRACK_TTL || 2678400),
        lyricsTtlSeconds: Number(process.env.LYRICS_TTL || 604800),
        maxCachedEntries: Number(process.env.MAX_CACHED_ENTRIES || 100000),
        commandTimeoutMs: Number(process.env.DRAGONFLY_COMMAND_TIMEOUT_MS || 750),
        memoryMaxEntries: Number(process.env.MEMORY_CACHE_MAX_ENTRIES || 1000),
        memoryMaxBytes: Number(process.env.MEMORY_CACHE_MAX_BYTES || 32 * 1024 * 1024),
        memoryTtlSeconds: Number(process.env.MEMORY_CACHE_TTL || 604800),
        maxEntryBytes: Number(process.env.CACHE_MAX_ENTRY_BYTES || 4 * 1024 * 1024),
        fuzzySearchEnabled: process.env.FUZZY_SEARCH_ENABLED === "true",
        fuzzySearchThreshold: Number(process.env.FUZZY_SEARCH_THRESHOLD || 0.9),
        ttlJitterPercent: Number(process.env.CACHE_TTL_JITTER || 0.05),
    },
    eventHub: {
        enabled: process.env.EVENT_HUB_ENABLED !== "false",
        path: process.env.EVENT_HUB_PATH || "/proxy/events",
        authToken: process.env.EVENT_HUB_AUTH_TOKEN || proxyPassword,
        defaultTimeoutMs: Number(process.env.EVENT_HUB_TIMEOUT_MS || 2500),
    },
    remapping: {
        enabled: process.env.REMAPPING_ENABLED !== "false",
        maxRecursionDepth: Number(process.env.MAX_RECURSION_DEPTH || 6),
        routeLearning: process.env.ROUTE_LEARNING_ENABLED !== "false",
        routeLearningTtlSeconds: Number(process.env.ROUTE_LEARNING_TTL || 1800),
        preRequest: [
            {
                name: "cleanTracking",
                transformerName: "cleanUrlTracking",
            },
            {
                name: "normalizeIsrc",
                match: "isrc:",
                transformerName: "normalizeIsrc",
            },
        ],
        postRequestOnFail: fallbackRules,
    },
    upstreams: {
        default: {
            id: "lavalink_main",
            url: process.env.UPSTREAM_DEFAULT_URL || "http://127.0.0.1:2333",
            wsUrl: process.env.UPSTREAM_DEFAULT_WS_URL || "ws://127.0.0.1:2333/v4/websocket",
            password: process.env.UPSTREAM_DEFAULT_PASSWORD || proxyPassword,
            encodingScope: process.env.UPSTREAM_DEFAULT_ENCODING_SCOPE || "lavalink-main",
            requestTimeoutMs: Number(process.env.UPSTREAM_DEFAULT_TIMEOUT_MS || 3500),
            failureThreshold: Number(process.env.UPSTREAM_DEFAULT_FAILURE_THRESHOLD || 5),
            circuitBreakerResetMs: Number(process.env.UPSTREAM_DEFAULT_CIRCUIT_RESET_MS || 15000),
        },
        nodelink_node: {
            id: "nodelink_backup",
            url: process.env.UPSTREAM_NODELINK_URL || "http://127.0.0.1:2334",
            wsUrl: process.env.UPSTREAM_NODELINK_WS_URL || "ws://127.0.0.1:2334/v4/websocket",
            password: process.env.UPSTREAM_NODELINK_PASSWORD || proxyPassword,
            encodingScope: process.env.UPSTREAM_NODELINK_ENCODING_SCOPE || "nodelink",
            enabled: process.env.UPSTREAM_NODELINK_ENABLED === "true",
            requestTimeoutMs: Number(process.env.UPSTREAM_NODELINK_TIMEOUT_MS || 3500),
            failureThreshold: Number(process.env.UPSTREAM_NODELINK_FAILURE_THRESHOLD || 5),
            circuitBreakerResetMs: Number(process.env.UPSTREAM_NODELINK_CIRCUIT_RESET_MS || 15000),
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
