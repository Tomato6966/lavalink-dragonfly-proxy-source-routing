import path from "path";
import { fileURLToPath } from "url";
import type { LavalinkProxyConfig } from "../types";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "../..");

/**
 * Loads the active configuration from config.ts or config.example.ts
 */
export async function loadConfig(): Promise<LavalinkProxyConfig> {
    const configTsPath = path.resolve(rootDir, "config.ts");
    const exampleTsPath = path.resolve(rootDir, "config.example.ts");

    try {
        if (await Bun.file(configTsPath).exists()) {
            const imported = await import(`file://${configTsPath}?t=${Date.now()}`);
            return imported.config || imported.default || imported;
        }

        if (await Bun.file(exampleTsPath).exists()) {
            const imported = await import(`file://${exampleTsPath}`);
            return imported.config || imported.default || imported;
        }
    } catch (err: any) {
        console.error(`[Config] Error loading config.ts:`, err?.message);
    }

    // Default Fallback
    return {
        server: {
            port: Number(process.env.PORT || 2332),
            host: process.env.HOST || "0.0.0.0",
            password: process.env.PASSWORD || "youshallnotpass",
        },
        dragonfly: {
            enabled: process.env.DRAGONFLY_ENABLED !== "false",
            url: process.env.DRAGONFLY_URL || "redis://127.0.0.1:6379",
            password: process.env.DRAGONFLY_PASSWORD || process.env.PASSWORD || "youshallnotpass",
            keyPrefix: "lavalink_proxy",
            searchTtlSeconds: 259200,
            trackTtlSeconds: 86400,
            lyricsTtlSeconds: 604800,
            maxCachedEntries: 100000,
        },
        eventHub: {
            enabled: true,
            path: "/proxy/events",
            authToken: "youshallnotpass",
            defaultTimeoutMs: 3000,
        },
        remapping: {
            enabled: true,
            maxRecursionDepth: 4,
            preRequest: [],
            postRequestOnFail: [],
        },
        upstreams: {
            default: {
                id: "lavalink_main",
                url: "http://127.0.0.1:2333",
                password: "youshallnotpass",
            },
        },
        logging: {
            debug: false,
            logHits: true,
            logMisses: true,
            logRoutes: true,
            logFallbacks: true,
        },
    };
}
