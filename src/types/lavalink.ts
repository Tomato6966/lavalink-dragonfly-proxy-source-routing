/**
 * Lavalink v4 Protocol Types & Schemas
 */

export interface LavalinkTrackInfo {
    identifier: string;
    isSeekable: boolean;
    author: string;
    length: number;
    isStream: boolean;
    position: number;
    title: string;
    uri?: string | null;
    artworkUrl?: string | null;
    isrc?: string | null;
    sourceName: string;
}

export interface LavalinkTrack {
    encoded: string;
    info: LavalinkTrackInfo;
    pluginInfo?: Record<string, any>;
    userData?: Record<string, any>;
}

export interface LavalinkPlaylistInfo {
    name: string;
    selectedTrack?: number;
}

export interface LavalinkPlaylistData {
    info: LavalinkPlaylistInfo;
    pluginInfo?: Record<string, any>;
    tracks: LavalinkTrack[];
}

export interface LavalinkException {
    message: string;
    severity: "common" | "suspicious" | "fault";
    cause?: string;
}

export interface LavalinkTrackResult {
    loadType: "track";
    data: LavalinkTrack;
}

export interface LavalinkPlaylistResult {
    loadType: "playlist";
    data: LavalinkPlaylistData;
}

export interface LavalinkSearchResult {
    loadType: "search";
    data: LavalinkTrack[];
}

export interface LavalinkEmptyResult {
    loadType: "empty";
    data: Record<string, never>;
}

export interface LavalinkErrorResult {
    loadType: "error";
    data: LavalinkException;
}

export type LavalinkLoadResult =
    | LavalinkTrackResult
    | LavalinkPlaylistResult
    | LavalinkSearchResult
    | LavalinkEmptyResult
    | LavalinkErrorResult;
