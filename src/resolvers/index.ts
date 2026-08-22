import ytsr from "@distube/ytsr";
import { parse as parseSpotifyUri } from "spotify-uri";

export interface MetadataResolverContext {
    originalIdentifier: string;
    timeoutMs: number;
}

export type MetadataResolverFn = (
    identifier: string,
    context: MetadataResolverContext
) => Promise<string | null>;

function stripSearchPrefix(identifier: string): string {
    return identifier
        .replace(/^[a-z0-9_-]*(?:search|rec|isrc):/i, "")
        .replace(/\s+/g, " ")
        .trim();
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_, reject) => {
                timer = setTimeout(() => reject(new Error(`resolver timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

/**
 * Canonicalize Spotify URLs/URIs without a network request. Spotify IDs remain
 * case-sensitive; the resource type is retained to prevent cache collisions.
 */
export function canonicalizeSpotifyIdentifier(identifier: string): string | null {
    try {
        const parsed = parseSpotifyUri(identifier.trim());
        return parsed.toURI();
    } catch {
        return null;
    }
}

/**
 * Optional metadata resolvers only return identifiers that a real backend must
 * load. They never create synthetic Lavalink encoded tracks.
 */
export class MetadataResolverRegistry {
    private readonly resolvers = new Map<string, MetadataResolverFn>();

    constructor() {
        this.registerDefaults();
    }

    private registerDefaults(): void {
        this.register("spotifyUrlToYoutubeSearch", async (identifier, context) => {
            const canonical = canonicalizeSpotifyIdentifier(identifier);
            if (!canonical || !/^spotify:(?:track|episode):/.test(canonical)) return null;

            const imported = await import("spotify-url-info");
            type SpotifyInfoFactory = (fetchImpl: typeof fetch) => {
                getDetails: (url: string, options?: RequestInit) => Promise<{
                    tracks: Array<{ artist: string; name: string }>;
                }>;
            };
            const namespace = imported as unknown as Record<string, unknown>;
            const createSpotifyInfo = (namespace.default ?? imported) as unknown as SpotifyInfoFactory;
            const spotify = createSpotifyInfo(fetch);
            const details = await withTimeout(
                spotify.getDetails(identifier, { signal: AbortSignal.timeout(context.timeoutMs) }),
                context.timeoutMs
            );
            const track = details.tracks?.[0];
            if (!track?.name || !track.artist) return null;
            return "ytsearch:" + track.artist + " - " + track.name;
        });

        this.register("distubeYoutubeSearch", async (identifier, context) => {
            process.env.YTSR_NO_UPDATE ||= "1";
            const query = stripSearchPrefix(identifier).slice(0, 300);
            if (!query || /^https?:\/\//i.test(query)) return null;

            const result = await withTimeout(
                ytsr(query, {
                    type: "video",
                    limit: 3,
                    requestOptions: {
                        headersTimeout: context.timeoutMs,
                        bodyTimeout: context.timeoutMs,
                    } as any,
                }),
                context.timeoutMs
            );

            const match = result.items.find((item) => !item.isUpcoming) ?? result.items[0];
            return match?.url ?? null;
        });
    }

    public register(name: string, resolver: MetadataResolverFn): void {
        this.resolvers.set(name, resolver);
    }

    public async resolve(
        name: string,
        identifier: string,
        context: MetadataResolverContext
    ): Promise<string | null> {
        const resolver = this.resolvers.get(name);
        if (!resolver) {
            console.warn(`[Resolver] Unknown metadata resolver "${name}"`);
            return null;
        }

        try {
            return await resolver(identifier, context);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[Resolver] ${name} failed: ${message}`);
            return null;
        }
    }
}
