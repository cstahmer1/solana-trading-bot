# System Architecture

**Generated:** 2026-01-25
**Git Commit:** 79e1e27

## High-Level Architecture

```mermaid
graph TB
    subgraph "External Services"
        DEX["DexScreener API"]
        JUP["Jupiter Aggregator"]
        SOL["Solana RPC"]
        HEL["Helius RPC"]
        SS["Solscan API"]
    end
    
    subgraph "Bot Core"
        direction TB
        MAIN["Main Loop<br/>(index.ts)"]
        
        subgraph "Decision Engine"
            RANK["Ranking Engine<br/>(ranking.ts)"]
            ROT["Rotation Engine<br/>(rotation.ts)"]
            STRAT["Strategy<br/>(strategy.ts)"]
        end
        
        subgraph "Execution"
            EXEC["Trade Executor<br/>(execution.ts)"]
            SCOUT["Scout Auto<br/>(scout_auto.ts)"]
            WHALE["Whale Signal<br/>(whaleSignal.ts)"]
        end
        
        subgraph "Data Layer"
            PERSIST["Persistence<br/>(persist.ts)"]
            PNL["PnL Engine<br/>(pnl_engine.ts)"]
            PORT["Portfolio<br/>(portfolio.ts)"]
            PRICEMETRICS["Price Metrics<br/>(price_metrics.ts)"]
        end
        
        subgraph "Configuration"
            CFG["Runtime Config<br/>(runtime_config.ts)"]
            RISK["Risk Profiles<br/>(risk_profiles.ts)"]
        end
    end
    
    subgraph "Dashboard"
        DASH["Express Server<br/>(server.ts)"]
        WS["WebSocket<br/>Real-time Updates"]
        UI["Web UI<br/>Matrix Theme"]
    end
    
    subgraph "Database"
        PG[("PostgreSQL<br/>Neon")]
    end
    
    MAIN --> RANK
    MAIN --> ROT
    MAIN --> EXEC
    MAIN --> SCOUT
    MAIN --> WHALE
    
    RANK --> CFG
    RANK --> PNL
    ROT --> RANK
    ROT --> CFG
    
    EXEC --> JUP
    EXEC --> SOL
    
    SCOUT --> EXEC
    SCOUT --> PRICEMETRICS
    WHALE --> HEL
    RANK --> PRICEMETRICS
    PRICEMETRICS --> PG
    
    PERSIST --> PG
    PNL --> PERSIST
    CFG --> PG
    
    MAIN --> DASH
    DASH --> WS
    WS --> UI
    
    DEX --> RANK
    DEX --> PNL
```

## Data Flow

### 1. Price Discovery Flow

```mermaid
sequenceDiagram
    participant Main as Main Loop
    participant DexS as DexScreener
    participant Rank as Ranking
    participant PnL as PnL Engine
    
    Main->>DexS: Fetch prices
    DexS-->>Main: Token prices
    Main->>PnL: Update positions with prices
    PnL->>PnL: Calculate FIFO cost basis
    PnL-->>Main: Position PnL values
    Main->>Rank: Rank positions
    Rank-->>Main: Ranked positions with scores
```

### 2. Trade Execution Flow

```mermaid
sequenceDiagram
    participant Rot as Rotation
    participant Exec as Executor
    participant Jup as Jupiter
    participant Sol as Solana RPC
    participant Persist as Persist
    
    Rot->>Exec: Execute trade (sell/buy)
    Exec->>Jup: Get quote
    Jup-->>Exec: Swap transaction
    Exec->>Sol: Submit transaction
    Sol-->>Exec: Confirmation
    Exec->>Persist: Record trade
    Persist->>Persist: Update FIFO lots
    Exec-->>Rot: Trade result
```

### 3. Scout Discovery Flow

```mermaid
sequenceDiagram
    participant Main as Main Loop
    participant Scout as Scout Auto
    participant Scan as Scanner
    participant DexS as DexScreener
    participant Exec as Executor
    
    Main->>Scout: Check scout queue
    Scout->>Scan: Scan for candidates
    Scan->>DexS: Filter by metrics
    DexS-->>Scan: Qualified tokens
    Scan-->>Scout: Scout candidates
    Scout->>Scout: Apply cooldowns/limits
    Scout->>Exec: Buy scout position
    Exec-->>Scout: Position opened
```

## Component Responsibilities

### Main Loop (index.ts)
- Orchestrates all bot operations on configurable interval (default 60s)
- Manages price fetching, position evaluation, and trade decisions
- Coordinates telemetry and dashboard updates
- Handles graceful shutdown and error recovery

### Ranking Engine (ranking.ts)
- Scores positions using weighted factors:
  - Signal strength (3x weight)
  - Momentum (2x weight)
  - Trailing performance (2.5x weight)
  - Time freshness (1.5x weight)
  - Quality metrics (1x weight)
- Applies penalties for stale positions and trailing stops
- Flags exit conditions (stop loss, underperformance)

### Rotation Engine (rotation.ts)
- Evaluates portfolio for rotation opportunities
- Priority-ordered exit triggers:
  1. Scout stop loss (immediate)
  2. Core loss exit (immediate)
  3. Scout grace expired (timed)
  4. Trailing stops
  5. Stale position exits
  6. Normal rotation
- Manages promotion from scout to core slots

### PnL Engine (pnl_engine.ts)
- FIFO (First-In-First-Out) cost basis tracking
- Per-lot tracking for accurate tax reporting
- Handles decimal corrections from price feeds
- Computes realized and unrealized gains

### Runtime Config (runtime_config.ts)
- 80+ configurable parameters
- Real-time updates without restart
- Validated against schema
- Persisted to database

### Dashboard (server.ts)
- Express HTTP server on port 5000
- WebSocket for real-time updates
- Matrix-themed UI
- API endpoints for manual controls

## Slot Hierarchy

```
┌─────────────────────────────────────────┐
│            CORE SLOTS (5)               │
│  - Higher allocation (12% each target)  │
│  - Promoted from successful scouts      │
│  - Lower exit thresholds                │
└─────────────────────────────────────────┘
                    ▲
                    │ Promotion
                    │ (minPnlPct, minSignalScore, minHoursHeld)
                    │
┌─────────────────────────────────────────┐
│           SCOUT SLOTS (40)              │
│  - Smaller allocation (3% each)         │
│  - Discovery/testing positions          │
│  - Higher stop loss threshold           │
└─────────────────────────────────────────┘
                    ▲
                    │ Entry
                    │ (autonomous discovery, manual queue)
                    │
┌─────────────────────────────────────────┐
│          TOKEN UNIVERSE                 │
│  - Discovered via scanner               │
│  - Filtered by liquidity/volume/holders │
│  - Cooldown management                  │
└─────────────────────────────────────────┘
```
