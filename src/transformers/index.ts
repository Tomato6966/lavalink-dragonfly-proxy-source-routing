import type { LavalinkLoadResult } from "../types";
import { buildSearchResult, buildTrack, buildTrackInfo, buildEmptyResult } from "../builders";

/**
 * Extract YouTube Video ID from any YouTube / YouTube Music URL
 */
export function extractYouTubeVideoId(identifier: string): string | null {
    if (!identifier.startsWith("http://") && !identifier.startsWith("https://")) {
        return null;
    }
    try {
        const url = new URL(identifier);
        if (url.hostname.includes("youtu.be")) {
            const pathId = url.pathname.slice(1).split("/")[0].split("?")[0];
            if (pathId && /^[\w-]{11}$/.test(pathId)) return pathId;
        }
        if (url.hostname.includes("youtube.com")) {
            const v = url.searchParams.get("v");
            if (v && /^[\w-]{11}$/.test(v)) return v;
            if (url.pathname.startsWith("/shorts/") || url.pathname.startsWith("/embed/")) {
                const parts = url.pathname.split("/");
                const id = parts[2]?.split("?")[0];
                if (id && /^[\w-]{11}$/.test(id)) return id;
            }
        }
    } catch {}
    return null;
}

/**
 * In-Process Transformation and Fallback Function Registry
 */
export type QueryTransformerFn = (identifier: string, context?: Record<string, any>) => string | Promise<string>;
export type ResponseTransformerFn = (data: any, identifier: string, context?: Record<string, any>) => any | Promise<any>;
export type InProcessFallbackFn = (identifier: string, context?: Record<string, any>) => LavalinkLoadResult | Promise<LavalinkLoadResult>;

export class TransformerRegistry {
    private queryTransformers: Map<string, QueryTransformerFn> = new Map();
    private responseTransformers: Map<string, ResponseTransformerFn> = new Map();
    private fallbackFunctions: Map<string, InProcessFallbackFn> = new Map();

    constructor() {
        this.registerDefaultTransformers();
    }

    private registerDefaultTransformers(): void {
        // Strip tracking parameters from URLs
        this.registerQueryTransformer("cleanUrlTracking", (identifier: string) => {
            try {
                if (identifier.startsWith("http://") || identifier.startsWith("https://")) {
                    const url = new URL(identifier);
                    const toDelete = ["si", "utm_source", "utm_medium", "utm_campaign", "feature", "fbclid", "pp", "list", "index"];
                    toDelete.forEach((param) => url.searchParams.delete(param));
                    return url.toString();
                }
            } catch {
                // Ignore invalid URLs
            }
            return identifier;
        });

        // Force normalized ISRC
        this.registerQueryTransformer("normalizeIsrc", (identifier: string) => {
            if (identifier.includes("isrc:")) {
                const parts = identifier.split("isrc:");
                return `${parts[0]}isrc:${parts[1].replace(/[^a-zA-Z0-9]/g, "").toUpperCase()}`;
            }
            return identifier;
        });

        // Rewrite YouTube Music URLs to standard YouTube
        this.registerQueryTransformer("ytmToYoutube", (identifier: string) => {
            if (identifier.includes("music.youtube.com/watch?v=")) {
                return identifier.replace("music.youtube.com", "www.youtube.com");
            }
            return identifier;
        });

        // Convert YouTube URL to YouTube search query by videoId
        this.registerQueryTransformer("youtubeUrlToSearch", (identifier: string) => {
            const videoId = extractYouTubeVideoId(identifier);
            if (videoId) {
                return `ytsearch:${videoId}`;
            }
            return identifier;
        });

        // Safe empty response transformer
        this.registerResponseTransformer("safeEmptyResponse", (data: any) => {
            if (!data || typeof data !== "object") {
                return buildEmptyResult();
            }
            return data;
        });

        // Mock fallback resolver using builders
        this.registerFallbackFunction("mockResolver", async (identifier: string) => {
            const track = buildTrack(
                buildTrackInfo({
                    title: `Resolved: ${identifier}`,
                    author: "InProcessResolver",
                    uri: "https://mivator.com",
                    sourceName: "custom",
                })
            );
            return buildSearchResult([track]);
        });
    }

    public registerQueryTransformer(name: string, fn: QueryTransformerFn): void {
        this.queryTransformers.set(name, fn);
    }

    public registerResponseTransformer(name: string, fn: ResponseTransformerFn): void {
        this.responseTransformers.set(name, fn);
    }

    public registerFallbackFunction(name: string, fn: InProcessFallbackFn): void {
        this.fallbackFunctions.set(name, fn);
    }

    public async transformQuery(transformerName: string, identifier: string, context?: Record<string, any>): Promise<string> {
        const fn = this.queryTransformers.get(transformerName);
        if (!fn) return identifier;
        try {
            return await fn(identifier, context);
        } catch (err: any) {
            console.error(`[Transformer] Error in query transformer "${transformerName}":`, err?.message);
            return identifier;
        }
    }

    public async transformResponse(transformerName: string, data: any, identifier: string, context?: Record<string, any>): Promise<any> {
        const fn = this.responseTransformers.get(transformerName);
        if (!fn) return data;
        try {
            return await fn(data, identifier, context);
        } catch (err: any) {
            console.error(`[Transformer] Error in response transformer "${transformerName}":`, err?.message);
            return data;
        }
    }

    public async executeFallbackFunction(fnName: string, identifier: string, context?: Record<string, any>): Promise<LavalinkLoadResult | null> {
        const fn = this.fallbackFunctions.get(fnName);
        if (!fn) return null;
        try {
            return await fn(identifier, context);
        } catch (err: any) {
            console.error(`[Transformer] Error in fallback function "${fnName}":`, err?.message);
            return null;
        }
    }
}
