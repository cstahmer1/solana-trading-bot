# Complexity Report

**Generated:** 2026-01-25
**Git Commit:** 79e1e27

## Codebase Size Summary

| Metric | Value |
|--------|-------|
| Total Lines of Code | 18,585 |
| TypeScript Files | 37 |
| Average Lines per File | 502 |
| Largest File | server.ts (6,654 lines) |
| Smallest File | sleep.ts (~10 lines) |

## File Size Distribution

### Complexity Hotspots (>500 lines)

These files contain the most complex logic and are candidates for future refactoring.

| File | Lines | Category | Notes |
|------|-------|----------|-------|
| server.ts | 6,654 | Dashboard | UI + API + WebSocket - consider splitting |
| index.ts | 2,070 | Core | Main bot loop - orchestration complexity |
| persist.ts | 1,049 | Data | Database operations - well-structured |
| pnl_engine.ts | 817 | Data | FIFO calculations - complex but necessary |
| scout_auto.ts | 697 | Execution | Autonomous scouting logic |
| runtime_config.ts | 681 | Config | 80+ settings with validation |
| reconcile.ts | 593 | Data | Wallet reconciliation |
| ranking.ts | 528 | Decision | Position scoring logic |
| rotation.ts | 502 | Decision | Portfolio rotation logic |

### Medium Complexity (200-500 lines)

| File | Lines | Category |
|------|-------|----------|
| init_db.ts | 459 | Setup |
| scanner.ts | 456 | Discovery |
| jupiter.ts | 430 | External API |
| whaleSignal.ts | 426 | Signals |
| execution.ts | 365 | Trading |
| reports.ts | 305 | Output |
| portfolio_risk.ts | 289 | Risk |
| dexscreener.ts | 284 | External API |
| telemetry.ts | 234 | Monitoring |
| helius.ts | 234 | External API |

### Low Complexity (<200 lines)

| File | Lines | Category |
|------|-------|----------|
| universe.ts | ~180 | Data |
| wallet.ts | ~150 | External |
| strategy.ts | ~140 | Decision |
| risk.ts | ~120 | Risk |
| portfolio.ts | ~100 | Data |
| decisions.ts | ~90 | Logic |
| state.ts | ~80 | Data |
| math.ts | ~60 | Utility |
| file_logger.ts | ~50 | Utility |
| config.ts | ~40 | Config |
| db.ts | ~30 | Data |
| logger.ts | ~50 | Utility |
| timezone.ts | ~30 | Utility |
| sleep.ts | ~10 | Utility |

## Complexity Visualization

```
Lines of Code by File
═══════════════════════════════════════════════════════════════════════════════

server.ts       ████████████████████████████████████████████████████████ 6,654
index.ts        ██████████████████ 2,070
persist.ts      █████████ 1,049
pnl_engine.ts   ███████ 817
scout_auto.ts   ██████ 697
runtime_config  ██████ 681
reconcile.ts    █████ 593
ranking.ts      █████ 528
rotation.ts     ████ 502
init_db.ts      ████ 460
scanner.ts      ████ 456
jupiter.ts      ████ 430
whaleSignal.ts  ████ 426
execution.ts    ███ 365
reports.ts      ███ 305
```

## Dependency Complexity

### Import Counts

Files with many imports have higher coupling and may be harder to maintain.

| File | Imports | Exported By |
|------|---------|-------------|
| index.ts | 28 | 1 |
| server.ts | 25 | 1 |
| rotation.ts | 5 | 2 |
| ranking.ts | 5 | 2 |
| execution.ts | 6 | 4 |
| persist.ts | 5 | 12 |
| scout_auto.ts | 8 | 2 |
| runtime_config.ts | 4 | 8 |

### Circular Dependencies

| Cycle | Impact | Mitigation |
|-------|--------|------------|
| risk_profiles → persist | Low | Lazy loading |
| server → index | Medium | Intentional bidirectional |
| server → index → rotation | Low | Dashboard imports via index |

## Suggested Refactoring Priorities

### High Priority

1. **server.ts (6,654 lines)**
   - Split into: `dashboard/routes.ts`, `dashboard/websocket.ts`, `dashboard/ui.ts`
   - Extract API handlers to separate files
   - Move UI HTML generation to templates

2. **index.ts (2,070 lines)**
   - Extract main loop into separate `loop.ts`
   - Move initialization to `bootstrap.ts`
   - Separate signal handling

### Medium Priority

3. **persist.ts (1,049 lines)**
   - Split by entity: `persist/positions.ts`, `persist/trades.ts`, `persist/config.ts`

4. **pnl_engine.ts (817 lines)**
   - Extract FIFO logic to `fifo.ts`
   - Separate reporting functions

### Low Priority

5. **scout_auto.ts, runtime_config.ts, reconcile.ts**
   - Well-structured but could use documentation
   - Consider adding inline comments

## Test Coverage Gaps

Based on file complexity, these areas need test coverage:

| File | Priority | Suggested Tests |
|------|----------|-----------------|
| ranking.ts | High | Unit tests for score calculation |
| rotation.ts | High | Integration tests for exit logic |
| pnl_engine.ts | High | FIFO lot calculations |
| execution.ts | Medium | Mock Jupiter responses |
| scout_auto.ts | Medium | Cooldown and limit logic |

## Technical Debt Summary

| Category | Count | Severity |
|----------|-------|----------|
| Large files (>1000 lines) | 3 | Medium |
| Circular dependencies | 3 | Low |
| Missing tests | ~15 files | High |
| Inline comments | Sparse | Low |
| Type safety gaps | ~5 any types | Low |
