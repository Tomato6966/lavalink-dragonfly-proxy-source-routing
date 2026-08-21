import type { LavalinkProxyConfig, UpstreamNodeConfig, PreRequestRule, PostRequestOnFailRule } from "../types";
import { TransformerRegistry, extractYouTubeVideoId } from "../transformers";

export interface PreRequestResult {
    transformedIdentifier: string;
    targetNode: UpstreamNodeConfig;
    isRemapped: boolean;
    appliedRule?: PreRequestRule;
    cacheCategory: "search" | "track" | "lyrics" | "other";
}

export interface FallbackResolution {
    rule: PostRequestOnFailRule;
    nextIdentifier: string;
    targetNode: UpstreamNodeConfig;
    isEventHub: boolean;
    isInProcess: boolean;
    handlerName?: string;
}

export class UpstreamRouter {
    private config: LavalinkProxyConfig;
    public transformers: TransformerRegistry;

    constructor(config: LavalinkProxyConfig) {
        this.config = config;
        this.transformers = new TransformerRegistry();
    }

    public updateConfig(newConfig: LavalinkProxyConfig): void {
        this.config = newConfig;
    }

    /**
     * Stage 1: Pre-Request Transformations & Initial Upstream Selection
     */
    public async applyPreRequest(rawIdentifier: string): Promise<PreRequestResult> {
        let identifier = rawIdentifier.trim();
        let targetNodeName = "default";
        let isRemapped = false;
        let appliedRule: PreRequestRule | undefined;
        let cacheCategory: "search" | "track" | "lyrics" | "other" = "track";

        if (!identifier) {
            return {
                transformedIdentifier: rawIdentifier,
                targetNode: this.config.upstreams.default,
                isRemapped: false,
                cacheCategory: "other",
            };
        }

        if (identifier.includes("search:") || identifier.includes("isrc:") || identifier.includes("rec:")) {
            cacheCategory = "search";
        }

        if (this.config.remapping.enabled && Array.isArray(this.config.remapping.preRequest)) {
            for (const rule of this.config.remapping.preRequest) {
                let matched = false;

                // Match exact prefix
                if (rule.prefix && identifier.startsWith(rule.prefix)) {
                    matched = true;
                    if (rule.rewritePrefix) {
                        identifier = rule.rewritePrefix + identifier.slice(rule.prefix.length);
                        isRemapped = true;
                        cacheCategory = "search";
                    }
                }

                // Match regex pattern
                if (rule.match && new RegExp(rule.match, "i").test(identifier)) {
                    matched = true;
                }

                if (matched) {
                    appliedRule = rule;
                    if (rule.routeToNode && this.config.upstreams[rule.routeToNode]) {
                        targetNodeName = rule.routeToNode;
                    }
                    if (rule.transformerName) {
                        identifier = await this.transformers.transformQuery(rule.transformerName, identifier);
                        isRemapped = true;
                    }
                    break;
                }
            }
        }

        const targetNode = this.config.upstreams[targetNodeName] || this.config.upstreams.default;

        return {
            transformedIdentifier: identifier,
            targetNode,
            isRemapped,
            appliedRule,
            cacheCategory,
        };
    }

    /**
     * Stage 2: Post-Request On-Fail Fallback Matching
     */
    public async getNextFallback(
        currentIdentifier: string,
        lastErrorMsg: string = "",
        isEmpty: boolean = false,
        usedRuleNames: Set<string> = new Set()
    ): Promise<FallbackResolution | null> {
        if (!this.config.remapping.enabled || !Array.isArray(this.config.remapping.postRequestOnFail)) {
            return null;
        }

        for (const rule of this.config.remapping.postRequestOnFail) {
            if (usedRuleNames.has(rule.name)) continue;

            const regex = new RegExp(rule.match, "i");
            if (!regex.test(currentIdentifier)) continue;

            // Check if error condition matches
            let errorMatches = false;
            if (isEmpty && (rule.fallbackOnEmpty ?? true)) {
                errorMatches = true;
            } else if (Array.isArray(rule.onErrors) && rule.onErrors.length > 0) {
                if (rule.onErrors.includes("*")) {
                    errorMatches = true;
                } else {
                    errorMatches = rule.onErrors.some((errSub) =>
                        lastErrorMsg.toLowerCase().includes(errSub.toLowerCase())
                    );
                }
            } else {
                errorMatches = true;
            }

            if (!errorMatches) continue;

            // Calculate next identifier
            let nextIdentifier = currentIdentifier;

            // If it's a YouTube URL or 11-char ID and fallback has a target prefix, resolve to clean song title
            const ytVideoId =
                extractYouTubeVideoId(currentIdentifier) ||
                (/^[\w-]{11}$/.test(currentIdentifier) ? currentIdentifier : null);

            if (ytVideoId && rule.targetPrefix) {
                const { fetchYouTubeOEmbedTitle } = await import("../transformers");
                const oembed = await fetchYouTubeOEmbedTitle(ytVideoId);
                if (oembed && oembed.title) {
                    nextIdentifier = rule.targetPrefix + oembed.title;
                } else {
                    nextIdentifier = rule.targetPrefix + ytVideoId;
                }
            } else if (rule.rewritePrefix && rule.targetPrefix && nextIdentifier.startsWith(rule.rewritePrefix)) {
                nextIdentifier = rule.targetPrefix + nextIdentifier.slice(rule.rewritePrefix.length);
            } else if (rule.targetPrefix && !nextIdentifier.startsWith(rule.targetPrefix)) {
                if (nextIdentifier.includes("search:")) {
                    const queryPart = nextIdentifier.slice(nextIdentifier.indexOf(":") + 1);
                    nextIdentifier = rule.targetPrefix + queryPart;
                } else {
                    nextIdentifier = rule.targetPrefix + nextIdentifier;
                }
            }

            const targetNodeName = rule.routeToNode || "default";
            const targetNode = this.config.upstreams[targetNodeName] || this.config.upstreams.default;

            return {
                rule,
                nextIdentifier,
                targetNode,
                isEventHub: !!rule.routeToFallbackFn && !!rule.eventHubHandler,
                isInProcess: !!rule.inProcessTransformer,
                handlerName: rule.eventHubHandler || rule.inProcessTransformer,
            };
        }

        return null;
    }
}
