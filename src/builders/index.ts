import type {
    LavalinkTrack,
    LavalinkTrackInfo,
    LavalinkSearchResult,
    LavalinkPlaylistResult,
    LavalinkTrackResult,
    LavalinkEmptyResult,
    LavalinkErrorResult,
} from "../types";

/**
 * Construct a type-safe Lavalink v4 TrackInfo object
 */
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

/**
 * Construct a type-safe Lavalink v4 Track
 */
export function buildTrack(
    info: LavalinkTrackInfo,
    encoded: string = "CUSTOM_TRACK_ENCODED",
    pluginInfo: Record<string, any> = {},
    userData: Record<string, any> = {}
): LavalinkTrack {
    return {
        encoded,
        info,
        pluginInfo,
        userData,
    };
}

/**
 * Create a quick track from basic metadata
 */
export function createFallbackTrack(
    title: string,
    author: string,
    uri: string = "https://mivator.com",
    lengthMs: number = 200000,
    sourceName: string = "custom",
    artworkUrl?: string
): LavalinkTrack {
    const info = buildTrackInfo({
        title,
        author,
        uri,
        length: lengthMs,
        sourceName,
        artworkUrl: artworkUrl ?? null,
    });
    return buildTrack(info);
}

/**
 * Construct a Lavalink v4 Search Result
 */
export function buildSearchResult(
    tracks: LavalinkTrack[],
    pluginInfo?: Record<string, any>
): LavalinkSearchResult {
    return {
        loadType: "search",
        data: tracks,
    };
}

/**
 * Construct a Lavalink v4 Single Track Result
 */
export function buildSingleTrackResult(track: LavalinkTrack): LavalinkTrackResult {
    return {
        loadType: "track",
        data: track,
    };
}

/**
 * Construct a Lavalink v4 Playlist Result
 */
export function buildPlaylistResult(
    name: string,
    tracks: LavalinkTrack[],
    selectedTrack: number = 0,
    pluginInfo?: Record<string, any>
): LavalinkPlaylistResult {
    return {
        loadType: "playlist",
        data: {
            info: {
                name,
                selectedTrack,
            },
            pluginInfo,
            tracks,
        },
    };
}

/**
 * Construct a Lavalink v4 Empty Result
 */
export function buildEmptyResult(): LavalinkEmptyResult {
    return {
        loadType: "empty",
        data: {},
    };
}

/**
 * Construct a Lavalink v4 Error Result
 */
export function buildErrorResult(
    message: string,
    severity: "common" | "suspicious" | "fault" = "fault",
    cause?: string
): LavalinkErrorResult {
    return {
        loadType: "error",
        data: {
            message,
            severity,
            cause,
        },
    };
}
