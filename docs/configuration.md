# Configuration Guide

The proxy configuration is loaded via environment variables (`.env`) and validated in [config.ts](file:///home/MivatorProjects/lavalink-dragonfly-proxy-source-routing/config.ts).

---

## ⚙️ Environment Variables Reference

### 🌐 Server & Network

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `2332` | HTTP and WebSocket listening port |
| `HOST` | `0.0.0.0` | Bind IP address |
| `PASSWORD` | `M!v4tor2026` | Authorization password for bots |
| `MAX_IN_FLIGHT_REQUESTS` | `1000` | Maximum simultaneous in-flight load requests |
| `MAX_LOAD_RESULT_BYTES` | `8388608` | Max response payload size (8 MB) |
| `WS_MAX_QUEUE_MESSAGES` | `256` | Max WebSocket outbound queue buffer length |
| `WS_MAX_QUEUE_BYTES` | `1048576` | Max WebSocket buffer in bytes (1 MB) |

---

### 🗄️ Multi-Tier Cache (Memory + Dragonfly)

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MEMORY_CACHE_MAX_ENTRIES` | `1000` | Max entries in local L1 In-Memory Cache |
| `MEMORY_CACHE_TTL` | `604800` | Lifespan in L1 cache (7 days = 604,800s) |
| `MAX_CACHED_ENTRIES` | `100000` | Max entries in L2 Dragonfly Cache (100k tracks) |
| `TRACK_TTL` | `2678400` | Dragonfly track TTL (31 days = 2,678,400s) |
| `SEARCH_TTL` | `2678400` | Dragonfly search query TTL (31 days) |
| `LYRICS_TTL` | `604800` | Lyrics cache TTL (7 days) |
| `DRAGONFLY_ENABLED` | `true` | Enables or disables Dragonfly backend |
| `DRAGONFLY_URL` | `redis://127.0.0.1:6666` | Dragonfly connection URL |
| `DRAGONFLY_PASSWORD` | `Mivator§2024!` | Dragonfly authentication password |
| `DRAGONFLY_KEY_PREFIX` | `mivator:lavalink` | Redis key namespace prefix |
| `DRAGONFLY_COMMAND_TIMEOUT_MS`| `750` | Maximum Redis command execution time (ms) |
| `CACHE_TTL_JITTER` | `0.05` | Random jitter percentage to prevent thundering herd |
| `FUZZY_SEARCH_ENABLED` | `false` | Enables Levenshtein fuzzy query matching |
| `FUZZY_SEARCH_THRESHOLD` | `0.9` | Similarity threshold for fuzzy hits (0.8 - 1.0) |

---

### 🔀 Upstream Nodes & Circuit Breakers

| Variable | Default | Description |
| :--- | :--- | :--- |
| `UPSTREAM_DEFAULT_URL` | `http://127.0.0.1:2333` | Primary Lavalink HTTP URL |
| `UPSTREAM_DEFAULT_WS_URL` | `ws://127.0.0.1:2333/v4/websocket` | Primary Lavalink WebSocket URL |
| `UPSTREAM_DEFAULT_PASSWORD` | `M!v4tor2026` | Primary node password |
| `UPSTREAM_DEFAULT_ENCODING_SCOPE` | `lavalink-main` | Encoding scope identifier |
| `UPSTREAM_DEFAULT_TIMEOUT_MS` | `3500` | HTTP request timeout for primary node |
| `UPSTREAM_DEFAULT_FAILURE_THRESHOLD` | `5` | Errors before circuit trips open |
| `UPSTREAM_DEFAULT_CIRCUIT_RESET_MS` | `15000` | Duration circuit stays open (15s) |

---

### 🔄 Routing, Fallbacks & Route Learning

| Variable | Default | Description |
| :--- | :--- | :--- |
| `MAX_RECURSION_DEPTH` | `4` | Maximum fallback attempts per request |
| `REMAPPING_ENABLED` | `true` | Enables pre-request and fallback rules |
| `ROUTE_LEARNING_ENABLED` | `true` | Enables fast-path route learning |
| `ROUTE_LEARNING_TTL` | `1800` | Learned route expiration (30 minutes) |
| `SPOTIFY_METADATA_TIMEOUT_MS` | `1800` | Spotify metadata resolver timeout |
| `DISTUBE_YTSR_ENABLED` | `true` | Enables DisTube YouTube search fallback |
| `DISTUBE_YTSR_TIMEOUT_MS` | `1800` | DisTube search timeout |

---

### 📡 Event Hub RPC Configuration

| Variable | Default | Description |
| :--- | :--- | :--- |
| `EVENT_HUB_ENABLED` | `true` | Enables external worker RPC |
| `EVENT_HUB_PATH` | `/proxy/events` | Event Hub WebSocket path |
| `EVENT_HUB_AUTH_TOKEN` | `M!v4tor2026` | Worker authentication token |
| `EVENT_HUB_TIMEOUT_MS` | `3500` | Max timeout for worker RPC calls |
| `EVENT_HUB_ENCODING_SCOPE` | `lavalink-main` | Worker-produced encoding scope |

---

### 📝 Logging

| Variable | Default | Description |
| :--- | :--- | :--- |
| `LOG_DEBUG` | `false` | Verbose debug logging |
| `LOG_HITS` | `true` | Log cache hit events |
| `LOG_MISSES` | `true` | Log cache miss events |
| `LOG_ROUTES` | `true` | Log request routing & cascade hops |
| `LOG_FALLBACKS` | `true` | Log fallback activations |
