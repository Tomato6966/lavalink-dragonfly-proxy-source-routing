import type { LavalinkLoadResult } from "../types";

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTrack(value: unknown): boolean {
    return isRecord(value) && typeof value.encoded === "string" && isRecord(value.info);
}

/** Validate the discriminated Lavalink v4 load-result shape before reading nested fields. */
export function isLavalinkLoadResult(value: unknown): value is LavalinkLoadResult {
    if (!isRecord(value) || typeof value.loadType !== "string") return false;

    switch (value.loadType) {
        case "track":
            return isTrack(value.data);
        case "search":
            return Array.isArray(value.data) && value.data.every(isTrack);
        case "playlist":
            return isRecord(value.data) && isRecord(value.data.info) &&
                Array.isArray(value.data.tracks) && value.data.tracks.every(isTrack);
        case "empty":
            return isRecord(value.data);
        case "error":
            return isRecord(value.data) && typeof value.data.message === "string" &&
                ["common", "suspicious", "fault"].includes(String(value.data.severity));
        default:
            return false;
    }
}

function hasPlayableEncoding(track: unknown): boolean {
    if (!isRecord(track)) return false;
    return typeof track.encoded === "string" && track.encoded.length > 8 &&
        track.encoded !== "CUSTOM_TRACK_ENCODED";
}

export function isPlayableLoadResult(value: unknown): value is LavalinkLoadResult {
    if (!isLavalinkLoadResult(value)) return false;
    if (value.loadType === "track") return hasPlayableEncoding(value.data);
    if (value.loadType === "search") return value.data.length > 0 && value.data.every(hasPlayableEncoding);
    if (value.loadType === "playlist") {
        return value.data.tracks.length > 0 && value.data.tracks.every(hasPlayableEncoding);
    }
    return false;
}
