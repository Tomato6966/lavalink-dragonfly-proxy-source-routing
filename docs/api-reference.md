# REST API & Protocol Reference

The proxy implements the full **Lavalink v4 REST API**, alongside additional proxy administration, caching, and prefetch endpoints.

---

## 🔒 Authentication

All requests (except `/proxy/health`) require the Lavalink password sent via the `Authorization` header:
```http
Authorization: M!v4tor2026
```

---

## 🎧 Lavalink Core Endpoints

### 1. Load Tracks
- **Method**: `GET`
- **Path**: `/v4/loadtracks?identifier=<encoded_query>`
- **Description**: Loads tracks, searches, or playlists with full multi-tier caching and request coalescing.
- **Custom Response Headers**:
  - `X-Proxy-Cache`: `HIT` | `MISS`
  - `X-Proxy-Node`: `cache` | `lavalink_main` | `nodelink_backup` | `eventhub:<handler>`
  - `X-Proxy-Attempts`: Number of cascade attempts executed (e.g. `1`, `2`)
  - `X-Proxy-Coalesced`: `HIT` (if coalesced with another active request)
  - `X-Proxy-Learned-Route`: `HIT` (if served via learned fast-path)

### 2. Player Updates (Direct Identifier Playback)
- **Method**: `PATCH`
- **Path**: `/v4/sessions/:sessionId/players/:guildId?noReplace=true|false`
- **Description**: Updates player state. If `track.identifier` is provided without `track.encoded`, the proxy automatically resolves, caches, and injects the encoded track.
- **Payload Example**:
  ```json
  {
    "track": {
      "identifier": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
      "userData": { "requester": "user#1234" }
    },
    "volume": 80
  }
  ```
- **Response Headers**:
  - `X-Proxy-Direct-Playback`: `RESOLVED`
  - `X-Proxy-Cache`: `HIT` | `MISS`

### 3. Decode Single Track
- **Method**: `GET`
- **Path**: `/v4/decodetrack?encodedTrack=<base64_encoded_track>`
- **Description**: Returns the decoded track metadata struct with caching.

### 4. Decode Multiple Tracks
- **Method**: `POST`
- **Path**: `/v4/decodetracks`
- **Payload**: `["base64_encoded_1", "base64_encoded_2"]`
- **Description**: Batch decodes tracks with multi-cache lookup.

---

## ⚡ Proxy Extension Endpoints

### 5. Speculative Queue Prefetch
- **Method**: `POST`
- **Path**: `/proxy/cache/prefetch` or `/v4/loadtracks/prefetch`
- **Payload**:
  ```json
  {
    "identifiers": [
      "dzsearch:Artist - Title",
      "https://open.spotify.com/track/..."
    ]
  }
  ```
- **Response**:
  ```json
  {
    "status": "ok",
    "prefetched": 2,
    "results": [
      { "identifier": "dzsearch:Artist - Title", "status": "ok", "loadType": "track", "cached": false }
    ]
  }
  ```

### 6. Health & Liveness Probe
- **Method**: `GET`
- **Path**: `/proxy/health`
- **Auth**: None (Public)
- **Response**:
  ```json
  {
    "status": "ok",
    "ready": true,
    "cacheReady": true,
    "uptimeSeconds": 1423
  }
  ```

### 7. Proxy & Cache Statistics
- **Method**: `GET`
- **Path**: `/proxy/stats`
- **Auth**: Required
- **Response**:
  ```json
  {
    "status": "ok",
    "runtime": "Bun",
    "uptimeSeconds": 1423,
    "cacheConnected": true,
    "cacheStats": {
      "hits": 4512,
      "memoryHits": 3102,
      "fuzzyHits": 14,
      "misses": 830,
      "writes": 830,
      "estimatedEntries": 830
    },
    "proxyStats": {
      "coalescedRequests": 182,
      "rejectedRequests": 0,
      "upstreamTimeouts": 0,
      "upstreamFailures": 0,
      "circuitBreakerRejects": 0
    }
  }
  ```

### 8. Combined Monitoring Snapshot
- **Method**: `GET`
- **Path**: `/proxy/monitoring`
- **Auth**: Required
- **Response**: Combined object containing both `health` and `stats` payloads.

### 9. Clear Cache
- **Method**: `POST`
- **Path**: `/proxy/cache/clear`
- **Auth**: Required
- **Response**:
  ```json
  {
    "success": true,
    "deleted": 830
  }
  ```

---

## 🔌 WebSocket Gateway

- **Path**: `/v4/websocket`
- **Headers**:
  - `Authorization: <password>`
  - `User-Id: <discord_bot_id>`
  - `Client-Name: <client_name>`
- **Description**: Transparent, low-latency WebSocket connection to the primary Lavalink upstream node with frame queue protection.
