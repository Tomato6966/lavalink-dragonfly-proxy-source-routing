import { createHash } from "node:crypto";
import { Redis } from "ioredis";
import type { DragonflyCacheConfig, LearnedRoute } from "../types";
import { canonicalizeSpotifyIdentifier } from "../resolvers";

export interface CacheStats {
    hits: number;
    memoryHits: number;
    fuzzyHits: number;
    misses: number;
    writes: number;
    evictions: number;
    errors: number;
    clears: number;
    estimatedEntries: number;
    memoryEntries: number;
    memoryBytes: number;
    memoryEvictions: number;
    fuzzyIndexEntries: number;
    oversizedSkips: number;
    maxMemoryEntries: number;
    maxMemoryBytes: number;
    maxFuzzyIndexEntries: number;
    maxRemoteEntries: number;
    remoteIndexEnabled: boolean;
}

export function calculateLevenshteinDistance(a: string, b: string): number {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;
    if (a.length > b.length) [a, b] = [b, a];

    let previous = Array.from({ length: a.length + 1 }, (_, index) => index);
    let current = new Array<number>(a.length + 1);

    for (let row = 1; row <= b.length; row++) {
        current[0] = row;
        for (let column = 1; column <= a.length; column++) {
            const substitutionCost = b.charCodeAt(row - 1) === a.charCodeAt(column - 1) ? 0 : 1;
            current[column] = Math.min(
                previous[column] + 1,
                current[column - 1] + 1,
                previous[column - 1] + substitutionCost
            );
        }
        [previous, current] = [current, previous];
    }

    return previous[a.length];
}

export function calculateSimilarity(a: string, b: string): number {
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - calculateLevenshteinDistance(a, b) / maxLen;
}

export function normalizeSearchQuery(raw: string): { prefix: string; cleanQuery: string } {
    let text = raw.trim().normalize("NFKC");
    let prefix = "";
    const match = text.match(/^([a-z0-9_-]+(?:\[[^\]]+\])?:)/i);
    if (match) {
        prefix = match[1].toLowerCase();
        text = text.slice(match[1].length);
    }

    const cleanQuery = text
        .toLocaleLowerCase("en-US")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .replace(/\s+/g, " ")
        .trim();
    return { prefix, cleanQuery };
}

/** Preserve case-sensitive direct identifiers while normalizing search text safely. */
export function canonicalizeCacheIdentifier(subCategory: string, identifier: string): string {
    const trimmed = identifier.trim().normalize("NFKC");
    const spotify = canonicalizeSpotifyIdentifier(trimmed);
    if (spotify) return spotify;
    if (subCategory !== "search") return trimmed;

    const { prefix, cleanQuery } = normalizeSearchQuery(trimmed);
    return `${prefix}${cleanQuery}`;
}

interface FuzzyIndexEntry {
    namespace: string;
    prefix: string;
    cleanQuery: string;
    rawIdentifier: string;
    addedAt: number;
}

interface MemoryEntry {
    value: unknown;
    expiresAt: number;
    bytes: number;
}

export class DragonflyCacheManager {
    private client: Redis | null = null;
    private readonly config: DragonflyCacheConfig;
    public isConnected = false;
    public readonly stats: CacheStats = {
        hits: 0,
        memoryHits: 0,
        fuzzyHits: 0,
        misses: 0,
        writes: 0,
        evictions: 0,
        errors: 0,
        clears: 0,
        estimatedEntries: 0,
        memoryEntries: 0,
        memoryBytes: 0,
        memoryEvictions: 0,
        fuzzyIndexEntries: 0,
        oversizedSkips: 0,
        maxMemoryEntries: 1000,
        maxMemoryBytes: 32 * 1024 * 1024,
        maxFuzzyIndexEntries: 5000,
        maxRemoteEntries: 0,
        remoteIndexEnabled: false,
    };
    private writeCounter = 0;
    private fuzzySearchIndex: FuzzyIndexEntry[] = [];
    private readonly maxFuzzyIndexSize = 5000;
    private readonly memoryCache = new Map<string, MemoryEntry>();
    private memoryBytes = 0;
    private evictionInFlight = false;

    constructor(config: DragonflyCacheConfig) {
        this.config = config;
        this.stats.maxMemoryEntries = config.memoryMaxEntries ?? 1000;
        this.stats.maxMemoryBytes = config.memoryMaxBytes ?? 32 * 1024 * 1024;
        this.stats.maxRemoteEntries = config.maxCachedEntries;
        this.stats.remoteIndexEnabled = config.maxCachedEntries > 0;
        if (config.enabled && config.url) this.init();
    }

    private init(): void {
        try {
            this.client = new Redis(this.config.url, {
                password: this.config.password || undefined,
                maxRetriesPerRequest: 1,
                connectTimeout: 3000,
                commandTimeout: this.config.commandTimeoutMs ?? 750,
                enableReadyCheck: true,
                enableOfflineQueue: false,
                lazyConnect: false,
                retryStrategy: (times) => Math.min(times * 200, 3000),
            });

            this.client.on("ready", () => {
                this.isConnected = true;
                console.log(`[DragonflyCache] Ready at ${this.safeConnectionUrl()}`);
                void this.syncEntryCount();
            });
            this.client.on("close", () => {
                this.isConnected = false;
            });
            this.client.on("reconnecting", () => {
                this.isConnected = false;
            });
            this.client.on("error", (error) => {
                this.stats.errors++;
                console.error("[DragonflyCache] Connection error:", error.message);
            });
        } catch (error) {
            this.stats.errors++;
            console.error("[DragonflyCache] Failed to initialize:", error instanceof Error ? error.message : error);
        }
    }

    private safeConnectionUrl(): string {
        try {
            const url = new URL(this.config.url);
            if (url.password) url.password = "***";
            return url.toString();
        } catch {
            return "configured endpoint";
        }
    }

    private digest(value: string): string {
        return createHash("sha256").update(value).digest("hex");
    }

    private formatKey(subCategory: string, identifier: string, namespace = ""): string {
        const canonical = canonicalizeCacheIdentifier(subCategory, identifier);
        return `${this.config.keyPrefix}:v3:${subCategory}:${this.digest(`${namespace}\u0000${canonical}`)}`;
    }

    private formatLearnedRouteKey(identifier: string, namespace = ""): string {
        const canonical = identifier.trim().normalize("NFKC");
        return `${this.config.keyPrefix}:v3:learned_route:${this.digest(`${namespace}\u0000${canonical}`)}`;
    }

    private get lruIndexKey(): string {
        return `${this.config.keyPrefix}:v3:__lru_index`;
    }

    private refreshMemoryStats(): void {
        this.stats.memoryEntries = this.memoryCache.size;
        this.stats.memoryBytes = this.memoryBytes;
        this.stats.fuzzyIndexEntries = this.fuzzySearchIndex.length;
    }

    private removeMemoryEntry(key: string): void {
        const existing = this.memoryCache.get(key);
        if (!existing) return;
        this.memoryCache.delete(key);
        this.memoryBytes = Math.max(0, this.memoryBytes - existing.bytes);
    }

    private getMemory(key: string): unknown | null {
        const entry = this.memoryCache.get(key);
        if (!entry) return null;
        if (entry.expiresAt <= Date.now()) {
            this.removeMemoryEntry(key);
            this.refreshMemoryStats();
            return null;
        }
        this.memoryCache.delete(key);
        this.memoryCache.set(key, entry);
        return entry.value;
    }

    private setMemory(key: string, value: unknown, ttlSeconds: number, bytes: number): void {
        const maxEntries = this.config.memoryMaxEntries ?? 1000;
        const maxBytes = this.config.memoryMaxBytes ?? 32 * 1024 * 1024;
        if (maxEntries <= 0 || (maxBytes > 0 && bytes > maxBytes)) return;
        const localTtl = Math.min(ttlSeconds > 0 ? ttlSeconds : 5, this.config.memoryTtlSeconds ?? 5);
        this.removeMemoryEntry(key);
        this.memoryCache.set(key, { value, expiresAt: Date.now() + localTtl * 1000, bytes });
        this.memoryBytes += bytes;
        while (this.memoryCache.size > maxEntries || (maxBytes > 0 && this.memoryBytes > maxBytes)) {
            const oldest = this.memoryCache.keys().next().value as string | undefined;
            if (!oldest) break;
            this.removeMemoryEntry(oldest);
            this.stats.memoryEvictions++;
        }
        this.refreshMemoryStats();
    }

    private ttlFor(subCategory: string, requested?: number): number {
        const base = requested ?? (
            subCategory === "search" ? this.config.searchTtlSeconds
                : subCategory === "lyrics" ? this.config.lyricsTtlSeconds
                    : this.config.trackTtlSeconds
        );
        if (base <= 0) return base;
        const jitter = Math.min(Math.max(this.config.ttlJitterPercent ?? 0.05, 0), 0.25);
        return Math.max(1, Math.round(base * (1 + (Math.random() * 2 - 1) * jitter)));
    }

    public async get(subCategory: string, identifier: string, namespace = ""): Promise<unknown | null> {
        const key = this.formatKey(subCategory, identifier, namespace);
        const memoryHit = this.getMemory(key);
        if (memoryHit !== null) {
            this.stats.hits++;
            this.stats.memoryHits++;
            return memoryHit;
        }

        if (!this.isConnected || !this.client || !this.config.enabled) {
            this.stats.misses++;
            return null;
        }

        try {
            const raw = await this.client.get(key);
            if (raw !== null) {
                const bytes = Buffer.byteLength(raw, "utf8");
                const maxEntryBytes = this.config.maxEntryBytes ?? 4 * 1024 * 1024;
                if (maxEntryBytes > 0 && bytes > maxEntryBytes) {
                    this.stats.oversizedSkips++;
                    this.stats.misses++;
                    return null;
                }
                const value: unknown = JSON.parse(raw);
                this.stats.hits++;
                this.setMemory(key, value, this.config.memoryTtlSeconds ?? 5, bytes);
                if (this.config.maxCachedEntries > 0) {
                    void this.client.zadd(this.lruIndexKey, Date.now(), key).catch(() => undefined);
                }
                return value;
            }

            if (subCategory === "search" && this.config.fuzzySearchEnabled === true) {
                const fuzzyHit = await this.lookupFuzzy(identifier, namespace);
                if (fuzzyHit) {
                    this.stats.hits++;
                    this.stats.fuzzyHits++;
                    void this.set(subCategory, identifier, fuzzyHit, undefined, namespace).catch(() => undefined);
                    return fuzzyHit;
                }
            }

            this.stats.misses++;
            return null;
        } catch (error) {
            this.stats.errors++;
            console.error(`[DragonflyCache] GET failed: ${error instanceof Error ? error.message : error}`);
            return null;
        }
    }

    private async lookupFuzzy(rawIdentifier: string, namespace: string): Promise<unknown | null> {
        if (!this.client || this.fuzzySearchIndex.length === 0) return null;
        const { prefix, cleanQuery } = normalizeSearchQuery(rawIdentifier);
        if (cleanQuery.length < 5) return null;

        let bestMatch: FuzzyIndexEntry | null = null;
        let bestSimilarity = Math.min(Math.max(this.config.fuzzySearchThreshold ?? 0.9, 0.8), 1);
        for (const entry of this.fuzzySearchIndex) {
            if (namespace !== entry.namespace || prefix !== entry.prefix) continue;
            if (Math.abs(cleanQuery.length - entry.cleanQuery.length) > 4) continue;
            const similarity = calculateSimilarity(cleanQuery, entry.cleanQuery);
            if (similarity >= bestSimilarity) {
                bestSimilarity = similarity;
                bestMatch = entry;
            }
        }
        if (!bestMatch) return null;

        const raw = await this.client.get(this.formatKey("search", bestMatch.rawIdentifier, namespace));
        if (raw === null) {
            this.fuzzySearchIndex = this.fuzzySearchIndex.filter((entry) => entry !== bestMatch);
            this.refreshMemoryStats();
            return null;
        }
        return JSON.parse(raw) as unknown;
    }

    public async set(
        subCategory: string,
        identifier: string,
        data: unknown,
        ttlSeconds?: number,
        namespace = ""
    ): Promise<void> {
        const key = this.formatKey(subCategory, identifier, namespace);
        const ttl = this.ttlFor(subCategory, ttlSeconds);
        let serialized: string | undefined;
        try {
            serialized = JSON.stringify(data);
        } catch (error) {
            this.stats.errors++;
            console.error(`[DragonflyCache] SET serialization failed: ${error instanceof Error ? error.message : error}`);
            return;
        }
        if (serialized === undefined) return;
        const bytes = Buffer.byteLength(serialized, "utf8");
        const maxEntryBytes = this.config.maxEntryBytes ?? 4 * 1024 * 1024;
        if (maxEntryBytes > 0 && bytes > maxEntryBytes) {
            this.stats.oversizedSkips++;
            return;
        }
        this.setMemory(key, data, ttl, bytes);
        if (subCategory === "search" && this.config.fuzzySearchEnabled === true) {
            this.registerFuzzyEntry(identifier, namespace);
        }
        if (!this.isConnected || !this.client || !this.config.enabled) return;

        try {
            const pipeline = this.client.pipeline();
            if (ttl > 0) pipeline.set(key, serialized, "EX", ttl);
            else pipeline.set(key, serialized);
            if (this.config.maxCachedEntries > 0) pipeline.zadd(this.lruIndexKey, Date.now(), key);
            const results = await pipeline.exec();
            const failed = results?.find(([error]) => error);
            if (failed?.[0]) throw failed[0];

            this.stats.writes++;
            if (this.config.maxCachedEntries > 0) {
                const zaddResult = results?.[results.length - 1]?.[1];
                if (typeof zaddResult === "number" && zaddResult > 0) {
                    this.stats.estimatedEntries += zaddResult;
                }
            }
            if (this.config.maxCachedEntries > 0 && ++this.writeCounter % 50 === 0) {
                void this.enforceMaxCachedEntries();
            }
        } catch (error) {
            this.stats.errors++;
            console.error(`[DragonflyCache] SET failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    private registerFuzzyEntry(rawIdentifier: string, namespace: string): void {
        const { prefix, cleanQuery } = normalizeSearchQuery(rawIdentifier);
        if (!prefix || cleanQuery.length < 5) return;
        const existing = this.fuzzySearchIndex.find(
            (entry) => entry.rawIdentifier === rawIdentifier && entry.namespace === namespace
        );
        if (existing) {
            existing.addedAt = Date.now();
            return;
        }
        this.fuzzySearchIndex.push({ namespace, prefix, cleanQuery, rawIdentifier, addedAt: Date.now() });
        if (this.fuzzySearchIndex.length > this.maxFuzzyIndexSize) this.fuzzySearchIndex.shift();
        this.refreshMemoryStats();
    }

    public async del(subCategory: string, identifier: string, namespace = ""): Promise<void> {
        const key = this.formatKey(subCategory, identifier, namespace);
        this.removeMemoryEntry(key);
        this.fuzzySearchIndex = this.fuzzySearchIndex.filter(
            (entry) => entry.rawIdentifier !== identifier || entry.namespace !== namespace
        );
        this.refreshMemoryStats();
        if (!this.isConnected || !this.client || !this.config.enabled) return;
        try {
            const pipeline = this.client.pipeline().unlink(key);
            if (this.config.maxCachedEntries > 0) pipeline.zrem(this.lruIndexKey, key);
            await pipeline.exec();
        } catch (error) {
            this.stats.errors++;
            console.error(`[DragonflyCache] DEL failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    public async clear(): Promise<number> {
        this.memoryCache.clear();
        this.memoryBytes = 0;
        this.fuzzySearchIndex = [];
        this.refreshMemoryStats();
        if (!this.isConnected || !this.client || !this.config.enabled) return 0;

        let deleted = 0;
        for (let pass = 0; pass < 3; pass++) {
            let cursor = "0";
            let deletedThisPass = 0;
            do {
                const [nextCursor, keys] = await this.client.scan(
                    cursor,
                    "MATCH",
                    `${this.config.keyPrefix}:*`,
                    "COUNT",
                    500
                );
                cursor = nextCursor;
                if (keys.length) deletedThisPass += await this.client.unlink(...keys);
            } while (cursor !== "0");
            deleted += deletedThisPass;
            if (deletedThisPass === 0) break;
        }

        this.stats.clears++;
        this.stats.estimatedEntries = 0;
        return deleted;
    }

    private async enforceMaxCachedEntries(): Promise<void> {
        if (this.evictionInFlight || !this.client || !this.isConnected || this.config.maxCachedEntries <= 0) return;
        this.evictionInFlight = true;
        try {
            const total = await this.client.zcard(this.lruIndexKey);
            this.stats.estimatedEntries = total;
            const excess = total - this.config.maxCachedEntries;
            if (excess <= 0) return;

            // Keep each background sweep bounded; never spread tens of thousands of keys into one command.
            const sweepLimit = Math.min(excess, 1000);
            const popped = await this.client.zpopmin(this.lruIndexKey, sweepLimit);
            const keys = popped.filter((_, index) => index % 2 === 0);
            for (let index = 0; index < keys.length; index += 250) {
                await this.client.unlink(...keys.slice(index, index + 250));
            }
            this.stats.evictions += keys.length;
            this.stats.estimatedEntries = Math.max(0, total - keys.length);
        } catch (error) {
            this.stats.errors++;
            console.error(`[DragonflyCache] Eviction failed: ${error instanceof Error ? error.message : error}`);
        } finally {
            this.evictionInFlight = false;
        }
    }

    private async syncEntryCount(): Promise<void> {
        if (!this.client || !this.isConnected || this.config.maxCachedEntries <= 0) return;
        try {
            this.stats.estimatedEntries = await this.client.zcard(this.lruIndexKey);
        } catch {
            // Cache failures are fail-open and are already surfaced by the client error event.
        }
    }

    public async getLearnedRoute(rawIdentifier: string, namespace = ""): Promise<LearnedRoute | null> {
        if (!this.isConnected || !this.client || !this.config.enabled) return null;
        try {
            const raw = await this.client.get(this.formatLearnedRouteKey(rawIdentifier, namespace));
            return raw ? JSON.parse(raw) as LearnedRoute : null;
        } catch {
            return null;
        }
    }

    public async setLearnedRoute(
        rawIdentifier: string,
        route: LearnedRoute,
        ttlSeconds = 1800,
        namespace = ""
    ): Promise<void> {
        if (!this.isConnected || !this.client || !this.config.enabled) return;
        try {
            await this.client.set(this.formatLearnedRouteKey(rawIdentifier, namespace), JSON.stringify(route), "EX", ttlSeconds);
        } catch (error) {
            this.stats.errors++;
            console.error(`[DragonflyCache] Learned-route write failed: ${error instanceof Error ? error.message : error}`);
        }
    }

    public async delLearnedRoute(rawIdentifier: string, namespace = ""): Promise<void> {
        if (!this.isConnected || !this.client || !this.config.enabled) return;
        try {
            await this.client.unlink(this.formatLearnedRouteKey(rawIdentifier, namespace));
        } catch {
            // A stale learned route will expire naturally.
        }
    }

    public async close(): Promise<void> {
        this.isConnected = false;
        if (!this.client) return;
        try {
            await this.client.quit();
        } catch {
            this.client.disconnect(false);
        } finally {
            this.client = null;
        }
    }
}
