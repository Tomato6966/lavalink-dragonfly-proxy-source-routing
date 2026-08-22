# Source Routing & Fallback Cascades

The proxy features a declarative **Source Routing & Cascade Engine** designed to handle complex track transformation, multi-stage fallback paths, and adaptive route learning.

---

## 🔀 The Two-Phase Routing Model

```mermaid
flowchart TD
    Raw["Incoming Identifier\n(e.g., Spotify URL / Search / ISRC)"] --> Phase1["Phase 1: Pre-Request Pipeline"]
    
    subgraph PreReq ["Pre-Request Rules"]
        Clean["Clean Tracking Parameters (utm_*, si=*)"]
        ISRC["Normalize ISRC Format"]
        Rewrite["Prefix Rewrites (e.g. spsearch: -> dzsearch:)"]
    end
    
    Phase1 --> PreReq --> RouteCheck{"Learned Route in Cache?"}
    
    RouteCheck -->|Yes| FastPath["Fast-Path to Learned Upstream Node\n(Bypass Cascade)"]
    RouteCheck -->|No| Primary["Execute Primary Upstream Request"]
    
    FastPath --> CheckSuccess1{"Success?"}
    Primary --> CheckSuccess1
    
    CheckSuccess1 -->|Yes| Success["Cache LoadResult (31d) & Save Learned Route"]
    CheckSuccess1 -->|No| Phase2["Phase 2: Cascading Fallbacks"]
    
    subgraph FallbackCascade ["Fallback Waterfall Rules"]
        direction TB
        F1["Rule 1: Direct Link -> ytsearch:"]
        F2["Rule 2: ytsearch: -> dzsearch:"]
        F3["Rule 3: dzsearch: -> Event Hub Worker RPC"]
        F4["Rule 4: Last Resort SoundCloud (scsearch:)"]
        F5["Rule 5: DisTube YouTube Scraper Resolver"]
        
        F1 --> F2 --> F3 --> F4 --> F5
    end
    
    Phase2 --> FallbackCascade
    FallbackCascade --> CheckSuccess2{"Any Rule Succeeded?"}
    CheckSuccess2 -->|Yes| Success
    CheckSuccess2 -->|No| Fail["Return Lavalink Error Result (502 Bad Gateway)"]
```

---

## 🛠️ Phase 1: Pre-Request Transformations

Configured in `config.remapping.preRequest`:

```typescript
preRequest: [
    {
        name: "cleanTracking",
        transformerName: "cleanUrlTracking", // Strips ?si=, &utm_source=, etc.
    },
    {
        name: "normalizeIsrc",
        match: "isrc:",
        transformerName: "normalizeIsrc",    // Normalizes CC-XXX-YY-NNNNN
    },
    {
        name: "spotifySearchToDeezer",
        prefix: "spsearch:",
        rewritePrefix: "dzsearch:",          // Routes spotify searches to fast Deezer backend
    },
    {
        name: "youtubeUrlToTitleSearch",
        match: "^https?://(www\\.|music\\.)?(youtube\\.com|youtu\\.be)/",
        transformerName: "youtubeUrlToTitleSearch",
    },
]
```

---

## 🌊 Phase 2: Post-Request Fallback Cascades

Configured in `config.remapping.postRequestOnFail`:

If an upstream request results in an empty search result, 429 rate-limit, or HTTP 500 error, the proxy activates the fallback chain:

1. **`spotifyDirectMetadataFallback`**: Fetches metadata for Spotify URLs via unauthenticated Spotify token API and converts it into a YouTube/Deezer search.
2. **`youtubeDirectLinkFailToSearch`**: If a direct YouTube video URL fails (e.g. age-restricted or region-locked), extracts title metadata and converts to `ytsearch:`.
3. **`youtubeSearchFailToDeezer`**: If `ytsearch:` fails or is rate-limited, attempts `dzsearch:` on Deezer.
4. **`deezerFailToEventHubWorker`**: Dispatches fallback request to connected external Discord bot workers via Event Hub RPC.
5. **`lastResortSoundCloud`**: Tries `scsearch:` as an audio fallback.
6. **`lastResortDistubeYoutubeSearch`**: Uses DisTube's scraper engine as a final resolver.

---

## 🧠 Adaptive Route Learning (`LearnedRoute`)

When a fallback rule succeeds after multiple failed attempts (e.g. YouTube was blocked, but Deezer succeeded on attempt 3):
- The proxy creates a `LearnedRoute` record in Dragonfly:
  ```json
  {
    "targetNodeName": "default",
    "transformedIdentifier": "dzsearch:Artist - Title",
    "cacheCategory": "search",
    "encodingScope": "lavalink-main",
    "learnedAt": 1724310000000,
    "attemptsSaved": 2
  }
  ```
- **TTL**: 30 minutes (`ROUTE_LEARNING_TTL=1800`).
- **Impact**: Any subsequent request for that track immediately jumps to the working provider on Attempt 1, completely skipping failed cascade hops!
