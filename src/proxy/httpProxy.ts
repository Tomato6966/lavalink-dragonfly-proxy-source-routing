import type { LavalinkProxyConfig, UpstreamNodeConfig, LavalinkLoadResult, LavalinkTrack, RoutingTrace, CascadeAttemptTrace, RuntimeConfigUpdateRequest } from "../types";
import type { DragonflyCacheManager } from "../cache";
import { classifyIdentifier, type FallbackFailureContext, type UpstreamRouter } from "../routing";
import type { EventHubManager } from "../eventHub";
import { buildEmptyResult, buildErrorResult } from "../builders";
import { isLavalinkLoadResult, isPlayableLoadResult } from "../validation/lavalink";
import { optimizeSearchOrder } from "../transformers";
import { resolveYtmToDeezerBridge, applySourceMasking } from "../resolvers";

function formatTimestamp(): string {
    const date = new Date();
    const pad = (value: number, width = 2) => String(value).padStart(width, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

interface ProxyResult {
    data: unknown;
    status: number;
    headers?: Record<string, string>;
}

interface CircuitState {
    consecutiveFailures: number;
    openUntil: number;
    halfOpenProbe: boolean;
}

interface RuntimeStats {
    coalescedRequests: number;
    rejectedRequests: number;
    upstreamTimeouts: number;
    upstreamFailures: number;
    circuitBreakerRejects: number;
}

export class HttpProxyHandler {
    private config: LavalinkProxyConfig;
    private readonly cache: DragonflyCacheManager;
    private readonly router: UpstreamRouter;
    private readonly eventHub: EventHubManager;
    private readonly startTime = Date.now();
    private readonly inFlightLoads = new Map<string, Promise<ProxyResult>>();
    private readonly circuits = new Map<string, CircuitState>();
    private readonly traces: RoutingTrace[] = [];
    private readonly runtimeStats: RuntimeStats = {
        coalescedRequests: 0,
        rejectedRequests: 0,
        upstreamTimeouts: 0,
        upstreamFailures: 0,
        circuitBreakerRejects: 0,
    };

    constructor(
        config: LavalinkProxyConfig,
        cache: DragonflyCacheManager,
        router: UpstreamRouter,
        eventHub: EventHubManager
    ) {
        this.config = config;
        this.cache = cache;
        this.router = router;
        this.eventHub = eventHub;
    }

    public onConfigUpdated?: (newConfig: LavalinkProxyConfig) => void;

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
    }

    /**
     * Resolve the target upstream node for player sessions, voice audio, or playback
     * based on primaryPlaybackNode and dynamic playerRouting rules.
     */
    public getPlaybackNode(pathname?: string, guildId?: string): UpstreamNodeConfig {
        if (this.config.server.playerRouting && Array.isArray(this.config.server.playerRouting)) {
            let gId = guildId;
            if (!gId && pathname) {
                const match = pathname.match(/\/players\/([^/?#]+)/);
                if (match) gId = match[1];
            }
            if (gId) {
                for (const rule of this.config.server.playerRouting) {
                    if (rule.guildId && rule.guildId === gId) {
                        const target = this.config.upstreams[rule.routeToNode];
                        if (target && target.enabled !== false) return target;
                    }
                    if (rule.guildIdMatch) {
                        try {
                            if (new RegExp(rule.guildIdMatch, "i").test(gId)) {
                                const target = this.config.upstreams[rule.routeToNode];
                                if (target && target.enabled !== false) return target;
                            }
                        } catch {}
                    }
                }
            }
        }

        const primaryName = this.config.server.primaryPlaybackNode;
        if (primaryName && this.config.upstreams[primaryName] && this.config.upstreams[primaryName].enabled !== false) {
            return this.config.upstreams[primaryName];
        }

        return this.config.upstreams.default;
    }

    private recordTrace(trace: RoutingTrace): void {
        const max = this.config.logging.maxTraces ?? 100;
        this.traces.unshift(trace);
        if (this.traces.length > max) {
            this.traces.length = max;
        }
    }

    public getTraces(limit: number = 50): RoutingTrace[] {
        return this.traces.slice(0, Math.max(1, Math.min(limit, 200)));
    }

    private summarizeLoadResult(resultData: LavalinkLoadResult | null): RoutingTrace["resultSummary"] {
        if (!resultData) return undefined;
        if (resultData.loadType === "track") {
            const track = (resultData as any).data;
            return {
                loadType: "track",
                trackCount: 1,
                title: track?.info?.title,
                author: track?.info?.author,
                sourceName: track?.info?.sourceName,
            };
        }
        if (resultData.loadType === "search") {
            const tracks = Array.isArray((resultData as any).data) ? (resultData as any).data : [];
            const first = tracks[0];
            return {
                loadType: "search",
                trackCount: tracks.length,
                title: first?.info?.title,
                author: first?.info?.author,
                sourceName: first?.info?.sourceName,
            };
        }
        if (resultData.loadType === "playlist") {
            const pl = (resultData as any).data;
            const tracks = pl?.tracks || [];
            const first = tracks[0];
            return {
                loadType: "playlist",
                trackCount: tracks.length,
                title: pl?.info?.name || first?.info?.title,
                author: first?.info?.author,
                sourceName: first?.info?.sourceName,
            };
        }
        return {
            loadType: resultData.loadType,
        };
    }

    public async handleRequest(req: Request): Promise<Response> {
        const requestStartedAt = performance.now();
        const url = new URL(req.url);
        const pathname = url.pathname;

        if (pathname === "/proxy/health") {
            return Response.json(this.healthSnapshot());
        }

        const unauthorized = this.authenticate(req, pathname);
        if (unauthorized) return unauthorized;

        if (pathname === "/proxy/stats") {
            return Response.json(this.statsSnapshot());
        }

        if (pathname === "/proxy/config") {
            if (req.method === "GET") {
                return Response.json(this.getConfigSnapshot());
            }
            if (req.method === "PATCH" || req.method === "POST") {
                return this.handleConfigUpdate(req);
            }
            return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "GET, PATCH, POST" } });
        }

        if (pathname === "/proxy/config/reset") {
            if (req.method !== "POST") {
                return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
            }
            return this.handleConfigReset();
        }

        if (pathname === "/proxy/monitoring") {
            if (req.method !== "GET") {
                return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "GET" } });
            }
            return Response.json({
                service: "lavalink-dragonfly-proxy",
                timestamp: Date.now(),
                health: this.healthSnapshot(),
                stats: this.statsSnapshot(),
                config: this.getConfigSnapshot(),
                traces: this.getTraces(50),
            });
        }

        if (pathname === "/proxy/traces") {
            if (req.method !== "GET") {
                return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "GET" } });
            }
            const limit = Math.min(Math.max(1, Number(url.searchParams.get("limit") || 50)), 200);
            return Response.json({
                service: "lavalink-dragonfly-proxy",
                timestamp: Date.now(),
                traces: this.getTraces(limit),
            });
        }

        if (pathname === "/proxy/cache/clear") {
            if (req.method !== "POST") {
                return Response.json({ error: "Method Not Allowed" }, { status: 405, headers: { Allow: "POST" } });
            }
            const deleted = await this.cache.clear();
            return Response.json({ success: true, deleted });
        }

        if (pathname === "/v4/loadtracks" && req.method === "GET") {
            const result = await this.handleCoalescedLoad(req, url, requestStartedAt);
            return this.toResponse(result);
        }

        if ((pathname === "/proxy/cache/prefetch" || pathname === "/v4/loadtracks/prefetch") && req.method === "POST") {
            return this.handlePrefetch(req, requestStartedAt);
        }

        if (pathname === "/v4/decodetrack" && req.method === "GET") {
            return this.handleDecodeTrack(req, url);
        }

        if (pathname === "/v4/decodetracks" && req.method === "POST") {
            return this.handleDecodeTracks(req, url);
        }

        const isPlayerUpdate = req.method === "PATCH" && /^\/v4\/sessions\/[^/]+\/players\/[^/]+$/.test(pathname);
        if (isPlayerUpdate) {
            const response = await this.handlePlayerUpdate(req, url, requestStartedAt);
            if (this.config.logging.logRoutes) {
                const took = (performance.now() - requestStartedAt).toFixed(2);
                console.log(`[${formatTimestamp()}] [Proxy:Player:PATCH] ${pathname} -> ${response.status} (${took}ms)`);
            }
            return response;
        }

        const targetNode = pathname.startsWith("/v4/sessions") ? this.getPlaybackNode(pathname) : this.config.upstreams.default;
        const response = await this.forwardGenericRequest(req, targetNode, url);
        if (this.config.logging.logRoutes) {
            const took = (performance.now() - requestStartedAt).toFixed(2);
            console.log(`[${formatTimestamp()}] [Proxy:REST] ${req.method} ${pathname} -> ${response.status} (${took}ms)`);
        }
        return response;
    }

    private healthSnapshot() {
        const cacheReady = !this.config.dragonfly.enabled || this.cache.isConnected;
        return {
            status: cacheReady ? "ok" : "degraded",
            ready: true,
            cacheReady,
            uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
        };
    }

    private statsSnapshot() {
        return {
            status: "ok",
            runtime: "Bun",
            uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
            cacheConnected: this.cache.isConnected,
            cacheStats: this.cache.stats,
            proxyStats: this.runtimeStats,
            inFlightLoadRequests: this.inFlightLoads.size,
            connectedEventHubClients: this.eventHub.connectedClientCount,
            configuredUpstreams: Object.keys(this.config.upstreams),
            circuitBreakers: this.circuitSnapshot(),
            remappingEnabled: this.config.remapping.enabled,
        };
    }

    public getConfigSnapshot(): Record<string, any> {
        const sanitizedUpstreams: Record<string, any> = {};
        for (const [name, node] of Object.entries(this.config.upstreams)) {
            sanitizedUpstreams[name] = {
                id: node.id,
                url: node.url,
                wsUrl: node.wsUrl,
                priority: node.priority,
                enabled: node.enabled !== false,
                encodingScope: node.encodingScope,
                requestTimeoutMs: node.requestTimeoutMs,
                failureThreshold: node.failureThreshold,
                circuitBreakerResetMs: node.circuitBreakerResetMs,
                hasPassword: Boolean(node.password),
            };
        }

        return {
            server: {
                port: this.config.server.port,
                host: this.config.server.host,
                primaryPlaybackNode: this.config.server.primaryPlaybackNode || "default",
                playerRouting: this.config.server.playerRouting || [],
                upstreamRequestTimeoutMs: this.config.server.upstreamRequestTimeoutMs,
                maxLoadResultBytes: this.config.server.maxLoadResultBytes,
                maxInFlightRequests: this.config.server.maxInFlightRequests,
            },
            dragonfly: {
                enabled: this.config.dragonfly.enabled,
                url: this.config.dragonfly.url,
                keyPrefix: this.config.dragonfly.keyPrefix,
                searchTtlSeconds: this.config.dragonfly.searchTtlSeconds,
                trackTtlSeconds: this.config.dragonfly.trackTtlSeconds,
                lyricsTtlSeconds: this.config.dragonfly.lyricsTtlSeconds,
                fuzzySearchEnabled: this.config.dragonfly.fuzzySearchEnabled,
                fuzzySearchThreshold: this.config.dragonfly.fuzzySearchThreshold,
                maxCachedEntries: this.config.dragonfly.maxCachedEntries,
            },
            remapping: {
                enabled: this.config.remapping.enabled,
                deezerYtmBridgeEnabled: this.config.remapping.deezerYtmBridgeEnabled !== false,
                searchReRankingEnabled: this.config.remapping.searchReRankingEnabled !== false,
                maskSourceToRequested: this.config.remapping.maskSourceToRequested !== false,
                routeLearning: this.config.remapping.routeLearning !== false,
                routeLearningTtlSeconds: this.config.remapping.routeLearningTtlSeconds,
                maxRecursionDepth: this.config.remapping.maxRecursionDepth,
                preRequestRuleCount: this.config.remapping.preRequest?.length || 0,
                postRequestRuleCount: this.config.remapping.postRequestOnFail?.length || 0,
            },
            upstreams: sanitizedUpstreams,
            logging: this.config.logging,
        };
    }

    private async handleConfigUpdate(req: Request): Promise<Response> {
        let body: RuntimeConfigUpdateRequest;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: "Invalid JSON request body" }, { status: 400 });
        }

        const mode = body.mode || "temporary";
        const { deepMerge, validateConfig, saveConfigOverwrites } = await import("../config");

        try {
            const updatedConfig = validateConfig(deepMerge(this.config, body as any));
            this.updateConfig(updatedConfig);
            this.router.updateConfig(updatedConfig);
            if (this.onConfigUpdated) {
                this.onConfigUpdated(updatedConfig);
            }

            if (mode === "permanent") {
                await saveConfigOverwrites(body as any);
                console.log(`[${formatTimestamp()}] [Proxy:Config:PERM] Saved permanent configuration overrides to config.overwrites.ts`);
            } else {
                console.log(`[${formatTimestamp()}] [Proxy:Config:TEMP] Applied temporary runtime configuration overrides`);
            }

            return Response.json({
                success: true,
                mode,
                message: mode === "permanent"
                    ? "Configuration updated and saved permanently to config.overwrites.ts"
                    : "Configuration updated temporarily in runtime memory",
                config: this.getConfigSnapshot(),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Response.json({ error: `Config update failed: ${message}` }, { status: 400 });
        }
    }

    private async handleConfigReset(): Promise<Response> {
        const { loadConfig, clearConfigOverwrites } = await import("../config");
        try {
            await clearConfigOverwrites();
            const reloaded = await loadConfig();
            this.updateConfig(reloaded);
            this.router.updateConfig(reloaded);
            if (this.onConfigUpdated) {
                this.onConfigUpdated(reloaded);
            }
            console.log(`[${formatTimestamp()}] [Proxy:Config:RESET] Reverted configuration to base config.ts`);
            return Response.json({
                success: true,
                message: "Configuration reset to base config.ts and overrides cleared",
                config: this.getConfigSnapshot(),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return Response.json({ error: `Config reset failed: ${message}` }, { status: 500 });
        }
    }

    private authenticate(req: Request, pathname: string): Response | null {
        if (!this.config.server.password) return null;
        if (req.headers.get("authorization") === this.config.server.password) return null;
        console.warn(`[${formatTimestamp()}] [Proxy:Auth:FAIL] Unauthorized request to ${pathname}`);
        return Response.json({
            timestamp: Date.now(),
            status: 401,
            error: "Unauthorized",
            message: "Invalid authorization password",
            path: pathname,
        }, { status: 401 });
    }

    private async handleCoalescedLoad(req: Request, url: URL, requestStartedAt: number): Promise<ProxyResult> {
        const cacheKey = Array.from(url.searchParams.entries())
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, value]) => `${key}=${value}`)
            .join("&");
        const existing = this.inFlightLoads.get(cacheKey);
        if (existing) {
            this.runtimeStats.coalescedRequests++;
            const result = await existing;
            return { ...result, headers: { ...result.headers, "X-Proxy-Coalesced": "HIT" } };
        }

        const maxInFlight = this.config.server.maxInFlightRequests ?? 1000;
        if (this.inFlightLoads.size >= maxInFlight) {
            this.runtimeStats.rejectedRequests++;
            return {
                data: buildErrorResult("Proxy is at its in-flight request limit", "fault"),
                status: 503,
                headers: { "Retry-After": "1" },
            };
        }

        const promise = this.resolveLoadTracks(req, url, requestStartedAt);
        this.inFlightLoads.set(cacheKey, promise);
        try {
            return await promise;
        } finally {
            if (this.inFlightLoads.get(cacheKey) === promise) this.inFlightLoads.delete(cacheKey);
        }
    }

    private async handlePrefetch(req: Request, requestStartedAt: number): Promise<Response> {
        let body: any;
        try {
            body = await req.json();
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }
        const rawList = Array.isArray(body?.identifiers)
            ? body.identifiers
            : typeof body?.identifier === "string"
                ? [body.identifier]
                : [];
        if (rawList.length === 0) {
            return Response.json({ error: "No identifiers provided for prefetch" }, { status: 400 });
        }
        const limit = Math.min(rawList.length, 50);
        const batch = rawList.slice(0, limit);
        const results = await Promise.all(
            batch.map(async (identifier: unknown) => {
                const trimmed = String(identifier || "").trim();
                if (!trimmed) return { identifier: trimmed, status: "skipped", cached: false };
                try {
                    const dummyUrl = new URL(`http://proxy/v4/loadtracks?identifier=${encodeURIComponent(trimmed)}`);
                    const dummyReq = new Request(dummyUrl, { headers: { authorization: this.config.server.password || "" } });
                    const res = await this.handleCoalescedLoad(dummyReq, dummyUrl, requestStartedAt);
                    return {
                        identifier: trimmed,
                        status: res.status === 200 ? "ok" : "error",
                        loadType: (res.data as any)?.loadType,
                        cached: res.headers?.["X-Proxy-Cache"] === "HIT",
                    };
                } catch (err) {
                    return { identifier: trimmed, status: "error", error: String(err), cached: false };
                }
            })
        );
        return Response.json({
            status: "ok",
            prefetched: results.length,
            results,
        });
    }

    private async handleDecodeTrack(req: Request, url: URL): Promise<Response> {
        const encodedTrack = url.searchParams.get("encodedTrack")?.trim();
        if (encodedTrack) {
            const cached = await this.cache.get("decoded", encodedTrack);
            if (cached) {
                return Response.json(cached, {
                    headers: { "X-Proxy-Cache": "HIT", "X-Proxy-Node": "cache" },
                });
            }
        }
        const response = await this.forwardGenericRequest(req, this.config.upstreams.default, url);
        if (response.ok && encodedTrack) {
            try {
                const cloned = response.clone();
                const json = await cloned.json();
                void this.cache.set("decoded", encodedTrack, json, this.config.dragonfly.trackTtlSeconds);
            } catch {
                // Ignore parse errors on decode caching
            }
        }
        return response;
    }

    private async handleDecodeTracks(req: Request, url: URL): Promise<Response> {
        let rawTracks: string[] = [];
        try {
            const body = await req.json();
            if (Array.isArray(body)) rawTracks = body;
        } catch {
            return Response.json({ error: "Invalid JSON array" }, { status: 400 });
        }

        if (rawTracks.length === 0) return Response.json([]);

        const results = Array.from<any>({ length: rawTracks.length });
        const missIndexes: number[] = [];
        const missTracks: string[] = [];

        await Promise.all(
            rawTracks.map(async (encodedTrack, index) => {
                if (typeof encodedTrack !== "string" || !encodedTrack) return;
                const cached = await this.cache.get("decoded", encodedTrack);
                if (cached) {
                    results[index] = cached;
                } else {
                    missIndexes.push(index);
                    missTracks.push(encodedTrack);
                }
            })
        );

        if (missTracks.length === 0) {
            return Response.json(results, { headers: { "X-Proxy-Cache": "HIT" } });
        }

        try {
            const upstreamTarget = this.createUpstreamUrl(this.config.upstreams.default, "/v4/decodetracks");
            const headers = new Headers(req.headers);
            headers.set("authorization", this.config.upstreams.default.password || this.config.server.password);
            headers.set("content-type", "application/json");

            const response = await fetch(upstreamTarget, {
                method: "POST",
                headers,
                body: JSON.stringify(missTracks),
                signal: AbortSignal.timeout(this.config.server.upstreamRequestTimeoutMs ?? 5000),
            });

            if (response.ok) {
                const upstreamResults = (await response.json()) as any[];
                if (Array.isArray(upstreamResults)) {
                    for (let i = 0; i < missIndexes.length; i++) {
                        const originalIndex = missIndexes[i];
                        const trackData = upstreamResults[i];
                        if (trackData) {
                            results[originalIndex] = trackData;
                            void this.cache.set("decoded", missTracks[i], trackData, this.config.dragonfly.trackTtlSeconds);
                        }
                    }
                }
                return Response.json(results, {
                    headers: { "X-Proxy-Cache": missIndexes.length < rawTracks.length ? "PARTIAL" : "MISS" },
                });
            }
        } catch (error) {
            console.error(`[${formatTimestamp()}] [Proxy:DecodeTracks:ERR] ${error instanceof Error ? error.message : error}`);
        }

        return this.forwardGenericRequest(req, this.config.upstreams.default, url);
    }

    private extractPlayableTrack(loadResult: LavalinkLoadResult): LavalinkTrack | null {
        if (!loadResult) return null;
        if (loadResult.loadType === "track") {
            return loadResult.data?.encoded ? loadResult.data : null;
        }
        if (loadResult.loadType === "search") {
            return Array.isArray(loadResult.data) && loadResult.data.length > 0 && loadResult.data[0].encoded
                ? loadResult.data[0]
                : null;
        }
        if (loadResult.loadType === "playlist") {
            return loadResult.data?.tracks?.length > 0 && loadResult.data.tracks[0].encoded
                ? loadResult.data.tracks[0]
                : null;
        }
        return null;
    }

    private async resolveTrackForDirectPlayback(
        rawIdentifier: string,
        requestStartedAt: number
    ): Promise<{ result: LavalinkLoadResult | null; cacheStatus: "HIT" | "MISS"; httpStatus: number }> {
        const dummyUrl = new URL(`http://proxy/v4/loadtracks?identifier=${encodeURIComponent(rawIdentifier)}`);
        const dummyReq = new Request(dummyUrl, {
            headers: { authorization: this.config.server.password || "" },
        });
        const loadResult = await this.handleCoalescedLoad(dummyReq, dummyUrl, requestStartedAt);
        const data = loadResult.data as LavalinkLoadResult;
        const cacheHit = loadResult.headers?.["X-Proxy-Cache"] === "HIT";
        return {
            result: isLavalinkLoadResult(data) ? data : null,
            cacheStatus: cacheHit ? "HIT" : "MISS",
            httpStatus: loadResult.status,
        };
    }

    private async handlePlayerUpdate(req: Request, url: URL, requestStartedAt: number): Promise<Response> {
        let bodyText = "";
        try {
            bodyText = await req.text();
        } catch {
            return Response.json({ error: "Failed to read request body" }, { status: 400 });
        }

        if (!bodyText || bodyText.trim() === "") {
            return this.forwardWithBody(req, this.config.upstreams.default, url, bodyText);
        }

        let body: Record<string, any>;
        try {
            body = JSON.parse(bodyText);
        } catch {
            return Response.json({ error: "Invalid JSON body" }, { status: 400 });
        }

        let cacheStatus: "HIT" | "MISS" | "BYPASS" = "BYPASS";
        let resolvedTrackEncoded: string | null = null;

        if (body?.track && typeof body.track === "object") {
            const hasEncoded = typeof body.track.encoded === "string" && body.track.encoded.trim() !== "";
            const identifier = typeof body.track.identifier === "string" ? body.track.identifier.trim() : "";

            if (!hasEncoded && identifier) {
                const loadResult = await this.resolveTrackForDirectPlayback(identifier, requestStartedAt);
                if (loadResult.result) {
                    const playableTrack = this.extractPlayableTrack(loadResult.result);
                    if (playableTrack) {
                        resolvedTrackEncoded = playableTrack.encoded;
                        body.track.encoded = playableTrack.encoded;
                        cacheStatus = loadResult.cacheStatus;
                        if (!body.track.userData && playableTrack.userData) {
                            body.track.userData = playableTrack.userData;
                        }
                    } else {
                        return Response.json({
                            timestamp: Date.now(),
                            status: 404,
                            error: "Not Found",
                            message: `Direct playback resolving returned no playable tracks for identifier: ${identifier}`,
                            path: url.pathname,
                        }, { status: 404 });
                    }
                } else {
                    return Response.json({
                        timestamp: Date.now(),
                        status: loadResult.httpStatus || 502,
                        error: "Bad Gateway",
                        message: `Direct playback resolving failed for identifier: ${identifier}`,
                        path: url.pathname,
                    }, { status: loadResult.httpStatus || 502 });
                }
            }
        }

        const serialized = JSON.stringify(body);
        const upstreamResponse = await this.forwardWithBody(req, this.config.upstreams.default, url, serialized);

        if (resolvedTrackEncoded) {
            const headers = new Headers(upstreamResponse.headers);
            headers.set("X-Proxy-Direct-Playback", "RESOLVED");
            headers.set("X-Proxy-Cache", cacheStatus);
            return new Response(upstreamResponse.body, {
                status: upstreamResponse.status,
                headers,
            });
        }

        return upstreamResponse;
    }

    private async forwardWithBody(
        req: Request,
        targetNode: UpstreamNodeConfig,
        url: URL,
        bodyText: string
    ): Promise<Response> {
        try {
            const upstreamTarget = this.createUpstreamUrl(targetNode, url.pathname, url.search);
            const headers = new Headers(req.headers);
            headers.set("authorization", targetNode.password || this.config.server.password);
            headers.set("accept-encoding", "identity");
            for (const header of ["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
                headers.delete(header);
            }

            const response = await fetch(upstreamTarget, {
                method: req.method,
                headers,
                body: bodyText,
                signal: AbortSignal.timeout(targetNode.requestTimeoutMs ?? this.config.server.upstreamRequestTimeoutMs ?? 10_000),
            });

            const responseHeaders = new Headers(response.headers);
            for (const header of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
                responseHeaders.delete(header);
            }
            return new Response(response.body, { status: response.status, headers: responseHeaders });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${formatTimestamp()}] [Proxy:REST:ERR] ${req.method} ${url.pathname}: ${message}`);
            return Response.json({ error: `Bad Gateway: ${message}` }, { status: 502 });
        }
    }

    private async resolveLoadTracks(req: Request, url: URL, requestStartedAt: number): Promise<ProxyResult> {
        const rawIdentifier = url.searchParams.get("identifier")?.trim() ?? "";
        if (!rawIdentifier) {
            return { data: { error: "Missing identifier parameter" }, status: 400 };
        }

        const traceId = `tr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        const cascadeAttempts: CascadeAttemptTrace[] = [];
        const playbackEncodingScope = this.encodingScope(this.config.upstreams.default);
        const rawCategory = classifyIdentifier(rawIdentifier);

        const initialCached = await this.cache.get(rawCategory, rawIdentifier, playbackEncodingScope) as LavalinkLoadResult | null;
        if (initialCached && this.isValidLoadResult(initialCached)) {
            const took = (performance.now() - requestStartedAt).toFixed(2);
            if (this.config.logging.logHits) {
                console.log(`[${formatTimestamp()}] [Proxy:Cache:HIT] ${rawCategory} "${rawIdentifier}" (${took}ms)`);
            }
            this.recordTrace({
                id: traceId,
                timestamp: Date.now(),
                rawIdentifier,
                finalIdentifier: rawIdentifier,
                category: rawCategory,
                cacheStatus: "HIT",
                appliedRules: [],
                attempts: [],
                finalTarget: "cache",
                success: true,
                status: 200,
                durationMs: Math.round(performance.now() - requestStartedAt),
                resultSummary: this.summarizeLoadResult(initialCached),
            });
            return {
                data: initialCached,
                status: 200,
                headers: { "X-Proxy-Cache": "HIT", "X-Proxy-Node": "cache" },
            };
        }

        if (this.config.logging.logMisses) {
            console.log(`[${formatTimestamp()}] [Proxy:Cache:MISS] ${rawCategory} "${rawIdentifier}"`);
        }

        const preResult = await this.router.applyPreRequest(rawIdentifier);
        let currentIdentifier = preResult.transformedIdentifier;
        let targetNode = preResult.targetNode;
        let isEventHub = false;
        let isInProcess = false;
        let handlerName: string | undefined;
        let attemptTimeoutMs: number | undefined;
        let attemptEncodingScope = this.encodingScope(targetNode);
        const appliedRules = preResult.appliedRules.map((r) => r.name || "rule");

        if (preResult.isRemapped && this.config.logging.logRoutes) {
            console.log(`[${formatTimestamp()}] [Proxy:Remap] "${rawIdentifier}" -> "${currentIdentifier}" (rules: ${appliedRules.join(", ")})`);
        }

        if (preResult.isRemapped) {
            const remappedCached = await this.cache.get(preResult.cacheCategory, currentIdentifier, playbackEncodingScope) as LavalinkLoadResult | null;
            if (remappedCached && this.isValidLoadResult(remappedCached)) {
                const took = (performance.now() - requestStartedAt).toFixed(2);
                if (this.config.logging.logHits) {
                    console.log(`[${formatTimestamp()}] [Proxy:Cache:HIT] ${preResult.cacheCategory} "${currentIdentifier}" (remapped from "${rawIdentifier}") (${took}ms)`);
                }
                this.recordTrace({
                    id: traceId,
                    timestamp: Date.now(),
                    rawIdentifier,
                    finalIdentifier: currentIdentifier,
                    category: preResult.cacheCategory,
                    cacheStatus: "HIT",
                    appliedRules,
                    attempts: [],
                    finalTarget: "cache",
                    success: true,
                    status: 200,
                    durationMs: Math.round(performance.now() - requestStartedAt),
                    resultSummary: this.summarizeLoadResult(remappedCached),
                });
                return {
                    data: remappedCached,
                    status: 200,
                    headers: { "X-Proxy-Cache": "HIT", "X-Proxy-Node": "cache" },
                };
            }
        }

        let usedLearnedFastPath = false;
        if (this.config.remapping.routeLearning !== false) {
            const learned = await this.cache.getLearnedRoute(rawIdentifier, playbackEncodingScope);
            const learnedNode = learned ? this.config.upstreams[learned.targetNodeName] : undefined;
            const learnedEncodingScope = learned?.encodingScope || (learnedNode ? this.encodingScope(learnedNode) : undefined);
            if (learned && learnedEncodingScope === playbackEncodingScope &&
                ((learnedNode && learnedNode.enabled !== false) || learned.isEventHub || learned.isInProcess)) {
                currentIdentifier = learned.transformedIdentifier;
                targetNode = this.config.upstreams[learned.targetNodeName] ?? targetNode;
                isEventHub = learned.isEventHub;
                isInProcess = learned.isInProcess;
                handlerName = learned.handlerName;
                attemptEncodingScope = learnedEncodingScope;
                usedLearnedFastPath = true;
                if (this.config.logging.logRoutes) {
                    console.log(`[${formatTimestamp()}] [Proxy:RouteLearning:HIT] "${rawIdentifier}" fast-routed to ${learned.targetNodeName} as "${currentIdentifier}"`);
                }
            } else if (learned && learnedEncodingScope !== playbackEncodingScope) {
                await this.cache.delLearnedRoute(rawIdentifier, playbackEncodingScope);
            }
        }

        // Intelligent Search Bridge: on dzsearch: query, route through YTM for popularity-ranked metadata, then resolve Deezer
        if (
            this.config.remapping.deezerYtmBridgeEnabled !== false &&
            rawIdentifier.toLowerCase().startsWith("dzsearch:") &&
            !usedLearnedFastPath
        ) {
            const bridgeStart = performance.now();
            const bridge = await resolveYtmToDeezerBridge(rawIdentifier, async (id) => {
                const up = await this.loadFromUpstream(req, url, this.config.upstreams.default, id);
                return up.data;
            });

            if (bridge.success && bridge.result && this.isValidLoadResult(bridge.result)) {
                let resultData = bridge.result;
                const totalDuration = Math.round(performance.now() - requestStartedAt);
                const bridgeDuration = Math.round(performance.now() - bridgeStart);

                // Re-ranking
                if (this.config.remapping.searchReRankingEnabled !== false && (resultData.loadType === "search" || resultData.loadType === "playlist")) {
                    const reRank = optimizeSearchOrder(rawIdentifier, resultData);
                    if (reRank.reOrdered) resultData = reRank.result;
                }

                // Source Masking ("Source Illusion")
                const maskEnabled = this.config.remapping.maskSourceToRequested !== false;
                resultData = applySourceMasking(resultData, rawIdentifier, maskEnabled);

                // Cache both raw and intermediate identifiers
                await Promise.all([
                    this.cache.set(rawCategory, rawIdentifier, resultData, undefined, playbackEncodingScope),
                    bridge.intermediateQuery
                        ? this.cache.set(classifyIdentifier(bridge.intermediateQuery), bridge.intermediateQuery, resultData, undefined, playbackEncodingScope)
                        : Promise.resolve(),
                ]);

                const summary = this.summarizeLoadResult(resultData);
                if (this.config.logging.logRoutes) {
                    console.log(`[${formatTimestamp()}] [Proxy:Bridge] "${rawIdentifier}" resolved via ${bridge.finalTarget} (from ${bridge.bridgedFrom} -> ${bridge.intermediateQuery || 'direct'}) in ${bridgeDuration}ms -> "${summary?.title || ''}" by "${summary?.author || ''}"`);
                }

                const trace: RoutingTrace = {
                    id: traceId,
                    timestamp: Date.now(),
                    rawIdentifier,
                    finalIdentifier: bridge.intermediateQuery || rawIdentifier,
                    category: rawCategory,
                    cacheStatus: "MISS",
                    appliedRules: ["deezerYtmBridge", ...appliedRules],
                    attempts: [
                        {
                            attempt: 1,
                            target: "ytm_search",
                            identifier: bridge.bridgedFrom,
                            durationMs: Math.round(bridgeDuration / 2),
                            status: 200,
                            success: true,
                            loadType: "search",
                        },
                        {
                            attempt: 2,
                            target: bridge.finalTarget === "deezer" ? "lavalink_deezer" : "lavalink_ytm_fallback",
                            identifier: bridge.intermediateQuery || rawIdentifier,
                            durationMs: Math.round(bridgeDuration / 2),
                            status: 200,
                            success: true,
                            loadType: resultData.loadType,
                        },
                    ],
                    finalTarget: bridge.finalTarget,
                    success: true,
                    status: 200,
                    durationMs: totalDuration,
                    bridgeFlow: {
                        bridgedFrom: bridge.bridgedFrom,
                        intermediateQuery: bridge.intermediateQuery,
                        intermediateResult: bridge.intermediateResultTitle,
                        finalTarget: bridge.finalTarget,
                        isSourceMasked: maskEnabled,
                        originalSource: "deezer",
                        actualSource: bridge.finalTarget,
                    },
                    resultSummary: summary,
                };
                this.recordTrace(trace);

                return {
                    data: resultData,
                    status: 200,
                    headers: {
                        "X-Proxy-Cache": "MISS",
                        "X-Proxy-Node": bridge.finalTarget,
                        "X-Proxy-Bridge": "ytm-deezer",
                        "X-Proxy-Resolved-Identifier": encodeURIComponent(bridge.intermediateQuery || rawIdentifier).slice(0, 512),
                    },
                };
            }
        }

        const maxDepth = Math.max(1, this.config.remapping.maxRecursionDepth || 4);
        const usedRuleNames = new Set<string>();
        let lastResponseData: LavalinkLoadResult | null = null;
        let lastHttpStatus = 502;
        let failure: FallbackFailureContext = {
            originalIdentifier: rawIdentifier,
            message: "",
            isEmpty: false,
        };
        let attempt = 0;

        while (attempt < maxDepth) {
            attempt++;
            let resultData: LavalinkLoadResult | null = null;
            let attemptSucceeded = false;
            const attemptStart = performance.now();
            const targetName = isEventHub ? `eventhub:${handlerName}` : isInProcess ? `inprocess:${handlerName}` : targetNode.id;

            if (this.config.logging.logRoutes) {
                console.log(`[${formatTimestamp()}] [Proxy:Cascade:${attempt}] Target: ${targetName} | Query: "${currentIdentifier}"`);
            }

            if (isEventHub && handlerName) {
                resultData = await this.eventHub.callHandler(handlerName, {
                    identifier: currentIdentifier,
                    originalIdentifier: rawIdentifier,
                    attempt,
                    lastError: failure.message,
                }, attemptTimeoutMs);
            } else if (isInProcess && handlerName) {
                resultData = await this.router.transformers.executeFallbackFunction(handlerName, currentIdentifier, {
                    rawIdentifier,
                    attempt,
                });
            } else if (!this.canAttempt(targetNode)) {
                failure = {
                    originalIdentifier: rawIdentifier,
                    message: `Circuit breaker open for ${targetNode.id}`,
                    isEmpty: false,
                    httpStatus: 503,
                };
                this.runtimeStats.circuitBreakerRejects++;
            } else {
                const upstream = await this.loadFromUpstream(req, url, targetNode, currentIdentifier);
                resultData = upstream.data;
                lastHttpStatus = upstream.status;
                failure = upstream.failure;
            }

            if (resultData && !isLavalinkLoadResult(resultData)) {
                resultData = null;
                failure = {
                    originalIdentifier: rawIdentifier,
                    message: `Invalid Lavalink load result from ${targetName}`,
                    isEmpty: false,
                    httpStatus: 502,
                };
                lastHttpStatus = 502;
            }

            if (resultData && isLavalinkLoadResult(resultData)) {
                attemptSucceeded = this.isValidLoadResult(resultData);
                if (!attemptSucceeded) {
                    const isEmptyResult = resultData.loadType === "empty" ||
                        (resultData.loadType === "search" && resultData.data.length === 0) ||
                        (resultData.loadType === "playlist" && resultData.data.tracks.length === 0);
                    const loadType = resultData.loadType === "error" ? "error" : isEmptyResult ? "empty" : undefined;
                    failure = {
                        originalIdentifier: rawIdentifier,
                        message: resultData.loadType === "error"
                            ? resultData.data.message
                            : isEmptyResult ? failure.message || "Empty track result" : "Backend returned non-playable encoded tracks",
                        isEmpty: isEmptyResult,
                        httpStatus: lastHttpStatus,
                        loadType,
                    };

                    if (isEmptyResult && resultData.loadType !== "empty") {
                        resultData = buildEmptyResult();
                    } else if (resultData.loadType !== "empty" && resultData.loadType !== "error") {
                        resultData = null;
                    }
                }
            }

            if (attemptSucceeded && attemptEncodingScope !== playbackEncodingScope) {
                attemptSucceeded = false;
                resultData = null;
                failure = {
                    originalIdentifier: rawIdentifier,
                    message: `Encoding scope ${attemptEncodingScope} is incompatible with playback scope ${playbackEncodingScope}`,
                    isEmpty: false,
                    httpStatus: 502,
                };
                lastHttpStatus = 502;
            }

            const attemptDuration = Math.round(performance.now() - attemptStart);
            cascadeAttempts.push({
                attempt,
                target: targetName,
                identifier: currentIdentifier,
                durationMs: attemptDuration,
                status: lastHttpStatus,
                success: attemptSucceeded,
                loadType: (resultData as any)?.loadType,
                error: attemptSucceeded ? undefined : failure.message,
            });

            if (attemptSucceeded && resultData) {
                // Mid-Request Search Algorithm Optimization (re-rank cover/tribute/remix noise)
                if (
                    this.config.remapping.searchReRankingEnabled !== false &&
                    (resultData.loadType === "search" || resultData.loadType === "playlist")
                ) {
                    const reRank = optimizeSearchOrder(rawIdentifier, resultData);
                    if (reRank.reOrdered) {
                        resultData = reRank.result;
                        if (reRank.topTrackChanged && this.config.logging.logRoutes) {
                            const newTop = this.summarizeLoadResult(resultData);
                            console.log(`[${formatTimestamp()}] [Proxy:ReRank] Optimized search order for "${rawIdentifier}" -> Promoted top track: "${newTop?.title || ''}" by "${newTop?.author || ''}"`);
                        }
                    }
                }

                // Source Masking ("Source Illusion")
                const maskEnabled = this.config.remapping.maskSourceToRequested !== false;
                resultData = applySourceMasking(resultData, rawIdentifier, maskEnabled);

                const currentCategory = classifyIdentifier(currentIdentifier);
                await Promise.all([
                    this.cache.set(currentCategory, currentIdentifier, resultData, undefined, playbackEncodingScope),
                    rawIdentifier === currentIdentifier
                        ? Promise.resolve()
                        : this.cache.set(rawCategory, rawIdentifier, resultData, undefined, playbackEncodingScope),
                ]);

                if (this.config.remapping.routeLearning !== false && (attempt > 1 || preResult.isRemapped || usedLearnedFastPath)) {
                    const targetNodeName = Object.keys(this.config.upstreams).find(
                        (name) => this.config.upstreams[name] === targetNode || this.config.upstreams[name].url === targetNode.url
                    ) ?? "default";
                    await this.cache.setLearnedRoute(rawIdentifier, {
                        targetNodeName,
                        transformedIdentifier: currentIdentifier,
                        cacheCategory: currentCategory,
                        isEventHub,
                        isInProcess,
                        handlerName,
                        encodingScope: attemptEncodingScope,
                        learnedAt: Date.now(),
                        attemptsSaved: Math.max(1, attempt - 1),
                    }, this.config.remapping.routeLearningTtlSeconds ?? 1800, playbackEncodingScope);
                }

                const totalDuration = Math.round(performance.now() - requestStartedAt);
                const summary = this.summarizeLoadResult(resultData);
                if (this.config.logging.logRoutes) {
                    const desc = summary?.title ? `"${summary.title}" (${summary.trackCount || 1} track(s))` : `${resultData.loadType}`;
                    console.log(`[${formatTimestamp()}] [Proxy:Success] "${rawIdentifier}" resolved via ${targetName} in ${totalDuration}ms -> ${desc}`);
                }

                this.recordTrace({
                    id: traceId,
                    timestamp: Date.now(),
                    rawIdentifier,
                    finalIdentifier: currentIdentifier,
                    category: currentCategory,
                    cacheStatus: "MISS",
                    appliedRules,
                    attempts: cascadeAttempts,
                    finalTarget: targetName,
                    success: true,
                    status: 200,
                    durationMs: totalDuration,
                    resultSummary: summary,
                });

                return {
                    data: resultData,
                    status: 200,
                    headers: {
                        "X-Proxy-Cache": "MISS",
                        "X-Proxy-Node": targetName,
                        "X-Proxy-Attempts": String(attempt),
                        "X-Proxy-Resolved-Identifier": encodeURIComponent(currentIdentifier).slice(0, 512),
                        ...(usedLearnedFastPath ? { "X-Proxy-Learned-Route": "HIT" } : {}),
                    },
                };
            }

            if (usedLearnedFastPath && attempt === 1) {
                await this.cache.delLearnedRoute(rawIdentifier, playbackEncodingScope);
                currentIdentifier = preResult.transformedIdentifier;
                targetNode = preResult.targetNode;
                isEventHub = false;
                isInProcess = false;
                handlerName = undefined;
                attemptTimeoutMs = undefined;
                attemptEncodingScope = this.encodingScope(targetNode);
                usedLearnedFastPath = false;
            }

            lastResponseData = resultData;
            const fallback = await this.router.getNextFallback(currentIdentifier, failure, usedRuleNames);
            if (!fallback) {
                if (this.config.logging.logFallbacks) {
                    console.log(`[${formatTimestamp()}] [Proxy:Fallback:End] No more fallback rules match for "${currentIdentifier}" (attempts: ${attempt})`);
                }
                break;
            }

            if (this.config.logging.logFallbacks) {
                const nextTargetName = fallback.isEventHub ? `eventhub:${fallback.handlerName}` : fallback.targetNode.id;
                console.log(`[${formatTimestamp()}] [Proxy:Fallback:${attempt}] Triggered rule "${fallback.rule.name}" -> Next Target: ${nextTargetName} | Next Query: "${fallback.nextIdentifier}" (reason: ${failure.message || (failure.isEmpty ? "empty result" : "error")})`);
            }

            usedRuleNames.add(fallback.rule.name);
            currentIdentifier = fallback.nextIdentifier;
            targetNode = fallback.targetNode;
            isEventHub = fallback.isEventHub;
            isInProcess = fallback.isInProcess;
            handlerName = fallback.handlerName;
            attemptTimeoutMs = fallback.timeoutMs;
            attemptEncodingScope = fallback.encodingScope;
        }

        const totalDuration = Math.round(performance.now() - requestStartedAt);
        const finalTargetName = targetNode?.id || "unknown";
        console.error(`[${formatTimestamp()}] [Proxy:Fail] "${rawIdentifier}" failed after ${attempt} attempts (${totalDuration}ms): ${failure.message}`);

        this.recordTrace({
            id: traceId,
            timestamp: Date.now(),
            rawIdentifier,
            finalIdentifier: currentIdentifier,
            category: classifyIdentifier(currentIdentifier),
            cacheStatus: "MISS",
            appliedRules,
            attempts: cascadeAttempts,
            finalTarget: finalTargetName,
            success: false,
            status: lastHttpStatus || 502,
            durationMs: totalDuration,
            error: failure.message || `Proxy failed after ${attempt} attempts`,
        });

        if (lastResponseData) return { data: lastResponseData, status: lastHttpStatus };
        return {
            data: buildErrorResult(`Proxy failed after ${attempt} attempts`, "fault", failure.message),
            status: 502,
        };
    }

    private async loadFromUpstream(
        req: Request,
        originalUrl: URL,
        targetNode: UpstreamNodeConfig,
        identifier: string
    ): Promise<{ data: LavalinkLoadResult | null; status: number; failure: FallbackFailureContext }> {
        const upstreamUrl = this.createUpstreamUrl(targetNode, "/v4/loadtracks");
        upstreamUrl.searchParams.set("identifier", identifier);
        originalUrl.searchParams.forEach((value, key) => {
            if (key !== "identifier") upstreamUrl.searchParams.set(key, value);
        });

        const timeoutMs = targetNode.requestTimeoutMs ?? this.config.server.upstreamRequestTimeoutMs ?? 3500;
        const maxBytes = this.config.server.maxLoadResultBytes ?? 8 * 1024 * 1024;
        try {
            const response = await fetch(upstreamUrl, {
                method: "GET",
                headers: {
                    Authorization: targetNode.password || this.config.server.password,
                    Accept: "application/json",
                    "Accept-Encoding": "identity",
                    "User-Agent": req.headers.get("user-agent") || "LavalinkDragonflyProxy/2",
                },
                signal: AbortSignal.timeout(timeoutMs),
            });
            const responseText = await this.readBoundedText(response, maxBytes);
            let data: LavalinkLoadResult | null = null;
            let invalidPayload = false;
            try {
                const parsed: unknown = JSON.parse(responseText);
                if (isLavalinkLoadResult(parsed)) data = parsed;
                else invalidPayload = true;
            } catch {
                invalidPayload = true;
            }

            if (invalidPayload || response.status >= 500 || response.status === 408 || response.status === 429) {
                this.recordNodeFailure(targetNode);
                this.runtimeStats.upstreamFailures++;
            } else {
                this.recordNodeSuccess(targetNode);
            }

            const message = invalidPayload
                ? `Invalid Lavalink load result from ${targetNode.id}`
                : data?.loadType === "error"
                    ? data.data.message
                    : response.ok ? "" : `HTTP ${response.status}: ${responseText.slice(0, 160)}`;
            const isEmpty = Boolean(data && (data.loadType === "empty" || (data.loadType === "search" && data.data.length === 0)));
            return {
                data,
                status: response.status,
                failure: {
                    originalIdentifier: originalUrl.searchParams.get("identifier") ?? identifier,
                    message,
                    isEmpty,
                    httpStatus: response.status,
                    loadType: data?.loadType === "empty" || data?.loadType === "error" ? data.loadType : undefined,
                },
            };
        } catch (error) {
            this.recordNodeFailure(targetNode);
            this.runtimeStats.upstreamFailures++;
            const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
            if (isTimeout) this.runtimeStats.upstreamTimeouts++;
            const message = `${isTimeout ? "Timeout" : "Connection failure"} to ${targetNode.id}: ${error instanceof Error ? error.message : error}`;
            return {
                data: null,
                status: 502,
                failure: {
                    originalIdentifier: originalUrl.searchParams.get("identifier") ?? identifier,
                    message,
                    isEmpty: false,
                    httpStatus: isTimeout ? 408 : 502,
                },
            };
        }
    }

    private async readBoundedText(response: Response, maxBytes: number): Promise<string> {
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (declaredLength > maxBytes) throw new Error(`upstream response exceeds ${maxBytes} bytes`);
        if (!response.body) return "";

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let total = 0;
        let text = "";
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel("response too large");
                throw new Error(`upstream response exceeds ${maxBytes} bytes`);
            }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    }

    private isValidLoadResult(data: unknown): data is LavalinkLoadResult {
        return isPlayableLoadResult(data);
    }

    private encodingScope(node: UpstreamNodeConfig): string {
        return node.encodingScope?.trim() || node.id;
    }

    private createUpstreamUrl(targetNode: UpstreamNodeConfig, path: string, search = ""): URL {
        const base = targetNode.url.endsWith("/") ? targetNode.url : `${targetNode.url}/`;
        return new URL(`${path.replace(/^\//, "")}${search}`, base);
    }

    private circuitKey(node: UpstreamNodeConfig): string {
        return node.id || node.url;
    }

    private canAttempt(node: UpstreamNodeConfig): boolean {
        const state = this.circuits.get(this.circuitKey(node));
        if (!state || state.openUntil === 0) return true;
        if (state.openUntil > Date.now()) return false;
        if (state.halfOpenProbe) return false;
        state.halfOpenProbe = true;
        return true;
    }

    private recordNodeSuccess(node: UpstreamNodeConfig): void {
        this.circuits.set(this.circuitKey(node), { consecutiveFailures: 0, openUntil: 0, halfOpenProbe: false });
    }

    private recordNodeFailure(node: UpstreamNodeConfig): void {
        const key = this.circuitKey(node);
        const state = this.circuits.get(key) ?? { consecutiveFailures: 0, openUntil: 0, halfOpenProbe: false };
        state.consecutiveFailures++;
        const threshold = node.failureThreshold ?? 5;
        if (state.halfOpenProbe || state.consecutiveFailures >= threshold) {
            state.openUntil = Date.now() + (node.circuitBreakerResetMs ?? 15_000);
            state.halfOpenProbe = false;
        }
        this.circuits.set(key, state);
    }

    private circuitSnapshot(): Record<string, { failures: number; openForMs: number }> {
        return Object.fromEntries(Array.from(this.circuits.entries()).map(([key, state]) => [key, {
            failures: state.consecutiveFailures,
            openForMs: Math.max(0, state.openUntil - Date.now()),
        }]));
    }

    private async forwardGenericRequest(req: Request, targetNode: UpstreamNodeConfig, url: URL): Promise<Response> {
        try {
            const upstreamTarget = this.createUpstreamUrl(targetNode, url.pathname, url.search);
            const headers = new Headers(req.headers);
            headers.set("authorization", targetNode.password || this.config.server.password);
            headers.set("accept-encoding", "identity");
            for (const header of ["host", "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
                headers.delete(header);
            }

            const isStreamingRoute = /^\/v4\/(?:trackstream|loadstream)/.test(url.pathname);
            const response = await fetch(upstreamTarget, {
                method: req.method,
                headers,
                body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
                signal: isStreamingRoute
                    ? req.signal
                    : AbortSignal.timeout(targetNode.requestTimeoutMs ?? this.config.server.upstreamRequestTimeoutMs ?? 10_000),
            });

            const responseHeaders = new Headers(response.headers);
            for (const header of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) {
                responseHeaders.delete(header);
            }
            return new Response(response.body, { status: response.status, headers: responseHeaders });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error(`[${formatTimestamp()}] [Proxy:REST:ERR] ${req.method} ${url.pathname}: ${message}`);
            return Response.json({ error: `Bad Gateway: ${message}` }, { status: 502 });
        }
    }

    private toResponse(result: ProxyResult): Response {
        return new Response(JSON.stringify(result.data), {
            status: result.status,
            headers: { "Content-Type": "application/json; charset=utf-8", ...result.headers },
        });
    }
}
