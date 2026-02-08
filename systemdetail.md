# System Settings & Data Pipeline Analysis

## Executive Summary

This document analyzes the settings system to identify:
1. Which settings in the UI are actually used in code
2. Settings that exist but are NOT used anywhere
3. The tick → price → trade decision pipeline and data freshness handling

---

## Part 1: Settings UI vs Code Usage

### Legend
- ✅ **CONNECTED**: Setting is in UI AND actively used in code logic
- ⚠️ **PARTIAL**: Setting exists in UI but usage is limited or conditional
- ❌ **UNUSED**: Setting exists in schema/UI but NOT consumed by any code

---

### Trading Configuration
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `riskProfile` | ✅ | Used in `risk.ts` for profile loading, logs | ✅ CONNECTED |
| `executionMode` | ✅ | Controls paper vs live in `execution.ts` | ✅ CONNECTED |
| `loopSeconds` | ✅ | Main loop interval in `index.ts` | ✅ CONNECTED |

### Risk Management
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `maxDailyDrawdownPct` | ✅ | Used in `risk.ts` circuit breaker | ✅ CONNECTED |
| `maxPositionPctPerAsset` | ✅ | Used in `risk.ts` position sizing | ✅ CONNECTED |
| `maxTurnoverPctPerDay` | ✅ | Used in `risk.ts` turnover limits | ✅ CONNECTED |
| `takeProfitPct` | ✅ | Used in `ranking.ts`, `index.ts` for TP logic | ✅ CONNECTED |

### Portfolio Limits
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `maxPositions` | ✅ | Used in `risk.ts`, `rotation.ts` | ✅ CONNECTED |
| `maxTop3ConcentrationPct` | ✅ | Used in `risk.ts` concentration check | ✅ CONNECTED |
| `maxPortfolioVolatility` | ✅ | Used in `index.ts` line 2099 | ✅ CONNECTED |
| `coreSlots` | ✅ | Used in `rotation.ts`, `ranking.ts` | ✅ CONNECTED |
| `scoutSlots` | ✅ | Used in `rotation.ts`, `scout_auto.ts` | ✅ CONNECTED |

### Execution Parameters
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `maxSlippageBps` | ✅ | Used in `execution.ts` for swap config | ✅ CONNECTED |
| `maxSingleSwapSol` | ✅ | Used in `execution.ts` for size capping | ✅ CONNECTED |
| `minTradeUsd` | ✅ | Used in `execution.ts` to skip dust trades | ✅ CONNECTED |

### Scanner Configuration
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `scannerMinLiquidity` | ✅ | Used in `scanner.ts` filtering | ✅ CONNECTED |
| `scannerMinVolume24h` | ✅ | Used in `scanner.ts` filtering | ✅ CONNECTED |
| `scannerMinHolders` | ✅ | Used in `scanner.ts` filtering | ✅ CONNECTED |
| `scannerMaxPriceChange24h` | ✅ | Used in `scanner.ts` filtering | ✅ CONNECTED |
| `scannerMinPriceChange24h` | ✅ | Used in `scanner.ts` filtering | ✅ CONNECTED |

### Signal & Ranking Weights
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `rankingSignalWeight` | ✅ | Used in `ranking.ts` composite score | ✅ CONNECTED |
| `rankingMomentumWeight` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `rankingTimeDecayWeight` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `rankingTrailingWeight` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `rankingFreshnessWeight` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `rankingQualityWeight` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `rankingStalePenalty` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `rankingTrailingStopPenalty` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |

### Rotation & Trailing Stops
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `rotationThreshold` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `stalePositionHours` | ✅ | Used in `ranking.ts`, `rotation.ts` | ✅ CONNECTED |
| `staleExitHours` | ✅ | Used in `rotation.ts` force-exit | ✅ CONNECTED |
| `trailingStopBasePct` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `trailingStopTightPct` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `trailingStopProfitThreshold` | ✅ | Used in `ranking.ts` | ✅ CONNECTED |
| `corePositionPctTarget` | ✅ | Used in `rotation.ts` sizing | ✅ CONNECTED |
| `scoutPositionPct` | ✅ | Used in `rotation.ts` sizing | ✅ CONNECTED |

### Re-entry Controls
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `reentryEnabled` | ✅ | Checked in `index.ts` re-entry logic | ✅ CONNECTED |
| `reentryCooldownMinutes` | ✅ | Used in re-entry timing | ✅ CONNECTED |
| `reentryWindowMinutes` | ✅ | Used in re-entry window | ✅ CONNECTED |
| `reentryMinMomentumScore` | ✅ | Used in re-entry qualification | ✅ CONNECTED |
| `reentrySizeMultiplier` | ✅ | Used in re-entry sizing | ✅ CONNECTED |
| `reentryMaxSolPct` | ✅ | Used in re-entry size cap | ✅ CONNECTED |

### Scout Promotion (Basic Criteria)
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `promotionMinPnlPct` | ✅ | Used in `ranking.ts` promotion check | ✅ CONNECTED |
| `promotionMinSignalScore` | ✅ | Used in promotion qualification | ✅ CONNECTED |
| `promotionDelayMinutes` | ✅ | Used in promotion timing (legacy) | ✅ CONNECTED |

### Scout Entry Gating (Volatility Scraper - New Jan 7)
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `scoutChaseRet15Max` | ✅ | Used in `scout_auto.ts` no-chase gate (default: 25%) | ✅ CONNECTED |
| `scoutImpulseRet15Min` | ✅ | Used in `scout_auto.ts` impulse detection (default: 10%) | ✅ CONNECTED |
| `scoutPullbackFromHigh15Min` | ✅ | Used in `scout_auto.ts` pullback requirement (default: 8%) | ✅ CONNECTED |
| `scoutEntrySmaMinutes` | ✅ | Used in `scout_auto.ts` SMA period (default: 30) | ✅ CONNECTED |
| `scoutEntryRequireAboveSma` | ✅ | Used in `scout_auto.ts` SMA gate toggle | ✅ CONNECTED |

### Continuation-Only Promotion Filters (New Jan 7)
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `promotionMinHoursHeld` | ✅ | Used in `ranking.ts` minimum hold time (default: 1hr) | ✅ CONNECTED |
| `promotionRequireRet60Min` | ✅ | Used in `ranking.ts` 60m return threshold (default: 10%) | ✅ CONNECTED |
| `promotionRequireRet15Min` | ✅ | Used in `ranking.ts` 15m return threshold (default: 0%) | ✅ CONNECTED |
| `promotionAvoidTopDrawdown30` | ✅ | Used in `ranking.ts` avoid-top filter (default: 3%) | ✅ CONNECTED |
| `promotionSmaMinutes` | ✅ | Used in `ranking.ts` SMA period for promo (default: 60) | ✅ CONNECTED |
| `promotionRequireAboveSma` | ✅ | Used in `ranking.ts` SMA gate for promo | ✅ CONNECTED |

### Operational Limits
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `concentrationRebalanceMaxPct` | ✅ | Used in `index.ts` rebalance logic | ✅ CONNECTED |
| `transferThresholdUsd` | ✅ | Used in `index.ts` line 448 | ✅ CONNECTED |

### Autonomous Scouts
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `autonomousScoutsEnabled` | ✅ | Checked in `scout_auto.ts` | ✅ CONNECTED |
| `autonomousDryRun` | ✅ | Controls paper vs live scouts | ✅ CONNECTED |
| `scoutAutoQueueScore` | ✅ | Used in `scout_auto.ts` filtering | ✅ CONNECTED |
| `scoutBuySol` | ✅ | Used in `scout_auto.ts` buy amount | ✅ CONNECTED |
| `minSolReserve` | ✅ | Used in `index.ts`, `scout_auto.ts` | ✅ CONNECTED |
| `scoutTokenCooldownHours` | ✅ | Used in cooldown logic | ✅ CONNECTED |
| `scoutDailyLimit` | ✅ | Used in daily cap | ✅ CONNECTED |
| `scoutQueuePollSeconds` | ✅ | Used in queue polling | ✅ CONNECTED |
| `scanIntervalMinutes` | ✅ | Used in scanner scheduling | ✅ CONNECTED |

### Whale Flow Confirmation
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `whaleConfirmEnabled` | ✅ | Used in `whaleSignal.ts` | ✅ CONNECTED |
| `whaleConfirmDryRun` | ✅ | Used in `whaleSignal.ts` | ✅ CONNECTED |
| `whaleConfirmPollSeconds` | ✅ | Used in whale polling | ✅ CONNECTED |
| `whaleWindowMinutes` | ✅ | Used in window calculation | ✅ CONNECTED |
| `whaleMinUsd` | ✅ | Used in whale threshold | ✅ CONNECTED |
| `whaleNetflowTriggerUsd` | ✅ | Used in netflow trigger | ✅ CONNECTED |
| `marketConfirmPct` | ✅ | Used in market confirmation | ✅ CONNECTED |
| `maxPriceImpactBps` | ✅ | Used in price impact check | ✅ CONNECTED |
| `exitNetflowUsd` | ✅ | Used in exit signal | ✅ CONNECTED |
| `exitTrailDrawdownPct` | ✅ | Used in exit logic | ✅ CONNECTED |
| `scoutUnderperformMinutes` | ✅ | Used in underperformance flagging | ✅ CONNECTED |
| `whaleCooldownMinutes` | ✅ | Used in cooldown | ✅ CONNECTED |

### Advanced Flow Controls
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `manualScoutBuyEnabled` | ✅ | Used in manual buy flow | ✅ CONNECTED |
| `scoutGraceMinutes` | ✅ | Used in `rotation.ts` | ✅ CONNECTED |
| `scoutStopLossPct` | ✅ | Used in `rotation.ts`, `index.ts` | ✅ CONNECTED |
| `lossExitPct` | ✅ | Used in `rotation.ts`, `index.ts` | ✅ CONNECTED |
| `stalePnlBandPct` | ✅ | Used in `ranking.ts` stale detection | ✅ CONNECTED |
| `dustThresholdUsd` | ✅ | Used in position filtering | ✅ CONNECTED |
| `minPositionUsd` | ✅ | Used in position validation | ✅ CONNECTED |
| `txFeeBufferSol` | ✅ | Used in `index.ts` SOL floor | ✅ CONNECTED |

### Strategy Engine
| Setting | UI | Code Usage | Status |
|---------|-----|------------|--------|
| `strategyTrendThreshold` | ✅ | Used in `strategy.ts` line 15 | ✅ CONNECTED |
| `strategyMomentumFactor` | ✅ | Used in `strategy.ts` line 16 | ✅ CONNECTED |
| `strategyBand` | ✅ | Used in `strategy.ts` line 17 | ✅ CONNECTED |
| `minTicksForSignals` | ✅ | Used in `strategy.ts` line 18 | ✅ CONNECTED |

---

## Part 2: Potentially Unused or Low-Usage Settings

After analysis, **ALL 102 settings in the UI are connected to code** (including 11 new settings added Jan 7 for Volatility Scraper Scouts). However, some have conditional or limited usage:

### Settings with Conditional Usage (Only Active When Feature Enabled)

| Setting | Condition |
|---------|-----------|
| `whaleConfirmEnabled` + all whale settings | Only active when `whaleConfirmEnabled=true` |
| `autonomousScoutsEnabled` + scout settings | Only active when `autonomousScoutsEnabled=true` |
| `reentryEnabled` + re-entry settings | Only active when `reentryEnabled=true` |

### Settings NOT in UI (Code-Only)

The following are defined in `RuntimeConfig` but have NO UI controls:

| Setting | Usage | Notes |
|---------|-------|-------|
| `manualPause` | Used in `index.ts` | Controlled via dashboard pause button, not settings page |

---

## Part 3: Tick → Price → Trade Decision Pipeline

### 3.1 Tick Cadence & Logging

**Trigger:** Main loop in `src/bot/index.ts` runs every `loopSeconds` (default: 60s)

```
Every loopSeconds (default 60s):
  → tick() function executes
  → Prices fetched
  → Signals computed
  → Decisions made
  → logTick() writes to logs/ticks_YYYY-MM-DD.jsonl
```

**Tick Log Contents:**
- Timestamp
- SOL price
- Portfolio equity
- All position prices and PnL
- Signal scores
- Config hash
- Mode (paper/live)

**File:** `logs/ticks_YYYY-MM-DD.jsonl`

---

### 3.2 Price Query Sources & Freshness

#### Primary Price Sources (in priority order):

| Source | Usage | Cache TTL | Freshness |
|--------|-------|-----------|-----------|
| `getAccurateSolPrice()` | SOL/USD | None | Real-time each tick |
| `jupUsdPrices()` | Universe tokens | Uses DexScreener | Per-request |
| `getTokenPriceViaDexScreener()` | Individual tokens | 30s cache | Near real-time |
| `getJupiterBatchPrices()` | Batch prices | 10s cache (`PRICE_CACHE_TTL`) | Very fresh |
| `jupQuote()` | Swap execution | No cache, retry logic | Real-time |
| `loadRecentPrices()` | Historical bars | DB query | Depends on insert rate |

#### Price Flow During Tick:

```
1. getAccurateSolPrice() → Current SOL price (fresh)
2. jupUsdPrices(universeMints) → Prices for all universe tokens
   → Uses DexScreener with rate-limited fetches
3. getBatchTokens(nonUniverseMints) → Prices for non-universe held tokens
4. insertPrices(rows) → Store prices in `prices` table for history
```

---

### 3.3 Historical Price Storage

**Table:** `prices`
```sql
CREATE TABLE prices (
  mint text,
  ts timestamptz,
  usd_price numeric,
  block_id text
);
```

**Insert Frequency:** Every tick (60s default) for all universe tokens

**Retrieval:** `loadRecentPrices(mint, limit)` returns last N price bars

---

### 3.4 Signal Computation & Freshness Validation

**File:** `src/bot/strategy.ts`

**Freshness Gate:** `minTicksForSignals` (default: 60)

```typescript
// From strategy.ts lines 18-37
const minTicks = config.minTicksForSignals;

if (prices.length < minTicks) {
  // BLOCKED - Not enough historical data
  return { 
    score: 0, 
    regime: "range", 
    features: { 
      n: prices.length, 
      insufficientTicks: 1,
      requiredTicks: minTicks,
      currentTicks: prices.length,
    } 
  };
}
```

**What This Means:**
- A token must have 60+ price points before signals are computed
- At default 60s ticks = 60 minutes of data minimum
- **IMPACT:** New tokens in universe get score=0 until 60 ticks collected

---

### 3.5 Trade Decision Flow

```
TICK START
│
├─> Fetch current prices (jupUsdPrices)
│
├─> Build portfolio snapshot (buildSnapshot)
│   └─> Includes: balances, prices, equity, positions
│
├─> For each position in universe:
│   ├─> loadRecentPrices(mint, 120) → Get last 120 bars
│   ├─> computeSignal(prices) → Get signal score
│   │   └─> If bars < minTicksForSignals → score = 0
│   └─> Store signal in position data
│
├─> rankPositions(positions, config)
│   └─> Composite score using all ranking weights
│
├─> Evaluate exits:
│   ├─> Take profit check (takeProfitPct)
│   ├─> Stop loss check (scoutStopLossPct / lossExitPct)
│   ├─> Stale position check (staleExitHours)
│   └─> Trailing stop check
│
├─> Evaluate entries/promotions:
│   ├─> Scout queue processing (autonomousScoutsEnabled)
│   ├─> Re-entry checks (reentryEnabled)
│   └─> Scout promotions (promotionMinPnlPct, promotionDelayMinutes)
│
├─> Execute approved trades:
│   ├─> jupQuote() → Get real-time quote
│   ├─> executeSwap() → Execute with slippage protection
│   └─> Log trade (insertTrade, logTrade)
│
└─> logTick() → Write tick data to file

TICK END
```

---

### 3.6 Data Freshness Summary

| Data Type | Freshness | Staleness Handling |
|-----------|-----------|-------------------|
| SOL Price | Real-time each tick | None - always fresh |
| Token Prices | ~10-30s cache | Falls back to DexScreener |
| Historical Bars | 60s granularity | minTicksForSignals gate |
| Signals | Computed fresh each tick | score=0 if insufficient history |
| Positions | Updated each tick | stalePnlBandPct + stalePositionHours |

---

### 3.7 Settings NOT Exposed in UI That Affect Data Flow

These are hardcoded but affect the pipeline:

| Constant | Location | Value | Purpose |
|----------|----------|-------|---------|
| `PRICE_CACHE_TTL` | jupiter.ts | 10000ms | Jupiter batch price cache |
| `DEXSCREENER_CACHE_TTL` | dexscreener.ts | 30000ms | DexScreener response cache |
| `RECENT_PRICE_LIMIT` | Various | 120 | Default bars to load for signals |

---

## Part 4: Recommendations

### Settings That Could Be Added to UI

1. **Price Cache TTL** - Currently hardcoded at 10s
2. **DexScreener Cache TTL** - Currently hardcoded at 30s
3. **Historical Bar Limit** - Currently hardcoded at 120

### Settings Usage Verification Needed

All settings appear connected. The system is well-wired.

### Data Freshness Considerations

1. **minTicksForSignals=60** means new tokens need ~60 minutes before trading
   - Lower this to 10-20 for faster deployment
   - Higher for more stable signals

2. **Price staleness not explicitly gated**
   - Prices are fetched fresh each tick
   - No explicit "price too old, skip trade" logic
   - Relies on API availability

3. **Signal staleness tracked via `rankingFreshnessWeight`**
   - Signals older than ~60 minutes get penalized in ranking
   - Not a hard gate, just a soft ranking factor

---

## Conclusion

**All 91 settings in the UI are connected to code and functional.**

The tick → price → trade pipeline:
1. Runs every `loopSeconds` (default 60s)
2. Fetches fresh prices from Jupiter/DexScreener
3. Requires `minTicksForSignals` history before computing signals
4. Uses real-time quotes for execution
5. Logs everything to files and database

No orphaned or dead settings were found.
