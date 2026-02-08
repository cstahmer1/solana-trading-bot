# Architecture Documentation

**Generated:** 2026-01-25
**Git Commit:** 79e1e27
**Build:** v1.0.0-79e1e27

## Overview

This documentation provides visual and textual representations of the Solana Trading Bot codebase structure, dependencies, decision flows, and complexity metrics.

## Contents

| Document | Description |
|----------|-------------|
| [DEPENDENCY_GRAPH.md](./DEPENDENCY_GRAPH.md) | Module import relationships and dependency chains |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | High-level system architecture diagram |
| [DECISION_FLOWS.md](./DECISION_FLOWS.md) | Exit logic, rotation, and promotion decision trees |
| [COMPLEXITY_REPORT.md](./COMPLEXITY_REPORT.md) | File sizes, hotspots, and complexity metrics |

## Regenerating Documentation

Run the following command to regenerate all architecture docs with current timestamps:

```bash
npm run docs:architecture
```

## Codebase Statistics

| Metric | Value |
|--------|-------|
| Total Lines of Code | 38,925 |
| TypeScript Files | 76 |
| Bot Modules | 32 |
| Dashboard Files | 1 |
| Utility Files | 3 |
| Circular Dependencies | 3 (known) |

## Module Categories

- **Core Engine**: index.ts, rotation.ts, ranking.ts
- **Execution**: execution.ts, jupiter.ts, solana.ts
- **Data/Persistence**: persist.ts, pnl_engine.ts, db.ts
- **Scouting**: scout_auto.ts, scanner.ts, whaleSignal.ts
- **Configuration**: runtime_config.ts, config.ts, risk_profiles.ts
- **Dashboard**: server.ts (WebSocket + REST API)
- **Utilities**: logger.ts, sleep.ts, timezone.ts
