# Lavalink Dragonfly Proxy, Source Router & Event Hub (100% Native Bun)

A blazing fast caching proxy, multi-stage source-remapping router, and **Event Hub RPC engine** built on **100% Native Bun (`Bun.serve`)** for **Lavalink v4** and **NodeLink**.

---

## 🌟 Key Features

1. **⚡ 100% Native Bun Architecture (`Bun.serve`):**
   - Built on Bun's internal uWebSockets and native zero-copy HTTP streaming engine.
   - Ultra-low memory footprint, sub-millisecond response latency, and managed with `bun.lock`.

2. **⚙️ Type-Safe `config.ts` & `.env` Support:**
   - Full TypeScript auto-completion for all settings.
   - Reads environment variables dynamically from `.env` files.

3. **🛠️ Lavalink v4 Response Builders (`src/builders`):**
   - Type-safe, memory-efficient constructors for tracks, playlists, search results, and safe errors.

4. **⚡ Dragonfly / Redis Cache & LRU Auto-Eviction (`src/cache`):**
   - Caches `/v4/loadtracks?identifier=...` searches and track lookups in Dragonfly/Redis.
   - Responds in **`< 0.5ms`** on cache hits with `X-Proxy-Cache: HIT`.
   - `maxCachedEntries`: Automatically enforces a memory ceiling by evicting oldest entries with an LRU index.

5. **🔀 Multi-Stage Source Remapping & Cascade Chains (`src/routing`):**
   - **`preRequest` Rules:** Transform queries before the first request (e.g. `spsearch:` ➔ `dzsearch:`, strip tracking parameters).
   - **`postRequestOnFail` Fallback Chains:** Trigger sequential fallbacks when upstream returns `loadType: "error"` or `loadType: "empty"` or network errors (e.g., YouTube fail ➔ route to NodeLink ➔ fallback to Deezer ➔ fallback to Event Hub ➔ fallback to SoundCloud).
   - **`maxRecursionDepth`:** Loop & cycle protection to prevent infinite fallback cascades.

6. **📡 Event Hub RPC Protocol (`src/eventHub`):**
   - External clients (your Discord bot, worker scripts, or scrapers) connect to `ws://localhost:2332/proxy/events`.
   - When a fallback triggers `routeToFallbackFn: true`, the proxy emits an RPC request to the connected client.
   - The client resolves tracks with custom code and returns the Lavalink JSON response back to the proxy within a configured timeout!

7. **🌐 Multi-Node Upstream Routing:**
   - Route specific sources or regex patterns to dedicated nodes (e.g. YouTube ➔ NodeLink on port `2334`, Deezer/Spotify ➔ Lavalink on port `2333`).

---

## 🛠️ Configuration Guide (`config.ts` / `.env`)

### Option 1: Edit `config.ts` (Type-Safe TypeScript)

```typescript
import type { LavalinkProxyConfig } from "./src/types";

export const config: LavalinkProxyConfig = {
    server: {
        port: Number(process.env.PORT || 2332),
        host: "0.0.0.0",
        password: process.env.PASSWORD || "youshallnotpass",
    },
    dragonfly: {
        enabled: true,
        url: process.env.DRAGONFLY_URL || "redis://127.0.0.1:6379",
        keyPrefix: "lavalink_proxy",
        searchTtlSeconds: 259200, // 3 days
        trackTtlSeconds: 86400,   // 24 hours
        lyricsTtlSeconds: 604800, // 7 days
        maxCachedEntries: 100000, // Cap on total cached entries
    },
    eventHub: {
        enabled: true,
        path: "/proxy/events",
        authToken: process.env.PASSWORD || "youshallnotpass",
        defaultTimeoutMs: 3000,
    },
    remapping: {
        enabled: true,
        maxRecursionDepth: 4,
        preRequest: [
            {
                name: "cleanTracking",
                transformerName: "cleanUrlTracking",
            },
            {
                name: "spotifySearchToDeezer",
                prefix: "spsearch:",
                rewritePrefix: "dzsearch:",
            },
        ],
        postRequestOnFail: [
            {
                name: "youtubeLinkFailToNodeLink",
                match: "^https?://(www\\.)?(youtube\\.com|youtu\\.be)/",
                onErrors: ["This video requires login", "All clients failed", "403", "429"],
                routeToNode: "nodelink_node",
            },
            {
                name: "youtubeSearchFailToDeezer",
                match: "^ytsearch:",
                targetPrefix: "dzsearch:",
                routeToNode: "default",
            },
            {
                name: "deezerFailToEventHubWorker",
                match: "^dzsearch:",
                routeToFallbackFn: true,
                eventHubHandler: "resolveFallbackTrack",
                timeoutMs: 3500,
            },
            {
                name: "lastResortSoundCloud",
                match: "^.*$",
                targetPrefix: "scsearch:",
                routeToNode: "default",
            },
        ],
    },
    upstreams: {
        default: {
            id: "lavalink_main",
            url: "http://127.0.0.1:2333",
            wsUrl: "ws://127.0.0.1:2333/v4/websocket",
            password: "youshallnotpass",
        },
        nodelink_node: {
            id: "nodelink_backup",
            url: "http://127.0.0.1:2334",
            wsUrl: "ws://127.0.0.1:2334/v4/websocket",
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

export default config;
```

### Option 2: Use `.env` Variables

Copy `.env.example` to `.env`:
```bash
PORT=2332
PASSWORD=youshallnotpass
DRAGONFLY_URL=redis://127.0.0.1:6379
MAX_CACHED_ENTRIES=100000
UPSTREAM_DEFAULT_URL=http://127.0.0.1:2333
UPSTREAM_NODELINK_URL=http://127.0.0.1:2334
```

---

## 🛠️ Lavalink v4 Response Builders API

Import from `src/builders` to cheaply construct valid Lavalink v4 objects:

```typescript
import {
    buildTrack,
    buildTrackInfo,
    buildSearchResult,
    buildPlaylistResult,
    buildEmptyResult,
    buildErrorResult,
    createFallbackTrack
} from "./src/builders";

// 1. Quick Track
const track = createFallbackTrack(
    "Rolling in the Deep",
    "Adele",
    "https://www.deezer.com/track/123456",
    228000,
    "deezer"
);

// 2. Search Result
const searchResult = buildSearchResult([track]);

// 3. Playlist Result
const playlistResult = buildPlaylistResult("My Favorites", [track]);

// 4. Safe Empty or Error Result
const empty = buildEmptyResult();
const error = buildErrorResult("Video unavailable in your region", "common");
```

---

## 📡 Event Hub RPC Client Tutorial

Connect any client to `ws://localhost:2332/proxy/events` to handle fallback track lookups:

```typescript
import { buildSearchResult, buildTrack, buildTrackInfo } from "./src/builders";

const ws = new WebSocket("ws://127.0.0.1:2332/proxy/events", {
    headers: { Authorization: "youshallnotpass", "Client-Name": "BotWorker" },
});

ws.onopen = () => {
    ws.send(JSON.stringify({
        type: "handshake",
        handlers: ["resolveFallbackTrack"]
    }));
};

ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data.toString());

    if (msg.type === "rpc_request" && msg.handler === "resolveFallbackTrack") {
        const track = buildTrack(buildTrackInfo({
            title: "Resolved Track",
            author: "Custom Artist",
            uri: "https://deezer.com/track/...",
            sourceName: "deezer"
        }));

        ws.send(JSON.stringify({
            type: "rpc_response",
            id: msg.id,
            success: true,
            data: buildSearchResult([track])
        }));
    }
};
```
*(A complete client is provided in [`examples/client-eventhub-example.ts`](examples/client-eventhub-example.ts))*.

---

## 🚀 Running the Proxy

```bash
cd /home/mivator/lavalink-dragonfly-proxy-source-routing

# Run unit tests:
bun test

# Typecheck:
bun run typecheck

# Start the proxy:
bun run start

# Run Event Hub worker example:
bun run example:client
```
