import type { LavalinkProxyConfig, PostRequestOnFailRule } from "./src/types";

/**
 * =========================================================================================
 *  LAVALINK DRAGONFLY PROXY - COMPLETE CONFIGURATION & ARCHITECTURE SPECIFICATION
 * =========================================================================================
 * 
 * This file documents every tunable parameter in the proxy, explaining what each line
 * controls, default behaviors, performance trade-offs, and how to auto-route playback.
 * 
 * 💡 TIPS:
 * - Copy this file to `config.ts` to customize your host setup.
 * - Runtime settings can also be modified live without downtime via the Admin REST API
 *   (`PATCH /proxy/config`) or from the Web Dashboard. Permanent changes are saved to
 *   `config.overwrites.ts`.
 */

// ─── Environment Variable Fallbacks ──────────────────────────────────────────────────────
const proxyPassword = process.env.PASSWORD || process.env.PROXY_PASSWORD || "youshallnotpass";
const enableDistubeFallback = process.env.DISTUBE_YTSR_ENABLED !== "false";

// ─── Cascading Failover Rule Definitions ─────────────────────────────────────────────────
/**
 * PostRequestOnFail rules execute sequentially when an upstream returns an error,
 * rate limit (429), or empty search result.
 */
const fallbackRules: PostRequestOnFailRule[] = [
    // 1. If Spotify search fails (e.g. rate-limit or quota), fall back to YouTube Music
    {
        name: "spotifySearchFailToYtMusic",
        match: "^spsearch:",
        targetPrefix: "ytmsearch:",
        routeToNode: "default",
    },
    // 2. If YouTube Music fails, fall back to Deezer
    {
        name: "ytMusicFailToDeezer",
        match: "^ytmsearch:",
        targetPrefix: "dzsearch:",
        routeToNode: "default",
    },
    // 3. If direct Spotify link fails, extract metadata via oEmbed/API and resolve on YouTube
    {
        name: "spotifyDirectMetadataFallback",
        match: "^(?:https?://open\\.spotify\\.com/(?:track|episode)/|spotify:(?:track|episode):)",
        metadataResolver: "spotifyUrlToYoutubeSearch",
        routeToNode: "default",
        timeoutMs: Number(process.env.SPOTIFY_METADATA_TIMEOUT_MS || 1800),
    },
    // 4. If YouTube direct link fails (e.g. 403 or signature decipher failure), retry via ytsearch title
    {
        name: "youtubeDirectLinkFailToSearch",
        match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
        onErrors: ["*"],
        targetPrefix: "ytsearch:",
        routeToNode: "default",
        timeoutMs: 1800,
    },
    // 5. If YouTube search fails, try Deezer
    {
        name: "youtubeSearchFailToDeezer",
        match: "^(?:yt|ytm)search:",
        targetPrefix: "dzsearch:",
        routeToNode: "default",
    },
    // 6. If Deezer search fails, fall back to YouTube Music
    {
        name: "deezerFailToYtMusic",
        match: "^dzsearch:",
        targetPrefix: "ytmsearch:",
        routeToNode: "default",
    },
    // 7. If Deezer fails completely, hand off to external EventHub resolver worker (if enabled)
    {
        name: "deezerFailToEventHubWorker",
        match: "^dzsearch:",
        routeToFallbackFn: true,
        eventHubHandler: "resolveFallbackTrack",
        timeoutMs: 2500,
        encodingScope: process.env.EVENT_HUB_ENCODING_SCOPE || "lavalink-main",
    },
    // 8. Last resort: fall back to SoundCloud
    {
        name: "lastResortSoundCloud",
        match: "^(?:dz|sp|am|yt|ytm)search:",
        targetPrefix: "scsearch:",
        routeToNode: "default",
    },
];

// Optional: DisTube YouTube scraper resolver (headless search when Lavalink YouTube is blocked)
if (enableDistubeFallback) {
    fallbackRules.push({
        name: "lastResortDistubeYoutubeSearch",
        match: "^(?:sc|dz|sp|am|yt|ytm)search:",
        metadataResolver: "distubeYoutubeSearch",
        routeToNode: "default",
        timeoutMs: Number(process.env.DISTUBE_YTSR_TIMEOUT_MS || 1800),
    });
}

// ─── Main Proxy Configuration ────────────────────────────────────────────────────────────
export const config: LavalinkProxyConfig = {
    /**
     * [SERVER] Network and Downstream Client Facing Settings
     */
    server: {
        // HTTP port the proxy listens on for Lavalink client connections (default: 2332)
        port: Number(process.env.PORT || process.env.PROXY_PORT || 2332),

        // Network interface IP to bind to ("0.0.0.0" for all interfaces, "127.0.0.1" for localhost only)
        host: process.env.HOST || process.env.PROXY_HOST || "0.0.0.0",

        // Authorization password that Discord music bots must provide in the "Authorization" header
        password: proxyPassword,

        // Total timeout in milliseconds for upstream REST requests before triggering fallback cascades (default: 3500ms)
        upstreamRequestTimeoutMs: Number(process.env.UPSTREAM_REQUEST_TIMEOUT_MS || 3500),

        // Maximum payload size in bytes accepted from upstream before skipping caching / parsing (default: 8MB)
        maxLoadResultBytes: Number(process.env.MAX_LOAD_RESULT_BYTES || 8 * 1024 * 1024),

        // Maximum concurrent in-flight loadtracks requests before shedding load with 503 Retry-After (default: 1000)
        maxInFlightRequests: Number(process.env.MAX_IN_FLIGHT_REQUESTS || 1000),

        // Maximum buffered WebSocket messages per client connection before applying backpressure (default: 256)
        websocketMaxQueueMessages: Number(process.env.WS_MAX_QUEUE_MESSAGES || 256),

        // Maximum queued WebSocket byte size per client connection (default: 1MB)
        websocketMaxQueueBytes: Number(process.env.WS_MAX_QUEUE_BYTES || 1024 * 1024),

        /**
         * 🎧 [PRIMARY PLAYBACK NODE CONFIGURATION]
         * 
         * Specifies which upstream node (from the `upstreams` dictionary below) is used
         * primarily for player updates, player creations, state fetching, and audio streaming.
         * 
         * Options:
         * - "default"        -> Uses the default Lavalink node (e.g. lavalink_main on port 2333)
         * - "nodelink_node"  -> Routes all player sessions to NodeLink (on port 2334)
         * - Any custom key defined in `upstreams`
         */
        primaryPlaybackNode: process.env.PRIMARY_PLAYBACK_NODE || "default",

        /**
         * 🔀 [PLAYBACK AUTO-ROUTING RULES]
         * 
         * Rules to automatically steer voice players & playback sessions to different nodes
         * based on Discord Guild ID (exact match or regex pattern / shard distribution).
         * 
         * Example:
         * [
         *   { guildId: "1170352918529052752", routeToNode: "nodelink_node" }, // Dedicated VIP server
         *   { guildIdMatch: "^[0-4]", routeToNode: "default" },               // Shard 0 guilds
         *   { guildIdMatch: "^[5-9]", routeToNode: "nodelink_node" }          // Shard 1 guilds
         * ]
         */
        playerRouting: [
            // Add custom guild-to-node routing rules here if needed
        ],
    },

    /**
     * [DRAGONFLY / REDIS CACHE] Multi-Tiered L1 Memory & Remote Cache
     */
    dragonfly: {
        // Master switch to enable/disable Dragonfly/Redis caching (default: true)
        enabled: process.env.DRAGONFLY_ENABLED !== "false",

        // Connection URI to Dragonfly / Redis server (default: redis://127.0.0.1:6666)
        url: process.env.DRAGONFLY_URL || process.env.REDIS_URL || "redis://127.0.0.1:6666",

        // Authentication password for Dragonfly / Redis (leave undefined if unauthenticated)
        password: process.env.DRAGONFLY_PASSWORD || undefined,

        // Key prefix used in Redis to isolate proxy data (default: "mivator:lavalink")
        keyPrefix: process.env.DRAGONFLY_KEY_PREFIX || "mivator:lavalink",

        // Time-To-Live in seconds for search query results (default: 2,678,400s = 31 days)
        searchTtlSeconds: Number(process.env.SEARCH_TTL || 2678400),

        // Time-To-Live in seconds for resolved track metadata and decoded tokens (default: 31 days)
        trackTtlSeconds: Number(process.env.TRACK_TTL || 2678400),

        // Time-To-Live in seconds for timed lyrics results (default: 604,800s = 7 days)
        lyricsTtlSeconds: Number(process.env.LYRICS_TTL || 604800),

        // Maximum total entries tracked in cache index (0 = unlimited, default: 100,000)
        maxCachedEntries: Number(process.env.MAX_CACHED_ENTRIES || 100000),

        // Socket command timeout in milliseconds for Dragonfly read/write operations (default: 750ms)
        commandTimeoutMs: Number(process.env.DRAGONFLY_COMMAND_TIMEOUT_MS || 750),

        // Maximum entries stored in hot in-process L1 memory cache (default: 1,000)
        memoryMaxEntries: Number(process.env.MEMORY_CACHE_MAX_ENTRIES || 1000),

        // Maximum memory in bytes allocated for hot L1 cache (default: 32MB)
        memoryMaxBytes: Number(process.env.MEMORY_CACHE_MAX_BYTES || 32 * 1024 * 1024),

        // Time-To-Live in seconds for hot L1 memory entries (default: 7 days)
        memoryTtlSeconds: Number(process.env.MEMORY_CACHE_TTL || 604800),

        // Maximum serialized byte size for a single cache entry; larger payloads bypass cache (default: 4MB)
        maxEntryBytes: Number(process.env.CACHE_MAX_ENTRY_BYTES || 4 * 1024 * 1024),

        // Enable fuzzy text similarity matching to serve cache hits on minor typos (default: false)
        fuzzySearchEnabled: process.env.FUZZY_SEARCH_ENABLED === "true",

        // Minimum similarity ratio (0.0 to 1.0) required for a fuzzy search cache hit (default: 0.9 = 90%)
        fuzzySearchThreshold: Number(process.env.FUZZY_SEARCH_THRESHOLD || 0.9),

        // Random percentage jitter added to TTLs to prevent simultaneous cache expiry stampedes (default: 0.05 = 5%)
        ttlJitterPercent: Number(process.env.CACHE_TTL_JITTER || 0.05),
    },

    /**
     * [EVENT HUB] Out-of-Process Distributed Worker Protocol
     */
    eventHub: {
        // Enable external worker WebSocket gateway for custom fallback scrapers (default: true)
        enabled: process.env.EVENT_HUB_ENABLED !== "false",

        // URL pathname where EventHub worker clients connect via WebSocket (default: "/proxy/events")
        path: process.env.EVENT_HUB_PATH || "/proxy/events",

        // Secret token required for worker daemons to authenticate with the proxy
        authToken: process.env.EVENT_HUB_AUTH_TOKEN || proxyPassword,

        // Maximum execution time in milliseconds for an EventHub worker task (default: 2500ms)
        defaultTimeoutMs: Number(process.env.EVENT_HUB_TIMEOUT_MS || 2500),
    },

    /**
     * [REMAPPING & INTELLIGENT RESOLUTION]
     */
    remapping: {
        // Master switch for query remapping and cascade routing (default: true)
        enabled: process.env.REMAPPING_ENABLED !== "false",

        // Maximum number of fallback hops allowed per search before returning 502/empty (default: 4)
        maxRecursionDepth: Number(process.env.MAX_RECURSION_DEPTH || 4),

        // Enable automatic route learning to skip failed cascades on repeated queries (default: true)
        routeLearning: process.env.ROUTE_LEARNING_ENABLED !== "false",

        // Time-To-Live in seconds for learned fast-path routes (default: 1800s = 30 minutes)
        routeLearningTtlSeconds: Number(process.env.ROUTE_LEARNING_TTL || 1800),

        /**
         * 🔍 [MULTI-LANGUAGE SEARCH RE-RANKER]
         * Enables BM25 text relevance, Dice coefficient bigram fuzzy matching, Jaro-Winkler string
         * similarity, ISRC deduplication, and 15+ language cover/tribute/remix noise demotion.
         * Default: true
         */
        searchReRankingEnabled: process.env.SEARCH_RERANKING_ENABLED !== "false",

        /**
         * ⚡ [INTELLIGENT YTM -> DEEZER SEARCH BRIDGE]
         * Solves Deezer's lack of popularity weighting by searching YouTube Music first for authoritative
         * artist & title metadata, then resolving that exact match on Deezer for audio playback.
         * If Deezer fails or is empty, seamlessly plays the YouTube Music track!
         * Default: true
         */
        deezerYtmBridgeEnabled: process.env.DEEZER_YTM_BRIDGE_ENABLED !== "false",

        /**
         * 🎭 [SOURCE MASKING / "SOURCE ILLUSION"]
         * Replaces `track.info.sourceName` to match the client's original requested source (e.g. "deezer" or "spotify"),
         * keeping Discord UI embeds consistent while preserving real backend info in `track.pluginInfo.actualSource`.
         * Default: true
         */
        maskSourceToRequested: process.env.MASK_SOURCE_TO_REQUESTED !== "false",

        // Pre-request rewrite and normalization rules applied before querying any backend
        preRequest: [
            // Strip tracking query parameters (si, utm_*, fbclid) from URLs to prevent duplicate cache entries
            {
                name: "cleanTracking",
                transformerName: "cleanUrlTracking",
            },
            // Normalize ISRC formatting to uppercase alphanumeric
            {
                name: "normalizeIsrc",
                match: "isrc:",
                transformerName: "normalizeIsrc",
            },
            // Direct Spotify search routing: use NodeLink if enabled, else rewrite to YouTube Music
            ...(process.env.UPSTREAM_NODELINK_ENABLED === "true"
                ? [
                      {
                          name: "spotifySearchToNodeLink",
                          prefix: "spsearch:",
                          routeToNode: "nodelink_node",
                      },
                  ]
                : [
                      {
                          name: "spotifySearchToYtMusic",
                          prefix: "spsearch:",
                          rewritePrefix: "ytmsearch:",
                      },
                  ]),
            // Convert raw YouTube URLs into accurate title-based search using official YouTube oEmbed metadata
            {
                name: "youtubeUrlToTitleSearch",
                match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
                transformerName: "youtubeUrlToTitleSearch",
            },
        ],

        // Post-request fallback rules executed on failure (defined above)
        postRequestOnFail: fallbackRules,
    },

    /**
     * [UPSTREAM NODES] Lavalink & NodeLink Backend Definitions
     */
    upstreams: {
        // Default Primary Lavalink node (typically Lavalink v4 with LavaSrc plugins)
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

        // Secondary NodeLink node (NodeLink v2 with Spotify/YouTube playback)
        nodelink_node: {
            id: "nodelink_backup",
            url: process.env.UPSTREAM_NODELINK_URL || "http://127.0.0.1:2334",
            wsUrl: process.env.UPSTREAM_NODELINK_WS_URL || "ws://127.0.0.1:2334/v4/websocket",
            password: process.env.UPSTREAM_NODELINK_PASSWORD || proxyPassword,
            encodingScope: process.env.UPSTREAM_NODELINK_ENCODING_SCOPE || "lavalink-main",
            enabled: process.env.UPSTREAM_NODELINK_ENABLED === "true",
            requestTimeoutMs: Number(process.env.UPSTREAM_NODELINK_TIMEOUT_MS || 3500),
            failureThreshold: Number(process.env.UPSTREAM_NODELINK_FAILURE_THRESHOLD || 5),
            circuitBreakerResetMs: Number(process.env.UPSTREAM_NODELINK_CIRCUIT_RESET_MS || 15000),
        },
    },

    /**
     * [LOGGING & TELEMETRY] Real-time Console Log Control
     */
    logging: {
        // Output verbose debug logs including WebSocket opcodes and payload sizes
        debug: process.env.LOG_DEBUG === "true",

        // Output log entry whenever a request hits L1 memory or Dragonfly Redis cache
        logHits: process.env.LOG_HITS !== "false",

        // Output log entry on cache misses
        logMisses: process.env.LOG_MISSES !== "false",

        // Output route remapping and cascade journey traces in console
        logRoutes: process.env.LOG_ROUTES !== "false",

        // Output fallback trigger logs explaining why an upstream was failed over
        logFallbacks: process.env.LOG_FALLBACKS !== "false",

        // Maximum in-memory traces stored for the Web Dashboard trace viewer (default: 100)
        maxTraces: 100,
    },
};

export default config;
