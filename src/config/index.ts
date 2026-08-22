import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LavalinkProxyConfig } from "../types";

const filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(filename), "../..");

function assertPositiveNumber(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
}

export function deepMerge<T extends Record<string, any>>(target: T, source: Record<string, any>): T {
    const result: any = { ...target };
    for (const [key, value] of Object.entries(source)) {
        if (value === undefined) continue;
        if (value && typeof value === "object" && !Array.isArray(value)) {
            result[key] = deepMerge(target[key] || {}, value);
        } else {
            result[key] = value;
        }
    }
    return result;
}

export function validateConfig(config: LavalinkProxyConfig): LavalinkProxyConfig {
    if (!config?.server || !config?.upstreams?.default) {
        throw new Error("Configuration must define server and upstreams.default");
    }
    assertPositiveNumber(config.server.port, "server.port");
    assertPositiveNumber(config.remapping.maxRecursionDepth, "remapping.maxRecursionDepth");
    if (!config.server.password) throw new Error("server.password must not be empty");
    if (config.eventHub.enabled && !config.eventHub.authToken?.trim()) {
        throw new Error("eventHub.authToken must not be empty when Event Hub is enabled");
    }
    if (!/^[a-zA-Z0-9:_-]{1,64}$/.test(config.dragonfly.keyPrefix)) {
        throw new Error("dragonfly.keyPrefix must use 1-64 safe characters");
    }

    const publicBind = !["127.0.0.1", "::1", "localhost"].includes(config.server.host);
    if (publicBind && config.server.password === "youshallnotpass") {
        console.warn("[Config:SECURITY] Replace the default password before exposing this proxy to a network");
    }

    for (const [name, node] of Object.entries(config.upstreams)) {
        if (!node?.id || !node.url) throw new Error(`upstreams.${name} requires id and url`);
        const httpUrl = new URL(node.url);
        if (httpUrl.protocol !== "http:" && httpUrl.protocol !== "https:") {
            throw new Error(`upstreams.${name}.url must use http or https`);
        }
        node.url = node.url.replace(/\/$/, "");
        if (node.wsUrl) {
            const wsUrl = new URL(node.wsUrl);
            if (wsUrl.protocol !== "ws:" && wsUrl.protocol !== "wss:") {
                throw new Error(`upstreams.${name}.wsUrl must use ws or wss`);
            }
        }
    }
    config.upstreams.default.enabled = true;
    return config;
}

/** Load config.ts when present, merged with optional config.overwrites.ts */
export async function loadConfig(): Promise<LavalinkProxyConfig> {
    const customPath = path.resolve(rootDir, "config.ts");
    const examplePath = path.resolve(rootDir, "config.example.ts");
    const selectedPath = (await Bun.file(customPath).exists()) ? customPath : examplePath;

    if (!(await Bun.file(selectedPath).exists())) {
        throw new Error("No config.ts or config.example.ts was found");
    }

    try {
        const imported = await import(`file://${selectedPath}?t=${Date.now()}`);
        let baseConfig: LavalinkProxyConfig = validateConfig(imported.config || imported.default || imported);

        // Check for persistent overwrites (config.overwrites.ts or config.overwrites.json)
        const overwritesTsPath = path.resolve(rootDir, "config.overwrites.ts");
        const overwritesJsonPath = path.resolve(rootDir, "config.overwrites.json");

        if (await Bun.file(overwritesTsPath).exists()) {
            try {
                const overwritesModule = await import(`file://${overwritesTsPath}?t=${Date.now()}`);
                const overwrites = overwritesModule.overwrites || overwritesModule.default || overwritesModule;
                if (overwrites && typeof overwrites === "object") {
                    baseConfig = validateConfig(deepMerge(baseConfig, overwrites));
                    console.log(`[Config] Loaded persistent overrides from ${path.basename(overwritesTsPath)}`);
                }
            } catch (err) {
                console.warn(`[Config] Failed to load ${path.basename(overwritesTsPath)}:`, err);
            }
        } else if (await Bun.file(overwritesJsonPath).exists()) {
            try {
                const text = await Bun.file(overwritesJsonPath).text();
                const overwrites = JSON.parse(text);
                if (overwrites && typeof overwrites === "object") {
                    baseConfig = validateConfig(deepMerge(baseConfig, overwrites));
                    console.log(`[Config] Loaded persistent overrides from ${path.basename(overwritesJsonPath)}`);
                }
            } catch (err) {
                console.warn(`[Config] Failed to load ${path.basename(overwritesJsonPath)}:`, err);
            }
        }

        return baseConfig;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load ${path.basename(selectedPath)}: ${message}`);
    }
}

/** Save persistent overrides to config.overwrites.ts and config.overwrites.json */
export async function saveConfigOverwrites(overwrites: Record<string, any>): Promise<void> {
    const overwritesTsPath = path.resolve(rootDir, "config.overwrites.ts");
    const overwritesJsonPath = path.resolve(rootDir, "config.overwrites.json");

    // Format TypeScript file
    const tsContent = `import type { LavalinkProxyConfig } from "./src/types";

/**
 * Runtime Persistent Overwrites for Lavalink Dragonfly Proxy
 * Generated automatically by the Admin REST API / Dashboard on ${new Date().toISOString()}.
 * Delete this file or call POST /proxy/config/reset to revert to base config.
 */
export const overwrites: Partial<LavalinkProxyConfig> = ${JSON.stringify(overwrites, null, 4)};

export default overwrites;
`;

    await Promise.all([
        Bun.write(overwritesTsPath, tsContent),
        Bun.write(overwritesJsonPath, JSON.stringify(overwrites, null, 4)),
    ]);
}

/** Clear persistent overrides */
export async function clearConfigOverwrites(): Promise<void> {
    const overwritesTsPath = path.resolve(rootDir, "config.overwrites.ts");
    const overwritesJsonPath = path.resolve(rootDir, "config.overwrites.json");

    const tsFile = Bun.file(overwritesTsPath);
    const jsonFile = Bun.file(overwritesJsonPath);

    if (await tsFile.exists()) {
        const fs = await import("node:fs/promises");
        await fs.unlink(overwritesTsPath).catch(() => {});
    }
    if (await jsonFile.exists()) {
        const fs = await import("node:fs/promises");
        await fs.unlink(overwritesJsonPath).catch(() => {});
    }
}
