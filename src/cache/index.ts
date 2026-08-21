import { Redis } from "ioredis";
import type { DragonflyCacheConfig } from "../types";

export interface CacheStats {
    hits: number;
    misses: number;
    writes: number;
    evictions: number;
    errors: number;
    estimatedEntries: number;
}

export class DragonflyCacheManager {
    private client: Redis | null = null;
    private config: DragonflyCacheConfig;
    public isConnected: boolean = false;
    public stats: CacheStats = {
        hits: 0,
        misses: 0,
        writes: 0,
        evictions: 0,
        errors: 0,
        estimatedEntries: 0,
    };
    private writeCounter: number = 0;

    constructor(config: DragonflyCacheConfig) {
        this.config = config;
        if (config.enabled && config.url) {
            this.init();
        }
    }

    private init(): void {
        try {
            this.client = new Redis(this.config.url, {
                maxRetriesPerRequest: 2,
                connectTimeout: 4000,
                enableReadyCheck: true,
                lazyConnect: false,
                retryStrategy: (times) => Math.min(times * 200, 3000),
            });

            this.client.on("connect", () => {
                this.isConnected = true;
                const safeUrl = this.config.url.replace(/:[^:@]+@/, ":***@");
                console.log(`[DragonflyCache] Connected to Dragonfly/Redis at ${safeUrl}`);
                this.syncEntryCount();
            });

            this.client.on("error", (err) => {
                this.isConnected = false;
                this.stats.errors++;
                console.error("[DragonflyCache] Connection error:", err.message);
            });
        } catch (err: any) {
            this.stats.errors++;
            console.error("[DragonflyCache] Failed to initialize client:", err?.message);
        }
    }

    private formatKey(subCategory: string, identifier: string): string {
        const clean = identifier.trim().toLowerCase();
        return `${this.config.keyPrefix}:${subCategory}:${clean}`;
    }

    private get lruIndexKey(): string {
        return `${this.config.keyPrefix}:__lru_index`;
    }

    public async get(subCategory: string, identifier: string): Promise<any | null> {
        if (!this.isConnected || !this.client || !this.config.enabled) {
            this.stats.misses++;
            return null;
        }
        try {
            const key = this.formatKey(subCategory, identifier);
            const raw = await this.client.get(key);
            if (!raw) {
                this.stats.misses++;
                return null;
            }
            this.stats.hits++;

            // Touch LRU score on hit
            if (this.config.maxCachedEntries > 0) {
                this.client.zadd(this.lruIndexKey, Date.now(), key).catch(() => {});
            }

            return JSON.parse(raw);
        } catch (err: any) {
            this.stats.errors++;
            console.error(`[DragonflyCache] Error getting key for "${identifier}":`, err?.message);
            return null;
        }
    }

    public async set(subCategory: string, identifier: string, data: any, ttlSeconds?: number): Promise<void> {
        if (!this.isConnected || !this.client || !this.config.enabled) return;
        try {
            const key = this.formatKey(subCategory, identifier);
            const serialized = JSON.stringify(data);
            const ttl = ttlSeconds ?? (subCategory === "search" ? this.config.searchTtlSeconds : this.config.trackTtlSeconds);

            if (ttl > 0) {
                await this.client.setex(key, ttl, serialized);
            } else {
                await this.client.set(key, serialized);
            }

            this.stats.writes++;
            this.stats.estimatedEntries++;

            // Track in LRU Index and check max cached amount
            if (this.config.maxCachedEntries > 0) {
                await this.client.zadd(this.lruIndexKey, Date.now(), key);

                // Run eviction check every 50 writes
                if (++this.writeCounter % 50 === 0) {
                    this.enforceMaxCachedEntries().catch(() => {});
                }
            }
        } catch (err: any) {
            this.stats.errors++;
            console.error(`[DragonflyCache] Error setting key for "${identifier}":`, err?.message);
        }
    }

    public async del(subCategory: string, identifier: string): Promise<void> {
        if (!this.isConnected || !this.client || !this.config.enabled) return;
        try {
            const key = this.formatKey(subCategory, identifier);
            await this.client.del(key);
            if (this.config.maxCachedEntries > 0) {
                await this.client.zrem(this.lruIndexKey, key);
            }
            this.stats.estimatedEntries = Math.max(0, this.stats.estimatedEntries - 1);
        } catch (err: any) {
            this.stats.errors++;
            console.error(`[DragonflyCache] Error deleting key for "${identifier}":`, err?.message);
        }
    }

    /**
     * Enforce maxCachedEntries by evicting the oldest entries
     */
    private async enforceMaxCachedEntries(): Promise<void> {
        if (!this.client || !this.isConnected || this.config.maxCachedEntries <= 0) return;
        try {
            const total = await this.client.zcard(this.lruIndexKey);
            this.stats.estimatedEntries = total;

            if (total > this.config.maxCachedEntries) {
                const excess = total - this.config.maxCachedEntries;
                const oldestKeys = await this.client.zrange(this.lruIndexKey, 0, excess - 1);
                if (oldestKeys.length > 0) {
                    const pipeline = this.client.pipeline();
                    for (const key of oldestKeys) {
                        pipeline.del(key);
                    }
                    pipeline.zrem(this.lruIndexKey, ...oldestKeys);
                    await pipeline.exec();

                    this.stats.evictions += oldestKeys.length;
                    this.stats.estimatedEntries = Math.max(0, total - oldestKeys.length);
                    console.log(`[DragonflyCache:Eviction] Evicted ${oldestKeys.length} oldest entries (Cap: ${this.config.maxCachedEntries})`);
                }
            }
        } catch (err: any) {
            console.error("[DragonflyCache:Eviction] Error during cache eviction:", err?.message);
        }
    }

    private async syncEntryCount(): Promise<void> {
        if (!this.client || !this.isConnected || this.config.maxCachedEntries <= 0) return;
        try {
            const count = await this.client.zcard(this.lruIndexKey);
            this.stats.estimatedEntries = count;
        } catch {}
    }
}
