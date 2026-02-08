# Dependency Graph

**Generated:** 2026-01-25
**Git Commit:** 79e1e27

## Module Dependency Overview

This document shows which modules import from which other modules, organized by layer.

## Layered Architecture

```mermaid
graph TB
    subgraph "Layer 0: Utilities"
        logger["logger.ts"]
        sleep["sleep.ts"]
        timezone["timezone.ts"]
    end
    
    subgraph "Layer 1: Config & Database"
        config["config.ts"]
        db["db.ts"]
        settings_schema["settings_schema.ts"]
    end
    
    subgraph "Layer 2: External APIs"
        dexscreener["dexscreener.ts"]
        helius["helius.ts"]
        jupiter["jupiter.ts"]
        solana["solana.ts"]
        solscan["solscan.ts"]
    end
    
    subgraph "Layer 3: Data & State"
        persist["persist.ts"]
        pnl_engine["pnl_engine.ts"]
        portfolio["portfolio.ts"]
        state["state.ts"]
        universe["universe.ts"]
        wallet["wallet.ts"]
    end
    
    subgraph "Layer 4: Risk & Strategy"
        risk["risk.ts"]
        risk_profiles["risk_profiles.ts"]
        portfolio_risk["portfolio_risk.ts"]
        strategy["strategy.ts"]
        runtime_config["runtime_config.ts"]
    end
    
    subgraph "Layer 5: Decision Logic"
        ranking["ranking.ts"]
        rotation["rotation.ts"]
        decisions["decisions.ts"]
        scanner["scanner.ts"]
    end
    
    subgraph "Layer 6: Execution & Signals"
        execution["execution.ts"]
        scout_auto["scout_auto.ts"]
        whaleSignal["whaleSignal.ts"]
    end
    
    subgraph "Layer 7: Orchestration"
        index["index.ts<br/>(main bot)"]
    end
    
    subgraph "Layer 8: Dashboard"
        server["server.ts<br/>(dashboard)"]
    end

    db --> config
    dexscreener --> logger
    helius --> logger
    helius --> config
    jupiter --> logger
    jupiter --> config
    execution --> logger
    execution --> config
    execution --> jupiter
    execution --> solana
    execution --> risk_profiles
    
    persist --> db
    persist --> pnl_engine
    persist --> timezone
    
    pnl_engine --> persist
    
    ranking --> runtime_config
    ranking --> persist
    ranking --> pnl_engine
    
    rotation --> ranking
    rotation --> runtime_config
    rotation --> persist
    
    runtime_config --> db
    runtime_config --> settings_schema
    
    scout_auto --> runtime_config
    scout_auto --> persist
    scout_auto --> scanner
    scout_auto --> execution
    
    index --> rotation
    index --> ranking
    index --> execution
    index --> persist
    index --> runtime_config
    index --> scout_auto
    index --> whaleSignal
    index --> telemetry
    index --> server
    
    server --> index
```

## Direct Dependencies by Module

### Core Orchestration (index.ts)
Imports from 28 modules - the central hub that coordinates all systems.

| Dependency | Purpose |
|------------|---------|
| rotation.ts | Portfolio rotation decisions |
| ranking.ts | Position ranking and scoring |
| execution.ts | Trade execution |
| persist.ts | Database operations |
| runtime_config.ts | Dynamic configuration |
| scout_auto.ts | Autonomous scouting |
| whaleSignal.ts | Whale tracking signals |
| telemetry.ts | Performance metrics |
| server.ts | Dashboard integration |

### Decision Layer (rotation.ts → ranking.ts)

```mermaid
graph LR
    rotation["rotation.ts"] --> ranking["ranking.ts"]
    ranking --> runtime_config["runtime_config.ts"]
    ranking --> persist["persist.ts"]
    ranking --> pnl_engine["pnl_engine.ts"]
    rotation --> persist
    rotation --> runtime_config
```

### Execution Chain

```mermaid
graph LR
    scout_auto["scout_auto.ts"] --> execution["execution.ts"]
    execution --> jupiter["jupiter.ts"]
    jupiter --> solana["solana.ts"]
    execution --> solana
```

### Data Layer

```mermaid
graph LR
    persist["persist.ts"] --> db["db.ts"]
    persist --> pnl_engine["pnl_engine.ts"]
    pnl_engine --> persist
    db --> config["config.ts"]
```

## Circular Dependencies (Known)

| Cycle | Modules | Status |
|-------|---------|--------|
| 1 | risk_profiles.ts → persist.ts | Controlled - lazy loading |
| 2 | server.ts → index.ts | Intentional bidirectional broadcast |
| 3 | server.ts → index.ts → rotation.ts | Dashboard imports rotation via index |

These circular dependencies are managed through careful import ordering and lazy evaluation where needed.

## Import Count by Module

| Module | Imports From | Imported By |
|--------|--------------|-------------|
| index.ts | 28 | 1 (server.ts) |
| server.ts | 25 | 1 (index.ts) |
| persist.ts | 5 | 12 |
| runtime_config.ts | 3 | 8 |
| execution.ts | 5 | 4 |
| ranking.ts | 4 | 2 |
| rotation.ts | 3 | 2 |
| config.ts | 0 | 8 |
| logger.ts | 0 | 15 |
