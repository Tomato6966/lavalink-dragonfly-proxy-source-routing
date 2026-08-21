/**
 * Proxy and Subsystem Configuration Types
 */

export interface UpstreamNodeConfig {
    id: string;
    url: string;
    wsUrl?: string;
    password?: string;
    priority?: number;
    enabled?: boolean;
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
    timeoutMs?: number;
}

export interface RemappingConfig {
    enabled: boolean;
    maxRecursionDepth: number;
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
}

export interface ProxyServerConfig {
    port: number;
    host: string;
    password: string;
}

export interface LavalinkProxyConfig {
    server: ProxyServerConfig;
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
    };
}
