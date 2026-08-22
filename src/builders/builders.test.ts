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

const ENCODED = "QAAAWgMABFRlc3QABkFydGlzdAAAAAAAAtMAAAALdGVzdF90cmFjawEAE2h0dHBzOi8vZXhhbXBsZS5jb20BAAZjdXN0b20AAAAAAAAAAA";

describe("Lavalink v4 response builders", () => {
    it("builds track info with protocol defaults", () => {
        const info = buildTrackInfo({ title: "Rolling in the Deep", author: "Adele", length: 228000 });
        expect(info.title).toBe("Rolling in the Deep");
        expect(info.length).toBe(228000);
        expect(info.isSeekable).toBe(true);
    });

    it("requires a real backend-produced encoded track", () => {
        const info = buildTrackInfo({ title: "Hello", author: "Adele" });
        expect(buildTrack(info, ENCODED).encoded).toBe(ENCODED);
        expect(() => buildTrack(info, "CUSTOM_TRACK_ENCODED")).toThrow();
    });

    it("creates fallback tracks only when encoding is supplied", () => {
        const track = createFallbackTrack(ENCODED, "Hello", "Adele", "https://deezer.com/track/456", 295000, "deezer");
        expect(track.info.title).toBe("Hello");
        expect(track.encoded).toBe(ENCODED);
    });

    it("builds search and playlist results", () => {
        const track = createFallbackTrack(ENCODED, "Song A", "Artist A");
        expect(buildSearchResult([track]).data).toHaveLength(1);
        expect(buildPlaylistResult("My Hits", [track]).data.info.name).toBe("My Hits");
    });

    it("builds empty and error results", () => {
        expect(buildEmptyResult().loadType).toBe("empty");
        const error = buildErrorResult("Video restricted", "common", "Geoblock");
        expect(error.data.message).toBe("Video restricted");
        expect(error.data.severity).toBe("common");
    });
});
