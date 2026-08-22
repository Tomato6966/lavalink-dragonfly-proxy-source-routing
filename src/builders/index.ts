import type {
    LavalinkTrack,
    LavalinkTrackInfo,
    LavalinkSearchResult,
    LavalinkPlaylistResult,
    LavalinkTrackResult,
    LavalinkEmptyResult,
    LavalinkErrorResult,
} from "../types";

export function buildTrackInfo(
    options: Partial<LavalinkTrackInfo> & { title: string; author: string }
): LavalinkTrackInfo {
    return {
        identifier: options.identifier || `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        isSeekable: options.isSeekable ?? true,
        author: options.author,
        length: options.length ?? 180000,
        isStream: options.isStream ?? false,
        position: options.position ?? 0,
        title: options.title,
        uri: options.uri ?? null,
        artworkUrl: options.artworkUrl ?? null,
        isrc: options.isrc ?? null,
        sourceName: options.sourceName ?? "custom",
    };
}

/** Build a track only from an encoded value produced by a compatible backend. */
export function buildTrack(
    info: LavalinkTrackInfo,
    encoded: string,
    pluginInfo: Record<string, unknown> = {},
    userData: Record<string, unknown> = {}
): LavalinkTrack {
    if (!encoded || encoded === "CUSTOM_TRACK_ENCODED") {
        throw new TypeError("encoded must be a real track returned by Lavalink/NodeLink");
    }
    return { encoded, info, pluginInfo, userData };
}

/** Convenience builder for workers that already received a real encoded value. */
export function createFallbackTrack(
    encoded: string,
    title: string,
    author: string,
    uri = "https://mivator.com",
    lengthMs = 200000,
    sourceName = "custom",
    artworkUrl?: string
): LavalinkTrack {
    return buildTrack(buildTrackInfo({
        title,
        author,
        uri,
        length: lengthMs,
        sourceName,
        artworkUrl: artworkUrl ?? null,
    }), encoded);
}

export function buildSearchResult(tracks: LavalinkTrack[]): LavalinkSearchResult {
    return { loadType: "search", data: tracks };
}

export function buildSingleTrackResult(track: LavalinkTrack): LavalinkTrackResult {
    return { loadType: "track", data: track };
}

export function buildPlaylistResult(
    name: string,
    tracks: LavalinkTrack[],
    selectedTrack = 0,
    pluginInfo?: Record<string, unknown>
): LavalinkPlaylistResult {
    return {
        loadType: "playlist",
        data: {
            info: { name, selectedTrack },
            pluginInfo,
            tracks,
        },
    };
}

export function buildEmptyResult(): LavalinkEmptyResult {
    return { loadType: "empty", data: {} };
}

export function buildErrorResult(
    message: string,
    severity: "common" | "suspicious" | "fault" = "fault",
    cause?: string
): LavalinkErrorResult {
    return { loadType: "error", data: { message, severity, cause } };
}
