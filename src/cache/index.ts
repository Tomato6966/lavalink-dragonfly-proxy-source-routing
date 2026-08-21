import { Redis } from "ioredis";
import type { DragonflyCacheConfig } from "../types";

export interface CacheStats {
    hits: number;
    fuzzyHits: number;
    misses: number;
    writes: number;
    evictions: number;
    errors: number;
    estimatedEntries: number;
}

/**
 * Fast Levenshtein distance calculation
 */
export function calculateLevenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (a.length === 0) return b.length;
    if (b.length === 0) return a.length;

    const matrix: number[][] = [];

    for (let i = 0; i <= b.length; i++) {
        matrix[i] = [i];
    }
    for (let j = 0; j <= a.length; j++) {
        matrix[0][j] = j;
    }

    for (let i = 1; i <= b.length; i++) {
        for (let j = 1; j <= a.length; j++) {
            if (b.charAt(i - 1) === a.charAt(j - 1)) {
                matrix[i][j] = matrix[i - 1][j - 1];
            } else {
                matrix[i][j] = Math.min(
                    matrix[i - 1][j - 1] + 1, // substitution
                    matrix[i][j - 1] + 1,     // insertion
                    matrix[i - 1][j] + 1      // deletion
                );
            }
        }
    }

    return matrix[b.length][a.length];
}

/**
 * Calculate string similarity ratio between 0.0 and 1.0
 */
export function calculateSimilarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    const distance = calculateLevenshteinDistance(a, b);
    return 1.0 - distance / maxLen;
}

/**
 * Normalize search query for fuzzy typo comparison
 */
export function normalizeSearchQuery(raw: string): { prefix: string; cleanQuery: string } {
    let text = raw.trim().toLowerCase();
    let prefix = "";

    const colonIdx = text.indexOf(":");
    if (colonIdx > 0 && colonIdx <= 10) {
        prefix = text.slice(0, colonIdx + 1);
        text = text.slice(colonIdx + 1);
    }

    // Remove punctuation, collapse multiple spaces
    const cleanQuery = text
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ")
        .trim();

    return { prefix, cleanQuery };
}

interface FuzzyIndexEntry {
    prefix: string;
    cleanQuery: string;
    rawIdentifier: string;
    subCategory: string;
    addedAt: number;
}

export class DragonflyCacheManager {
    private client: Redis | null = null;
    private config: DragonflyCacheConfig;
    public isConnected: boolean = false;
    public stats: CacheStats = {
        hits: 0,
        fuzzyHits: 0,
        misses: 0,
        writes: 0,
        evictions: 0,
        errors: 0,
        estimatedEntries: 0,
    };
    private writeCounter: number = 0;
    private fuzzySearchIndex: FuzzyIndexEntry[] = [];
    private maxFuzzyIndexSize: number = 5000;

    constructor(config: DragonflyCacheConfig) {
        this.config = config;
        if (config.enabled && config.url) {
            this.init();
        }
    }

    private init(): void {
        try {
            const redisOptions: any = {
                maxRetriesPerRequest: 2,
                connectTimeout: 4000,
                enableReadyCheck: true,
                lazyConnect: false,
                protocol: 2, // Use RESP2 to avoid NOAUTH HELLO issues on Redis/Dragonfly
                retryStrategy: (times: number) => Math.min(times * 200, 3000),
            };

            if (this.config.password) {
                redisOptions.password = this.config.password;
            }

            this.client = new Redis(this.config.url, redisOptions);

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

    /**
     * Get cached value by key, with automatic Levenshtein fuzzy match fallback for search typos
     */
    public async get(subCategory: string, identifier: string): Promise<any | null> {
        if (!this.isConnected || !this.client || !this.config.enabled) {
            this.stats.misses++;
            return null;
        }
        try {
            // 1. Direct exact key lookup
            const key = this.formatKey(subCategory, identifier);
            const raw = await this.client.get(key);
            if (raw) {
                this.stats.hits++;

                // Touch LRU score on hit
                if (this.config.maxCachedEntries > 0) {
                    this.client.zadd(this.lruIndexKey, Date.now(), key).catch(() => {});
                }

                return JSON.parse(raw);
            }

            // 2. Fuzzy / Typo match for search queries
            if (subCategory === "search") {
                const fuzzyHit = await this.lookupFuzzy(identifier);
                if (fuzzyHit) {
                    this.stats.fuzzyHits++;
                    // Also alias the typo query in cache for instant O(1) hits next time
                    this.set(subCategory, identifier, fuzzyHit.data).catch(() => {});
                    return fuzzyHit.data;
                }
            }

            this.stats.misses++;
            return null;
        } catch (err: any) {
            this.stats.errors++;
            console.error(`[DragonflyCache] Error getting key for "${identifier}":`, err?.message);
            return null;
        }
    }

    /**
     * Search the in-memory index for a typo / fuzzy match (Similarity >= 85%)
     */
    private async lookupFuzzy(rawIdentifier: string): Promise<{ data: any; matchedIdentifier: string; similarity: number } | null> {
        if (!this.client || this.fuzzySearchIndex.length === 0) return null;

        const { prefix, cleanQuery } = normalizeSearchQuery(rawIdentifier);
        if (cleanQuery.length < 5) return null; // Don't fuzzy-match very short queries

        let bestMatch: FuzzyIndexEntry | null = null;
        let bestSimilarity = 0.85; // Require at least 85% similarity

        for (const entry of this.fuzzySearchIndex) {
            // Must have matching source prefix (e.g. dzsearch:) if specified
            if (prefix && entry.prefix && prefix !== entry.prefix) continue;

            // Length difference must be small (<= 4 chars)
            if (Math.abs(cleanQuery.length - entry.cleanQuery.length) > 4) continue;

            const similarity = calculateSimilarity(cleanQuery, entry.cleanQuery);
            if (similarity >= bestSimilarity) {
                bestSimilarity = similarity;
                bestMatch = entry;
            }
        }

        if (bestMatch) {
            const key = this.formatKey("search", bestMatch.rawIdentifier);
            const raw = await this.client.get(key);
            if (raw) {
                console.log(
                    `[DragonflyCache:FuzzyMatch] Typo "${rawIdentifier}" matched "${bestMatch.rawIdentifier}" (${(bestSimilarity * 100).toFixed(1)}% match)`
                );
                return {
                    data: JSON.parse(raw),
                    matchedIdentifier: bestMatch.rawIdentifier,
                    similarity: bestSimilarity,
                };
            }
        }

        return null;
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

            // Index for fuzzy matching
            if (subCategory === "search") {
                this.registerFuzzyEntry(identifier, subCategory);
            }

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

    private registerFuzzyEntry(rawIdentifier: string, subCategory: string): void {
        const { prefix, cleanQuery } = normalizeSearchQuery(rawIdentifier);
        if (cleanQuery.length < 5) return;

        // Check if already indexed
        const existing = this.fuzzySearchIndex.find((e) => e.rawIdentifier === rawIdentifier);
        if (existing) {
            existing.addedAt = Date.now();
            return;
        }

        this.fuzzySearchIndex.push({
            prefix,
            cleanQuery,
            rawIdentifier,
            subCategory,
            addedAt: Date.now(),
        });

        if (this.fuzzySearchIndex.length > this.maxFuzzyIndexSize) {
            this.fuzzySearchIndex.shift(); // Remove oldest
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
            this.fuzzySearchIndex = this.fuzzySearchIndex.filter((e) => e.rawIdentifier !== identifier);
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
