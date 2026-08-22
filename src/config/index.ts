import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LavalinkProxyConfig } from "../types";

const filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(filename), "../..");

function assertPositiveNumber(value: number, name: string): void {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
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

/** Load config.ts when present, otherwise the tracked environment-driven template. */
export async function loadConfig(): Promise<LavalinkProxyConfig> {
    const customPath = path.resolve(rootDir, "config.ts");
    const examplePath = path.resolve(rootDir, "config.example.ts");
    const selectedPath = await Bun.file(customPath).exists() ? customPath : examplePath;

    if (!await Bun.file(selectedPath).exists()) {
        throw new Error("No config.ts or config.example.ts was found");
    }

    try {
        const imported = await import(`file://${selectedPath}?t=${Date.now()}`);
        return validateConfig(imported.config || imported.default || imported);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to load ${path.basename(selectedPath)}: ${message}`);
    }
}
