import { describe, expect, it } from "bun:test";
import {
    calculateLevenshteinDistance,
    calculateSimilarity,
    canonicalizeCacheIdentifier,
    DragonflyCacheManager,
    normalizeSearchQuery,
} from "./index";
import { extractYouTubeVideoId } from "../transformers";

describe("cache key safety and fuzzy matching", () => {
    it("calculates exact and typo similarity", () => {
        const canonical = normalizeSearchQuery("dzsearch:sweet dreams are made of these").cleanQuery;
        const typo = normalizeSearchQuery("dzsearch:swwet dreams are nade of these").cleanQuery;
        expect(calculateLevenshteinDistance(canonical, typo)).toBe(2);
        expect(calculateSimilarity(canonical, typo)).toBeGreaterThanOrEqual(0.85);
    });

    it("does not collapse a materially different query", () => {
        const original = normalizeSearchQuery("dzsearch:sweet dreams are made of these").cleanQuery;
        const targeted = normalizeSearchQuery("dzsearch:sweet dreams are made of these by marilyn manson").cleanQuery;
        expect(calculateSimilarity(original, targeted)).toBeLessThan(0.7);
    });

    it("preserves case-sensitive direct identifiers", () => {
        expect(canonicalizeCacheIdentifier("track", "qeMFqkcPYcg"))
            .not.toBe(canonicalizeCacheIdentifier("track", "QEmFQKCpyCG"));
    });

    it("normalizes only search text and keeps source prefixes distinct", () => {
        expect(canonicalizeCacheIdentifier("search", "YTSEARCH:  Hello,   WORLD! ")).toBe("ytsearch:hello world");
        expect(normalizeSearchQuery("ytsearch:hello world").prefix).not.toBe(
            normalizeSearchQuery("dzsearch:hello world").prefix
        );
    });

    it("canonicalizes Spotify resource type and ID without network access", () => {
        const id = "4uLU6hMCjMI75M1A2tKUQC";
        expect(canonicalizeCacheIdentifier("track", `https://open.spotify.com/track/${id}?si=test`))
            .toBe(`spotify:track:${id}`);
    });

    it("extracts case-sensitive YouTube video IDs from supported URL formats", () => {
        const id = "qeMFqkcPYcg";
        expect(extractYouTubeVideoId(`https://music.youtube.com/watch?v=${id}`)).toBe(id);
        expect(extractYouTubeVideoId(`https://youtu.be/${id}`)).toBe(id);
        expect(extractYouTubeVideoId(`https://youtube.com/shorts/${id}`)).toBe(id);
    });

    it("bounds L1 memory and skips oversized serialized entries", async () => {
        const cache = new DragonflyCacheManager({
            enabled: false,
            url: "redis://127.0.0.1:6379",
            keyPrefix: "test",
            searchTtlSeconds: 60,
            trackTtlSeconds: 60,
            lyricsTtlSeconds: 60,
            maxCachedEntries: 0,
            memoryMaxEntries: 10,
            memoryMaxBytes: 64,
            maxEntryBytes: 64,
            memoryTtlSeconds: 5,
        });

        await cache.set("search", "ytsearch:oversized", "x".repeat(100));
        expect(cache.stats.oversizedSkips).toBe(1);
        expect(cache.stats.memoryEntries).toBe(0);

        await cache.set("search", "ytsearch:first", { value: "a".repeat(30) });
        await cache.set("search", "ytsearch:second", { value: "b".repeat(30) });
        expect(cache.stats.memoryEntries).toBeLessThanOrEqual(1);
        expect(cache.stats.memoryBytes).toBeLessThanOrEqual(64);
        expect(cache.stats.memoryEvictions).toBeGreaterThanOrEqual(1);
        await cache.close();
    });

    it("keeps the hot L1 cache active without a Dragonfly connection", async () => {
        const cache = new DragonflyCacheManager({
            enabled: false,
            url: "redis://127.0.0.1:6379",
            keyPrefix: "test",
            searchTtlSeconds: 60,
            trackTtlSeconds: 60,
            lyricsTtlSeconds: 60,
            maxCachedEntries: 0,
            memoryMaxEntries: 10,
            memoryTtlSeconds: 5,
        });
        await cache.set("search", "ytsearch:l1 cache", { cached: true }, undefined, "lavalink-main");

        expect(await cache.get("search", "ytsearch:l1 cache", "lavalink-main")).toEqual({ cached: true });
        expect(cache.stats.memoryHits).toBe(1);
        await cache.close();
    });
});
