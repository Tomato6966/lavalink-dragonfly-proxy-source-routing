import type { LavalinkProxyConfig, UpstreamNodeConfig, PreRequestRule, PostRequestOnFailRule } from "../types";
import { TransformerRegistry, extractYouTubeVideoId, fetchYouTubeOEmbedTitle } from "../transformers";
import { MetadataResolverRegistry } from "../resolvers";

export type CacheCategory = "search" | "track" | "lyrics" | "other";

export interface PreRequestResult {
    transformedIdentifier: string;
    targetNode: UpstreamNodeConfig;
    isRemapped: boolean;
    appliedRule?: PreRequestRule;
    appliedRules: PreRequestRule[];
    cacheCategory: CacheCategory;
}

export interface FallbackFailureContext {
    originalIdentifier: string;
    message: string;
    isEmpty: boolean;
    httpStatus?: number;
    loadType?: "empty" | "error";
}

export interface FallbackResolution {
    rule: PostRequestOnFailRule;
    nextIdentifier: string;
    targetNode: UpstreamNodeConfig;
    isEventHub: boolean;
    isInProcess: boolean;
    handlerName?: string;
    timeoutMs?: number;
    encodingScope: string;
}

export function classifyIdentifier(identifier: string): CacheCategory {
    const value = identifier.trim();
    if (!value) return "other";
    if (/^(?:lyrics|lyricsearch):/i.test(value)) return "lyrics";

    const prefix = value.match(/^([a-z0-9_-]+(?:\[[^\]]+\])?):/i)?.[1]?.toLowerCase();
    if (prefix && (prefix.includes("search") || prefix === "search" || prefix === "isrc" || prefix === "rec")) {
        return "search";
    }
    return "track";
}

function matchesRule(rule: { prefix?: string; match?: string }, identifier: string): boolean {
    if (!rule.prefix && !rule.match) return true;
    if (rule.prefix && identifier.startsWith(rule.prefix)) return true;
    if (!rule.match) return false;
    try {
        return new RegExp(rule.match, "i").test(identifier);
    } catch {
        console.warn(`[Router] Ignoring invalid regular expression: ${rule.match}`);
        return false;
    }
}

export class UpstreamRouter {
    private config: LavalinkProxyConfig;
    public readonly transformers: TransformerRegistry;
    public readonly resolvers: MetadataResolverRegistry;

    constructor(config: LavalinkProxyConfig) {
        this.config = config;
        this.transformers = new TransformerRegistry();
        this.resolvers = new MetadataResolverRegistry();
    }

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
    }

    private getNode(nodeName: string): UpstreamNodeConfig {
        const selected = this.config.upstreams[nodeName];
        if (selected?.enabled !== false) return selected;
        return this.config.upstreams.default;
    }

    /** Apply every matching rule in order so cleaning, rewriting, and node routing compose. */
    public async applyPreRequest(rawIdentifier: string): Promise<PreRequestResult> {
        let identifier = rawIdentifier.trim();
        let targetNodeName = "default";
        let isRemapped = false;
        let appliedRule: PreRequestRule | undefined;
        const appliedRules: PreRequestRule[] = [];

        if (!identifier) {
            return {
                transformedIdentifier: rawIdentifier,
                targetNode: this.getNode("default"),
                isRemapped: false,
                appliedRules: [],
                cacheCategory: "other",
            };
        }

        if (this.config.remapping.enabled && Array.isArray(this.config.remapping.preRequest)) {
            for (const rule of this.config.remapping.preRequest) {
                if (!matchesRule(rule, identifier)) continue;
                appliedRule = rule;
                appliedRules.push(rule);

                if (rule.prefix && rule.rewritePrefix && identifier.startsWith(rule.prefix)) {
                    const rewritten = rule.rewritePrefix + identifier.slice(rule.prefix.length);
                    isRemapped ||= rewritten !== identifier;
                    identifier = rewritten;
                }

                if (rule.routeToNode && this.config.upstreams[rule.routeToNode]?.enabled !== false) {
                    targetNodeName = rule.routeToNode;
                }

                if (rule.transformerName) {
                    const transformed = await this.transformers.transformQuery(rule.transformerName, identifier);
                    isRemapped ||= transformed !== identifier;
                    identifier = transformed;
                }
            }
        }

        return {
            transformedIdentifier: identifier,
            targetNode: this.getNode(targetNodeName),
            isRemapped,
            appliedRule,
            appliedRules,
            cacheCategory: classifyIdentifier(identifier),
        };
    }

    private failureMatches(rule: PostRequestOnFailRule, failure: FallbackFailureContext): boolean {
        if (failure.isEmpty && rule.fallbackOnEmpty === false) return false;

        const effectiveLoadType = failure.isEmpty ? "empty" : failure.loadType;
        if (rule.onLoadTypes && (!effectiveLoadType || !rule.onLoadTypes.includes(effectiveLoadType))) {
            return false;
        }
        if (rule.onHttpStatuses && (!failure.httpStatus || !rule.onHttpStatuses.includes(failure.httpStatus))) {
            return false;
        }
        if (rule.onErrors?.length) {
            if (rule.onErrors.includes("*")) return true;
            const message = failure.message.toLowerCase();
            return rule.onErrors.some((part) => message.includes(part.toLowerCase()));
        }
        return true;
    }

    /** Select and prepare the next backend attempt for a structured failure. */
    public async getNextFallback(
        currentIdentifier: string,
        failure: FallbackFailureContext,
        usedRuleNames: Set<string> = new Set()
    ): Promise<FallbackResolution | null> {
        if (!this.config.remapping.enabled || !Array.isArray(this.config.remapping.postRequestOnFail)) {
            return null;
        }

        for (const rule of this.config.remapping.postRequestOnFail) {
            if (usedRuleNames.has(rule.name)) continue;

            const matchesCurrent = matchesRule(rule, currentIdentifier);
            const matchesOriginal = matchesRule(rule, failure.originalIdentifier);
            if (!matchesCurrent && !matchesOriginal) continue;
            if (!this.failureMatches(rule, failure)) continue;

            let nextIdentifier = currentIdentifier;
            const matchedIdentifier = matchesCurrent ? currentIdentifier : failure.originalIdentifier;

            if (rule.metadataResolver) {
                const resolved = await this.resolvers.resolve(rule.metadataResolver, currentIdentifier, {
                    originalIdentifier: failure.originalIdentifier,
                    timeoutMs: rule.timeoutMs ?? 1800,
                });
                if (!resolved) continue;
                nextIdentifier = resolved;
            } else {
                const ytVideoId =
                    extractYouTubeVideoId(matchedIdentifier) ||
                    (/^[\w-]{11}$/.test(matchedIdentifier) ? matchedIdentifier : null);

                if (ytVideoId && rule.targetPrefix) {
                    const oembed = await fetchYouTubeOEmbedTitle(ytVideoId);
                    nextIdentifier = rule.targetPrefix + (oembed?.title || ytVideoId);
                } else if (rule.rewritePrefix && rule.targetPrefix && nextIdentifier.startsWith(rule.rewritePrefix)) {
                    nextIdentifier = rule.targetPrefix + nextIdentifier.slice(rule.rewritePrefix.length);
                } else if (rule.targetPrefix && !nextIdentifier.startsWith(rule.targetPrefix)) {
                    const colonIndex = nextIdentifier.indexOf(":");
                    const queryPart = classifyIdentifier(nextIdentifier) === "search" && colonIndex >= 0
                        ? nextIdentifier.slice(colonIndex + 1)
                        : nextIdentifier;
                    nextIdentifier = rule.targetPrefix + queryPart;
                }
            }

            const targetNode = this.getNode(rule.routeToNode || "default");
            const isEventHub = Boolean(rule.routeToFallbackFn && rule.eventHubHandler);
            const isInProcess = Boolean(rule.inProcessTransformer);
            const explicitEncodingScope = rule.encodingScope?.trim();
            if ((isEventHub || isInProcess) && !explicitEncodingScope) {
                console.warn(`[Router] Ignoring non-node fallback "${rule.name}" without encodingScope`);
                continue;
            }
            return {
                rule,
                nextIdentifier,
                targetNode,
                isEventHub,
                isInProcess,
                handlerName: rule.eventHubHandler || rule.inProcessTransformer,
                timeoutMs: rule.timeoutMs,
                encodingScope: explicitEncodingScope || targetNode.encodingScope?.trim() || targetNode.id,
            };
        }

        return null;
    }
}
