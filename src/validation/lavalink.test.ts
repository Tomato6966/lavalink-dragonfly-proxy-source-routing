import { describe, expect, it } from "bun:test";
import { isLavalinkLoadResult, isPlayableLoadResult } from "./lavalink";

const playableTrack = {
    encoded: "real_backend_encoded_track",
    info: {},
};

describe("Lavalink load-result validation", () => {
    it("accepts structurally valid backend results", () => {
        expect(isLavalinkLoadResult({ loadType: "track", data: playableTrack })).toBe(true);
        expect(isPlayableLoadResult({ loadType: "search", data: [playableTrack] })).toBe(true);
    });

    it("rejects malformed nested discriminated values", () => {
        expect(isLavalinkLoadResult(null)).toBe(false);
        expect(isLavalinkLoadResult({ loadType: "search", data: null })).toBe(false);
        expect(isLavalinkLoadResult({ loadType: "playlist", data: { info: {}, tracks: null } })).toBe(false);
    });

    it("keeps structural validity separate from playable encoded tracks", () => {
        expect(isLavalinkLoadResult({ loadType: "empty", data: {} })).toBe(true);
        expect(isPlayableLoadResult({ loadType: "empty", data: {} })).toBe(false);
        expect(isPlayableLoadResult({ loadType: "track", data: { ...playableTrack, encoded: "CUSTOM_TRACK_ENCODED" } })).toBe(false);
    });
});
