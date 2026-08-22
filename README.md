# Lavalink Dragonfly Proxy & Source Router

A low-latency, drop-in Lavalink v4 proxy built on `Bun.serve`. It keeps the client-facing Lavalink REST/WebSocket contract, caches load results in a small in-process LRU plus Dragonfly/Redis, learns successful fallback routes, and recovers failed searches through ordered backend and metadata-resolver strategies.

The proxy is designed for Lavalink v4 and NodeLink-compatible backends. It is not an audio source implementation.

## The compatibility rule that matters

A Lavalink track's `encoded` value is backend/source-manager state, not metadata. A title, artist, Spotify URL, Deezer record, or YouTube result cannot be turned into a playable track by inventing an encoded string.

This project therefore follows three rules:

1. Local packages only canonicalize metadata or recover a new identifier.
2. The recovered identifier is loaded by a real Lavalink/NodeLink backend.
3. Event Hub workers must return a real load result whose encoded tracks came from a compatible backend.

Keep the backend that loads a track compatible with the backend that plays it. The safest setup uses one default playback backend and its own plugins/source managers for all final encoding. To use NodeLink as the player, configure it as `upstreams.default`; do not casually mix NodeLink-produced encodings into a Lavalink playback session.

The proxy enforces this with `encodingScope`. A successful fallback is returned or cached only when its scope matches `upstreams.default.encodingScope`; Event Hub and in-process fallback rules must explicitly declare the scope of their worker/backend. Cache and learned-route keys are also scope-namespaced. If you keep an ignored custom `config.ts`, add `encodingScope` to those rules before upgrading.

See the official [Lavalink REST API](https://lavalink.dev/api/rest), [WebSocket API](https://lavalink.dev/api/websocket), [NodeLink differences](https://nodelink.js.org/docs/differences), [LavaSrc](https://github.com/topi314/LavaSrc), and the official [Lavalink YouTube source plugin](https://github.com/lavalink-devs/youtube-source).

## What v2 adds

- Case-safe, SHA-256-bounded cache keys. Case-sensitive YouTube/Spotify IDs no longer collide.
- A hot in-process L1 cache in front of Dragonfly.
- Per-process single-flight request coalescing for identical `/v4/loadtracks` misses.
- Pipelined Dragonfly writes, TTL jitter, real namespace clearing, learned-route expiry, playback-scope isolation, and optional fuzzy matching (off by default).
- Composable pre-request rules. Global URL cleanup, prefix rewrites, transformers, and node selection can all run in order.
- Structured fallback conditions for `empty`, `error`, HTTP status, and error-message matching.
- Per-rule timeouts, upstream deadlines, response-size limits, in-flight limits, and per-node circuit breakers.
- Streaming generic REST forwarding instead of buffering entire bodies.
- Bounded WebSocket queues and Bun backpressure limits.
- Event Hub responses bound to the worker that received the RPC, cleanup on disconnect, and least-loaded worker selection.
- Guarded Spotify track/episode recovery through `spotify-url-info` and case-safe parsing through `spotify-uri`.
- A bounded `@distube/ytsr` last resort that returns a YouTube URL to the backend; it never exposes/caches signed stream URLs.
- Reproducible non-root Docker packaging and deterministic tests with no live-network dependency.

## Quick start

Requirements:

- Bun 1.3+
- Lavalink v4 or a NodeLink-compatible backend
- Dragonfly/Redis (optional; the proxy fails open without it)

```bash
bun install --frozen-lockfile

# Minimal local configuration
export PASSWORD='replace-with-a-long-random-secret'
export UPSTREAM_DEFAULT_PASSWORD='your-lavalink-password'
export UPSTREAM_DEFAULT_URL='http://127.0.0.1:2333'
export UPSTREAM_DEFAULT_WS_URL='ws://127.0.0.1:2333/v4/websocket'

bun run check
bun run start
```

Bun automatically reads a local `.env`. Both `.env` and `config.ts` are intentionally ignored so deployment secrets stay outside Git. Copy `config.example.ts` to `config.ts` when you need a fully typed routing policy.

The safe listener default is `127.0.0.1:2332`. Set `HOST=0.0.0.0` only behind an authenticated/private network or reverse proxy and replace the default password first.

## Default fallback policy

The tracked example always tries the original identifier on the real backend first. It only remaps after a failure:

- Failed Spotify track/episode URL → `spotify-url-info` metadata → `ytsearch:artist - title` → backend.
- Failed YouTube URL → official oEmbed title/video ID → `ytsearch:` → backend.
- Failed `ytsearch:`/`ytmsearch:` → `dzsearch:` → backend (use LavaSrc or another compatible source plugin).
- Failed `dzsearch:` → Event Hub worker `resolveFallbackTrack`.
- Failed provider search → `scsearch:` → backend.
- Final search failure → `@distube/ytsr` metadata lookup → direct YouTube URL → backend.

`DISTUBE_YTSR_ENABLED=false` disables the scraper-based last resort. Provider metadata resolvers have strict outer deadlines and only return backend-loadable identifiers.

The historical `youtube-sr` package was evaluated but is not a default dependency: it is archived, lacks built-in abort handling, and its repository/npm license metadata conflicts. The maintained DisTube search adapter fills the same isolated last-resort role. The adapter registry in `src/resolvers` makes adding another resolver straightforward.

## Typed routing rules

```ts
import type { LavalinkProxyConfig } from "./src/types";

const config: LavalinkProxyConfig = {
  // server, cache, Event Hub, upstreams, logging...
  remapping: {
    enabled: true,
    maxRecursionDepth: 6,
    routeLearning: true,
    routeLearningTtlSeconds: 1800,
    preRequest: [
      { name: "clean", transformerName: "cleanUrlTracking" },
      { name: "spotify-search", prefix: "spsearch:", rewritePrefix: "dzsearch:" },
    ],
    postRequestOnFail: [
      {
        name: "youtube-auth-failure",
        match: "^ytsearch:",
        onLoadTypes: ["error"],
        onErrors: ["sign in", "bot check", "403"],
        targetPrefix: "scsearch:",
        routeToNode: "default",
      },
      {
        name: "empty-deezer-result",
        match: "^dzsearch:",
        onLoadTypes: ["empty"],
        fallbackOnEmpty: true,
        routeToFallbackFn: true,
        eventHubHandler: "resolveFallbackTrack",
        timeoutMs: 2500,
        encodingScope: "lavalink-main",
      },
    ],
  },
};
```

Rules are evaluated in order and each fallback rule runs at most once per request. Invalid regular expressions fail closed and are logged. Disabled upstreams fall back to `default`.

Unknown standard/plugin routes are streamed unchanged to the default backend, including `/v4/info`, decode routes, LavaSearch routes, and NodeLink extensions. Player and session routes intentionally remain on the default WebSocket/playback backend.

## Cache design

Default values:

| Data | TTL |
|---|---:|
| Search results | 6 hours |
| Direct tracks/URLs | 24 hours |
| Lyrics | 7 days |
| Learned route | 30 minutes |
| In-process L1 | 5 seconds / 1,000 entries |

Cache schema `v3` intentionally cold-starts on upgrade so older entries without encoding provenance cannot leak across playback backends. Each remote TTL gets ±5% jitter to avoid synchronized expiry. The cache is fail-open with a 750 ms command timeout and no offline command queue. Fuzzy search aliases are disabled by default because automatic typo matching can change user intent; enable them only after measuring your queries.

`maxCachedEntries` provides an application-managed LRU index. For a dedicated Dragonfly deployment, prefer Dragonfly's native memory limit/cache mode and set `MAX_CACHED_ENTRIES=0` to remove the global LRU-index hot key. Keep Dragonfly close to the proxy (same host/AZ/VPC) and measure p95/p99 latency.

Cache hits expose `X-Proxy-Cache: HIT`; coalesced waiters expose `X-Proxy-Coalesced: HIT`; learned routes expose `X-Proxy-Learned-Route: HIT`.

## Event Hub

Workers connect to `ws://127.0.0.1:2332/proxy/events` with `Authorization` and `Client-Name` headers, then register handlers:

```json
{ "type": "handshake", "handlers": ["resolveFallbackTrack"] }
```

RPC responses are accepted only from the selected worker. On disconnect, that worker's pending calls are cancelled so the cascade can continue. See `examples/client-eventhub-example.ts`; its resolver calls a real fallback backend and returns that backend's Lavalink JSON.

Do not return `CUSTOM_TRACK_ENCODED` or metadata-only synthetic tracks. The v2 builders require the encoded value explicitly and reject the old placeholder.

## Operations and security

| Route | Authentication | Purpose |
|---|---|---|
| `GET /proxy/health` | Public/minimal | Process/cache readiness |
| `GET /proxy/stats` | Lavalink password | Cache, breaker, RPC, and coalescing stats |
| `POST /proxy/cache/clear` | Lavalink password | SCAN/UNLINK this proxy namespace |
| `/v4/*` | Lavalink password | Proxied Lavalink/NodeLink API |
| `/v4/websocket` | Lavalink password | Default backend session tunnel |

Passwords are never accepted through query strings. Keep Dragonfly private, use a restricted ACL/TLS where appropriate, and never place credentials in upstream URLs committed to Git.

## Docker

```bash
docker build -t lavalink-dragonfly-proxy .
docker run --rm -p 2332:2332 \
  -e PASSWORD='replace-with-a-long-random-secret' \
  -e UPSTREAM_DEFAULT_URL='http://host.docker.internal:2333' \
  -e UPSTREAM_DEFAULT_WS_URL='ws://host.docker.internal:2333/v4/websocket' \
  -e UPSTREAM_DEFAULT_PASSWORD='your-lavalink-password' \
  -e DRAGONFLY_URL='redis://host.docker.internal:6379' \
  lavalink-dragonfly-proxy
```

The image includes the tracked environment-driven config only. Mount an ignored `config.ts` at `/app/config.ts` if you need custom rules.

## Development

```bash
bun run typecheck
bun test
bun run check
```

The test suite covers builders, case-safe cache canonicalization, Spotify URI mapping, routing composition, structured failures, encoding-scope isolation, malformed payload rejection, WebSocket close-code safety, authenticated admin routes, real cache clearing, and concurrent request coalescing.

## Inspiration and source adapters

The provider-adapter boundary draws on the strongest ideas in the older Deezcord and better-erela Apple/Deezer projects: dispatch by provider resource type, retain stable provider IDs, separate display metadata from normalized matching text, bound pagination, and postpone expensive unresolved-track conversion until needed. This implementation avoids their old Erela monkey patches, unbounded API calls/token refresh, and playlist-wide conversion bursts.

For full Spotify/Deezer/Apple playlist and album support, use LavaSrc/a backend source manager or an Event Hub worker that asks a compatible backend to resolve each selected item. Metadata previews and signed media URLs are not durable playback tracks.

## License

MIT
