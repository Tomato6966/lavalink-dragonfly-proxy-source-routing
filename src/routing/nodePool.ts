import type { LavalinkProxyConfig, UpstreamNodeConfig } from "../types";

/**
 * 32-bit FNV-1a Hash for high-speed consistent hashing
 */
export function fnv1a32(str: string): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
}

/**
 * High-Performance Consistent Hash Ring for Guild-Affinity Voice Player Routing
 */
export class ConsistentHashRing {
    private readonly vnodesPerNode: number;
    private ring: Array<{ hash: number; nodeId: string }> = [];
    private sortedHashes: number[] = [];

    constructor(vnodesPerNode: number = 100) {
        this.vnodesPerNode = Math.max(10, vnodesPerNode);
    }

    public build(nodes: UpstreamNodeConfig[]): void {
        this.ring = [];
        for (const node of nodes) {
            if (node.enabled === false) continue;
            const weight = Math.max(1, node.weight || 1);
            const totalVnodes = this.vnodesPerNode * weight;
            for (let i = 0; i < totalVnodes; i++) {
                const vnodeKey = `${node.id || node.url}#vn${i}`;
                const hash = fnv1a32(vnodeKey);
                this.ring.push({ hash, nodeId: node.id });
            }
        }
        this.ring.sort((a, b) => a.hash - b.hash);
        this.sortedHashes = this.ring.map(entry => entry.hash);
    }

    public getNode(key: string): string | null {
        if (this.ring.length === 0) return null;
        const keyHash = fnv1a32(key);

        // Binary search for first ring entry >= keyHash (clockwise traversal)
        let low = 0;
        let high = this.sortedHashes.length - 1;
        let index = 0;

        if (keyHash > this.sortedHashes[high] || keyHash <= this.sortedHashes[0]) {
            index = 0; // Wrap around to 0
        } else {
            while (low <= high) {
                const mid = (low + high) >>> 1;
                if (this.sortedHashes[mid] >= keyHash) {
                    index = mid;
                    high = mid - 1;
                } else {
                    low = mid + 1;
                }
            }
        }

        return this.ring[index]?.nodeId ?? null;
    }
}

export interface NodeHealthStatus {
    isHealthy: boolean;
    lastChecked: number;
    latencyMs: number;
    consecutiveFailures: number;
    error?: string;
}

/**
 * UpstreamNodePool: Dynamic Multi-Node Cluster Manager, Load Balancer & Health Prober
 */
export class UpstreamNodePool {
    private config: LavalinkProxyConfig;
    private readonly nodes = new Map<string, UpstreamNodeConfig>();
    private readonly health = new Map<string, NodeHealthStatus>();
    private readonly inFlight = new Map<string, number>();
    private readonly hashRing: ConsistentHashRing;
    private roundRobinIndex: number = 0;
    private healthCheckTimer: any = null;

    constructor(config: LavalinkProxyConfig) {
        this.config = config;
        this.hashRing = new ConsistentHashRing(100);
        this.rebuildFromConfig();
    }

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
        this.rebuildFromConfig();
    }

    private rebuildFromConfig(): void {
        this.nodes.clear();
        for (const [name, node] of Object.entries(this.config.upstreams)) {
            const normalized: UpstreamNodeConfig = {
                ...node,
                id: node.id || name,
            };
            this.nodes.set(normalized.id, normalized);
            if (!this.health.has(normalized.id)) {
                this.health.set(normalized.id, {
                    isHealthy: normalized.enabled !== false,
                    lastChecked: Date.now(),
                    latencyMs: 0,
                    consecutiveFailures: 0,
                });
            }
        }
        this.rebuildRing();
    }

    private rebuildRing(): void {
        const healthyPlaybackNodes = this.getHealthyNodes(n => n.enabled !== false);
        this.hashRing.build(healthyPlaybackNodes);
    }

    public getAllNodes(): UpstreamNodeConfig[] {
        return Array.from(this.nodes.values());
    }

    public getHealthyNodes(predicate?: (node: UpstreamNodeConfig) => boolean): UpstreamNodeConfig[] {
        return Array.from(this.nodes.values()).filter(node => {
            if (node.enabled === false) return false;
            const h = this.health.get(node.id);
            if (h && !h.isHealthy) return false;
            return predicate ? predicate(node) : true;
        });
    }

    public getNodeByName(name: string): UpstreamNodeConfig | null {
        if (!name) return null;
        const byId = this.nodes.get(name);
        if (byId) return byId;

        // Check if name was the key in config.upstreams
        const byConfigKey = this.config.upstreams[name];
        if (byConfigKey) return { ...byConfigKey, id: byConfigKey.id || name };

        // Match by URL
        for (const node of this.nodes.values()) {
            if (node.url === name || node.id === name) return node;
        }
        return null;
    }

    public getDefaultNode(): UpstreamNodeConfig {
        const primary = this.config.server.primaryPlaybackNode;
        if (primary) {
            const node = this.getNodeByName(primary);
            if (node && node.enabled !== false) return node;
        }
        const defaultNode = this.config.upstreams.default;
        if (defaultNode) {
            return { ...defaultNode, id: defaultNode.id || "default" };
        }
        // Fallback to first available healthy node
        const first = this.getHealthyNodes()[0];
        if (first) return first;
        return { id: "fallback_default", url: "http://127.0.0.1:2333" };
    }

    /**
     * Resolve target playback node using Consistent Hashing by Guild ID,
     * configured explicit routing rules, or fallback strategy.
     */
    public getNodeForPlayback(guildId?: string): UpstreamNodeConfig {
        if (guildId && this.config.server.playerRouting?.length) {
            // Check explicit playerRouting rules first
            for (const rule of this.config.server.playerRouting) {
                if (rule.guildId && rule.guildId === guildId) {
                    const target = this.getNodeByName(rule.routeToNode);
                    if (target && target.enabled !== false) return target;
                }
                if (rule.guildIdMatch) {
                    try {
                        if (new RegExp(rule.guildIdMatch, "i").test(guildId)) {
                            const target = this.getNodeByName(rule.routeToNode);
                            if (target && target.enabled !== false) return target;
                        }
                    } catch {}
                }
            }
        }

        return this.getDefaultNode();
    }

    /**
     * Select node for general search dispatch (Round-Robin or Least-Connections)
     */
    public getNodeForSearch(preferredScope?: string): UpstreamNodeConfig {
        const strategy = this.config.cluster?.strategy || "round-robin";
        const healthy = this.getHealthyNodes(n =>
            preferredScope ? (n.encodingScope || n.id) === preferredScope : true
        );

        if (healthy.length === 0) {
            return this.getDefaultNode();
        }

        if (strategy === "least-connections") {
            let bestNode = healthy[0];
            let minInFlight = this.inFlight.get(bestNode.id) || 0;
            for (let i = 1; i < healthy.length; i++) {
                const count = this.inFlight.get(healthy[i].id) || 0;
                if (count < minInFlight) {
                    minInFlight = count;
                    bestNode = healthy[i];
                }
            }
            return bestNode;
        }

        // Default: Round-Robin across healthy search nodes
        this.roundRobinIndex = (this.roundRobinIndex + 1) % healthy.length;
        return healthy[this.roundRobinIndex];
    }

    /**
     * Select node for track decoding
     */
    public getNodeForDecode(scope?: string): UpstreamNodeConfig {
        if (scope) {
            const matching = this.getHealthyNodes(n => (n.encodingScope || n.id) === scope);
            if (matching.length > 0) return matching[0];
        }
        return this.getDefaultNode();
    }

    /**
     * Select node for lyrics retrieval
     */
    public getNodeForLyrics(): UpstreamNodeConfig {
        const lyricsNodes = this.getHealthyNodes(n =>
            n.tags?.includes("lyrics") || n.id.includes("lyrics")
        );
        if (lyricsNodes.length > 0) return lyricsNodes[0];
        return this.getDefaultNode();
    }

    /**
     * Check if any active healthy node supports a given capability tag or type (e.g. "nodelink")
     */
    public hasCapability(typeOrTag: string): boolean {
        const lower = typeOrTag.toLowerCase();
        for (const node of this.getHealthyNodes()) {
            if (node.type?.toLowerCase() === lower) return true;
            if (node.tags?.some(t => t.toLowerCase() === lower)) return true;
            if (node.id.toLowerCase().includes(lower)) return true;
        }
        return false;
    }

    /**
     * Get all healthy nodes matching a given capability tag or type
     */
    public getNodesWithCapability(typeOrTag: string): UpstreamNodeConfig[] {
        const lower = typeOrTag.toLowerCase();
        return this.getHealthyNodes(node =>
            node.type?.toLowerCase() === lower ||
            Boolean(node.tags?.some(t => t.toLowerCase() === lower)) ||
            node.id.toLowerCase().includes(lower)
        );
    }

    public incrementInFlight(nodeId: string): void {
        this.inFlight.set(nodeId, (this.inFlight.get(nodeId) || 0) + 1);
    }

    public decrementInFlight(nodeId: string): void {
        const cur = this.inFlight.get(nodeId) || 0;
        this.inFlight.set(nodeId, Math.max(0, cur - 1));
    }

    public recordSuccess(nodeId: string, latencyMs: number = 0): void {
        const state = this.health.get(nodeId) || {
            isHealthy: true,
            lastChecked: Date.now(),
            latencyMs,
            consecutiveFailures: 0,
        };
        state.isHealthy = true;
        state.lastChecked = Date.now();
        state.latencyMs = latencyMs;
        state.consecutiveFailures = 0;
        state.error = undefined;
        this.health.set(nodeId, state);
    }

    public recordFailure(nodeId: string, error?: string): void {
        const state = this.health.get(nodeId) || {
            isHealthy: true,
            lastChecked: Date.now(),
            latencyMs: 0,
            consecutiveFailures: 0,
        };
        state.consecutiveFailures++;
        state.lastChecked = Date.now();
        state.error = error;
        const node = this.getNodeByName(nodeId);
        const threshold = node?.failureThreshold ?? 5;
        if (state.consecutiveFailures >= threshold) {
            state.isHealthy = false;
            this.rebuildRing();
        }
        this.health.set(nodeId, state);
    }

    public getHealthSnapshot(): Record<string, NodeHealthStatus> {
        return Object.fromEntries(this.health.entries());
    }

    /**
     * Probe a single node's health via GET /version or GET /v4/info
     */
    public async probeNodeHealth(node: UpstreamNodeConfig): Promise<boolean> {
        const start = performance.now();
        const timeoutMs = this.config.cluster?.healthCheckTimeoutMs || 2500;
        try {
            const url = `${node.url.replace(/\/$/, "")}/version`;
            const res = await fetch(url, {
                headers: { Authorization: node.password || this.config.server.password },
                signal: AbortSignal.timeout(timeoutMs),
            });
            const latency = Math.round(performance.now() - start);
            if (res.ok || res.status === 401 || res.status === 404) {
                this.recordSuccess(node.id, latency);
                return true;
            }
            this.recordFailure(node.id, `HTTP ${res.status}`);
            return false;
        } catch (err: any) {
            this.recordFailure(node.id, err?.message || "Health check failed");
            return false;
        }
    }

    /**
     * Proactively probe all configured nodes in parallel
     */
    public async checkAllNodesHealth(): Promise<Record<string, boolean>> {
        const results: Record<string, boolean> = {};
        const probes = Array.from(this.nodes.values()).map(async node => {
            if (node.enabled === false) {
                results[node.id] = false;
                return;
            }
            results[node.id] = await this.probeNodeHealth(node);
        });
        await Promise.allSettled(probes);
        return results;
    }

    public startHealthProber(intervalMs?: number): void {
        this.stopHealthProber();
        const interval = intervalMs || this.config.cluster?.healthCheckIntervalMs || 15_000;
        this.healthCheckTimer = setInterval(() => {
            this.checkAllNodesHealth().catch(() => {});
        }, interval);
    }

    public stopHealthProber(): void {
        if (this.healthCheckTimer) {
            clearInterval(this.healthCheckTimer);
            this.healthCheckTimer = null;
        }
    }
}
