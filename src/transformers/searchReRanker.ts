import type { LavalinkLoadResult, LavalinkTrack } from "../types";

// ─── Constants & Configuration ───────────────────────────────────────────────

/** BM25 tuning: k1 controls term-frequency saturation, b controls length normalization */
const BM25_K1 = 1.4;
const BM25_B = 0.6;

/** Score weights for each ranking signal (tuned for music search) */
const W = {
    /** BM25 text relevance (title + author combined) */
    bm25:           40,
    /** Bigram Dice-coefficient fuzzy title similarity */
    bigramTitle:    25,
    /** Bigram Dice-coefficient fuzzy author similarity */
    bigramAuthor:   18,
    /** Exact or near-exact core title match */
    exactTitle:     35,
    /** Artist token overlap bonus */
    artistMatch:    25,
    /** Query-parsed artist name exact match */
    artistExact:    40,
    /** Upstream position preservation (gentle decay) */
    positionDecay:  0.8,
    /** Official edition bonus */
    officialBonus:  12,
    /** Duration in sweet-spot bonus */
    durationBonus:  8,
    /** ISRC dedup penalty for lower-ranked dupes */
    isrcDupePenalty: -60,
    /** Cover/tribute/baby penalty when unsolicited */
    coverPenalty:   -80,
    /** Remix/slowed/sped penalty when unsolicited */
    remixPenalty:   -55,
    /** Live version penalty when unsolicited */
    livePenalty:    -30,
    /** Soundtrack / OST / Cast penalty when unsolicited */
    soundtrackPenalty: -45,
    /** Compilation/various artists penalty */
    compilationPenalty: -20,
    /** Cover/tribute boost when user explicitly wants one */
    coverBoost:     55,
    /** Remix boost when user explicitly wants one */
    remixBoost:     55,
    /** Live boost when user explicitly wants one */
    liveBoost:      45,
    /** Soundtrack / OST / Cast boost when user explicitly wants one */
    soundtrackBoost: 40,
} as const;

// ─── Multi-Language Noise & Modifier Patterns ────────────────────────────────

/** Cover, tribute, karaoke, lullaby, baby, instrumental — across EN, ES, FR, DE, PT, IT, RU, JA, KO, AR, TR, PL, NL */
const COVER_REGEX = /(?:\b(?:covers?|coversong|coverversion|tribute(?:\s+(?:band|to))?|karaoke[êé]?|klavier|orchester|orchestral|piano\s*(?:version|cover)|instrumental|parody|parodie|parodia|8d\s*audio|bass\s*boost(?:ed)?|chipmunk|midi|bossa\s*nova|reprise|hommage|voz\s*e\s*viol[aã]o|utattemita|kav[eé]r|kov[eé]r|кавер|минусовка|lullaby|lullabies|berceuse|wiegenlied|ninna\s*nanna|cancion\s*de\s*cuna|babies?\s*love|baby\s*(?:music|sleep|lullaby)|kids?|bedtime|music\s*box|soundalike|sound-alike|versione|versión)\b|歌ってみた|カラオケ|커버)/i;

/** Acoustic / brass band / marching band / ensemble covers & tributes */
const ENSEMBLE_NOISE_REGEX = /\b(brass\s*band|marching\s*band|orchestral\s*tribute|string\s*quartet|tribute\s*band|party\s*band|steel\s*drum\s*band|big\s*band\s*tribute|tribute\s*orchestra|backing\s*track)\b/i;

/** Soundtrack, Broadway cast recording, film score, motion picture OST */
const SOUNDTRACK_REGEX = /\b(from the (?:motion picture|soundtrack|film|musical|series|netflix\s*series|movie)|soundtrack(?:\s*(?:version|album))?|original\s*(?:broadway\s*)?cast(?:\s*recording)?|cast\s*(?:recording|version)|ost\b|motion\s*picture\s*score|music\s*from\s+the\s+(?:motion\s*picture|film|series|movie))\b/i;

/** Acoustic / unplugged — separate from covers for distinct intent handling */
const ACOUSTIC_REGEX = /\b(acoustic|acoustique|akustik|akustisk|acústica|acustica|unplugged|version\s*(?:acústica|acoustique|akustisch))\b/i;

/** Remix, slowed, sped up, nightcore, bootleg, mashup */
const REMIX_REGEX = /(?:\b(?:remix|rmx|club\s*mix|extended\s*mix|dance\s*mix|dub\s*mix|vip\s*mix|radio\s*mix|bootleg|flip|mashup|mash-up|slowed\s*(?:\+|&|and)?\s*reverb|slowed(?:\s+down)?|sped\s*up|nightcore|hardstyle|trap\s*(?:mix|remix)|drill\s*(?:mix|remix)|bass\s*house|house\s*mix|techno\s*(?:mix|remix)|trance\s*(?:mix|remix)|lofi|lo-fi|chopped\s*(?:and|&)\s*screwed|remiks|ремикс)\b|リミックス|리믹스)/i;

/** Live recording indicators */
const LIVE_REGEX = /(?:\b(?:live\s+(?:at|in|from|on|@)|live\s*session|live\s*recording|en\s*vivo|ao\s*vivo|en\s*direct|live\s*performance|live\s*acoustic|tour\s*edition|live\s*concert|live\s*version|unplugged\s*(?:live|session))\b|ライブ|ライ브)/i;

/** Official remaster, album version, radio edit — should NOT be penalized */
const OFFICIAL_EDITION_REGEX = /\b(re-?master(?:ed)?|original\s*(?:mix|version|recording)|radio\s*edit|album\s*version|official\s*(?:audio|video|music\s*video)|studio\s*version|single\s*version|explicit|deluxe\s*(?:edition|version)?|anniversary\s*(?:edition|version)?|bonus\s*track|expanded\s*edition|standard\s*edition)\b/i;

/** Compilation album / Various Artists indicators */
const COMPILATION_REGEX = /\b(various\s*artists?|v\/?a\b|compilation|sampler|greatest\s*hits\s*(?:of\s*)?|best\s*of\b|top\s*(?:hits|tracks)|now\s*that'?s?\s*what\s*i\s*call|hitzone|bravo\s*hits|hit\s*parade|20\s*(?:greatest|biggest)|mega\s*hits|ultra\s*hits)\b/i;

/** Featuring / collaboration tags to strip for matching purposes */
const FEAT_REGEX = /\s*[([]?\s*(?:feat\.?|ft\.?|featuring|with|prod\.?\s*by|produced\s*by|&|×|x(?=\s+[A-Z]))\s+.+$/i;
const FEAT_STRIP_REGEX = /\s*[([]?\s*(?:feat\.?|ft\.?|featuring)\s+[^)\]]+[)\]]?/gi;

/** Common music stopwords for BM25 scoring (filtered from token significance) */
const STOPWORDS = new Set([
    "the", "a", "an", "of", "in", "on", "at", "to", "for", "and", "or", "by",
    "is", "it", "my", "me", "i", "you", "we", "her", "his", "our", "your",
    "de", "la", "le", "les", "el", "los", "das", "der", "die", "des", "du",
    "no", "da", "do", "na", "em", "um", "una", "une", "dei", "di",
]);

// ─── Homophone & Typo Normalization ──────────────────────────────────────────

/**
 * Music homophones, common title/artist misspellings, and typo replacements
 */
const HOMOPHONE_REPLACEMENTS: Array<[RegExp, string]> = [
    [/\bloose\s+yourself\b/gi, "lose yourself"],
    [/\bloose\s+control\b/gi, "lose control"],
    [/\bloose\s+my\s+mind\b/gi, "lose my mind"],
    [/\bloose\s+you\b/gi, "lose you"],
    [/\bloose\s+it\b/gi, "lose it"],
    [/\bloose\s+my\s+breath\b/gi, "lose my breath"],
    [/\b(don'?t|cant|can'?t|never|wanna|going\s+to|gonna)\s+loose\b/gi, "$1 lose"],
    [/\blooser\b/gi, "loser"],
    [/\bstills\s+tanding\b/gi, "still standing"],
    [/\bclam\s+down\b/gi, "calm down"],
    [/\bdefinately\b/gi, "definitely"],
    [/\bpersuit\b/gi, "pursuit"],
    [/\bseperate\b/gi, "separate"],
    [/\bunforgetable\b/gi, "unforgettable"],
];

/**
 * Pre-scoring query normalizer for high-frequency music homophones and common typos
 */
export function normalizeMusicHomophones(text: string): string {
    if (!text) return "";
    let result = text;
    for (const [pattern, replacement] of HOMOPHONE_REPLACEMENTS) {
        result = result.replace(pattern, replacement);
    }
    return result;
}

// ─── String Processing Utilities ─────────────────────────────────────────────

/** Normalize: lowercase, strip diacritics, collapse whitespace, trim */
function normalize(text: string): string {
    return (text || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[''`]/g, "'")
        .replace(/[""]/g, '"')
        .replace(/[\s\-_/\\|,;:]+/g, " ")
        .trim();
}

/** Extract core title: remove parenthetical tags (feat., official video, year remaster, etc.) */
function extractCoreTitle(title: string): string {
    const cleaned = title
        // Remove feat/ft blocks first
        .replace(FEAT_STRIP_REGEX, "")
        // Remove known noise parentheticals and soundtrack tags
        .replace(/\s*[([{](?:official|audio|video|music\s*video|lyrics?\s*(?:video)?|hd|hq|4k|uhd|re-?master(?:ed)?|\d{4}\s*re-?master(?:ed)?|from\s*[^)\]}]+|soundtrack\s*version)[)\]}]/gi, "")
        // Remove trailing " - From ..." or " - Single" or " - Soundtrack..."
        .replace(/\s*-\s*(?:from\s+[^-\n]+|single|soundtrack.*)$/i, "")
        // Remove remaining parentheticals  
        .replace(/\s*[([{][^)\]}]*[)\]}]/g, "")
        .trim();
    return normalize(cleaned || title);
}

/** Strip featuring credits from artist name */
function stripFeaturing(author: string): string {
    return author
        .replace(FEAT_REGEX, "")
        .replace(/\s*[([].*[)\]]/g, "")
        .trim();
}

/** Tokenize into significant words (length >= 2, no stopwords) */
function tokenize(text: string): string[] {
    return normalize(text)
        .split(/\s+/)
        .filter(w => w.length >= 2 && !STOPWORDS.has(w));
}

/** Tokenize keeping stopwords (for BM25 document length accuracy) */
function tokenizeRaw(text: string): string[] {
    return normalize(text).split(/\s+/).filter(w => w.length >= 1);
}

/** Extract character bigrams from normalized text */
function bigrams(text: string): Set<string> {
    const n = normalize(text);
    const set = new Set<string>();
    for (let i = 0; i < n.length - 1; i++) {
        set.add(n.slice(i, i + 2));
    }
    return set;
}

/**
 * Dice coefficient: 2 * |A ∩ B| / (|A| + |B|)
 * Returns 0..1 similarity score using character bigrams.
 * Fast O(n) with Set intersection.
 */
function diceCoefficient(a: string, b: string): number {
    if (a === b) return 1;
    const ba = bigrams(a);
    const bb = bigrams(b);
    if (ba.size === 0 || bb.size === 0) return 0;
    let intersection = 0;
    for (const bg of ba) {
        if (bb.has(bg)) intersection++;
    }
    return (2 * intersection) / (ba.size + bb.size);
}

/**
 * Jaro-Winkler similarity (prefix-weighted).
 * Returns 0..1, where 1 is exact match.
 * Optimized for short music titles (typically < 100 chars).
 */
function jaroWinkler(s1: string, s2: string): number {
    if (s1 === s2) return 1;
    const len1 = s1.length;
    const len2 = s2.length;
    if (len1 === 0 || len2 === 0) return 0;

    const matchWindow = Math.max(0, Math.floor(Math.max(len1, len2) / 2) - 1);
    const s1Matches = new Uint8Array(len1);
    const s2Matches = new Uint8Array(len2);

    let matches = 0;
    let transpositions = 0;

    for (let i = 0; i < len1; i++) {
        const start = Math.max(0, i - matchWindow);
        const end = Math.min(i + matchWindow + 1, len2);
        for (let j = start; j < end; j++) {
            if (s2Matches[j] || s1[i] !== s2[j]) continue;
            s1Matches[i] = 1;
            s2Matches[j] = 1;
            matches++;
            break;
        }
    }

    if (matches === 0) return 0;

    let k = 0;
    for (let i = 0; i < len1; i++) {
        if (!s1Matches[i]) continue;
        while (!s2Matches[k]) k++;
        if (s1[i] !== s2[k]) transpositions++;
        k++;
    }

    const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

    // Winkler: boost for common prefix (up to 4 chars)
    let prefix = 0;
    const maxPrefix = Math.min(4, Math.min(len1, len2));
    for (let i = 0; i < maxPrefix; i++) {
        if (s1[i] === s2[i]) prefix++;
        else break;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
}

// ─── Query Intent Parser ─────────────────────────────────────────────────────

interface ParsedQuery {
    /** Full normalized query */
    full: string;
    /** Query with modifiers stripped */
    clean: string;
    /** Parsed artist name (if detectable) */
    artist: string;
    /** Parsed title portion */
    title: string;
    /** Significant tokens (no stopwords) */
    tokens: string[];
    /** Raw tokens (with stopwords, for BM25 doc length) */
    rawTokens: string[];
    /** User intent flags */
    wantsCover: boolean;
    wantsRemix: boolean;
    wantsLive: boolean;
    wantsAcoustic: boolean;
    wantsSoundtrack: boolean;
}

/** Common query separator patterns: "artist - title", "title by artist" */
const QUERY_SEPARATORS = /\s+[-–—]\s+|\s+by\s+/i;

function parseQuery(rawIdentifier: string): ParsedQuery {
    // Strip source prefix
    const colonIdx = rawIdentifier.indexOf(":");
    const queryPart = colonIdx >= 0 ? rawIdentifier.slice(colonIdx + 1) : rawIdentifier;

    const homophoneNormalized = normalizeMusicHomophones(queryPart);
    const full = normalize(homophoneNormalized);

    // Detect user intent BEFORE stripping modifiers
    const wantsCover = COVER_REGEX.test(full) || ENSEMBLE_NOISE_REGEX.test(full);
    const wantsRemix = REMIX_REGEX.test(full);
    const wantsLive = LIVE_REGEX.test(full);
    const wantsAcoustic = /\b(acoustic|acoustique|akustik|ac[uú]stica|unplugged)\b/i.test(full);
    const wantsSoundtrack = SOUNDTRACK_REGEX.test(full) || /\b(soundtrack|ost|cast|movie|film|score)\b/i.test(full);

    // Strip modifiers to get clean matching query
    let clean = full
        .replace(COVER_REGEX, " ")
        .replace(ENSEMBLE_NOISE_REGEX, " ")
        .replace(REMIX_REGEX, " ")
        .replace(LIVE_REGEX, " ")
        .replace(SOUNDTRACK_REGEX, " ")
        .replace(/\b(soundtrack|ost|cast|movie|film|score)\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();

    // Try to parse "artist - title" or "title by artist" pattern
    let artist = "";
    let title = clean;

    const separatorMatch = clean.match(QUERY_SEPARATORS);
    if (separatorMatch && separatorMatch.index !== undefined) {
        const parts = clean.split(QUERY_SEPARATORS);
        if (parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2) {
            // "artist - title" pattern (most common)
            if (clean.includes(" - ") || clean.includes(" – ") || clean.includes(" — ")) {
                artist = parts[0].trim();
                title = parts.slice(1).join(" ").trim();
            }
            // "title by artist" pattern
            else if (/\s+by\s+/i.test(clean)) {
                title = parts[0].trim();
                artist = parts.slice(1).join(" ").trim();
            }
        }
    }

    const tokens = tokenize(clean);
    const rawTokens = tokenizeRaw(clean);

    return { full, clean, artist, title, tokens, rawTokens, wantsCover, wantsRemix, wantsLive, wantsAcoustic, wantsSoundtrack };
}

// ─── BM25 Scoring ────────────────────────────────────────────────────────────

/**
 * Lightweight BM25 scoring for a single "document" (track metadata)
 * against a query. Uses precomputed IDF from the track collection.
 */
function bm25Score(
    queryTokens: string[],
    docTokens: string[],
    avgDocLen: number,
    idfMap: Map<string, number>,
): number {
    const docLen = docTokens.length;
    if (docLen === 0 || queryTokens.length === 0) return 0;

    // Count term frequencies in this doc
    const tf = new Map<string, number>();
    for (const t of docTokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
    }

    let score = 0;
    for (const qt of queryTokens) {
        const freq = tf.get(qt) || 0;
        if (freq === 0) continue;
        const idf = idfMap.get(qt) || 0;
        const numerator = freq * (BM25_K1 + 1);
        const denominator = freq + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen));
        score += idf * (numerator / denominator);
    }

    return score;
}

/**
 * Build IDF map from all track "documents" for the query tokens.
 * IDF(t) = ln((N - df(t) + 0.5) / (df(t) + 0.5) + 1)
 */
function buildIdfMap(queryTokens: string[], documents: string[][]): Map<string, number> {
    const N = documents.length;
    const idf = new Map<string, number>();
    const querySet = new Set(queryTokens);

    for (const qt of querySet) {
        let df = 0;
        for (const doc of documents) {
            if (doc.includes(qt)) df++;
        }
        idf.set(qt, Math.log((N - df + 0.5) / (df + 0.5) + 1));
    }

    return idf;
}

// ─── Main Re-Ranker ──────────────────────────────────────────────────────────

export interface ReRankResult {
    result: LavalinkLoadResult;
    reOrdered: boolean;
    topTrackChanged: boolean;
}

/**
 * Advanced Mid-Request Search Result Optimizer
 * 
 * Implements a multi-signal scoring pipeline inspired by modern search engines:
 * 
 * 1. **BM25 Text Relevance** — term-frequency saturation + length normalization
 *    across combined title+author document, with IDF computed from the result set.
 * 
 * 2. **Bigram Dice Coefficient** — fuzzy character-level similarity for resilience
 *    against typos, transliterations, and partial matches.
 * 
 * 3. **Jaro-Winkler Similarity** — prefix-weighted fuzzy matching, ideal for
 *    music titles where the beginning is usually correct.
 * 
 * 4. **Query Intent Parsing** — detects "artist - title" and "title by artist"
 *    patterns. When the user includes an artist name, we give strong preference
 *    to matching artists.
 * 
 * 5. **Multi-Language Noise Detection** — 15+ languages worth of cover, tribute,
 *    karaoke, remix, slowed+reverb, lullaby, baby, kids, compilation patterns.
 *    Inspects title, author, AND album name metadata.
 * 
 * 6. **Featuring Normalization** — strips "feat.", "ft.", "featuring", etc. from
 *    both query and track metadata for cleaner matching.
 * 
 * 7. **ISRC Deduplication** — when multiple tracks share the same ISRC, only the
 *    highest-scored one keeps its rank; others are heavily penalized.
 * 
 * 8. **Duration Curve** — graduated scoring with a bell-curve sweet spot
 *    (90s–390s typical song), penalizing ringtone snippets and DJ sets.
 * 
 * 9. **Compilation/Various Artists Detection** — penalizes tracks from compilation
 *    albums when the user likely wants the original release.
 * 
 * 10. **Upstream Position Preservation** — gentle index-based decay to respect the
 *     upstream engine's ranking signal (which may encode popularity/recency).
 */
export function optimizeSearchOrder(rawIdentifier: string, loadResult: LavalinkLoadResult): ReRankResult {
    // Only optimize search or playlist-search results with 2+ tracks
    if (loadResult.loadType !== "search" && loadResult.loadType !== "playlist") {
        return { result: loadResult, reOrdered: false, topTrackChanged: false };
    }

    const rawTracks: LavalinkTrack[] = loadResult.loadType === "search"
        ? (Array.isArray(loadResult.data) ? loadResult.data : [])
        : ((loadResult.data as any)?.tracks || []);

    if (rawTracks.length <= 1) {
        return { result: loadResult, reOrdered: false, topTrackChanged: false };
    }

    // ── Parse query intent ───────────────────────────────────────────────────
    const query = parseQuery(rawIdentifier);

    // ── Prepare track documents for BM25 ─────────────────────────────────────
    const trackDocs: Array<{
        track: LavalinkTrack;
        originalIndex: number;
        normalizedTitle: string;
        normalizedAuthor: string;
        normalizedAlbum: string;
        coreTitle: string;
        strippedAuthor: string;
        titleTokens: string[];
        authorTokens: string[];
        combinedTokens: string[];
    }> = rawTracks.map((track, idx) => {
        const rawTitle = track.info.title || "";
        const rawAuthor = track.info.author || "";
        const rawAlbum = (track.pluginInfo as any)?.albumName
            || (track.pluginInfo as any)?.album?.name
            || (track.userData as any)?.albumName
            || "";

        const normalizedTitle = normalize(rawTitle);
        const normalizedAuthor = normalize(rawAuthor);
        const normalizedAlbum = normalize(rawAlbum);
        const coreTitle = extractCoreTitle(rawTitle);
        const strippedAuthor = normalize(stripFeaturing(rawAuthor));

        const titleTokens = tokenize(rawTitle);
        const authorTokens = tokenize(stripFeaturing(rawAuthor));
        const combinedTokens = [...tokenizeRaw(rawTitle), ...tokenizeRaw(rawAuthor)];

        return {
            track, originalIndex: idx,
            normalizedTitle, normalizedAuthor, normalizedAlbum,
            coreTitle, strippedAuthor,
            titleTokens, authorTokens, combinedTokens,
        };
    });

    // ── BM25 preparation ─────────────────────────────────────────────────────
    const allDocs = trackDocs.map(td => td.combinedTokens);
    const avgDocLen = allDocs.reduce((sum, d) => sum + d.length, 0) / allDocs.length;
    const idfMap = buildIdfMap(query.tokens, allDocs);

    // ── Score each track ─────────────────────────────────────────────────────
    const scored = trackDocs.map((td) => {
        let score = 100; // Baseline

        // ─── Signal 1: BM25 Text Relevance ──────────────────────────────
        const bm25 = bm25Score(query.tokens, td.combinedTokens, avgDocLen, idfMap);
        // Normalize BM25 to roughly 0..1 range (max BM25 for music metadata ≈ 8-12)
        const bm25Normalized = Math.min(bm25 / 8, 1);
        score += bm25Normalized * W.bm25;

        // ─── Signal 2: Bigram Dice Similarity (Fuzzy) ───────────────────
        const titleDice = diceCoefficient(query.clean, td.coreTitle);
        score += titleDice * W.bigramTitle;

        // Author fuzzy match (compare parsed artist if available, else full query)
        const authorMatchSource = query.artist || query.clean;
        const authorDice = diceCoefficient(authorMatchSource, td.strippedAuthor);
        score += authorDice * W.bigramAuthor;

        // ─── Signal 3: Exact / Near-Exact Title Match ───────────────────
        const queryTitle = query.title || query.clean;
        const jwTitle = jaroWinkler(normalize(queryTitle), td.coreTitle);
        if (jwTitle >= 0.95) {
            score += W.exactTitle;
        } else if (jwTitle >= 0.85) {
            score += W.exactTitle * 0.6;
        } else if (jwTitle >= 0.75) {
            score += W.exactTitle * 0.3;
        }

        // ─── Signal 4: Artist Match ─────────────────────────────────────
        if (query.artist) {
            // User explicitly included artist in query
            const artistJw = jaroWinkler(normalize(query.artist), td.strippedAuthor);
            if (artistJw >= 0.90) {
                score += W.artistExact;
            } else if (artistJw >= 0.80) {
                score += W.artistExact * 0.5;
            } else if (artistJw >= 0.70) {
                score += W.artistExact * 0.25;
            }
        } else {
            // No explicit artist: check token overlap
            let matchedArtistTokens = 0;
            for (const qt of query.tokens) {
                if (td.authorTokens.includes(qt)) matchedArtistTokens++;
            }
            if (matchedArtistTokens > 0 && query.tokens.length > 0) {
                const ratio = matchedArtistTokens / query.tokens.length;
                score += ratio * W.artistMatch;
            }
        }

        // ─── Signal 5: Noise Detection (Multi-Language) ─────────────────
        const combinedMeta = `${td.track.info.title} ${td.track.info.author} ${td.normalizedAlbum}`;
        const hasCoverTag = COVER_REGEX.test(combinedMeta) || ENSEMBLE_NOISE_REGEX.test(combinedMeta);
        const hasAcousticTag = ACOUSTIC_REGEX.test(combinedMeta);
        const hasRemixTag = REMIX_REGEX.test(combinedMeta);
        const hasLiveTag = LIVE_REGEX.test(combinedMeta);
        const hasSoundtrackTag = SOUNDTRACK_REGEX.test(combinedMeta);
        const isOfficialEdition = OFFICIAL_EDITION_REGEX.test(td.track.info.title);
        const isCompilation = COMPILATION_REGEX.test(td.track.info.author) || COMPILATION_REGEX.test(td.normalizedAlbum);

        // Cover/tribute handling (separate from acoustic)
        if (query.wantsCover) {
            score += hasCoverTag ? W.coverBoost : -30;
        } else if (hasCoverTag) {
            score += W.coverPenalty;
        }

        // Soundtrack / OST handling
        if (query.wantsSoundtrack) {
            score += hasSoundtrackTag ? W.soundtrackBoost : -20;
        } else if (hasSoundtrackTag) {
            score += W.soundtrackPenalty;
        }

        // Acoustic/unplugged intent handling
        if (query.wantsAcoustic) {
            score += hasAcousticTag ? W.coverBoost : -20;
        } else if (hasAcousticTag && !isOfficialEdition) {
            score -= 15; // Gentle demotion for unsolicited acoustic versions
        }

        // Remix handling
        if (query.wantsRemix) {
            score += hasRemixTag ? W.remixBoost : -30;
        } else if (hasRemixTag && !isOfficialEdition) {
            score += W.remixPenalty;
        }

        // Live handling
        if (query.wantsLive) {
            score += hasLiveTag ? W.liveBoost : -20;
        } else if (hasLiveTag) {
            score += W.livePenalty;
        }

        // Official edition bonus (remasters, radio edits are authentic)
        if (isOfficialEdition && !query.wantsRemix && !query.wantsCover && !hasSoundtrackTag) {
            score += W.officialBonus;
        }

        // Compilation / Various Artists penalty
        if (isCompilation) {
            score += W.compilationPenalty;
        }

        // ─── Signal 6: Duration Heuristic (Bell Curve) ──────────────────
        const lengthSec = (td.track.info.length || 0) / 1000;
        if (lengthSec > 0) {
            if (lengthSec >= 120 && lengthSec <= 330) {
                // Sweet spot: typical pop/rock song (2–5.5 min)
                score += W.durationBonus;
            } else if (lengthSec >= 90 && lengthSec <= 420) {
                // Acceptable range (1.5–7 min)
                score += W.durationBonus * 0.5;
            } else if (lengthSec < 50) {
                // Ringtone / snippet / preview
                score -= 25;
            } else if (lengthSec > 600) {
                // DJ set / full album / meditation track
                score -= 15;
            } else if (lengthSec > 900) {
                // Very long — almost certainly not what user wants
                score -= 35;
            }
        }

        // ─── Signal 7: Upstream Position Decay ──────────────────────────
        // Gently preserves upstream search engine ranking (which may encode popularity)
        score -= td.originalIndex * W.positionDecay;

        return { track: td.track, score, originalIndex: td.originalIndex, isrc: td.track.info.isrc };
    });

    // ── ISRC Deduplication Pass ───────────────────────────────────────────────
    // If multiple tracks share the same ISRC, keep only the highest-scored one.
    const seenIsrcs = new Map<string, number>(); // isrc -> best score
    for (const s of scored) {
        if (s.isrc && s.isrc.length >= 8) {
            const normalizedIsrc = s.isrc.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
            const existing = seenIsrcs.get(normalizedIsrc);
            if (existing === undefined || s.score > existing) {
                seenIsrcs.set(normalizedIsrc, s.score);
            }
        }
    }
    for (const s of scored) {
        if (s.isrc && s.isrc.length >= 8) {
            const normalizedIsrc = s.isrc.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
            const bestScore = seenIsrcs.get(normalizedIsrc);
            if (bestScore !== undefined && s.score < bestScore) {
                s.score += W.isrcDupePenalty;
            }
        }
    }

    // ── Sort by final score (ties broken by original upstream position) ──────
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
