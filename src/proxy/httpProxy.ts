import type { LavalinkProxyConfig, UpstreamNodeConfig, LavalinkLoadResult } from "../types";
import type { DragonflyCacheManager } from "../cache";
import type { UpstreamRouter } from "../routing";
import type { EventHubManager } from "../eventHub";
import { buildErrorResult } from "../builders";

export class HttpProxyHandler {
    private config: LavalinkProxyConfig;
    private cache: DragonflyCacheManager;
    private router: UpstreamRouter;
    private eventHub: EventHubManager;
    private startTime: number = Date.now();

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

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
    }

    public async handleRequest(req: Request): Promise<Response> {
        const urlObj = new URL(req.url);
        const pathname = urlObj.pathname;

        // 1. Stats & Health Route
        if (pathname === "/proxy/stats" || pathname === "/proxy/health") {
            return Response.json({
                status: "ok",
                runtime: "Bun Native",
                uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
                cacheConnected: this.cache.isConnected,
                cacheStats: this.cache.stats,
                connectedEventHubClients: this.eventHub.connectedClientCount,
                configuredUpstreams: Object.keys(this.config.upstreams),
                remappingEnabled: this.config.remapping.enabled,
                maxRecursionDepth: this.config.remapping.maxRecursionDepth,
            });
        }

        // 2. Cache Invalidation Route
        if (pathname === "/proxy/cache/clear" && (req.method === "POST" || req.method === "GET")) {
            const authHeader = req.headers.get("authorization") || urlObj.searchParams.get("password");
            if (authHeader !== this.config.server.password) {
                return Response.json({ error: "Unauthorized" }, { status: 401 });
            }
            console.log("[Proxy:Cache] Cache flush requested.");
            return Response.json({ success: true, message: "Cache flush requested" });
        }

        // 3. Authenticate Lavalink Client
        const clientAuth = req.headers.get("authorization");
        if (this.config.server.password && clientAuth !== this.config.server.password) {
            return Response.json(
                {
                    timestamp: Date.now(),
                    status: 401,
                    error: "Unauthorized",
                    message: "Invalid authorization password",
                    path: pathname,
                },
                { status: 401 }
            );
        }

        // 4. Handle `/v4/loadtracks` with Full Fallback Cascade & Dragonfly Cache
        if (pathname === "/v4/loadtracks" && req.method === "GET") {
            return await this.handleLoadTracksWithCascade(req, urlObj);
        }

        // 5. Forward generic REST endpoints (player PATCH/POST/GET, sessions, etc.)
        return await this.forwardGenericRequest(req, this.config.upstreams.default, urlObj);
    }

    private async handleLoadTracksWithCascade(req: Request, urlObj: URL): Promise<Response> {
        const rawIdentifier = urlObj.searchParams.get("identifier") || "";
        if (!rawIdentifier) {
            return Response.json({ error: "Missing identifier parameter" }, { status: 400 });
        }

        // 1. Direct Cache Lookup on Raw Identifier (only return valid non-empty cached data)
        const initialCached = (await this.cache.get("search", rawIdentifier)) || (await this.cache.get("track", rawIdentifier));
        if (initialCached && this.isValidLoadResult(initialCached)) {
            if (this.config.logging.logHits) {
                const count = Array.isArray(initialCached.data) ? ` (${initialCached.data.length} tracks)` : "";
                console.log(`[Proxy:Cache:HIT] "${rawIdentifier}" -> ${initialCached.loadType}${count}`);
            }
            return Response.json(initialCached, {
                headers: {
                    "X-Proxy-Cache": "HIT",
                    "X-Proxy-Node": "cache",
                },
            });
        }

        // 2. Stage 1: Pre-Request Transformations
        const preResult = await this.router.applyPreRequest(rawIdentifier);
        let currentIdentifier = preResult.transformedIdentifier;
        let targetNode: UpstreamNodeConfig = preResult.targetNode;
        let isEventHub = false;
        let isInProcess = false;
        let handlerName: string | undefined;

        if (preResult.isRemapped && this.config.logging.logRoutes) {
            console.log(`[Proxy:PreRequest] Remapped "${rawIdentifier}" -> "${currentIdentifier}"`);
        }

        // Check if remapped query is in cache
        if (preResult.isRemapped) {
            const remappedCached = await this.cache.get(preResult.cacheCategory, currentIdentifier);
            if (remappedCached && this.isValidLoadResult(remappedCached)) {
                if (this.config.logging.logHits) {
                    const count = Array.isArray(remappedCached.data) ? ` (${remappedCached.data.length} tracks)` : "";
                    console.log(`[Proxy:Cache:HIT] "${rawIdentifier}" (via "${currentIdentifier}") -> ${remappedCached.loadType}${count}`);
                }
                return Response.json(remappedCached, {
                    headers: {
                        "X-Proxy-Cache": "HIT",
                        "X-Proxy-Node": "cache",
                    },
                });
            }
        }

        // 3. Stage 2: Cascade & Fallback Execution Loop
        const maxDepth = this.config.remapping.maxRecursionDepth || 4;
        const usedRuleNames = new Set<string>();
        let lastErrorMsg = "";
        let lastResponseData: any = null;
        let lastHttpStatus = 502;
        let attempt = 0;

        while (attempt < maxDepth) {
            attempt++;
            let attemptSuccess = false;
            let resultData: LavalinkLoadResult | null = null;

            if (this.config.logging.logRoutes) {
                console.log(
                    `[Proxy:Cascade] Attempt #${attempt}: Query="${currentIdentifier}" Target=${
                        isEventHub ? `EventHub:${handlerName}` : targetNode.id || targetNode.url
                    }`
                );
            }

            // Case A: Event Hub RPC Fallback
            if (isEventHub && handlerName) {
                try {
                    resultData = await this.eventHub.callHandler(
                        handlerName,
                        {
                            identifier: currentIdentifier,
                            originalIdentifier: rawIdentifier,
                            attempt,
                            lastError: lastErrorMsg,
                        },
                        3500
                    );
                    if (resultData && this.isValidLoadResult(resultData)) {
                        attemptSuccess = true;
                    }
                } catch (err: any) {
                    lastErrorMsg = `EventHub error: ${err.message}`;
                }
            }
            // Case B: In-Process Function Fallback
            else if (isInProcess && handlerName) {
                try {
                    resultData = await this.router.transformers.executeFallbackFunction(
                        handlerName,
                        currentIdentifier,
                        { rawIdentifier, attempt }
                    );
                    if (resultData && this.isValidLoadResult(resultData)) {
                        attemptSuccess = true;
                    }
                } catch (err: any) {
                    lastErrorMsg = `InProcess error: ${err.message}`;
                }
            }
            // Case C: Upstream Node HTTP Request
            else {
                try {
                    const upstreamUrl = new URL(`${targetNode.url}/v4/loadtracks`);
                    upstreamUrl.searchParams.set("identifier", currentIdentifier);

                    urlObj.searchParams.forEach((val, key) => {
                        if (key !== "identifier") upstreamUrl.searchParams.set(key, val);
                    });

                    const response = await fetch(upstreamUrl.toString(), {
                        method: "GET",
                        headers: {
                            Authorization: targetNode.password || this.config.server.password,
                            Accept: "application/json",
                            "User-Agent": req.headers.get("user-agent") || "LavalinkBunProxy/1.1",
                        },
                    });

                    lastHttpStatus = response.status;
                    const responseText = await response.text();
                    try {
                        resultData = JSON.parse(responseText);
                    } catch {
                        resultData = null;
                    }

                    if (response.ok && resultData && this.isValidLoadResult(resultData)) {
                        attemptSuccess = true;
                    } else {
                        lastErrorMsg =
                            (resultData as any)?.data?.message ||
                            (resultData as any)?.error ||
                            `HTTP ${response.status}: ${responseText.slice(0, 120)}`;
                    }
                } catch (err: any) {
                    lastErrorMsg = `Connection failed to ${targetNode.url}: ${err.message}`;
                }
            }

            // 4. Evaluate Attempt Result
            if (attemptSuccess && resultData) {
                // Save valid result in Dragonfly Cache
                await this.cache.set(preResult.cacheCategory, currentIdentifier, resultData);
                if (rawIdentifier !== currentIdentifier) {
                    await this.cache.set(preResult.cacheCategory, rawIdentifier, resultData);
                }

                if (this.config.logging.logFallbacks && attempt > 1) {
                    console.log(`[Proxy:Fallback:Success] Resolved "${rawIdentifier}" via attempt #${attempt} ("${currentIdentifier}")`);
                }

                return Response.json(resultData, {
                    headers: {
                        "X-Proxy-Cache": "MISS",
                        "X-Proxy-Node": isEventHub ? `eventhub:${handlerName}` : targetNode.id || "upstream",
                        "X-Proxy-Attempts": String(attempt),
                        "X-Proxy-Resolved-Identifier": currentIdentifier,
                    },
                });
            }

            // Record last response data
            lastResponseData = resultData;
            const isEmpty = !resultData || resultData.loadType === "empty" || (resultData.loadType === "search" && (!Array.isArray(resultData.data) || resultData.data.length === 0));

            // 5. Find next matching fallback rule
            const fallback = this.router.getNextFallback(currentIdentifier, lastErrorMsg, isEmpty, usedRuleNames);
            if (!fallback) {
                if (this.config.logging.logFallbacks) {
                    console.warn(`[Proxy:Fallback:Exhausted] No further fallback rules for "${currentIdentifier}" (Last Error: ${lastErrorMsg})`);
                }
                break;
            }

            usedRuleNames.add(fallback.rule.name);
            if (this.config.logging.logFallbacks) {
                console.log(`[Proxy:Fallback:Trigger] Rule "${fallback.rule.name}" triggered -> Next="${fallback.nextIdentifier}"`);
            }

            currentIdentifier = fallback.nextIdentifier;
            targetNode = fallback.targetNode;
            isEventHub = fallback.isEventHub;
            isInProcess = fallback.isInProcess;
            handlerName = fallback.handlerName;
        }

        // All cascade attempts failed
        if (lastResponseData) {
            return Response.json(lastResponseData, { status: lastHttpStatus });
        }

        return Response.json(
            buildErrorResult(`Proxy failed after ${attempt} cascade attempts: ${lastErrorMsg}`, "fault", lastErrorMsg),
            { status: 502 }
        );
    }

    private isValidLoadResult(data: any): boolean {
        if (!data || typeof data !== "object") return false;
        if (data.loadType === "track" || data.loadType === "playlist") {
            return !!data.data;
        }
        if (data.loadType === "search") {
            return Array.isArray(data.data) && data.data.length > 0;
        }
        return false;
    }

    private async forwardGenericRequest(
        req: Request,
        targetNode: UpstreamNodeConfig,
        urlObj: URL
    ): Promise<Response> {
        try {
            const upstreamTarget = new URL(`${targetNode.url}${urlObj.pathname}${urlObj.search}`);
            const headers = new Headers(req.headers);
            headers.set("authorization", targetNode.password || this.config.server.password);
            headers.delete("host");
            headers.delete("content-length");

            const reqBody = req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined;

            const response = await fetch(upstreamTarget.toString(), {
                method: req.method,
                headers,
                body: reqBody,
            });

            if (this.config.logging.debug) {
                console.log(`[Proxy:REST] ${req.method} ${urlObj.pathname} -> HTTP ${response.status}`);
            }

            return new Response(response.body, {
                status: response.status,
                headers: response.headers,
            });
        } catch (err: any) {
            console.error(`[Proxy:Error] Forwarding ${req.method} ${urlObj.pathname} failed:`, err?.message);
            return Response.json({ error: `Bad Gateway: ${err?.message}` }, { status: 502 });
        }
    }
}
