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

5. **🧠 Levenshtein Fuzzy Typo Matching:**
   - Automatically detects typos in search queries (e.g. `swwet dreams are nade of these` ➔ `sweet dreams are made of these`) with $\ge 85\%$ similarity.
   - Instant cache hit without querying upstreams for minor typos!
   - Distinguishes intentionally distinct searches (e.g., adding `by marilyn manson`) and resolves them separately.

6. **🔗 YouTube Direct URL Video-ID Fallback Cascade:**
   - Extracts 11-character video IDs from `youtube.com/watch?v=...`, `youtu.be/...`, and `music.youtube.com/...`.
   - When upstream Lavaplayer fails on direct stream links (due to `FriendlyException` or IP blocks), the proxy automatically cascades to `ytsearch:${videoId}` via Innertube.

7. **🔀 Multi-Stage Source Remapping & Cascade Chains (`src/routing`):**
   - **`preRequest` Rules:** Transform queries before the first request (e.g. `spsearch:` ➔ `dzsearch:`, strip tracking parameters).
   - **`postRequestOnFail` Fallback Chains:** Trigger sequential fallbacks when upstream returns `loadType: "error"` or `loadType: "empty"` or network errors (e.g., YouTube fail ➔ route to NodeLink ➔ fallback to Deezer ➔ fallback to Event Hub ➔ fallback to SoundCloud).
   - **`maxRecursionDepth`:** Loop & cycle protection to prevent infinite fallback cascades.

8. **📡 Event Hub RPC Protocol (`src/eventHub`):**
   - External clients (your Discord bot, worker scripts, or scrapers) connect to `ws://localhost:2332/proxy/events`.
   - When a fallback triggers `routeToFallbackFn: true`, the proxy emits an RPC request to the connected client.
   - The client resolves tracks with custom code and returns the Lavalink JSON response back to the proxy within a configured timeout!

9. **🌐 Multi-Node Upstream Routing:**
   - Route specific sources or regex patterns to dedicated nodes (e.g. YouTube ➔ NodeLink on port `2334`, Deezer/Spotify ➔ Lavalink on port `2333`).

---

## ⏳ Cache Specifications & TTLs

| Cache Category | Default TTL | Config Key / Env Variable | Description |
|---|---|---|---|
| **Search Queries** | **3 Days** (259,200s) | `searchTtlSeconds` / `SEARCH_TTL` | Cached search results for `dzsearch:`, `ytsearch:`, `scsearch:`, etc. |
| **Direct Tracks & URLs** | **24 Hours** (86,400s) | `trackTtlSeconds` / `TRACK_TTL` | Individual track metadata and direct URL lookups. |
| **Lyrics** | **7 Days** (604,800s) | `lyricsTtlSeconds` / `LYRICS_TTL` | Synchronized and plain text lyrics. |
| **Max Cached Entries** | **100,000 items** | `maxCachedEntries` / `MAX_CACHED_ENTRIES` | Hard memory ceiling with automatic LRU eviction. |

---

## 🧠 Levenshtein Fuzzy Typo Matching

The proxy uses an optimized **Levenshtein Distance & Similarity Algorithm** on incoming search queries:

- **Similarity Formula:**
  $$\text{Similarity}(A, B) = 1 - \frac{\text{LevenshteinDistance}(A, B)}{\max(|A|, |B|)}$$

### Typo Resolution Examples:

1. **Typo Match ($\ge 85\%$ Similarity):**
   - *Original Search:* `sweet dreams are made of these` (len 30)
   - *Typo Query:* `swwet dreams are nade of these` (len 30)
   - *Edit Distance:* 2 ('w' $\leftrightarrow$ 'e', 'n' $\leftrightarrow$ 'm')
   - *Similarity:* $93.3\%$ ($\ge 85\%$)
   - **Action:** Returns the cached result immediately in **$\approx 1.5\text{ms}$** and automatically aliases the typo key in Dragonfly.

2. **Distinct Search Query ($< 85\%$ Similarity):**
   - *Original Search:* `sweet dreams are made of these`
   - *Targeted Query:* `sweet dreams are made of these by marilyn manson`
   - *Similarity:* $62.5\%$ ($< 85\%$)
   - **Action:** Differentiated as a distinct query and searched separately upstream.

---

## 🔗 YouTube Direct Link & Fallback Cascade

When loading YouTube or YouTube Music URLs directly (`music.youtube.com/watch?v=...`, `youtube.com/watch?v=...`, `youtu.be/...`), YouTube frequently rate-limits direct stream requests and returns `FriendlyException: Something went wrong while looking up the track`.

The proxy resolves this automatically:
1. Extracts the **11-character video ID** (`extractYouTubeVideoId`).
2. If the direct URL fails with any error, the fallback rule `youtubeDirectLinkFailToSearch` triggers.
3. The proxy cascades to `ytsearch:${videoId}` to load the track via Innertube, returning a valid Lavalink track response with **0 errors**.

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
            {
                name: "youtubeUrlToSearch",
                match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
                transformerName: "youtubeUrlToSearch",
            },
        ],
        postRequestOnFail: [
            {
                name: "youtubeDirectLinkFailToSearch",
                match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
                onErrors: ["*"],
                targetPrefix: "ytsearch:",
                routeToNode: "default",
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
SEARCH_TTL=259200
TRACK_TTL=86400
LYRICS_TTL=604800
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
    createFallbackTrack,
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
    ws.send(
        JSON.stringify({
            type: "handshake",
            handlers: ["resolveFallbackTrack"],
        })
    );
};

ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data.toString());

    if (msg.type === "rpc_request" && msg.handler === "resolveFallbackTrack") {
        const track = buildTrack(
            buildTrackInfo({
                title: "Resolved Track",
                author: "Custom Artist",
                uri: "https://deezer.com/track/...",
                sourceName: "deezer",
            })
        );

        ws.send(
            JSON.stringify({
                type: "rpc_response",
                id: msg.id,
                success: true,
                data: buildSearchResult([track]),
            })
        );
    }
};
```

_(A complete client is provided in [`examples/client-eventhub-example.ts`](examples/client-eventhub-example.ts))_.

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

### Start via pm2

```bash
pm2 start --name "[:2332] Lavalink-Dragonfly-Proxy" bun -- run start
```
