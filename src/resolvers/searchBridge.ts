import type { LavalinkLoadResult, LavalinkTrack } from "../types";
import { optimizeSearchOrder, normalizeMusicHomophones } from "../transformers/searchReRanker";

export interface BridgeContext {
    rawIdentifier: string;
    executeUpstreamSearch: (identifier: string) => Promise<LavalinkLoadResult | null>;
    timeoutMs?: number;
}

export interface BridgeResult {
    result: LavalinkLoadResult | null;
    bridgedFrom: string;
    intermediateQuery: string;
    intermediateResultTitle?: string;
    finalTarget: "deezer" | "youtube" | "none";
    success: boolean;
}

/**
 * Extract clean search term without prefixes
 */
function cleanQueryTerm(query: string): string {
    return query
        .replace(/^(?:dzsearch|spsearch|ytsearch|ytmsearch|scsearch|amsearch|search):/i, "")
        .trim();
}

/**
 * Clean artist and title for targeted downstream resolution
 */
function buildTargetedQuery(track: LavalinkTrack): string {
    const author = (track.info.author || "")
        .replace(/\s*-\s*Topic$/i, "")
        .replace(/\s*[([]?\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[)\]]?/gi, "")
        .replace(/\s*,\s*.*$/i, "")
        .trim();

    const title = (track.info.title || "")
        .replace(/\s*[([](?:official|audio|video|music\s*video|lyrics?\s*(?:video)?|hd|hq|4k|single\s*version|from\s+[^)\]]+|soundtrack)[^)\]]*[)\]]/gi, "")
        .replace(/\s*-\s*(?:single|from\s+.*|soundtrack.*)$/i, "")
        .trim();

    if (author && title) {
        return `${author} - ${title}`;
    }
    return title || author;
}

/**
 * Check if a Lavalink result contains playable tracks
 */
function hasPlayableTracks(res: LavalinkLoadResult | null): boolean {
    if (!res) return false;
    if (res.loadType === "search") {
        return Array.isArray(res.data) && res.data.length > 0 && Boolean(res.data[0]?.encoded);
    }
    if (res.loadType === "playlist") {
        const tracks = (res.data as any)?.tracks;
        return Array.isArray(tracks) && tracks.length > 0 && Boolean(tracks[0]?.encoded);
    }
    if (res.loadType === "track") {
        return Boolean((res.data as any)?.encoded);
    }
    return false;
}

/**
 * Intelligent YouTube Music -> Deezer Search Bridge
 * 
 * 1. Normalizes music homophones and queries YouTube Music (`ytmsearch:<query>`) for authoritative metadata.
 * 2. Runs middle-stage candidate re-ranking on the YTM pool to select the authentic canonical studio master.
 * 3. Issues a targeted search to Deezer (`dzsearch:Artist - Title`).
 * 4. If Deezer succeeds -> returns authentic Deezer audio.
 * 5. If Deezer fails/empty -> seamlessly falls back to the top YouTube Music audio candidate!
 */
export async function resolveYtmToDeezerBridge(
    rawQuery: string,
    executeUpstreamSearch: (identifier: string) => Promise<LavalinkLoadResult | null>
): Promise<BridgeResult> {
    const rawClean = cleanQueryTerm(rawQuery);
    const cleanQuery = normalizeMusicHomophones(rawClean);
    if (!cleanQuery) {
        return {
            result: null,
            bridgedFrom: rawQuery,
            intermediateQuery: "",
            finalTarget: "none",
            success: false,
        };
    }

    const ytmIdentifier = `ytmsearch:${cleanQuery}`;

    // Step 1: Query YouTube Music
    let ytmResult = await executeUpstreamSearch(ytmIdentifier);
    if (!hasPlayableTracks(ytmResult)) {
        // Fallback to standard ytsearch if ytmsearch is empty
        ytmResult = await executeUpstreamSearch(`ytsearch:${cleanQuery}`);
    }

    if (!hasPlayableTracks(ytmResult) || !ytmResult) {
        return {
            result: null,
            bridgedFrom: ytmIdentifier,
            intermediateQuery: "",
            finalTarget: "none",
            success: false,
        };
    }

    // Step 2: Re-rank YouTube Music candidates to pick the top authentic artist & title
    const reRankedYtm = optimizeSearchOrder(rawQuery, ytmResult);
    const topYtmTrack = (reRankedYtm.result.loadType === "search"
        ? (reRankedYtm.result.data as LavalinkTrack[])[0]
        : (reRankedYtm.result.data as any)?.tracks?.[0]) as LavalinkTrack | undefined;

    if (!topYtmTrack) {
        return {
            result: reRankedYtm.result,
            bridgedFrom: ytmIdentifier,
            intermediateQuery: "",
            finalTarget: "youtube",
            success: true,
        };
    }

    // Step 3: Build targeted query for Deezer
    const targetedQuery = buildTargetedQuery(topYtmTrack);
    const dzIdentifier = `dzsearch:${targetedQuery}`;

    // Step 4: Resolve on Deezer
    const dzResult = await executeUpstreamSearch(dzIdentifier);

    if (hasPlayableTracks(dzResult) && dzResult) {
        // Step 5: Deezer resolution succeeded!
        const reRankedDz = optimizeSearchOrder(dzIdentifier, dzResult);
        const tracks = reRankedDz.result.loadType === "search"
            ? (reRankedDz.result.data as LavalinkTrack[])
            : ((reRankedDz.result.data as any)?.tracks as LavalinkTrack[] || []);

        tracks.forEach((track) => {
            track.pluginInfo = {
                ...track.pluginInfo,
                bridgedFrom: ytmIdentifier,
                bridgedQuery: targetedQuery,
                bridgedIntermediate: `${topYtmTrack.info.author} - ${topYtmTrack.info.title}`,
                actualSource: track.info.sourceName || "deezer",
            };
        });

        return {
            result: reRankedDz.result,
            bridgedFrom: ytmIdentifier,
            intermediateQuery: dzIdentifier,
            intermediateResultTitle: `${topYtmTrack.info.author} - ${topYtmTrack.info.title}`,
            finalTarget: "deezer",
            success: true,
        };
    }

    // Step 6: Deezer resolution failed or was empty -> fallback to YouTube Music audio
    const ytmTracks = reRankedYtm.result.loadType === "search"
        ? (reRankedYtm.result.data as LavalinkTrack[])
        : ((reRankedYtm.result.data as any)?.tracks as LavalinkTrack[] || []);

    ytmTracks.forEach((track) => {
        track.pluginInfo = {
            ...track.pluginInfo,
            bridgedFrom: ytmIdentifier,
            bridgedQuery: targetedQuery,
            bridgedIntermediate: `${topYtmTrack.info.author} - ${topYtmTrack.info.title}`,
            actualSource: track.info.sourceName || "youtube",
            bridgeFallback: true,
        };
    });

    return {
        result: reRankedYtm.result,
        bridgedFrom: ytmIdentifier,
        intermediateQuery: dzIdentifier,
        intermediateResultTitle: `${topYtmTrack.info.author} - ${topYtmTrack.info.title}`,
        finalTarget: "youtube",
        success: true,
    };
}

/**
 * Determine the canonical requested source platform from an identifier
 */
export function extractRequestedSource(identifier: string): string | null {
    const trimmed = identifier.trim().toLowerCase();
    if (trimmed.startsWith("dzsearch:") || trimmed.startsWith("deezer:")) return "deezer";
    if (trimmed.startsWith("spsearch:") || trimmed.startsWith("spotify:")) return "spotify";
    if (trimmed.startsWith("ytsearch:") || trimmed.startsWith("youtube:")) return "youtube";
    if (trimmed.startsWith("ytmsearch:") || trimmed.startsWith("youtubemusic:")) return "youtube";
    if (trimmed.startsWith("scsearch:") || trimmed.startsWith("soundcloud:")) return "soundcloud";
    if (trimmed.startsWith("amsearch:") || trimmed.startsWith("applemusic:")) return "applemusic";
    if (trimmed.startsWith("ymsearch:") || trimmed.startsWith("yandexmusic:")) return "yandexmusic";
    return null;
}

/**
 * Apply Source Masking / "Source Illusion" to a LavalinkLoadResult.
 * 
 * If enabled, masks `track.info.sourceName` to match the client's requested source
 * while preserving the real audio backend and provenance in `pluginInfo`.
 */
export function applySourceMasking(
    loadResult: LavalinkLoadResult,
    rawIdentifier: string,
    enabled: boolean = true
): LavalinkLoadResult {
    if (!enabled) return loadResult;

    const requestedSource = extractRequestedSource(rawIdentifier);
    if (!requestedSource) return loadResult;

    const maskTrack = (track: LavalinkTrack) => {
        if (!track || !track.info) return;
        const actualSource = track.pluginInfo?.actualSource || track.info.sourceName || "unknown";

        track.pluginInfo = {
            ...track.pluginInfo,
            actualSource,
            originalRequestedSource: requestedSource,
            isSourceMasked: actualSource !== requestedSource,
        };

        track.info = {
            ...track.info,
            sourceName: requestedSource,
        };
    };

    if (loadResult.loadType === "search" && Array.isArray(loadResult.data)) {
        loadResult.data.forEach(maskTrack);
    } else if (loadResult.loadType === "track" && loadResult.data) {
        maskTrack(loadResult.data as LavalinkTrack);
    } else if (loadResult.loadType === "playlist" && (loadResult.data as any)?.tracks) {
        ((loadResult.data as any).tracks as LavalinkTrack[]).forEach(maskTrack);
    }

    return loadResult;
}
