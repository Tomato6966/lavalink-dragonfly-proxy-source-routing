import { describe, expect, it } from "bun:test";
import {
    buildTrack,
    buildTrackInfo,
    buildSearchResult,
    buildPlaylistResult,
    buildEmptyResult,
    buildErrorResult,
    createFallbackTrack,
} from "./index";

describe("Lavalink v4 Response Builders", () => {
    it("should build track info correctly", () => {
        const info = buildTrackInfo({
            title: "Rolling in the Deep",
            author: "Adele",
            length: 228000,
            uri: "https://deezer.com/track/123",
            sourceName: "deezer",
        });

        expect(info.title).toBe("Rolling in the Deep");
        expect(info.author).toBe("Adele");
        expect(info.length).toBe(228000);
        expect(info.sourceName).toBe("deezer");
        expect(info.isSeekable).toBe(true);
    });

    it("should create fallback track cleanly", () => {
        const track = createFallbackTrack("Hello", "Adele", "https://deezer.com/track/456", 295000, "deezer");
        expect(track.info.title).toBe("Hello");
        expect(track.encoded).toBe("CUSTOM_TRACK_ENCODED");
    });

    it("should build search result", () => {
        const track = createFallbackTrack("Song A", "Artist A");
        const search = buildSearchResult([track]);
        expect(search.loadType).toBe("search");
        expect(search.data.length).toBe(1);
    });

    it("should build playlist result", () => {
        const track = createFallbackTrack("Song B", "Artist B");
        const playlist = buildPlaylistResult("My Hits", [track]);
        expect(playlist.loadType).toBe("playlist");
        expect(playlist.data.info.name).toBe("My Hits");
        expect(playlist.data.tracks.length).toBe(1);
    });

    it("should build empty and error results", () => {
        const empty = buildEmptyResult();
        expect(empty.loadType).toBe("empty");

        const error = buildErrorResult("Video restricted", "common", "Geoblock");
        expect(error.loadType).toBe("error");
        expect(error.data.message).toBe("Video restricted");
        expect(error.data.severity).toBe("common");
    });
});
