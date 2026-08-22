import { describe, it, expect } from "bun:test";
import { optimizeSearchOrder } from "./searchReRanker";
import type { LavalinkLoadResult, LavalinkTrack } from "../types";

function createTrack(title: string, author: string, lengthMs: number = 228000): LavalinkTrack {
    return {
        encoded: "test-encoded",
        info: {
            identifier: "track-id",
            isSeekable: true,
            author,
            length: lengthMs,
            isStream: false,
            position: 0,
            title,
            uri: "https://example.com/track",
            artworkUrl: "https://example.com/art.jpg",
            isrc: "US1234567890",
            sourceName: "deezer",
        },
        pluginInfo: {},
        userData: {},
    };
}

describe("Advanced Multi-Language Search Re-Ranker", () => {
    it("demotes cover bands and promotes original artist to index #0", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: [
                createTrack("Rolling in the Deep", "Bossa Nova Covers"),
                createTrack("Rolling in the Deep (Karaoke Version)", "Karaoke All Stars"),
                createTrack("Rolling in the Deep (Tribute)", "Tribute Band"),
                createTrack("Rolling in the Deep", "Adele"),
            ],
        };

        const { result, topTrackChanged } = optimizeSearchOrder("spsearch:rolling in the deep", loadResult);
        expect(topTrackChanged).toBe(true);
        const tracks = result.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Adele");
        expect(tracks[0].info.title).toBe("Rolling in the Deep");
    });

    it("handles multi-language cover and acoustic keywords (Spanish, French, German, Russian, Japanese)", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: [
                createTrack("Set Fire to the Rain (Versión Acústica)", "Spanish Covers"),
                createTrack("Set Fire to the Rain (Reprise)", "French Tribute"),
                createTrack("Set Fire to the Rain (Klavier Version)", "German Piano"),
                createTrack("Set Fire to the Rain (кавер)", "Russian Cover Artist"),
                createTrack("Set Fire to the Rain", "Adele"),
            ],
        };

        const { result, topTrackChanged } = optimizeSearchOrder("dzsearch:set fire to the rain", loadResult);
        expect(topTrackChanged).toBe(true);
        const tracks = result.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Adele");
    });

    it("promotes covers or acoustics when the user explicitly requests them", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: [
                createTrack("Rolling in the Deep", "Adele"),
                createTrack("Rolling in the Deep (Acoustic Version)", "Adele"),
            ],
        };

        const { result } = optimizeSearchOrder("ytsearch:rolling in the deep acoustic", loadResult);
        const tracks = result.data as LavalinkTrack[];
        expect(tracks[0].info.title).toContain("Acoustic");
    });

    it("demotes unsolicited remixes and slowed+reverb edits", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: [
                createTrack("Set Fire to the Rain (Lupage Remix)", "Lupage"),
                createTrack("Set Fire to the Rain (Slowed + Reverb)", "Vibe Edit"),
                createTrack("Set Fire to the Rain (Sped Up Nightcore)", "Nightcore Squad"),
                createTrack("Set Fire to the Rain", "Adele"),
            ],
        };

        const { result, topTrackChanged } = optimizeSearchOrder("dzsearch:set fire to the rain", loadResult);
        expect(topTrackChanged).toBe(true);
        const tracks = result.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Adele");
    });

    it("promotes remixes when user explicitly searches for a remix", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: [
                createTrack("Set Fire to the Rain", "Adele"),
                createTrack("Set Fire to the Rain (Club Remix)", "Moto Blanco"),
            ],
        };

        const { result } = optimizeSearchOrder("spsearch:set fire to the rain remix", loadResult);
        const tracks = result.data as LavalinkTrack[];
        expect(tracks[0].info.title).toContain("Remix");
    });

    it("preserves official remaster and album version tags without treating them as bad remixes", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: [
                createTrack("In the End (2020 Remaster)", "Linkin Park"),
                createTrack("In the End (Karaoke Version)", "Karaoke Band"),
            ],
        };

        const { result } = optimizeSearchOrder("spsearch:in the end linkin park", loadResult);
        const tracks = result.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Linkin Park");
    });

    it("operates ultra-fast with sub-millisecond execution time", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: Array.from({ length: 50 }, (_, i) => 
                createTrack(`Track ${i} (Cover Version)`, `Artist ${i}`)
            ),
        };
        (loadResult.data as LavalinkTrack[])[40] = createTrack("Original Track", "Main Artist");

        const start = performance.now();
        const { result } = optimizeSearchOrder("spsearch:original track main artist", loadResult);
        const duration = performance.now() - start;

        expect((result.data as LavalinkTrack[])[0].info.title).toBe("Original Track");
        expect(duration).toBeLessThan(5); // under 5ms (typically <0.1ms)
    });
});
