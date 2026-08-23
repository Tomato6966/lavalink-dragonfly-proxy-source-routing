export type LoadBalancerStrategy = "consistent-hash" | "least-connections" | "round-robin" | "priority";

export interface UpstreamNodeConfig {
    id: string;
    url: string;
    wsUrl?: string;
    password?: string;
    priority?: number;
    enabled?: boolean;
    /** Node type / engine descriptor (e.g. "lavalink", "nodelink") */
    type?: "lavalink" | "nodelink" | "custom" | string;
    /** Capabilities / functional tags (e.g. ["search", "playback", "lyrics", "deezer"]) */
    tags?: string[];
    /** Relative weight for weighted load balancing strategies (default: 1) */
    weight?: number;
    /** Nodes may exchange encoded tracks only when this matches the default playback node. */
    encodingScope?: string;
    /** Total deadline for an upstream REST request. */
    requestTimeoutMs?: number;
    /** Open the local circuit breaker after this many consecutive transport/5xx failures. */
    failureThreshold?: number;
    /** How long an open circuit waits before allowing another probe. */
    circuitBreakerResetMs?: number;
}

export interface ClusterConfig {
    enabled?: boolean;
    strategy?: LoadBalancerStrategy;
    healthCheckIntervalMs?: number;
    healthCheckTimeoutMs?: number;
    autoRebalance?: boolean;
}

export interface PreRequestRule {
    name?: string;
    match?: string;
    prefix?: string;
    rewritePrefix?: string;
    routeToNode?: string;
    transformerName?: string;
}

export interface PostRequestOnFailRule {
    name: string;
    match: string;
    onErrors?: string[];
    fallbackOnEmpty?: boolean;
    routeToNode?: string;
    rewritePrefix?: string;
    targetPrefix?: string;
    routeToFallbackFn?: boolean;
    eventHubHandler?: string;
    inProcessTransformer?: string;
    /** Resolve the search to a new backend-loadable identifier, never a fabricated encoded track. */
    metadataResolver?: string;
    timeoutMs?: number;
    onHttpStatuses?: number[];
    onLoadTypes?: Array<"empty" | "error">;
    /** Encoded-track compatibility group returned by this fallback. Defaults to its target node's scope. */
    encodingScope?: string;
}

export interface LearnedRoute {
    targetNodeName: string;
    transformedIdentifier: string;
    cacheCategory: "search" | "track" | "lyrics" | "other";
    isEventHub: boolean;
    isInProcess: boolean;
    handlerName?: string;
    encodingScope: string;
    learnedAt: number;
    attemptsSaved: number;
}

export interface RemappingConfig {
    enabled: boolean;
    maxRecursionDepth: number;
    routeLearning?: boolean;
    routeLearningTtlSeconds?: number;
    searchReRankingEnabled?: boolean;
    maskSourceToRequested?: boolean;
    deezerYtmBridgeEnabled?: boolean;
    preRequest: PreRequestRule[];
    postRequestOnFail: PostRequestOnFailRule[];
}

export interface EventHubConfig {
    enabled: boolean;
    path: string;
    authToken: string;
    defaultTimeoutMs: number;
}

export interface DragonflyCacheConfig {
    enabled: boolean;
    url: string;
    password?: string;
    keyPrefix: string;
    searchTtlSeconds: number;
    trackTtlSeconds: number;
    lyricsTtlSeconds: number;
    maxCachedEntries: number; // Maximum number of entries tracked in cache (0 = unlimited)
    commandTimeoutMs?: number;
    memoryMaxEntries?: number;
    memoryMaxBytes?: number;
    memoryTtlSeconds?: number;
    /** Skip remote/L1 writes larger than this serialized JSON size; 0 disables the cap. */
    maxEntryBytes?: number;
    fuzzySearchEnabled?: boolean;
    fuzzySearchThreshold?: number;
    ttlJitterPercent?: number;
}

export interface PlayerRoutingRule {
    guildId?: string;
    guildIdMatch?: string;
    routeToNode: string;
}

export interface ProxyServerConfig {
    port: number;
    host: string;
    password: string;
    upstreamRequestTimeoutMs?: number;
    maxLoadResultBytes?: number;
    maxInFlightRequests?: number;
    websocketMaxQueueMessages?: number;
    websocketMaxQueueBytes?: number;
    /** Upstream node ID/name in `upstreams` used primarily for player updates and playback (defaults to "default"). */
    primaryPlaybackNode?: string;
    /** Rules for auto-routing player sessions / voice playback to specific nodes by guildId or pattern. */
    playerRouting?: PlayerRoutingRule[];
}

export interface RuntimeConfigUpdateRequest {
    mode?: "temporary" | "permanent";
    server?: Partial<ProxyServerConfig>;
    cluster?: Partial<ClusterConfig>;
    dragonfly?: Partial<DragonflyCacheConfig>;
    remapping?: Partial<RemappingConfig>;
    upstreams?: Record<string, Partial<UpstreamNodeConfig>>;
    logging?: Partial<LavalinkProxyConfig["logging"]>;
}

export interface CascadeAttemptTrace {
    attempt: number;
    target: string;
    identifier: string;
    durationMs: number;
    status: number;
    success: boolean;
    loadType?: string;
    error?: string;
}

export interface BridgeFlowTrace {
    bridgedFrom: string;
    intermediateQuery: string;
    intermediateResult?: string;
    finalTarget: string;
    isSourceMasked: boolean;
    originalSource: string;
    actualSource: string;
}

export interface RoutingTrace {
    id: string;
    timestamp: number;
    rawIdentifier: string;
    finalIdentifier: string;
    category: "search" | "track" | "lyrics" | "other";
    cacheStatus: "HIT" | "MISS" | "COALESCED";
    appliedRules: string[];
    attempts: CascadeAttemptTrace[];
    finalTarget: string;
    success: boolean;
    status: number;
    durationMs: number;
    bridgeFlow?: BridgeFlowTrace;
    resultSummary?: {
        loadType: string;
        trackCount?: number;
        title?: string;
        author?: string;
        sourceName?: string;
    };
    error?: string;
}

export interface LavalinkProxyConfig {
    server: ProxyServerConfig;
    cluster?: ClusterConfig;
    dragonfly: DragonflyCacheConfig;
    eventHub: EventHubConfig;
    remapping: RemappingConfig;
    upstreams: {
        default: UpstreamNodeConfig;
        [nodeName: string]: UpstreamNodeConfig;
    };
    logging: {
        debug: boolean;
        logHits: boolean;
        logMisses: boolean;
        logRoutes: boolean;
        logFallbacks: boolean;
        maxTraces?: number;
    };
}

