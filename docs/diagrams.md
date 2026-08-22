# System Visualizations & Diagrams

This document contains Mermaid diagrams illustrating data flow, caching hierarchies, direct playback mechanics, and fault tolerance workflows within the proxy.

---

## 1. Overall System Architecture

```mermaid
graph TD
    subgraph Clients ["Discord Music Bots & Clients"]
        Bot1["Bot Shard A"]
        Bot2["Bot Shard B"]
        WebUI["Web Dashboard"]
    end

    subgraph ProxyGateway ["Lavalink Dragonfly Proxy (Port 2332)"]
        direction TB
        AuthFilter["Authentication Layer"]
        ReqCoalescer["In-Flight Request Coalescer"]
        
        subgraph CacheEngine ["Multi-Tier Cache Subsystem"]
            L1Map["L1 Hot In-Memory LRU\n(1,000 Tracks / 7 Days)"]
            L2Dragon["L2 Dragonfly Redis DB\n(100k Tracks / 31 Days)"]
            FuzzyIdx["Fuzzy Search Index"]
        end

        subgraph CoreLogic ["Routing & Processing Core"]
            DirectPlayProc["Direct Identifier Playback Interceptor"]
            DecodeProc["Track Decoder Cache (/v4/decodetrack)"]
            PreRouter["Pre-Request Transformer (ISRC/URL Clean)"]
            CascadeEngine["Fallback Cascade Engine"]
            LearnedStore["Learned Route Fast-Path Cache"]
            CircuitManager["Circuit Breakers"]
        end

        WSGateway["WebSocket Gateway & Buffer (/v4/websocket)"]
    end

    subgraph Backends ["Audio Backends & Microservices"]
        LavalinkNode["Primary Lavalink Node (Port 2333)"]
        NodeLinkNode["Secondary NodeLink Node (Port 2334)"]
        WorkerPool["Event Hub Workers (JSON-RPC)"]
    end

    Clients -->|REST API / WS| AuthFilter
    AuthFilter --> ReqCoalescer
    AuthFilter --> WSGateway
    WSGateway <--> LavalinkNode

    ReqCoalescer --> L1Map
    L1Map -->|MISS| L2Dragon
    L2Dragon -->|MISS| FuzzyIdx
    FuzzyIdx -->|MISS| DirectPlayProc
    DirectPlayProc --> PreRouter
    PreRouter --> CascadeEngine
    CascadeEngine --> CircuitManager
    CircuitManager --> LavalinkNode
    CircuitManager --> NodeLinkNode
    CascadeEngine --> WorkerPool
    CascadeEngine --> LearnedStore
```

---

## 2. Direct Identifier Playback Flow (`PATCH /v4/sessions/:id/players/:guild`)

```mermaid
sequenceDiagram
    autonumber
    actor Bot as Discord Music Bot
    participant Proxy as Lavalink Dragonfly Proxy
    participant Cache as L1 / L2 Cache (7d / 31d)
    participant Lavalink as Upstream Lavalink Node

    Bot->>Proxy: PATCH /v4/sessions/{id}/players/{guild}<br/>{ "track": { "identifier": "dzsearch:Ed Sheeran Shape of You" } }
    
    Proxy->>Proxy: Intercept: track.identifier present & track.encoded missing
    Proxy->>Cache: Check L1 / L2 Cache for "dzsearch:Ed Sheeran Shape of You"
    
    alt Cache HIT (< 1ms)
        Cache-->>Proxy: Return cached playable track (encoded string)
    else Cache MISS
        Proxy->>Proxy: Run Pre-Request Transformers & Cascade Resolvers
        Proxy->>Cache: Save resolved track in L1 (7d) & L2 (31d)
    end

    Proxy->>Proxy: Inject body.track.encoded = "<resolved_base64_string>"
    Proxy->>Lavalink: Forward PATCH with complete encoded track
    Lavalink-->>Proxy: 200 OK (Player state updated)
    Proxy-->>Bot: 200 OK (Headers: X-Proxy-Direct-Playback: RESOLVED)
```

---

## 3. Request Coalescing Under High Concurrency

```mermaid
sequenceDiagram
    autonumber
    participant GuildA as Guild A (User 1)
    participant GuildB as Guild B (User 2)
    participant GuildC as Guild C (User 3)
    participant Coalescer as Proxy Request Coalescer
    participant Upstream as Upstream Scraper / Backend

    GuildA->>Coalescer: GET /v4/loadtracks?identifier=ytsearch:TrendingSong
    Note over Coalescer: Initiates Promise 1 for "ytsearch:TrendingSong"
    GuildB->>Coalescer: GET /v4/loadtracks?identifier=ytsearch:TrendingSong
    GuildC->>Coalescer: GET /v4/loadtracks?identifier=ytsearch:TrendingSong
    Note over Coalescer: Subscribes Guild B & C to active Promise 1
    
    Coalescer->>Upstream: Single upstream fetch to YouTube/Deezer
    Upstream-->>Coalescer: Returns single LavalinkLoadResult

    Coalescer-->>GuildA: 200 OK (X-Proxy-Cache: MISS)
    Coalescer-->>GuildB: 200 OK (X-Proxy-Coalesced: HIT)
    Coalescer-->>GuildC: 200 OK (X-Proxy-Coalesced: HIT)
```

---

## 4. Multi-Stage Fallback Cascade Decision Tree

```mermaid
flowchart TD
    Start["Incoming Track Request"] --> T1["Pre-Request: Clean Tracking & Normalize ISRC"]
    T1 --> LearnedCheck{"Learned Route in Cache?"}
    
    LearnedCheck -->|HIT| LearnedExec["Fast-Path to Known Working Provider"]
    LearnedCheck -->|MISS| PrimaryExec["Try Primary Node (Lavalink Main)"]
    
    LearnedExec --> Result1{"Playable Track Returned?"}
    PrimaryExec --> Result1
    
    Result1 -->|Yes| CacheAndSave["Write to L1/L2 Cache & Record LearnedRoute"]
    Result1 -->|No / Error| FallbackChain["Activate Fallback Cascade Engine"]
    
    subgraph CascadeChain ["Cascade Waterfall Sequence"]
        Step1["Attempt 1: Spotify Direct Metadata Resolver"]
        Step2["Attempt 2: Direct Video Link -> Title Search"]
        Step3["Attempt 3: YouTube Search -> Deezer Search"]
        Step4["Attempt 4: Event Hub External Worker RPC"]
        Step5["Attempt 5: Last Resort SoundCloud Search"]
        Step6["Attempt 6: DisTube YouTube Scraper"]

        Step1 -->|Fail| Step2
        Step2 -->|Fail| Step3
        Step3 -->|Fail| Step4
        Step4 -->|Fail| Step5
        Step5 -->|Fail| Step6
    end
    
    FallbackChain --> CascadeChain
    CascadeChain --> FinalResult{"Any Attempt Succeeded?"}
    FinalResult -->|Yes| CacheAndSave
    FinalResult -->|No| ReturnError["Return 502 Bad Gateway / Lavalink Error Result"]
```

---

## 5. Circuit Breaker State Machine

```mermaid
stateDiagram-v2
    [*] --> Closed

    state Closed {
        [*] --> NormalOperation: Requests succeed
        NormalOperation --> FailureRecorded: Node error or timeout
        FailureRecorded --> NormalOperation: Success resets failure count
    }

    Closed --> Open: Consecutive failures >= failureThreshold (5)

    state Open {
        [*] --> FastReject: Reject incoming requests with 503
        FastReject --> Sleep: Wait circuitBreakerResetMs (15s)
    }

    Open --> HalfOpen: Timer expires (15s elapsed)

    state HalfOpen {
        [*] --> ProbeRequest: Dispatch single probe request
    }

    HalfOpen --> Closed: Probe succeeds (Reset failure count)
    HalfOpen --> Open: Probe fails (Reset open timer)
```
