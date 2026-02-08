# Solana Trading Bot - Complete Rules Reference

This document details every buy, sell, and removal rule used by the trading bot. Parameters marked with [UI] can be configured via the dashboard. All other parameters require code changes.

---

## 1. SIGNAL GENERATION

### Momentum Score Calculation
The momentum score determines trade direction and strength. Range: -3 to +3

**Components (each contributes -1, 0, or +1):**

| Component | Bullish (+1) | Neutral (0) | Bearish (-1) |
|-----------|--------------|-------------|--------------|
| 5m vs 1h price | 5m > 1h | - | 5m < 1h |
| 1h vs 6h price | 1h > 6h | - | 1h < 6h |
| 6h vs 24h price | 6h > 24h | - | 6h < 24h |

**Example:** If 5m > 1h (+1), 1h > 6h (+1), 6h < 24h (-1) = Score of +1

### Regime Detection
Determines if market is trending or ranging.

**Trend Regime:** `|score| >= 2`
- Strong directional movement
- Bot trades more aggressively
- Required for re-entry logic

**Range Regime:** `|score| < 2`
- Choppy/sideways market
- Bot reduces exposure
- Triggers sell signals for held positions

---

## 2. BUY RULES

### Primary Buy Conditions
All must be true for a buy signal:

1. **Regime is "trend"** - Score >= 2 or Score <= -2
2. **Score is positive** - Upward momentum (score > 0)
3. **Drift exceeds band** - Current weight below target by more than rebalance band
4. **Not in cooldown** - No trade on this token in last 2 minutes
5. **Position limits not exceeded** - See Risk Limits below
6. **Sufficient SOL balance** - Enough to execute trade

### Trade Sizing
```
wantUsd = (targetWeight - currentWeight) * totalEquity
tradeUsd = min(wantUsd, maxSingleSwapSol * solPrice)
```

Minimum trade: `max(config.minTradeUsd, riskProfile.minTradeUsd)` [UI]

### Risk Limit Checks (Pre-Trade Projection)
Before any buy, the bot projects post-trade metrics:

1. **Position Count Limit** [UI: maxPositions]
   - Default: 10
   - Rejects buy if it would create position #11+

2. **Top-3 Concentration Limit** [UI: maxTop3ConcentrationPct]
   - Default: 70%
   - Rejects buy if top 3 positions would exceed 70% of portfolio

3. **Portfolio Volatility Limit** [UI: maxPortfolioVolatility]
   - Default: 100 (effectively disabled)
   - Based on 24h price change weighted by position size

---

## 3. SELL RULES

### Take-Profit [UI: takeProfitPct]
```
Trigger: currentPrice >= entryPrice * (1 + takeProfitPct)
Default: 25% gain
```

- Sells entire position
- Tracks token for potential re-entry (see Re-Entry Rules)
- Logged as strategy: "take_profit"

### Stop-Loss (Hardcoded)
```
Trigger: currentPrice <= entryPrice * 0.85
Default: 15% loss
```

- Sells entire position
- Does NOT track for re-entry
- Logged as strategy: "stop_loss"

### Regime-Based Exit
```
Trigger: regime == "range" AND score < 0
```

- When momentum turns negative in choppy market
- Sells based on drift calculation
- Logged as strategy: "regime_based"

### Concentration Rebalancing
```
Trigger: top3Concentration > maxTop3ConcentrationPct
```

- Calculates excess: `currentTop3% - maxTop3%`
- Sells portion of largest position to reduce concentration
- Continues until under limit or 3 trades executed
- Logged as strategy: "concentration_rebalance"

---

## 4. RE-ENTRY RULES (After Take-Profit)

When a token is sold at take-profit, it enters re-entry tracking.

### Tracking Window
- **Cooldown:** 3 minutes (prevents whipsaw, ensures fresh data)
- **Expiration:** 30 minutes from sell

### Re-Entry Conditions (ALL must be true)
1. **Time:** Between 3-30 minutes since take-profit sell
2. **No existing position:** Token not currently held (>$1 value)
3. **Price sustained:** Current price >= 98% of sell price
4. **Trend regime:** Must be in trend (|score| >= 2)
5. **Strong momentum:** Score >= 1.0
6. **Position limits:** Would not exceed maxPositions or top-3 concentration

### Re-Entry Trade Sizing
```
reentryUsd = min(
  minTradeUsd * 3,           // 3x minimum trade
  maxSingleSwapSol * 0.5     // 50% of max single swap
)
```

Logged as strategy: "reentry_momentum"

---

## 5. UNIVERSE MANAGEMENT (Boot from List)

### Automatic Removal
Tokens are NOT automatically removed from universe. Manual removal only via dashboard.

### Scanner Filter Criteria [UI Settings]
New tokens must pass these filters to appear in opportunities:

| Filter | Setting | Description |
|--------|---------|-------------|
| Min Liquidity | scannerMinLiquidity | USD liquidity in pool |
| Min 24h Volume | scannerMinVolume24h | Trading volume |
| Min Holders | scannerMinHolders | Number of holders (note: not always available) |
| Max 24h Change | scannerMaxPriceChange24h | Filters out pump-and-dumps |
| Min 24h Change | scannerMinPriceChange24h | Filters out dead tokens |

**Current Defaults:**
- Min Liquidity: $10,000
- Min Volume: $5,000
- Min Holders: 100 (bypassed if API doesn't provide)
- Max 24h Change: +500%
- Min 24h Change: -50%

### Manual Universe Control
- "Add to Universe" button on Opportunities tab
- Remove via Universe tab (delete button)

---

## 6. CIRCUIT BREAKERS

### Daily Drawdown Limit [UI: maxDailyDrawdownPct]
```
Trigger: portfolioValue < peakValue * (1 - maxDailyDrawdownPct)
Default: 7%
```

- Pauses ALL trading
- Resets at midnight UTC
- Logged: "circuit breaker: drawdown"

### Daily Turnover Limit [UI: maxTurnoverPctPerDay]
```
Trigger: dailyTurnover > portfolioValue * maxTurnoverPctPerDay
Default: 500% (5x)
```

- Pauses ALL trading
- Prevents overtrading
- Resets at midnight UTC

### Manual Pause [UI: manualPause checkbox]
- Immediately stops all trading
- Dashboard shows "PAUSED" status

---

## 7. TRADE EXECUTION LIMITS

### Per-Trade Limits
| Limit | UI Setting | Default |
|-------|------------|---------|
| Max single swap | maxSingleSwapSol | 3 SOL |
| Max slippage | maxSlippageBps | 150 bps (1.5%) |
| Min trade size | minTradeUsd | $15 |

### Cooldown Between Trades
```
Same token: 2 minutes
Any trade: No minimum (can do 3 per tick)
Max trades per tick: 3
```

---

## 8. RISK PROFILES

Four profiles available [UI: dropdown]:

| Profile | Take Profit | Stop Loss | Max Swap | Slippage |
|---------|-------------|-----------|----------|----------|
| conservative | 15% | 15% | 1 SOL | 100 bps |
| moderate | 20% | 15% | 2 SOL | 125 bps |
| high | 25% | 15% | 3 SOL | 150 bps |
| aggressive | 35% | 15% | 5 SOL | 200 bps |

Note: Stop loss is always 15% (hardcoded in strategy logic)

---

## 9. TIMING & SCHEDULING

### Main Loop [UI: loopSeconds]
- Default: 60 seconds
- Evaluates all positions and signals
- Executes up to 3 trades per tick

### Market Scan
- Runs every 30 minutes (hardcoded)
- Fetches trending tokens from DexScreener
- Fetches new listings
- Results appear in Opportunities tab

---

## 10. WEIGHT ALLOCATION

### Target Weight Calculation
When regime is "trend" with positive score:
```
baseWeight = 0.05 (5% base allocation)
```

When regime is "range" or score <= 0:
```
targetWeight = 0
```

### Rebalance Band
```
band = 0.02 (2%)
```
- Only trades if |drift| > 2%
- Prevents excessive small trades

---

## 11. PRICE DATA SOURCES

### DexScreener API
- Primary price source
- Provides: price, 24h volume, liquidity, price changes
- Rate limited: 300 requests/minute

### Fallback
- Jupiter API for swap quotes
- On-chain data for token balances

---

## 12. PRICE DATA SAFETY MECHANISMS

These safeguards prevent catastrophic losses when price data is missing or invalid.

### Problem Addressed
New tokens may not be indexed by external price feeds immediately after purchase. Without protection, the bot could:
1. See price = 0 for a newly bought token
2. Trigger false stop-loss (0 < entry * 0.85 = true)
3. Execute sell with 0 decimals, resulting in 0 tokens sent
4. Receive 0 SOL back = total loss

### Safety Gates (All Exit Logic)
Before any sell, the bot validates price data:

```
Take-Profit:    Skip if pos.priceUsd <= 0
Stop-Loss:      Skip if pos.priceUsd <= 0
Regime Sell:    Skip if v.usdPrice <= 0
Concentration:  Skip if largestPos.priceUsd <= 0
```

When skipped, bot logs: `"Skipping [strategy] - no valid price data"`

### Price Seeding After Buy
Immediately after a successful buy:
```typescript
if (!prices[mint] || prices[mint].usdPrice <= 0) {
  prices[mint] = { 
    usdPrice: effectivePrice,   // Calculated from trade
    decimals: tokenDecimals,    // From trade or default 9
    blockId: null 
  };
}
```

This ensures the next tick has valid price data even if external feeds haven't caught up.

### Decimals Fallback
All sell paths use: `decimals = prices[mint]?.decimals ?? 9`

SPL tokens use 9 decimals by default. Never default to 0, which would truncate token amounts.

### Re-Entry Already Protected
Re-entry logic has built-in protection:
```
if (!priceData || priceData.usdPrice <= 0) continue;
```

---

## 13. CONSTANTS (Hardcoded)

These require code changes to modify:

```typescript
// src/bot/index.ts
REENTRY_COOLDOWN_MS = 3 * 60 * 1000     // 3 minutes
REENTRY_WINDOW_MS = 30 * 60 * 1000      // 30 minutes
REENTRY_MIN_MOMENTUM_SCORE = 1.0        // Minimum score for re-entry

// src/bot/strategy.ts
STOP_LOSS_PCT = 0.15                    // 15% stop loss
BASE_WEIGHT = 0.05                      // 5% target allocation
REBALANCE_BAND = 0.02                   // 2% drift threshold

// Trade execution
COOLDOWN_MS = 2 * 60 * 1000             // 2 min between same-token trades
MAX_TRADES_PER_TICK = 3                 // Max trades per loop iteration
```

---

## 14. DECISION FLOW SUMMARY

```
TICK START
    |
    v
[Get Prices & Portfolio Snapshot]
    |
    v
[Generate Signals for Each Token]
    - Calculate momentum score
    - Determine regime (trend/range)
    |
    v
[SELLS: Take-Profit Check]
    - If price >= entry * 1.25 -> SELL ALL, track for re-entry
    |
    v
[SELLS: Stop-Loss Check]
    - If price <= entry * 0.85 -> SELL ALL
    |
    v
[SELLS: Concentration Rebalancing]
    - If top-3 > 70% -> Sell largest position portion
    |
    v
[BUYS: Re-Entry Check]
    - If tracked token still strong after 3+ min -> BUY
    |
    v
[BUYS: Drift-Based Rebalancing]
    - If target > current + band AND trend AND score > 0 -> BUY
    - Check all risk limits before executing
    |
    v
[Update Dashboard State]
    |
    v
TICK END (wait loopSeconds)
```

---

## 15. LOGGING STRATEGIES

Trade logs use these strategy names:
- `take_profit` - Sold at profit target
- `stop_loss` - Sold at loss limit
- `drift` - Normal rebalancing trade
- `regime_based` - Sold due to regime change
- `concentration_rebalance` - Sold to reduce concentration
- `reentry_momentum` - Bought back after take-profit

---

Last Updated: December 22, 2025
