import { describe, it, expect } from "bun:test";
import { resolveYtmToDeezerBridge, applySourceMasking, extractRequestedSource } from "./searchBridge";
import type { LavalinkLoadResult, LavalinkTrack } from "../types";

function createTrack(title: string, author: string, sourceName: string = "deezer", opts: { albumName?: string } = {}): LavalinkTrack {
    return {
        encoded: "test-encoded-token",
        info: {
            identifier: "track-123",
            isSeekable: true,
            author,
            length: 215000,
            isStream: false,
            position: 0,
            title,
            uri: "https://example.com/track",
            artworkUrl: "https://example.com/art.jpg",
            isrc: "US1234567890",
            sourceName,
        },
        pluginInfo: opts.albumName ? { albumName: opts.albumName } : {},
        userData: {},
    };
}

describe("Search Bridge Engine (YTM -> Deezer)", () => {
    it("extracts requested source correctly", () => {
        expect(extractRequestedSource("dzsearch:it's raining men")).toBe("deezer");
        expect(extractRequestedSource("spsearch:it's raining men")).toBe("spotify");
        expect(extractRequestedSource("ytsearch:it's raining men")).toBe("youtube");
        expect(extractRequestedSource("ytmsearch:it's raining men")).toBe("youtube");
        expect(extractRequestedSource("scsearch:it's raining men")).toBe("soundcloud");
    });

    it("bridges dzsearch query via YTM and resolves authentic Deezer track", async () => {
        const mockUpstream = async (identifier: string): Promise<LavalinkLoadResult | null> => {
            if (identifier.startsWith("ytmsearch:")) {
                return {
                    loadType: "search",
                    data: [
                        createTrack("It's Raining Men (Single Version)", "The Weather Girls", "youtube"),
                    ],
                };
            }
            if (identifier.startsWith("dzsearch:")) {
                // When queried with targeted "The Weather Girls - It's Raining Men", Deezer returns authentic track
                return {
                    loadType: "search",
                    data: [
                        createTrack("It's Raining Men", "The Weather Girls", "deezer", { albumName: "Success" }),
                        createTrack("It's Raining Men", "The Mega Band", "deezer"),
                    ],
                };
            }
            return null;
        };

        const bridge = await resolveYtmToDeezerBridge("dzsearch:it's raining men", mockUpstream);
        expect(bridge.success).toBe(true);
        expect(bridge.finalTarget).toBe("deezer");
        expect(bridge.intermediateResultTitle).toBe("The Weather Girls - It's Raining Men (Single Version)");
        expect(bridge.intermediateQuery).toBe("dzsearch:The Weather Girls - It's Raining Men");

        const tracks = bridge.result?.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("The Weather Girls");
        expect(tracks[0].pluginInfo?.bridgedFrom).toBe("ytmsearch:it's raining men");
        expect(tracks[0].pluginInfo?.actualSource).toBe("deezer");
    });

    it("falls back to YouTube Music if Deezer resolution fails or is empty", async () => {
        const mockUpstream = async (identifier: string): Promise<LavalinkLoadResult | null> => {
            if (identifier.startsWith("ytmsearch:")) {
                return {
                    loadType: "search",
                    data: [
                        createTrack("Super Rare Track", "Underground Artist", "youtube"),
                    ],
                };
            }
            if (identifier.startsWith("dzsearch:")) {
                // Deezer has no match
                return { loadType: "empty", data: {} as any };
            }
            return null;
        };

        const bridge = await resolveYtmToDeezerBridge("dzsearch:super rare track", mockUpstream);
        expect(bridge.success).toBe(true);
        expect(bridge.finalTarget).toBe("youtube");

        const tracks = bridge.result?.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Underground Artist");
        expect(tracks[0].pluginInfo?.actualSource).toBe("youtube");
        expect(tracks[0].pluginInfo?.bridgeFallback).toBe(true);
    });

    it("applies source masking to preserve client requested source while embedding true backend", () => {
        const loadResult: LavalinkLoadResult = {
            loadType: "search",
            data: [
                createTrack("It's Raining Men", "The Weather Girls", "youtube"),
            ],
        };

        const masked = applySourceMasking(loadResult, "dzsearch:it's raining men", true);
        const tracks = masked.data as LavalinkTrack[];

        expect(tracks[0].info.sourceName).toBe("deezer"); // Masked to match dzsearch
        expect(tracks[0].pluginInfo?.actualSource).toBe("youtube"); // Real playback engine preserved
        expect(tracks[0].pluginInfo?.originalRequestedSource).toBe("deezer");
        expect(tracks[0].pluginInfo?.isSourceMasked).toBe(true);
    });

    it("re-ranks YTM intermediate pool to pick Elton John over Taron Egerton OST for 'i\\'m still standing'", async () => {
        const mockUpstream = async (identifier: string): Promise<LavalinkLoadResult | null> => {
            if (identifier.startsWith("ytmsearch:")) {
                // YTM raw list has viral Rocketman OST as index 0, Elton John as index 1
                return {
                    loadType: "search",
                    data: [
                        createTrack("I'm Still Standing (From \"Rocketman\" Soundtrack)", "Taron Egerton", "youtube", { albumName: "Rocketman OST" }),
                        createTrack("I'm Still Standing", "Elton John", "youtube", { albumName: "Too Low For Zero" }),
                    ],
                };
            }
            if (identifier.startsWith("dzsearch:Elton John - I'm Still Standing")) {
                return {
                    loadType: "search",
                    data: [
                        createTrack("I'm Still Standing", "Elton John", "deezer", { albumName: "Too Low For Zero" }),
                    ],
                };
            }
            return null;
        };

        const bridge = await resolveYtmToDeezerBridge("dzsearch:i'm still standing", mockUpstream);
        expect(bridge.success).toBe(true);
        expect(bridge.finalTarget).toBe("deezer");
        expect(bridge.intermediateResultTitle).toBe("Elton John - I'm Still Standing");
        expect(bridge.intermediateQuery).toBe("dzsearch:Elton John - I'm Still Standing");

        const tracks = bridge.result?.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Elton John");
    });

    it("bridges spsearch query with homophone normalization ('loose yourself' -> Eminem)", async () => {
        let searchedYtmQuery = "";
        const mockUpstream = async (identifier: string): Promise<LavalinkLoadResult | null> => {
            if (identifier.startsWith("ytmsearch:")) {
                searchedYtmQuery = identifier;
                return {
                    loadType: "search",
                    data: [
                        createTrack("Lose Yourself", "Eminem", "youtube", { albumName: "8 Mile" }),
                    ],
                };
            }
            if (identifier.startsWith("dzsearch:Eminem - Lose Yourself")) {
                return {
                    loadType: "search",
                    data: [
                        createTrack("Lose Yourself", "Eminem", "deezer", { albumName: "Curtain Call" }),
                    ],
                };
            }
            return null;
        };

        const bridge = await resolveYtmToDeezerBridge("spsearch:loose yourself", mockUpstream);
        expect(searchedYtmQuery).toBe("ytmsearch:lose yourself");
        expect(bridge.success).toBe(true);
        expect(bridge.finalTarget).toBe("deezer");

        // Apply source masking as proxy would
        const masked = applySourceMasking(bridge.result!, "spsearch:loose yourself", true);
        const tracks = masked.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Eminem");
        expect(tracks[0].info.sourceName).toBe("spotify");
        expect(tracks[0].pluginInfo?.actualSource).toBe("deezer");
        expect(tracks[0].pluginInfo?.originalRequestedSource).toBe("spotify");
        expect(tracks[0].pluginInfo?.isSourceMasked).toBe(true);
    });

    it("bridges spsearch:no diggity avoiding Deezer brass band trap", async () => {
        const mockUpstream = async (identifier: string): Promise<LavalinkLoadResult | null> => {
            if (identifier.startsWith("ytmsearch:")) {
                return {
                    loadType: "search",
                    data: [
                        createTrack("No Diggity (feat. Dr. Dre, Queen Pen)", "Blackstreet", "youtube", { albumName: "Another Level" }),
                    ],
                };
            }
            if (identifier.startsWith("dzsearch:Blackstreet - No Diggity")) {
                return {
                    loadType: "search",
                    data: [
                        createTrack("No Diggity", "Blackstreet", "deezer", { albumName: "Another Level" }),
                        createTrack("No Diggity", "High & Mighty Brass Band", "deezer"),
                    ],
                };
            }
            return null;
        };

        const bridge = await resolveYtmToDeezerBridge("spsearch:no diggity", mockUpstream);
        expect(bridge.success).toBe(true);
        expect(bridge.finalTarget).toBe("deezer");

        const masked = applySourceMasking(bridge.result!, "spsearch:no diggity", true);
        const tracks = masked.data as LavalinkTrack[];
        expect(tracks[0].info.author).toBe("Blackstreet");
        expect(tracks[0].info.sourceName).toBe("spotify");
        expect(tracks[0].pluginInfo?.actualSource).toBe("deezer");
    });
});
