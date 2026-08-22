import type { LavalinkLoadResult, LavalinkTrack } from "../types";

/**
 * Multi-Language Noise & Modifier Patterns
 * Covers English, Spanish, French, German, Portuguese, Italian, Japanese (Romaji/Kana), and Cyrillic/Russian.
 */
const COVER_REGEX = /\b(cover|covers|tribute|tribute band|karaoke|karaokê|karaoké|acoustic|acoustique|akustik|ac[uú]stica|klavier|orchester|orchestral|piano version|instrumental|parody|8d audio|bass boosted|chipmunk|midi|bossa nova|reprise|hommage|voz e viol[aã]o|utattemita|歌ってみた|カラオケ|kaver|kover|кавер|минусовка)\b/i;

const REMIX_REGEX = /\b(remix|rmx|club mix|extended mix|dance mix|vip mix|bootleg|flip|mashup|slowed\s*\+?\s*reverb|slowed|sped up|nightcore|hardstyle|trap mix|drill mix|bass house|remiks|ремикс)\b/i;

const LIVE_REGEX = /\b(live at|live in|live from|live on|live session|live recording|en vivo|ao vivo|en direct|live performance|live acoustic|tour edition|live concert)\b/i;

const OFFICIAL_EDITION_REGEX = /\b(remastered|remaster|original mix|radio edit|album version|official audio|official video|studio version|single version|explicit|deluxe edition)\b/i;

/** Normalize text: lower-case, strip diacritics/accents, trim extra whitespace. */
function normalizeString(text: string): string {
    return (text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[\s\-_/\\|]+/g, " ")
        .trim();
}

/** Extract clean core title ignoring parenthetical tags like (Official Video), (2011 Remaster), etc. */
function extractCoreTitle(title: string): string {
    const cleaned = title
        .replace(/\s*[([{](?:official|audio|video|music video|lyrics?|hd|hq|4k|remastered|remaster|\d{4})[^)\]}]*[)\]}]/gi, "")
        .replace(/\s*[([{][^)\]}]*[)\]}]/g, "")
        .trim();
    return normalizeString(cleaned || title);
}

/** Tokenize string into a set of significant words (length >= 2). */
function tokenize(text: string): Set<string> {
    const words = normalizeString(text).split(/\s+/).filter(w => w.length >= 2);
    return new Set(words);
}

export interface ReRankResult {
    result: LavalinkLoadResult;
    reOrdered: boolean;
    topTrackChanged: boolean;
}

/**
 * Mid-Request Search Algorithm Optimization
 * Analyzes query intent, scores candidate tracks, and promotes the most relevant authentic original track to index #0.
 */
export function optimizeSearchOrder(rawIdentifier: string, loadResult: LavalinkLoadResult): ReRankResult {
    // Only optimize search or playlist-search results containing 2 or more tracks
    if (loadResult.loadType !== "search" && loadResult.loadType !== "playlist") {
        return { result: loadResult, reOrdered: false, topTrackChanged: false };
    }

    const rawTracks: LavalinkTrack[] = loadResult.loadType === "search"
        ? (Array.isArray(loadResult.data) ? loadResult.data : [])
        : ((loadResult.data as any)?.tracks || []);

    if (rawTracks.length <= 1) {
        return { result: loadResult, reOrdered: false, topTrackChanged: false };
    }

    // Strip source prefix (e.g. "spsearch:", "dzsearch:", "ytsearch:", "ytmsearch:")
    const colonIdx = rawIdentifier.indexOf(":");
    const queryPart = colonIdx >= 0 ? rawIdentifier.slice(colonIdx + 1) : rawIdentifier;
    const normalizedQuery = normalizeString(queryPart);
    const queryTokens = tokenize(normalizedQuery);

    // Detect user's explicit intent
    const userWantsCover = COVER_REGEX.test(normalizedQuery);
    const userWantsRemix = REMIX_REGEX.test(normalizedQuery);
    const userWantsLive = LIVE_REGEX.test(normalizedQuery);

    const scored = rawTracks.map((track, originalIndex) => {
        let score = 100 - originalIndex * 1.0; // Baseline preserve upstream rank

        const rawTitle = track.info.title || "";
        const rawAuthor = track.info.author || "";
        const normalizedTitle = normalizeString(rawTitle);
        const normalizedAuthor = normalizeString(rawAuthor);
        const coreTitle = extractCoreTitle(rawTitle);
        const titleTokens = tokenize(normalizedTitle);
        const authorTokens = tokenize(normalizedAuthor);

        // 1. Exact or Clean Core Title Match
        if (coreTitle === normalizedQuery || normalizedTitle === normalizedQuery) {
            score += 45;
        } else if (coreTitle.startsWith(normalizedQuery) || normalizedQuery.startsWith(coreTitle)) {
            score += 25;
        } else {
            // Token overlap ratio
            let matchedTokens = 0;
            for (const token of queryTokens) {
                if (titleTokens.has(token) || authorTokens.has(token)) matchedTokens++;
            }
            const overlapRatio = queryTokens.size > 0 ? matchedTokens / queryTokens.size : 0;
            score += Math.round(overlapRatio * 30);
        }

        // 2. Author/Artist Token Overlap
        let matchedAuthorTokens = 0;
        for (const token of queryTokens) {
            if (authorTokens.has(token)) matchedAuthorTokens++;
        }
        if (matchedAuthorTokens > 0) {
            score += Math.min(matchedAuthorTokens * 15, 30);
        }

        // 3. Modifier Intent Matching (Multi-Language)
        const hasCoverTag = COVER_REGEX.test(rawTitle) || COVER_REGEX.test(rawAuthor);
        const hasRemixTag = REMIX_REGEX.test(rawTitle) || REMIX_REGEX.test(rawAuthor);
        const hasLiveTag = LIVE_REGEX.test(rawTitle) || LIVE_REGEX.test(rawAuthor);
        const isOfficialEdition = OFFICIAL_EDITION_REGEX.test(rawTitle);

        if (userWantsCover) {
            score += hasCoverTag ? 50 : -40;
        } else if (hasCoverTag) {
            score -= 70;
        }

        if (userWantsRemix) {
            score += hasRemixTag ? 50 : -40;
        } else if (hasRemixTag && !isOfficialEdition) {
            score -= 50;
        }

        if (userWantsLive) {
            score += hasLiveTag ? 40 : -30;
        } else if (hasLiveTag) {
            score -= 30;
        }

        if (isOfficialEdition && !userWantsRemix && !userWantsCover) {
            score += 15; // Bonus for official remaster/album version
        }

        // 4. Duration Heuristic (Favors typical song duration 1m30s - 6m30s)
        const lengthSec = (track.info.length || 0) / 1000;
        if (lengthSec >= 90 && lengthSec <= 390) {
            score += 10;
        } else if (lengthSec > 0 && (lengthSec < 50 || lengthSec > 900)) {
            score -= 30; // Penalize short ringtones/snippets or long DJ sets
        }

        return { track, score, originalIndex };
    });

    // Sort tracks by highest score, preserving upstream order on ties
    scored.sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex);

    const reorderedTracks = scored.map(s => s.track);
    const topTrackChanged = reorderedTracks[0] !== rawTracks[0];
    const reOrdered = scored.some((s, idx) => s.originalIndex !== idx);

    let finalData: any;
    if (loadResult.loadType === "search") {
        finalData = reorderedTracks;
    } else {
        finalData = {
            ...(loadResult.data as any),
            tracks: reorderedTracks,
        };
    }

    return {
        result: {
            ...loadResult,
            data: finalData,
        },
        reOrdered,
        topTrackChanged,
    };
}
