import { describe, it, expect } from "bun:test";
import { ConsistentHashRing, UpstreamNodePool } from "./nodePool";
import type { LavalinkProxyConfig, UpstreamNodeConfig } from "../types";

function createMockConfig(upstreams: Record<string, UpstreamNodeConfig>): LavalinkProxyConfig {
    return {
        server: {
            port: 2332,
            host: "0.0.0.0",
            password: "test",
            primaryPlaybackNode: "default",
        },
        cluster: {
            enabled: true,
            strategy: "consistent-hash",
        },
        dragonfly: {
            enabled: false,
            url: "redis://127.0.0.1:6666",
            keyPrefix: "test",
            searchTtlSeconds: 60,
            trackTtlSeconds: 60,
            lyricsTtlSeconds: 60,
            maxCachedEntries: 1000,
        },
        eventHub: {
            enabled: false,
            path: "/proxy/events",
            authToken: "test",
            defaultTimeoutMs: 1000,
        },
        remapping: {
            enabled: true,
            maxRecursionDepth: 3,
            preRequest: [],
            postRequestOnFail: [],
        },
        upstreams: {
            default: {
                id: "default_node",
                url: "http://127.0.0.1:2333",
            },
            ...upstreams,
        },
        logging: {
            debug: false,
            logHits: false,
            logMisses: false,
            logRoutes: false,
            logFallbacks: false,
        },
    };
}

describe("Dynamic Multi-Node Cluster Pool & Consistent Hashing", () => {
    describe("ConsistentHashRing", () => {
        it("distributes 10,000 guild IDs uniformly across 100 simulated nodes", () => {
            const ring = new ConsistentHashRing(100);
            const nodes: UpstreamNodeConfig[] = Array.from({ length: 100 }, (_, i) => ({
                id: `lavalink_node_${i + 1}`,
                url: `http://10.0.0.${i + 1}:2333`,
                enabled: true,
            }));

            ring.build(nodes);

            const distribution: Record<string, number> = {};
            const totalGuilds = 10_000;

            for (let i = 0; i < totalGuilds; i++) {
                const guildId = `11703529185290${(100000 + i).toString()}`;
                const selected = ring.getNode(guildId);
                expect(selected).toBeDefined();
                if (selected) {
                    distribution[selected] = (distribution[selected] || 0) + 1;
                }
            }

            // Verify all 100 nodes received guilds
            const hitNodes = Object.keys(distribution).length;
            expect(hitNodes).toBe(100);

            // Average per node is 100 guilds. Expect reasonable distribution across all nodes (10 to 300)
            for (const count of Object.values(distribution)) {
                expect(count).toBeGreaterThan(10);
                expect(count).toBeLessThan(350);
            }
        });

        it("is strictly deterministic for identical guild IDs", () => {
            const ring = new ConsistentHashRing(100);
            const nodes: UpstreamNodeConfig[] = [
                { id: "node_us_1", url: "http://127.0.0.1:2333" },
                { id: "node_us_2", url: "http://127.0.0.1:2334" },
                { id: "node_eu_1", url: "http://127.0.0.1:2335" },
            ];
            ring.build(nodes);

            const guildA = "1170352918529052752";
            const guildB = "9876543210987654321";

            const firstA = ring.getNode(guildA);
            const firstB = ring.getNode(guildB);

            for (let i = 0; i < 50; i++) {
                expect(ring.getNode(guildA)).toBe(firstA);
                expect(ring.getNode(guildB)).toBe(firstB);
            }
        });

        it("re-balances gracefully when a node is removed", () => {
            const ring = new ConsistentHashRing(100);
            const node1 = { id: "node_1", url: "http://127.0.0.1:2333" };
            const node2 = { id: "node_2", url: "http://127.0.0.1:2334" };
            const node3 = { id: "node_3", url: "http://127.0.0.1:2335" };

            ring.build([node1, node2, node3]);
            const guildIds = Array.from({ length: 500 }, (_, i) => `guild_${i}`);
            const initialMap = new Map<string, string>();
            for (const g of guildIds) {
                initialMap.set(g, ring.getNode(g)!);
            }

            // Remove node3
            ring.build([node1, node2]);

            let changedCount = 0;
            for (const g of guildIds) {
                const initial = initialMap.get(g);
                const updated = ring.getNode(g);
                expect(updated).toBeDefined();
                expect(updated).not.toBe("node_3");
                if (initial !== updated) {
                    changedCount++;
                    // Only keys previously on node_3 should have changed
                    expect(initial).toBe("node_3");
                }
            }

            expect(changedCount).toBeGreaterThan(0);
        });
    });

    describe("UpstreamNodePool", () => {
        it("matches capabilities dynamically by type, tags, and ID without hardcoded names", () => {
            const config = createMockConfig({
                node_nl_1: {
                    id: "nodelink_us_east",
                    url: "http://127.0.0.1:2334",
                    type: "nodelink",
                    tags: ["spotify", "youtube"],
                },
                node_dz_1: {
                    id: "deezer_fast_pool",
                    url: "http://127.0.0.1:2335",
                    tags: ["deezer", "lossless", "lyrics"],
                },
            });

            const pool = new UpstreamNodePool(config);

            expect(pool.hasCapability("nodelink")).toBe(true);
            expect(pool.hasCapability("deezer")).toBe(true);
            expect(pool.hasCapability("lyrics")).toBe(true);
            expect(pool.hasCapability("non_existent")).toBe(false);

            const deezerNodes = pool.getNodesWithCapability("deezer");
            expect(deezerNodes.length).toBe(1);
            expect(deezerNodes[0].id).toBe("deezer_fast_pool");

            const lyricsNode = pool.getNodeForLyrics();
            expect(lyricsNode.id).toBe("deezer_fast_pool");
        });

        it("dispatches search queries using round-robin across healthy nodes", () => {
            const config = createMockConfig({
                node_a: { id: "node_a", url: "http://10.0.0.1:2333" },
                node_b: { id: "node_b", url: "http://10.0.0.2:2333" },
                node_c: { id: "node_c", url: "http://10.0.0.3:2333" },
            });
            config.cluster = { enabled: true, strategy: "round-robin" };

            const pool = new UpstreamNodePool(config);
            const selections = Array.from({ length: 6 }, () => pool.getNodeForSearch().id);

            // Verify cyclical dispatch
            expect(new Set(selections).size).toBeGreaterThan(1);
        });

        it("routes least-connections to the node with fewest in-flight requests", () => {
            const config = createMockConfig({
                node_busy: { id: "node_busy", url: "http://10.0.0.1:2333" },
                node_free: { id: "node_free", url: "http://10.0.0.2:2333" },
            });
            config.cluster = { enabled: true, strategy: "least-connections" };

            const pool = new UpstreamNodePool(config);
            pool.incrementInFlight("default_node");
            pool.incrementInFlight("default_node");
            pool.incrementInFlight("node_busy");
            pool.incrementInFlight("node_busy");
            pool.incrementInFlight("node_busy");

            const chosen = pool.getNodeForSearch();
            expect(chosen.id).toBe("node_free");
        });

        it("automatically removes failing node from healthy pool and hash ring", () => {
            const config = createMockConfig({
                flaky_node: {
                    id: "flaky_node",
                    url: "http://10.0.0.5:2333",
                    failureThreshold: 2,
                },
            });

            const pool = new UpstreamNodePool(config);
            expect(pool.getHealthyNodes().some(n => n.id === "flaky_node")).toBe(true);

            // Trigger failures
            pool.recordFailure("flaky_node", "Connection timeout");
            expect(pool.getHealthyNodes().some(n => n.id === "flaky_node")).toBe(true);

            pool.recordFailure("flaky_node", "Connection refused");
            // Now exceeds threshold of 2
            expect(pool.getHealthyNodes().some(n => n.id === "flaky_node")).toBe(false);

            // Recover
            pool.recordSuccess("flaky_node", 15);
            expect(pool.getHealthyNodes().some(n => n.id === "flaky_node")).toBe(true);
        });
    });
});
