# Solana Autonomous Trading Bot

## Project Overview
A professional autonomous quantitative trading bot for Solana tokens. Features multi-asset portfolio management with regime-based signal trading, scout/core slot hierarchy, automatic token discovery and rotation, trailing stops, circuit breakers, and a Matrix-themed live dashboard.

## Recent Changes (Jan 30, 2026)
- **CRITICAL FIX: USDC Auto-Buy Bug**: Fixed bug where USDC was autonomously converted to SOL when it became the majority held position:
  - **Root Cause**: `rotation.ts` only excluded MINT_SOL from position tracking/exits, NOT MINT_USDC
  - **Symptom**: When holding mostly USDC (after flash close to stables), bot treated USDC as a tradeable position, triggering stop-loss/stale exits which converted 100% of USDC back to SOL
  - **Fix**: Added MINT_USDC exclusion to all position filters in `rotation.ts` (lines 107, 216, 228)
  - **Files Changed**: `src/bot/rotation.ts` (3 filter locations)
  - **Expected Behavior**: USDC is now treated as a base asset (like SOL) and never enters position tracking or exit logic

- **Buy SOL Button for USDC Positions**: Dashboard now shows a green "Buy SOL" button for USDC positions:
  - **Purpose**: Manual conversion from stables back to trading capital (inverse of flash close)
  - **Reserve Limit**: Uses 95% of USDC balance, keeping 5% reserve (matches flash close behavior)
  - **New Endpoint**: `/api/usdc-to-sol` with confirmation token requirement
  - **UI**: Green button replaces red flash close button for USDC positions only

## Recent Changes (Jan 29, 2026)
- **Exit Liquidity Validation**: Prevents entries and promotions when exit routes are too costly or fragmented:
  - **Problem Solved**: Bot could enter positions with thin liquidity, then get stuck with high slippage on exit
  - **Entry Check Flow**: Before any buy, simulates a 90% position sell to validate exit viability
  - **Promotion Check Flow**: Before scout-to-core promotion, simulates full post-promotion core-size exit
  - **Lane-Specific Thresholds**: Scouts allow more risk (8% impact, 94% roundtrip, 3 hops), cores stricter (5% impact, 96% roundtrip, 2 hops)
  - **Route Blacklist**: Can disallow specific intermediate mints in exit routes (exitLiqDisallowMints config)
  - **Safety Haircut**: Simulates selling 90% of position (configurable) to be conservative
  - **9 New Config Settings**: exitLiquidityCheckEnabled, exitLiqMaxImpactPctScout/Core, exitLiqMinRoundTripScout/Core, exitLiqMaxHopsScout/Core, exitLiqSafetyHaircut, exitLiqDisallowMints
  - **New Module**: `src/bot/exit_liquidity.ts` with checkExitLiquidityForEntry, checkPromotionExitLiquidity, getExitLiquiditySettings
  - **Integration Points**: scout_auto.ts (autonomous buys), index.ts (allocation buys and promotions)
  - **17 Unit Tests**: Coverage in `src/bot/__tests__/exit_liquidity.test.ts`
  - **Expected Behavior**: Logs EXIT_LIQ_CHECK_FAIL or PROMOTION_EXIT_LIQ_FAIL when blocked

- **CRITICAL FIX: Peak Price Reset on Promotion**: Fixed bug causing immediate exit after scout-to-core promotion:
  - **Root Cause**: When promoting scout to core, peak_price was NOT reset, so trailing stop logic used the old scout peak
  - **Symptom**: Position promoted to core, then immediately sold via trailing stop (within 1-2 minutes)
  - **Fix**: `executePromotion()` now resets `peak_price` to current price, giving core position a fresh start
  - **Files Changed**: `src/bot/persist.ts` (updatePositionSlotType), `src/bot/rotation.ts` (executePromotion), `src/bot/index.ts` (promotion call site)

## Recent Changes (Jan 26, 2026)
- **1-Minute Fill-Forward Bars**: Guarantees one bar per minute per tracked mint so strict SMA gating can work:
  - **Problem Solved**: Bars were sparse (only written on price change/quote), so `smaGateBars` stalled at ~20-40 and never reached 60
  - **New Module**: `src/bot/bar_writer.ts` with fill-forward logic aligned to minute boundaries
  - **Tracked Mints Set**: In-memory Set with 6h TTL and 200 max cap - mints added on SCOUT_ENTRY_EVAL
  - **Last Price Cache**: In-memory Map updated on every price insert, hydrated from DB on startup
  - **Fill-Forward Logic**: Every minute, for each tracked mint with a known price, inserts a bar if none exists
  - **DB Safety**: Uses `ON CONFLICT DO NOTHING` to avoid duplicates, no uncontrolled DB growth
  - **BAR_FILL_FORWARD_SUMMARY Log**: Shows minuteTs, trackedMintCount, barsWritten, skippedNoPriceCount, skippedAlreadyExistsCount
  - **Integration**: `initBarWriter()` called at startup, prices update cache on every tick
  - **13 Unit Tests**: Coverage in `src/bot/__tests__/bar_writer.test.ts`
  - **Expected Behavior**: `smaGateBars` increases by ~1 per minute, reaches 60 within ~60 minutes, then SMA gate passes/fails based on price

## Recent Changes (Jan 25, 2026)
- **Strict SMA Gating (100% Bars Required)**: Fixed SMA computation to require full bar count and added explicit gate logging:
  - **100% Bar Requirement**: `computeSMAWithMeta()` now returns null unless `bars >= minutes` (was 80% before)
  - **No Partial-Window SMAs**: With 240m trend window, you need 240 bars — no shortcuts, no fake SMAs
  - **Explicit Gate Logging**: SCOUT_ENTRY_EVAL now includes `smaGate`, `smaGateBars`, `smaGateMinutesUsed`, `smaGatePass` to show exactly which SMA gated
  - **Additional Fields**: `smaShortMinutes`, `smaTrendMinutes` added for clarity
  - **Impact**: With `scoutEntryTrendSmaMinutes=240`, tokens need 4h of tracked price history to pass the gate

- **Pullback-in-Trend SMA Filter**: Replaced broken "above 30m SMA" filter with trend-aware pullback entry logic:
  - **Problem Solved**: The old SMA gate (price > SMA30) blocked pullback entries AND silently passed tokens with no price history
  - **Hard Fail on Insufficient History**: If trend SMA can't be computed (< 100% of required bars), entry FAILS with `INSUFFICIENT_HISTORY` - no more silent skips
  - **Trend Filter Instead of Buy-the-Top Filter**: Now requires `priceNow > SMA(trendWindow)` instead of `priceNow > SMA(shortWindow)`
  - **Pullbacks Allowed**: You can now buy tokens that are below their short SMA (30m) as long as they're above their trend SMA (240m) - this is a pullback in an uptrend
  - **New Helper**: `computeSMAWithMeta(mint, minutes)` returns `{sma, bars, minutes}` for validation
  - **New Config Setting**: `scoutEntryTrendSmaMinutes` (default 240 = 4 hours) - the trend SMA window
  - **Existing Config**: `scoutEntrySmaMinutes` (default 30) - kept for short SMA logging only
  - **Fail Reasons**: `INSUFFICIENT_HISTORY` (can't compute trend SMA), `BELOW_TREND_SMA` (price <= trend SMA = downtrend)
  - **Enhanced Logging**: SCOUT_ENTRY_EVAL now includes smaShort, smaShortBars, smaTrend, smaTrendBars, smaTrendMinutes, smaGate, smaGateBars, smaGateMinutesUsed, smaGatePass
  - **9 Unit Tests**: Comprehensive coverage in `src/bot/__tests__/scout_entry_sma.test.ts`
  - **Expected Behavior**: New/young tokens with < 4h of history are blocked; downtrending tokens are blocked; pullbacks in uptrends are allowed

## Recent Changes (Jan 21, 2026)
- **Rug Defense Layer - Liquidation Lock System**: Prevents averaging down into rugs and ensures protective exits execute:
  - **Problem Solved**: After a stop-loss trigger, exits were blocked by minTradeUsd (position value too low), then allocator immediately tried to buy more to restore targetPct
  - **Invariant A - Protective Exits Bypass minTradeUsd**: scout_stop_loss_exit, break_even_exit, break_even_lock_exit, stale_timeout_exit, core_loss_exit now bypass minTradeUsd checks
  - **Invariant B - Liquidation Lock**: Once protective exit triggers, ALL buys/adds for that mint are blocked for 24 hours
  - **Invariant C - SCOUT_NO_TOPUP**: Existing scout positions CANNOT receive allocation drift top-ups - scouts are fixed-size probes
  - **New Module**: `src/bot/liquidation_lock.ts` with isProtectiveExit(), setLiquidatingState(), isLiquidatingMint(), clearLiquidatingState(), getActiveLiquidations()
  - **New DB Columns**: position_tracking table now has: liquidating (boolean), liquidating_reason (text), liquidating_since (timestamptz), reentry_ban_until (timestamptz)
  - **Allocation Rebalancer Block**: Liquidating mints treated as targetPct=0, logged as BUY_SKIPPED_LIQUIDATING
  - **Reentry Buy Block**: Reentry logic skips liquidating mints with BUY_SKIPPED_LIQUIDATING log
  - **Regime Trend Buy Block**: Regime buys skipped for liquidating mints with BUY_SKIPPED_LIQUIDATING log
  - **Scout Queue Block**: enqueueScoutCandidates and processScoutQueue both check isLiquidatingMint before allowing entry
  - **Scout No Top-Up**: When slotType='scout' AND position exists, plannedAddUsd forced to 0 with binding constraint SCOUT_NO_TOPUP
  - **Logging**: PROTECTIVE_EXIT_BYPASS_MIN_TRADE, BUY_SKIPPED_LIQUIDATING, SCOUT_NO_TOPUP logs for observability
  - **19 Unit Tests**: Comprehensive coverage in `src/bot/__tests__/liquidation_lock.test.ts`
  - **Expected Behavior**: After stop triggers, never see SOL->TOKEN buys for that mint; protective exits always attempt; scouts don't average down

## Recent Changes (Jan 20, 2026)
- **Path A Enforcement - Scout Lifecycle Management**: Scouts are now protected from allocation/regime-based sells:
  - **Hard Rule**: Scout positions CANNOT be sold by allocation targets or regime rebalancing
  - **Scout Exits Only Via**: stop-loss, TP, trailing stop, stale timeout, underperform grace, reentry rules
  - **Implementation**: Added slotType='scout' guard in regime sell path before hysteresis check
  - **Logging**: Debug-level only (no allocation_events/rotation_log spam for expected behavior)
  - **Promotion Unaffected**: Verified promotion logic does NOT depend on targetPct - uses pnlPct, signalScore, hoursHeld
  - **Core Unchanged**: Core positions still subject to regime sells (with hysteresis gates)
  - **6 Unit Tests**: Added to rebalance_hysteresis.test.ts for scout vs core behavior
  - **Expected Behavior**: rotation_log will no longer show regime_trend_sell for scouts; scouts persist until lifecycle exits
  
- **Sell Hysteresis Implementation**: 3-gate system to prevent instant churn from volatile target allocation drops:
  - **Gate 1 - MIN_HOLD_BEFORE_REBALANCE_SELL**: Position must be held for configurable minimum time (default 15 min) before rebalance sell allowed
  - **Gate 2 - TARGET_DROP_NOT_PERSISTENT**: Target must remain below current for N consecutive ticks (default 3) to confirm trend
  - **Gate 3 - TRIM_TOO_SMALL**: Skips trims below minimum USD threshold (default $20) to avoid fee bleed
  - **New Module**: `src/bot/rebalance_hysteresis.ts` with updateTargetState, evaluateRebalanceSellGate functions
  - **In-Memory Tracking**: Per-mint consecutiveTicksBelowCurrent counter, resets when target >= current
  - **Scope**: Only applies to regime/allocation-based sells (NOT stop-loss, trailing stop, etc.)
  - **Observability**: Skipped sells logged to allocation_events (outcome=SKIPPED) and rotation_log (action=skipped)
  - **New Settings**: rebalanceSellMinHoldMinutes, rebalanceSellTargetDropConfirmTicks, rebalanceSellMinTrimUsd
  - **35 Unit Tests**: Comprehensive coverage in `src/bot/__tests__/rebalance_hysteresis.test.ts`
  
- **Rotation Log Audit Gap Fix**: Regime-based sells now logged to rotation_log table:
  - **Root Cause**: Regime sells (allocation-driven rebalancing) were executing but NOT logging to rotation_log
  - **Affected Path**: Lines 4195-4310 in index.ts - regime_trend_mr sells
  - **Fix**: Added insertRotationLog call with action='exit' or 'trim', reasonCode='regime_trend_sell'
  - **Meta Fields**: txSig, targetPct, currentPct, drift, proceedsUsd, soldAmount, remainingAmount, exitType, slotType
  - **All Exit Paths Now Logged**: closePosition, take_profit, concentration_rebalance, rotation, trailing_stop, stale_exit, AND regime_trend_sell
  
- **Must-Price Coverage Refactor**: Price coverage now computed over targeted mints only (not 800+ wallet dust):
  - **Core Helpers**: `getMustPriceMints()` returns SOL/USDC/USDT + positions + allocation targets
  - **computeMustPriceCoverage()**: Calculates coverage ratio, priced count, and missing mints array
  - **Split Thresholds**: `executionPriceCoverageMin` (0.60) gates trading, `equityPriceCoverageMin` (0.75) gates risk updates
  - **Post-Allocation Recheck**: After targets computed, coverage rechecked with targets included
  - **executionBlockedFinal**: New variable that includes allocation targets for trade gating
  - **PRICE_COVERAGE_FAILED Log**: Now shows isTarget/isPosition flags for each missing mint
  - **Drawdown Gating**: Uses positions-only coverage (appropriate since drawdown measures current holdings)
  - **Execution Gating**: Uses target-inclusive coverage (blocks trade if target mint lacks price)
  - **162 Setting Descriptions**: All bot_settings entries have accurate descriptions documenting their functionality
  - **Type Coercion Fix**: Numeric settings now parse correctly as numbers, not strings
  - **15 Unit Tests**: Comprehensive coverage in `src/bot/__tests__/must_price_mints.test.ts`
  - **New Files**: `src/bot/must_price_mints.ts`

## Recent Changes (Jan 19, 2026)
- **Allocation Instrumentation Suite**: Complete allocation debugging and execution visibility:
  - **Task A - Scaling Visibility**: scoresToTargets returns ScalingMetadata (sumRawTargetsPct, sumScaledTargetsPct, scaleFactor, clampedCount, redistributionPassesUsed)
  - **ALLOCATION_GAP_DIAGNOSTIC**: Shows raw vs scaled targets, deployTargetPct, all scaling metadata
  - **ALLOCATION_CONFIG_STARTUP**: One-time log at bot start showing deployTargetPct, capMaxMintExposurePct, capMaxTotalExposurePct
  - **Task B - Planned vs Executed**: Renamed actualAddUsd→plannedAddUsd, added executedAddUsd/executionOutcome/executionReason/txSig/feeGovernor
  - **Execution Outcomes**: SKIPPED for allocator-blocked trades (cooldown, min trade, caps), PENDING for approved, NOT_ATTEMPTED for no gap
  - **Task C - Execution Feedback**: New allocation_events table persists all allocation attempts with outcomes
  - **ExecutionResult Type**: Structured return from execution layer (outcome, reason, txSig, executedUsd, feeDecision)
  - **Task D - Non-Target Holdings**: nonTargetHoldings array shows top 5 positions with exposure but no target (explains totalCurrent > totalTarget)
  - **Task E - Stuck Target Watchdog**: Feature-flagged (allocationStuckWatchdogEnabled=false) exponential backoff for repeatedly-failed targets
  - **Task F - Unit Tests**: 60 tests across 3 files (allocation_scaling, stuck_target_watchdog, allocation_events)
  - **New Config Settings**: allocationStuckWatchdogEnabled, allocationStuckMinGapPct, allocationStuckMaxAttempts, allocationStuckBackoffMinutesBase
  - **New Files**: src/bot/allocation_events.ts, src/bot/stuck_target_watchdog.ts

- **Utilization Scaling & Allocation Gap Diagnostics**: Addressing ~82% idle capital issue:
  - **Config Alignment**: Raised `capMaxMintExposurePct` from 8% to 12% so core positions can reach their 12% target
  - **Risk Budget Fix**: Aligned `riskBudget` in decisions.ts to 0.55 (matching `capMaxTotalExposurePct`) as single source of truth
  - **ALLOCATION_GAP_DIAGNOSTIC Log**: New structured log showing target, current, gap, desired/actual add USD, and binding constraint
  - **Binding Constraint Detection**: Correctly identifies MAX_MINT_EXPOSURE, MAX_TOTAL_EXPOSURE, MAX_SINGLE_SWAP, MIN_TRADE_USD, COOLDOWN
  - **Cooldown Fix**: Uses `config.loopSeconds * 3` instead of hardcoded 180s for accurate COOLDOWN flagging
  - **Lever 2 - Utilization Scaling**: New `deployTargetPct` (default 0.35) scales non-zero targets proportionally
  - **Multi-Pass Redistribution**: Up to 5 passes to redistribute remaining budget to unclamped positions after hitting per-asset caps
  - **New Config**: `deployTargetPct` added to RuntimeConfig with DB persistence via `deploy_target_pct` key
  - **Lever 3 Optional**: Top-K exploration budget pending user decision based on live performance

- **Scout Queue Stuck Row Fixes**: Enhanced watchdog for automatic recovery of stuck scout queue items:
  - **Watchdog Module**: `src/bot/scoutQueueWatchdog.ts` with `resetStaleBuyingScoutQueue()`
  - **Exponential Backoff**: Retries use baseBackoff * 2^attempt formula for progressively longer cooldowns
  - **Retry Limits**: Max 3 attempts before permanent SKIPPED marking (configurable via `scoutQueueMaxBuyAttempts`)
  - **Unified Status**: Changed from BUYING to IN_PROGRESS as single source of truth for claimed items
  - **ManualPause Gate**: Check happens BEFORE claimNextQueuedScout() to prevent orphaned claims
  - **Config Settings**: Added `scoutQueueStaleMinutes` (5), `scoutQueueMaxBuyAttempts` (3)
  - **Unit Tests**: 6 new tests in `scoutQueueWatchdog.test.ts`
- **Fee Governor Decision Persistence**: Actual fee decisions now stored in database:
  - **SwapResult Enhancement**: `feeDecisionSummary` field captures actual fees from Jupiter execution
  - **Trade Analytics**: `priority_fee_lamports` in bottrades reflects real fee paid, not estimates
  - **Meta Field**: `feeGovernor` object stored with priorityLevel, maxLamports, and reason
- **Price Coverage Guard**: Prevents false drawdown alerts from incomplete price data:
  - **Coverage Tracking**: Computes heldCount, pricedCount, and coverage ratio each tick
  - **90% Threshold**: Configurable via `equityPriceCoverageMin` (default 0.90)
  - **Circuit Protection**: Skips updateCircuit/checkCircuit when coverage below threshold
  - **Pause State Preservation**: Bot pause state only updated when coverage is complete
  - **Logging**: PRICE_COVERAGE_CHECK and INCOMPLETE_PRICES logs for observability

## Recent Changes (Jan 16, 2026)
- **Priority Fee Governor**: Notional-aware priority fee computation for optimal transaction inclusion:
  - **New Module**: `src/bot/feeGovernor.ts` with `getPriorityFeeLamports()` function
  - **Notional-Based Fees**: Fees scale with trade size (0.3% for scout, 0.2% for core lane)
  - **Retry Ladder**: Exponential backoff multipliers [1, 2, 4, 8] on retry attempts
  - **Min/Max Caps**: Exit trades have 100k lamport floor; Scout max 400k, Core max 1M
  - **Fee Ratio Guard**: Optional skip recommendation when effective fee ratio exceeds 1%
  - **Safety Haircut**: 0.85 multiplier leaves headroom below computed max
  - **Feature Flag**: `feeGovernorEnabled` OFF by default for safe gradual rollout
  - **Lane Detection**: Inferred from strategy name (scout/autonomous) or meta.lane field
  - **Jupiter Integration**: Passes computed `prioritizationFeeLamports` and `priorityLevel` to swap API
  - **Structured Logging**: `logFeeDecision()` captures all decision factors for observability
  - **11 New Settings**: All database-backed in runtime_config for runtime modification
  - **CLI Demo**: `scripts/feeGovernorDemo.ts` for dry-run fee computation with comparison tables
  - **17 Unit Tests**: Comprehensive coverage in `src/bot/__tests__/feeGovernor.test.ts`

## Recent Changes (Jan 14, 2026)
- **SELL_EXECUTED Failsafe Logging**: Added centralized audit log for ALL sell transactions to prevent silent sales:
  - **Problem Solved**: Tokens were being sold without recorded reason (no rotation_log, no bot_trades entry, no console log explaining WHY)
  - **Solution**: Added `SELL_EXECUTED` failsafe log in `executeSwap()` that fires for EVERY successful sell (inputMint ≠ SOL)
  - **Log Level**: Uses `logger.warn` to ensure high visibility in production logs
  - **Captured Fields**: mint, strategy, status, txSig, inAmount, outAmount, reasonCode, full meta
  - **ReasonCode Standardization**: Updated all sell paths to include `reasonCode` in meta:
    - take_profit, concentration_rebalance, regime_trend_mr, exit_invariant_cleanup, sniper_* (stop_loss/take_profit/timeout)
    - closePosition and rotation already had reasonCode
  - **Fallback**: Shows "UNKNOWN" if caller forgets reasonCode (alerts operators to fix the gap)
  - **Files Modified**: execution.ts, index.ts, exit_invariant.ts, sniper/executor.ts
- **Critical PnL Cost Basis Fix**: Fixed incorrect cost basis recording when capital management adjusts trade size:
  - **Root Cause**: `scout_auto.ts` was using `config.scoutBuySol` (default config value) instead of `spendSol` (actual adjusted value from capital management) when calculating cost basis
  - **Impact**: When capital management adjusted scout buy sizes, the recorded cost basis was wrong, causing PnL percentage to be wildly incorrect (e.g., +194% instead of +0%)
  - **Fix**: Changed 4 locations in scout_auto.ts (live path lines 750, 832 and paper path lines 931, 1023) to use `spendSol` variable
  - **Safeguard Logging**: Added `sizeWasAdjusted` detection that logs when capital management modifies the trade size, showing both actual and config values

## Recent Changes (Jan 13, 2026)
- **Capital Management System**: Capacity-aware sizing that prevents scaling into negative EV:
  - **Three-Cap Sizing**: `finalSize = min(riskCap, liquidityCap, edgeCap, mintCap)` - smallest constraint wins
  - **Sublinear Scout Scaling**: Uses sqrt-based sizing to prevent scouts from becoming PnL chasers as equity grows
  - **Size Sweep**: Quote-based roundtrip checks at multiple multipliers (0.5x, 1x, 2x, 4x, 8x) to find max feasible size
  - **Capacity Telemetry**: Tracks realized vs quoted slippage with auto-adjusting governor (future)
  - **Liquidity Tier Requirements**: Separate minimums for scout ($25k TVL, $5k 5m vol) vs core ($150k TVL, $25k 5m vol)
  - **Critical Safety**: Rejected trades skip entirely (no fallback to legacy sizing)
  - **26 New Settings**: All fully database-backed in bot_settings table for runtime modification:
    - `capital_mgmt_enabled` - Master toggle for capacity-aware sizing
    - `cap_max_total_exposure_pct`, `cap_max_core_exposure_pct`, `cap_max_scout_exposure_pct`, `cap_max_mint_exposure_pct` - Portfolio exposure limits
    - `cap_risk_per_trade_scout_pct`, `cap_risk_per_trade_core_pct` - Risk budget per position type
    - `cap_entry_max_impact_pct_scout/core`, `cap_exit_max_impact_pct_scout/core` - Price impact constraints
    - `cap_roundtrip_min_ratio_scout/core` - Minimum roundtrip efficiency (slippage tolerance)
    - `cap_liquidity_safety_haircut` - Haircut applied to quoted liquidity
    - `cap_max_participation_5m_vol_pct`, `cap_max_participation_1h_vol_pct` - Volume participation limits
    - `cap_min_pool_tvl_usd_scout/core`, `cap_min_5m_vol_usd_scout/core` - Tier minimums
    - `cap_scout_size_min_usd`, `cap_scout_size_max_usd`, `cap_scout_size_base_usd`, `cap_scout_size_base_equity` - Scout sizing bounds
    - `cap_edge_buffer_pct` - Edge buffer for fee/slippage
    - `cap_size_sweep_multipliers` - JSON array of multipliers for size sweep
  - **New Files**: `src/bot/capital_management.ts` with `chooseSize()`, `checkLiquidityTierRequirements()`, `runSizeSweep()`
  - **Settings Seeding**: Missing settings automatically populated in database on startup
- **Honeypot/Sellability Filter**: Pre-buy validation to eliminate unsellable tokens:
  - New module `src/bot/sellability.ts` with `checkSellability()` function
  - Gets buy quote (SOL→TOKEN), then sell quote (TOKEN→SOL) using 90% of buy output
  - Rejects tokens with round-trip ratio < 0.92 (8% max loss) or sell impact > 3%
  - Integrated into scout_auto.ts before any purchase execution
  - New settings: `prebuyRoundtripMinRatio` (0.92), `prebuyMaxSellImpactPct` (0.03)
- **Break-Even Lock Protection**: Prevents profitable trades from becoming losses:
  - Once position reaches +6% (`breakEvenLockProfitPct`), effective stop becomes entry price
  - Uses dedicated `breakEvenExitTriggered` flag (separate from core trailing stops)
  - Exit triggers when pnlPct < -0.5% (accounting for fees/slippage)
  - Priority 0 in evaluateRotation - executes BEFORE all other exit logic
  - Protected from: scout grace expired, stale timeout, stale exit no replacement
  - Can still rotate via opportunity-cost when candidate beats rotationThreshold (2.5)
- **Churn Reduction Settings**: Updated 17 config values to reduce premature exits:
  - `staleExitHours`: 1→2, `stalePnlBandPct`: 0.01→0.02
  - `scoutUnderperformMinutes`: 60→90, `scoutGraceMinutes`: 14→20
  - `rotationThreshold`: 1.5→2.5
  - `trailingStopProfitThreshold`: 0.35→0.12, `trailingStopBasePct`: 0.37→0.20, `trailingStopTightPct`: 0.20→0.10
  - `scoutStopLossPct`: 0.08→0.07
  - `promotionDelayMinutes`: 60→75, `promotionMinPnlPct`: 0.02→0.03
  - `reentryMinMomentumScore`: 1→7

## Recent Changes (Jan 10, 2026)
- **Orphan Position Liquidation System**: Prevents "orphan" positions (held tokens no longer in target universe) from sitting unmanaged:
  - New `orphanExitGraceTicks` setting (default 2) - configurable grace period before liquidation
  - New module `src/bot/orphan_tracker.ts` - tracks consecutive ticks each mint is missing from targets
  - Orphans identified by comparing wallet holdings vs. target mints (universe + candidates + tracked positions)
  - After grace period, generates `universe_exit` decisions routed through standard closePosition flow
  - Maintains FIFO P&L tracking integrity by using existing exit pipeline
  - Telemetry counters: `unmanagedHeldCount`, `unmanagedHeldUsd` for monitoring dashboards
  - Structured logging: ORPHAN_TELEMETRY, ORPHAN_READY_FOR_EXIT, UNIVERSE_EXIT for debugging
  - Per-tick limit: MAX_ORPHAN_EXITS_PER_TICK = 3 to prevent excessive processing
  - Unit tests: 11 tests in `src/bot/__tests__/orphan_tracker.test.ts`
- **Decision Attribution System Enhancements**:
  - Added `decision_id` parameter to `insertTradeLot()` in pnl_engine.ts
  - Runtime warning (ERROR level): DECISION_ATTRIBUTION_GAP logged when trade_lot recorded without decision_id
  - Orphan exit paths thread decision_id through logDecision → closePosition → trade_lots
  - Enables complete audit trail for all universe_exit trades

## Recent Changes (Jan 7, 2026)
- **Volatility Scraper Scouts + Continuation-Only Promotion**: Complete strategy overhaul for proactive pullback harvesting:
  - **Scout Entry Gating**: New `evaluateScoutEntry()` in scout_auto.ts with no-chase gate (ret15 < 25%), pullback requirement (8% from 15m high after 10% impulse), and SMA filter
  - **Scout TP = Full Exit**: Modified take-profit flow in index.ts to always execute full exit on TP - no more promoting on take-profit (TP acts as "cash register")
  - **Continuation-Only Promotion**: New async `evaluatePromotionWithContinuation()` in ranking.ts requiring: 1hr+ hold, ret60 > 10%, ret15 > 0%, 3% pullback from 30m high, above SMA60
  - **Price Metrics Module**: New `src/bot/price_metrics.ts` with computeReturn, computeHigh, computeSMA, computeDrawdown functions backed by prices table
  - **New Settings** (13 total): scoutChaseRet15Max, scoutImpulseRet15Min, scoutPullbackFromHigh15Min, scoutEntrySmaMinutes, scoutEntryRequireAboveSma, promotionMinHoursHeld, promotionRequireRet60Min, promotionRequireRet15Min, promotionAvoidTopDrawdown30, promotionSmaMinutes, promotionRequireAboveSma
  - **Observability**: SCOUT_ENTRY_EVAL and PROMO_EVAL structured logging for all gate evaluations
- **Scout Exit Pipeline Fix**: Complete fix for scout exits being detected but not executing:
  - **Unified exitActions pipeline**: Single source of truth for all exit triggers (stop-loss, take-profit)
  - **Proper counter wiring**: sellsAttempted incremented BEFORE closePosition, sellsExecuted/sellsFailed AFTER result
  - **Suppression accounting**: Every skip has a counter (maxPerTick, minTradeUsd, balanceZero, holdTimeTooShort/other)
  - **EXIT_SUPPRESSED logging**: Every skipped action logs exact reason with mint and pnlPct
  - **EXIT_INVARIANT_VIOLATION**: Error logged if triggers > 0 but no sells or suppressions (catches any disconnect)
  - **Mint-level diagnostics in EXIT_EVAL_SUMMARY**: stopTriggeredMints, tpCandidateMintsTop, tpTriggeredMints, exitActionsTop10
  - **/api/debug/pnl_compare**: New endpoint showing UI vs evaluator pnlPct to diagnose TP threshold mismatches
  - **ensurePositionTrackingHealth()**: Runs at startup AND hourly to backfill missing tracking entries
  - **Pause gating fixed**: Pause blocks BUYs only, protective SELLs always execute (SELL_BYPASS_PAUSE logging)
  - **/api/debug/position_health**: Production sanity checks endpoint

## Recent Changes (Jan 5, 2026)
- **Scout Take-Profit System**: Automated profit harvesting for scout positions:
  - New settings: `scoutTakeProfitPct` (default 8%), `scoutTpMinHoldMinutes` (default 5 min)
  - Decision logic: Scouts held ≥5 minutes with PnL ≥8% trigger evaluation
  - Promotion path: If meets criteria (trend regime, signal ≥2.0, PnL ≥20%, held ≥15min) → promote to core
  - Exit path: If not promotable → exit with SELL_SCOUT_TAKE_PROFIT reason code
  - Structured events: SCOUT_TP_TRIGGER, SCOUT_TP_PROMOTE, SCOUT_TP_EXIT for analytics
  - Quote preflight: Validates Jupiter quote before executing exits
  - Performance: Uses trackingMap to avoid N+1 DB queries
  - Per-tick limit: MAX_SCOUT_TP_PER_TICK = 2 to prevent excessive processing
  - Sanity tests: `scripts/scout_tp_sanity.ts` (6/6 tests passing)
- **Comprehensive P&L Tracking System**: End-to-end P&L tracking with consistency guarantees:
  - **Peak P&L Tracking**: New `peak_pnl_pct` column in position_tracking, updated on every price tick
  - **FIFO→bot_trades Sync**: `updateTradePnl()` propagates FIFO results to bot_trades.pnl_usd after sells
  - **Post-Sell Validation**: `validateTradePnlConsistency()` verifies bot_trades.pnl_usd matches pnl_events sum
  - **Decision Breadcrumbs**: Structured EXIT_DECISION events log all TP/stop/trailing triggers with full context
  - **Settings UI**: Added corePositionPctTarget slider (5-40%) with decimal/percentage conversion
- **P&L Dashboard Consistency Fix**: Fixed P&L discrepancy between Overview and Rotation tabs:
  - Root cause: Rotation tab used stale `last_price` from position_tracking; Overview had no fallback when FIFO missing
  - `/api/slot-status` (Rotation) now uses real-time prices from `getLatestPositions()` telemetry
  - `/api/positions` (Overview) now has position_tracking fallback when FIFO cost basis is missing
  - Both endpoints now use identical data sources: real-time prices, FIFO cost basis with tracking fallback
  - Added `fifoDataMissing` flag to API responses for monitoring

## Recent Changes (Jan 4, 2026)
- **P&L USD Discrepancy Fix**: Fixed dashboard showing $0.00 P&L for positions with missing FIFO data:
  - Root cause: position_lots table missing entries caused take-profit and dashboard to silently skip positions
  - `/api/slot-status` now falls back to position_tracking data when FIFO is unavailable
  - Take-profit check now logs warnings and uses position_tracking entry_price as fallback
  - All exit conditions (take-profit, trailing stop, stop-loss) now work correctly with fallback data
- **Data Integrity Monitoring**: New system to detect FIFO/tracking data mismatches:
  - New function `checkPositionDataIntegrity()` in pnl_engine.ts
  - Detects: missing FIFO data, quantity mismatches (>20%), price mismatches (>50%)
  - New API endpoint `/api/position-data-integrity` for production monitoring
  - Structured logging with DATA_INTEGRITY prefix for easy log searching
- **Enhanced Ranking Logging**: Ranking function now logs warnings when entry price is 0 (stop losses would fail)

## Recent Changes (Jan 3, 2026)
- **Exit Invariant System**: Ensures positions are fully closed on exit trades:
  - New module: `src/bot/exit_invariant.ts` with `enforceExitInvariant()` helper
  - 7 new settings: `exitInvariantEnabled`, `exitInvariantMaxRetries`, `exitInvariantRetryDelayMs`, `exitInvariantMinRemainingQty`, `exitInvariantMinRemainingUsd`, `exitInvariantSlippageBps`, `exitInvariantForceExactClose`
  - Wired into all 4 full-exit sell paths: protective exits, take profit, rotation exit, regime mean revert (full exit only)
  - New query helpers: `getRemainingExposure()`, `insertPartialExitEvent()` in persist.ts
  - New pnl_events type: `partial_exit_remaining` for tracking failed cleanup attempts
  - Cleanup sells tagged with `source='exit_invariant_cleanup'` for attribution
  - Dashboard settings UI updated with Exit Invariant configuration section
  - Sanity test: `scripts/exit_invariant_sanity.ts`
- **Position Decisions Ledger**: Complete trade decision lifecycle tracking:
  - New `position_decisions` table captures every trade decision with action_type, reason_code, qty/usd deltas, signal snapshots
  - Decision types: `enter`, `add`, `trim`, `exit`, `rebalance`
  - Reason codes: `take_profit`, `trailing_stop_exit`, `rotation_exit`, `concentration_rebalance`, `regime_mean_revert`, `scout_stop_loss_exit`, `core_loss_exit`, `rotation_buy`, `reentry_buy`, `regime_trend_buy`, `scout_auto_buy`
  - All 5 sell paths and 6 buy paths instrumented for complete lifecycle audit trail
  - New `decision_id` column in `trade_lots` for correlation
  - Sanity check queries: `getSellsWithoutDecisions()`, `getPromotionsWithoutExits()`, `getTradesWithNullSource()`
  - Helpers: `logDecision()`, `updateTradeLotDecisionId()`, `getPositionDecisions()`, `getDecisionsByJourney()`
- **Allocation Ramp System**: Prevents over-allocation on low tick count tokens:
  - New settings: `allocationRampEnabled`, `minTicksForFullAlloc`, `preFullAllocMaxPct`, `smoothRamp`, `hardCapBeforeFull`
  - Decouples "signal exists" from "how big we're allowed to allocate"
  - Allows signal computation with low ticks (minTicksForSignals=5) while capping allocation until sufficient tick history exists
  - Algorithm: confidence = sqrt(ticks/minTicksForFullAlloc) for smooth ramp; applies cap of preFullAllocMaxPct until ticks >= minTicksForFullAlloc
  - Prevents 35% allocations on tokens with only 5 ticks of history
  - Structured logging when ramp materially reduces sizing (>=1% reduction)
  - New module: `src/bot/allocation_ramp.ts`, sanity tests: `scripts/ramp_sanity.ts`
- **Settings Truth Diagnostic System**: Comprehensive diagnostics for runtime vs. database settings transparency:
  - New API endpoints: `/api/settings/db`, `/api/settings/effective`, `/api/settings/diff`, `/api/risk-state`
  - Enhanced `/api/status` with envName, execMode, settingsHash, gitSha, pid, dbLabel, lastSettingsReloadAt
  - Periodic config refresh (60s TTL) with caching to avoid DB hammering
  - SETTINGS_UPDATED structured logging with changedKeys, hashBefore, hashAfter
  - Enhanced risk.ts with explicit equity-based PnL calculation and baselineType tracking
  - RISK_PAUSE_TRIGGERED/RISK_PAUSE_CLEARED event logging for daily drawdown pause mechanism
  - New Diagnostics dashboard tab with DB settings, effective settings, diff table, and risk state panel
  - Security: All diagnostic endpoints sanitize sensitive keys (database_url, private_key, api_key, etc.)
  - Verification scripts: `scripts/verify-settings.ts`, `scripts/test-hash-stability.ts`

## Recent Changes (Jan 1, 2026)
- **Trade Analytics Infrastructure**: Comprehensive analytics for every trade:
  - New `bot_trades` columns: `reason_code`, `entry_score`, `exit_score`, `fees_lamports`, `priority_fee_lamports`, `route`, `settings_snapshot`, `liquidity_usd`
  - 30+ structured `TRADE_REASONS` codes for all entry/exit types (buy_scout_auto, sell_stop_loss, rotation_exit, etc.)
  - `buildTradeAnalytics()` helper captures fee estimates, route info, and settings at trade time
  - `captureSettingsSnapshot()` records 12 key settings for reproducibility analysis
  - All ~20 trade insertion sites now populate analytics fields for PnL analysis by reason, score bucket, and settings
  - Startup safety checks validate stop loss percentages and detect unit mismatches
- **Token Sniper Module**: New autonomous token sniper for catching new tokens at creation:
  - Detects InitializeMint events via Helius WebSocket API
  - Waits for pool creation (Raydium/Jupiter) with 30s timeout
  - Executes 0.01 SOL buys on new tokens with tradeable pools
  - Hardcoded 84% take profit, 11% stop loss (independent from main bot)
  - Max 50 concurrent sniper positions
  - **Production only**: Only activates in deployed environment
  - API endpoints: `/api/sniper/status`, `/api/sniper/positions`, `/api/sniper/start`, `/api/sniper/stop`, `/api/sniper/reset`
  - Files: `src/sniper/` module (config.ts, helius_ws.ts, pool_detector.ts, position_tracker.ts, executor.ts, index.ts)

## Recent Changes (Dec 31, 2025)
- **Complete Rotation Log Audit Trail**: All sell paths (PROTECTIVE_EXIT, TAKE_PROFIT, CONCENTRATION_REBALANCE) now log to rotation_log table with:
  - Transaction signature (txSig) for on-chain tracing
  - Normalized reasonCodes (scout_stop_loss, core_loss_exit, take_profit, concentration_rebalance)
  - sellAmount for FIFO reconciliation
  - Only logged on successful swaps (status: sent/paper)
- **Environment Identification**: All logs now tagged with `env: "dev"` or `env: "prod"` for clear environment identification
- **Boot Banner**: Startup and periodic (every 10 min) logging of environment context including deploymentId, dbLabel, walletLabel, executionMode, and configHash
- **Config Source Tracking**: Each setting tracks its source (default/env/db) via `getConfigSources()`
- **Environment Mismatch Warnings**: Logs warnings when prod runs in paper mode or dev runs in live mode
- **API Endpoint**: `/api/env-status` shows effective config, sources, and environment info

## Core Capabilities
- **Multi-Asset Portfolio**: Trade any Solana SPL token, not locked to a single asset
- **Autonomous Scout System**: Automatically discovers, evaluates, and trades promising new tokens
- **Regime Detection**: Identifies trend vs range market conditions per token
- **Signal-Based Execution**: Only trades when signal strength exceeds cost threshold
- **Risk Management**: Trailing stops, take profit, drawdown limits, concentration controls
- **Live Dashboard**: Matrix-themed UI with real-time WebSocket telemetry

## Trading Strategy

### Signal Generation
- **Regime Detection**: Classifies each token as "trend" (momentum-following) or "range" (mean-reversion)
- **Multi-Factor Scoring**: Combines signal strength, momentum, time decay, freshness, and quality metrics
- **Edge-First Trading**: Only executes when expected edge exceeds transaction costs

### Portfolio Rotation System

#### Two-Tier Slot Structure
- **Core Slots (5)**: Primary positions at 12% target allocation each
- **Scout Slots (10)**: Smaller exploratory positions at 3% allocation each
- **Dynamic Promotion**: Successful scouts auto-promote to core positions

#### Unified Ranking Engine
Scores both held positions and candidates on the same scale:
- Signal score (current trading signal strength)
- Momentum (unrealized PnL trajectory)
- Time decay (older signals get less weight)
- Trailing stop proximity (near-stop positions rank lower)
- Freshness (recent signals rank higher)
- Quality (token fundamentals like holders, volume, liquidity)

#### Trailing Stop Logic
- **Base Threshold**: 30% drop from peak triggers exit
- **Dynamic Tightening**: For positions with >50% profit, threshold tightens to 12%
- **Peak Tracking**: Continuously updates peak price per position

#### Stale Position Detection
- **Warning Zone**: After 48 hours, positions get ranking penalty
- **Hard Exit**: After 72 hours flat (|PnL| < 5%), force exit regardless of rank

#### Opportunity-Cost Rotation
- Compares worst-held position against best scanner candidate
- Rotation threshold of 1.5 rank delta required before swapping
- Prevents excessive churn while allowing genuine upgrades

#### Scout-to-Core Promotion Criteria
- Position gain >= promotionMinPnlPct (default 20%, configurable)
- Signal score >= promotionMinSignalScore (default 1.0, configurable)
- Held >= promotionDelayMinutes (default 15 minutes, configurable 0-1440)
- Note: Regime (trend/range) is NOT required for promotion

#### Promotion Grace Period
When a scout is promoted to core, a 10-minute grace period is triggered:
- Take-profit evaluation is skipped during grace period
- Grace period cleared when core allocation buy executes and recalculates cost basis
- Prevents immediate take-profit triggers on old low scout cost basis
- Ensures blended cost basis reflects the larger core position buy

### Circuit Breakers
- **Daily Drawdown Limit**: Auto-pauses if drawdown exceeds limit (default 5%)
- **Turnover Cap**: Limits daily trading volume to prevent overtrading (default 100% of portfolio)
- **Per-Trade Size Limits**: Max SOL per swap (1.5 SOL), min USD trade size ($25)
- **SOL Reserve**: Always keeps minimum SOL unspent (0.1 SOL)
- **Low SOL Mode**: Auto-skips all trading when SOL <= reserve + fee buffer (~0.11 SOL). Prevents futile trade attempts when wallet is underfunded. Trading resumes automatically when topped up.

### Capital Deployment Flow (Scout → Promote → Allocate)
New tokens MUST go through the scout system before receiving full allocations:

1. **Scanner Discovery**: High-scoring tokens identified by market scanner
2. **Scout Entry**: If `autonomousScoutsEnabled`, tokens enter as small scout positions (scoutBuySol = 0.02 SOL, 3% of portfolio max)
3. **Promotion Criteria**: Scouts promoted to core when: PnL >= threshold, held >= threshold, signal score >= threshold (regime NOT required)
4. **Core Allocation**: Only promoted core positions can receive full targetPct allocation (up to 40%)

Key safeguards:
- Regime/rotation buys ONLY apply to tokens already in portfolio
- Scout positions capped at `scoutPositionPct` (3%) regardless of signal score
- Core positions can reach `maxPositionPctPerAsset` (40%)
- All buys capped by `capBuyToReserve()` to preserve SOL reserve
- **Core Position Protection**: Regime sells blocked if core position has missing/inconsistent slotType in candidates, or if target is below 50% of baseline allocation (prevents erroneous liquidation due to data consistency issues)

### Risk Profiles
Four configurable risk levels:
- **Low**: Conservative (10% max position, 30-min cooldown, 0.5x turnover)
- **Medium**: Balanced (25% max position, 10-min cooldown, 1x turnover)
- **High**: Aggressive (40% max position, 3-min cooldown, 2x turnover)
- **Degen**: Maximum risk (60% max position, 1-min cooldown, 6x turnover)

## Autonomous Scout System

Fully autonomous token discovery and small-position buying system:

### Flow
1. **Scanner Discovery**: Periodic market scans find high-scoring opportunities
2. **Auto-Queue**: Eligible tokens automatically added to scout queue
3. **Auto-Buy Worker**: Processes queue, buys small scout positions
4. **Rotation Integration**: New scouts visible to promotion/exit logic

### Safety Controls
- **Daily Limit**: Max 5 scout entries per day
- **Per-Token Cooldown**: 24 hours before re-attempting same token
- **SOL Reserve**: Always keep 0.1 SOL unspent
- **Slot Limits**: Respects scout slot capacity
- **Dry Run Mode**: Logs without executing trades

### Configuration
- `autonomousScoutsEnabled` (false) - Master toggle
- `autonomousDryRun` (true) - Test mode
- `scoutAutoQueueScore` (10) - Min score for auto-queuing
- `scoutBuySol` (0.02) - SOL per scout buy
- `minSolReserve` (0.1) - Minimum SOL reserve
- `scoutTokenCooldownHours` (24) - Per-token cooldown
- `scoutDailyLimit` (5) - Max entries per day
- `scoutQueuePollSeconds` (60) - Queue processing interval

## Whale Flow Confirmation

Optional overlay that gates trading decisions with whale flow signals from Helius enhanced transactions API.

### Gating Points
1. **Scout-to-Core Promotion**: Require positive whale netflow before promoting
2. **Scout Entry**: Require whale confirmation before buying new scouts
3. **Exit Signal** (additive): Log whale exit pressure to reinforce rotation decisions

### Configuration
- `whaleConfirmEnabled` (false) - Master toggle for whale confirmation
- `whaleConfirmDryRun` (true) - Log signals without blocking trades
- `whaleConfirmPollSeconds` (30) - Polling interval for whale data
- `whaleWindowMinutes` (10) - Time window for analyzing whale activity
- `whaleMinUsd` (5000) - Minimum USD value to count as whale transaction
- `whaleNetflowTriggerUsd` (8000) - Positive netflow needed for confirmation
- `marketConfirmPct` (1.5) - Min price change % for market confirmation
- `maxPriceImpactBps` (150) - Maximum acceptable price impact in bps
- `exitNetflowUsd` (-7000) - Negative netflow threshold for exit signal
- `exitTrailDrawdownPct` (8) - Trailing stop drawdown percentage
- `scoutUnderperformMinutes` (180) - Minutes before marking scout as underperforming
- `whaleCooldownMinutes` (60) - Cooldown between whale-gated actions

### Requirements
Uses existing Helius integration via SOLANA_RPC_URL (already configured).

## Matrix Dashboard

### Features
- **Matrix Theme**: Black background with digital rain animation, glowing green terminal aesthetics
- **Overview Tab**: Real-time portfolio value, P&L, equity chart, active positions
- **Signals Tab**: Live signal matrix showing scores/regime per token
- **Positions Tab**: Portfolio breakdown with allocation percentages
- **Trades Tab**: Full execution history with Solscan links
- **Market Scanner Tab**: Token discovery and opportunity scoring
- **Settings Tab**: Full runtime configuration editing
- **Circuit Gauges**: Visual drawdown and turnover indicators
- **WebSocket Updates**: Real-time streaming telemetry

### Flash Close
One-click button to market sell entire positions:
- Regular tokens → Sell for SOL
- SOL → Sell for USDC
- USDC → Sell for SOL
- Confirmation dialog, pause check, rate limited

### Security
- Password-protected with rate-limited login
- HttpOnly cookies, strict SameSite
- Session regeneration on login
- Input validation on all endpoints
- Helmet security headers

## Market Scanner

### Data Sources
- **Jupiter**: Trending tokens and price data
- **DexScreener**: New listings, trending, market data
- **Solscan**: Token metadata, holders, transfers

### Opportunity Scoring
Ranks tokens by:
- Volume (24h trading volume)
- Holder count
- Price momentum
- Liquidity depth
- Verification status
- Trending status

## Structured Event Logging (LLM Pattern Analysis)

Captures the full journey of tokens from discovery to exit with correlated event IDs for downstream LLM analysis.

### Event Types
- **SCAN_OPPORTUNITY**: Token discovered by scanner with score, reasons, price, volume, liquidity, holders
- **QUEUE_DECISION**: Token queued or skipped with reason, signal readiness (bar count), config snapshot
- **TRADE_ENTRY**: Entry trade with decision price, execution price, slippage, signal snapshot
- **TRADE_EXIT**: Exit trade with trigger reason, decision/execution price, realized PnL, holding time
- **PROMOTION**: Scout promoted to core with PnL, signal score, held minutes
- **SIGNAL_SNAPSHOT**: Periodic signal state with score, regime, bar count, features

### Event Structure
Each event includes:
- `event_id`: Unique identifier
- `journey_id`: Correlated ID linking scan→queue→entry→exit for same token
- `timestamp`, `mint`, `symbol`
- Event-specific data (prices, signals, config snapshots)

### Log Files
- Location: `logs/events_YYYY-MM-DD.jsonl`
- Format: JSONL (one JSON object per line)
- Use for: LLM pattern discovery, entry quality analysis, parameter optimization

### Example Analysis Questions
- "Did tokens entered with bar_count < 60 have worse PnL than those with full signal data?"
- "Are we consistently entering higher than optimal due to slippage?"
- "Which trigger_reason (take_profit, rotation, regime_rebalance) has best outcomes?"

## Position Decisions Ledger

Complete trade decision lifecycle tracking table that captures every trade decision with full context.

### Schema
```
position_decisions:
  decision_id uuid      - Unique identifier, FK to trade_lots
  mint, symbol          - Token identifiers
  action_type           - enter | add | trim | exit | rebalance
  reason_code           - take_profit | trailing_stop_exit | rotation_exit | concentration_rebalance | regime_mean_revert | scout_stop_loss_exit | core_loss_exit
  reason_detail         - Human-readable context
  triggered_by          - Subsystem: strategy_engine | protective_exit | rotation
  tx_sig                - Transaction signature for on-chain correlation
  qty_before/after/delta - Position quantity changes
  usd_value_before/after - USD value changes
  target_pct_before/after - Target allocation changes
  confidence_score      - Signal confidence at decision time
  ticks_observed        - Data history available
  signal_snapshot       - JSON with score, regime, features
  journey_id            - Correlation ID linking token lifecycle
```

### Instrumented Paths
All 5 sell execution paths log decisions:
1. **TAKE_PROFIT**: Profit targets met → exit
2. **CONCENTRATION_REBALANCE**: Portfolio over-concentrated → trim
3. **ROTATION**: Better opportunity found → exit current
4. **PROTECTIVE_EXIT**: Stop loss or trailing stop triggered → exit
5. **REGIME_SELL**: Mean reversion regime adjustment → exit/trim

All 6 buy execution paths log decisions:
1. **ROTATION_BUY**: New position from rotation → enter/add
2. **REENTRY_BUY**: Re-entering after take-profit → enter
3. **REGIME_BUY**: Trend regime allocation → enter/add
4. **SCOUT_AUTO_BUY** (live): Autonomous scout entry → enter
5. **SCOUT_AUTO_BUY** (paper): Paper mode scout entry → enter
6. **SCOUT_AUTO_BUY** (paper corrected): Paper with price correction → enter

### Sanity Checks
Built-in queries detect logging gaps:
- `getSellsWithoutDecisions(hours)` - Sells missing decision records
- `getPromotionsWithoutExits(hours)` - Promotions with no subsequent exit
- `getTradesWithNullSource(hours)` - trade_lots with null source field

### Data Export (Dashboard Export Tab)
The dashboard Export tab provides bulk data extraction for analysis:
- **Trades**: Full trade history with timestamps, amounts, prices (CSV/JSON)
- **Telemetry**: Tick-by-tick signal and position data (CSV/JSON)
- **Prices**: Historical price snapshots (CSV/JSON)
- **Equity Snapshots**: Portfolio value over time (CSV/JSON)
- **Config History**: Configuration change log (CSV/JSON)
- **Event Logs (Journey-Linked)**: Structured events with journey_id correlation (CSV/JSON)
- **Journeys Summary**: Grouped events by journey_id for complete token lifecycle analysis (JSON)
- **All Data Bundle**: Complete export of all data types (JSON)

Export API endpoints:
- `/api/export/events?start=YYYY-MM-DD&end=YYYY-MM-DD` - Raw events with journey_id
- `/api/export/events/stats` - Event log statistics
- `/api/export/events/journeys?start=YYYY-MM-DD&end=YYYY-MM-DD` - Events grouped by journey

## Project Structure
```
src/
  bot/
    index.ts          # Main loop + tick scheduler
    config.ts         # Environment config + Zod validation
    runtime_config.ts # Dynamic config with DB persistence
    solana.ts         # Connection + transaction handling
    jupiter.ts        # Quote + swap + price fetching
    dexscreener.ts    # DexScreener API for prices and trending
    helius.ts         # Helius RPC for enhanced token data
    strategy.ts       # Signal computation + regime detection
    decisions.ts      # Target weight calculation
    execution.ts      # Swap execution with priority fees
    risk.ts           # Circuit breakers (drawdown, turnover)
    risk_profiles.ts  # Risk profile definitions
    portfolio.ts      # Portfolio snapshot builder
    portfolio_risk.ts # Concentration and risk tracking
    wallet.ts         # Wallet balance fetching
    state.ts          # Bot state management
    persist.ts        # Database persistence layer
    universe.ts       # Trading universe builder
    ranking.ts        # Unified ranking engine for positions/candidates
    rotation.ts       # Portfolio rotation logic and slot management
    reconcile.ts      # Wallet-to-database position reconciliation + lot processing
    pnl_engine.ts     # FIFO lot-based PnL calculation engine
    scout_auto.ts     # Autonomous scout queuing and buying
    reports.ts        # Weekly report generation
    scanner.ts        # Market scanner for token discovery
    solscan.ts        # Solscan API client with caching
    telemetry.ts      # Signal/position/price recording for dashboard
    event_logger.ts   # Structured event logging for LLM analysis
    db.ts             # PostgreSQL connection pool
    init_db.ts        # Database table initialization
    math.ts           # Mathematical utilities
  dashboard/
    server.ts         # Express + WebSocket dashboard server
  utils/
    logger.ts         # Pino console streaming (real-time debugging)
docs/
  FUTURE_UPDATES.md         # Planned features and enhancements
```

## Database Schema

### Core Tables
- **trading_universe**: Tokens being actively traded with slot_type (core/scout)
- **position_tracking**: Real-time positions with entry prices, peak prices, slot types
- **bot_trades**: All executed trades with metadata, reason codes, PnL
- **rotation_log**: History of rotation decisions with reason codes
- **scout_queue**: Autonomous scout queue (QUEUED/BUYING/BOUGHT/SKIPPED/FAILED)

### Telemetry Tables
- **prices**: Historical price data for signal computation
- **features**: Signal features per timestamp
- **equity_snapshots**: Portfolio value over time
- **bot_tick_telemetry**: Per-tick decision data (regime, weights, signals)
- **bot_runtime_status**: Current bot status with heartbeat

### Configuration Tables
- **bot_settings**: Runtime configuration (persisted across restarts)
- **risk_profiles**: Risk profile definitions
- **wallet_transfers**: Deposit/withdrawal tracking for accurate P&L

### Reporting Tables
- **weekly_reports**: Performance attribution and trade breakdown
- **scanner_opportunities**: Discovered opportunities from market scans
- **trending_tokens**: Cached trending token data
- **token_metrics**: Token quality metrics

### PnL Tracking Tables (Lot-Based System)
- **reconciled_trades**: Blockchain-sourced trade records with USD values at execution time
- **trade_lots**: Immutable record of each buy/sell with USD value captured at execution
- **position_lots**: Aggregated cost basis per mint with FIFO lot tracking
- **pnl_events**: Realized PnL events from lot matching (buy/sell pair completions)
- **daily_position_snapshots**: End-of-day snapshots for unrealized PnL tracking

## PnL Tracking System

### Design Principles
1. **USD Values Captured at Execution**: Token and SOL prices are recorded at trade time, not calculated retroactively
2. **FIFO Cost-Basis Matching**: Sells are matched against oldest buys first for accurate realized PnL
3. **Blockchain as Source of Truth**: Helius reconciliation provides authoritative trade data
4. **Lot-Based Tracking**: Each buy creates a lot; sells consume lots chronologically

### How It Works
1. **Trade Execution**: When a swap executes, lot is created with USD values at that moment
2. **Helius Reconciliation**: processTradesIntoLots() backfills historical trades into lot system
3. **FIFO Matching**: processSellWithFIFO() matches sells against oldest open lots
4. **PnL Events**: Each lot closure generates a pnl_event with realized gain/loss
5. **Unrealized PnL**: calculateUnrealizedPnL() computes mark-to-market on open lots

### API Endpoints
- `GET /api/pnl` - Returns realized/unrealized PnL summary with position breakdown
- `POST /api/pnl/sync` - Triggers full backfill of trades into lot system

### Dust Handling
- Positions below $1 unrealized value can be written off via writeOffDustPosition()
- Dust write-offs create pnl_events with event_type 'dust_writeoff'

## Environment Variables

### Required Secrets
```bash
SOLANA_RPC_URL         # Solana RPC endpoint
BOT_WALLET_PRIVATE_KEY # Base58 encoded keypair
DATABASE_URL           # PostgreSQL connection (dev)
PROD_DATABASE_URL      # PostgreSQL connection (production)
DASHBOARD_PASSWORD     # Dashboard login password
SESSION_SECRET         # Session encryption key
```

### Optional
```bash
SOLSCAN_API_KEY        # Solscan Pro API key (enhanced data)
IS_PRODUCTION          # Set to "true" for production mode
```

## Configuration Parameters

All parameters are configurable via dashboard Settings tab:

### Core Parameters
- `riskProfile` - low/medium/high/degen
- `executionMode` - paper/live
- `loopSeconds` - Main loop interval (default: 60)

### Risk Limits
- `maxDailyDrawdownPct` - Daily drawdown limit (default: 0.05 = 5%)
- `maxPositionPctPerAsset` - Max position size (default: 0.25 = 25%)
- `maxTurnoverPctPerDay` - Daily turnover cap (default: 1.0 = 100%)
- `maxSlippageBps` - Max slippage in bps (default: 80)
- `maxSingleSwapSol` - Max SOL per trade (default: 1.5)
- `minTradeUsd` - Min trade size in USD (default: 25)
- `maxPositions` - Max simultaneous positions (default: 10)
- `maxTop3ConcentrationPct` - Max top-3 concentration (default: 0.70)
- `maxPortfolioVolatility` - Max portfolio volatility (default: 0.50)
- `takeProfitPct` - Take profit threshold (default: 0.05 = 5%)

Note: These are code defaults. Running values are persisted in the database and can be modified via the dashboard Settings tab.

### Slot Configuration
- `coreSlots` - Number of core slots (default: 5)
- `scoutSlots` - Number of scout slots (default: 10)
- `corePositionPctTarget` - Target per core slot (default: 0.12)
- `scoutPositionPct` - Allocation per scout (default: 0.03)

### Rotation & Exit
- `rotationThreshold` - Rank delta for rotation (default: 1.5)
- `stalePositionHours` - Hours before stale penalty (default: 48)
- `staleExitHours` - Hours before forced exit (default: 72)
- `trailingStopBasePct` - Base trailing stop (default: 0.30)
- `trailingStopTightPct` - Tightened trailing stop (default: 0.12)
- `trailingStopProfitThreshold` - Profit to tighten (default: 0.50)

### Ranking Weights
- `rankingSignalWeight` (3.0)
- `rankingMomentumWeight` (2.0)
- `rankingTimeDecayWeight` (1.0)
- `rankingTrailingWeight` (2.5)
- `rankingFreshnessWeight` (1.5)
- `rankingQualityWeight` (1.0)
- `rankingStalePenalty` (-2.0)
- `rankingTrailingStopPenalty` (-10.0)

### Scout Promotion
- `promotionMinPnlPct` (0.20)
- `promotionMinSignalScore` (1.0)
- `promotionMinHoursHeld` (2)

### Re-entry
- `reentryEnabled` (true)
- `reentryCooldownMinutes` (3)
- `reentryWindowMinutes` (30)
- `reentryMinMomentumScore` (1.0)
- `reentrySizeMultiplier` (3.0)
- `reentryMaxSolPct` (0.5)

**FIFO Lot Clearing on Re-entry**: When re-entering a position after full exit (valueUsd < $1), all existing position lots are closed (is_closed=true) and in-memory entry prices are cleared. This prevents FIFO quarantine from triggering due to stale lot data from the previous position.

### Strategy
- `strategyTrendThreshold` (0.75)
- `strategyMomentumFactor` (0.25)
- `strategyBand` (0.05)
- `minTicksForSignals` (60) - Minimum price ticks before signal computation

### Allocation Ramp
The allocation ramp system prevents over-allocation to tokens with limited price history. It decouples "signal exists" from "how big the allocation can be".

- `allocationRampEnabled` (true) - Master toggle for the ramp system
- `minTicksForFullAlloc` (30) - Number of ticks required before full allocation allowed
- `preFullAllocMaxPct` (0.08 = 8%) - Hard cap on allocation before tick threshold reached
- `smoothRamp` (true) - Use sqrt scaling for gradual ramp (vs linear)
- `hardCapBeforeFull` (true) - Strictly enforce preFullAllocMaxPct before threshold

**How it works**: Tokens with fewer than `minTicksForFullAlloc` ticks get scaled allocations:
- confidence = sqrt(ticks / minTicksForFullAlloc) when smoothRamp=true
- effective_allocation = min(raw_target * confidence, preFullAllocMaxPct)
- Once ticks >= minTicksForFullAlloc, full target allocation is allowed

This prevents scenarios where a new token with only 5 ticks of history gets a 35% allocation just because signals are strong.

### Scanner Filters
- `scannerMinLiquidity` (10000)
- `scannerMinVolume24h` (5000)
- `scannerMinHolders` (0) - Set to 0 because DexScreener trending doesn't provide holder counts
- `scannerMaxPriceChange24h` (500)
- `scannerMinPriceChange24h` (-50)

## API Endpoints

### Portfolio & Trading
- `GET /api/positions` - Current wallet positions
- `GET /api/trades` - Trade history
- `GET /api/portfolio-risk` - Portfolio risk metrics
- `GET /api/slot-status` - Current slot allocation
- `POST /api/flash-close` - Immediate position liquidation

### Configuration
- `GET /api/config` - Current runtime config
- `POST /api/settings` - Update configuration
- `GET /api/runtime-status` - Bot status with heartbeat

### Market Data
- `GET /api/scan` - Run market scan
- `GET /api/scanner-data` - Recent scanner opportunities
- `GET /api/trending` - Trending tokens
- `GET /api/universe` - Trading universe

### Administration
- `POST /api/add-to-universe` - Add token to universe
- `POST /api/remove-from-universe` - Remove token
- `GET /api/admin/scout-queue` - Scout queue status
- `GET /api/admin/autonomous-status` - Autonomous system status

### Export
- `GET /api/export/trades` - Export trades CSV/JSON
- `GET /api/export/telemetry` - Export tick data
- `GET /api/export/equity` - Export equity snapshots
- `GET /api/export/logs/:filename` - Download log files

## NPM Scripts
- `npm run bot` - Start the trading bot
- `npm run init-db` - Initialize database tables (auto-runs on bot start)

## How It Works

### Every Tick (default 60s)
1. Refresh runtime config from database
2. Fetch SOL and token prices (Jupiter/DexScreener)
3. Compute wallet balances and portfolio snapshot
4. Check circuit breakers (drawdown, turnover, pause)
5. Sync position tracking with wallet state
6. Generate signals for universe tokens
7. Rank all positions and candidates
8. Check take profit opportunities
9. Check trailing stop exits
10. Check stale position exits
11. Evaluate rotation opportunities
12. Execute trades via Jupiter
13. Update telemetry and broadcast to dashboard
14. Run periodic market scan
15. Process autonomous scout queue

### Trade Execution
- All trades routed through Jupiter aggregator
- Priority fees based on risk profile
- Slippage protection on all swaps
- Transactions confirmed before recording

## Safety Features
- **Paper mode by default** - No real trades until explicitly enabled
- **Circuit breakers** - Auto-pause on drawdown or turnover limits
- **Trailing stops** - Dynamic exit on price drops
- **Slippage protection** - Max slippage enforced on all swaps
- **SOL reserve** - Always keeps minimum SOL for gas
- **Dust filtering** - Hides positions under $0.50 from display

## Recent Updates (Dec 2025)

### Reset Portfolio Feature (Dec 27, Updated Dec 31)
- Added "Danger Zone" section in dashboard Settings tab
- **Reset Portfolio** button: flash sells ALL non-SOL/non-USDC tokens and clears all state
  - Preview button shows list of tokens to be sold with USD values
  - Double confirmation required (type "RESET" to confirm)
  - Fetches actual token decimals from blockchain for accurate amounts
- **Clean Data Only** button: Clears database without selling tokens (type "CLEANUP" to confirm)
- **Preserved** (Core Configuration):
  - `bot_settings` - Runtime configuration parameters
  - `risk_profiles` - Risk management configurations
  - `bot_runtime_status` - Manual pause state, execution mode
  - `trading_universe` - SOL/USDC defaults only
- **Cleared** (All Historical Data):
  - Scout & Queue: scout_queue
  - PnL & Positions: pnl_events, position_tracking, position_lots, trade_lots, daily_position_snapshots
  - Trades: trades, bot_trades, reconciled_trades
  - Snapshots: equity_snapshots
  - Price Data: prices, features, token_metrics, trending_tokens, scanner_opportunities
  - Telemetry & Logs: bot_tick_telemetry, rotation_log, weekly_reports, wallet_transfers, bot_config_history
- P&L tracking starts fresh to avoid calculation issues on re-buys

### Advanced Flow Controls & Manual Scout Buy (Dec 27)
- Exposed 11 hardcoded trading parameters to dashboard settings for faster SOL deployment:
  - `stalePnlBandPct` (0.05): Exit if PnL stuck in this band too long
  - `stalePositionHours` (48): Hours before position is flagged stale
  - `staleExitHours` (72): Hours before stale position is force-exited
  - `dustThresholdUsd` (0.50): Skip positions below this value
  - `minPositionUsd` (1.0): Minimum position value
  - `txFeeBufferSol` (0.01): Reserved for transaction fees
  - `scoutStopLossPct` (0.18): Max loss before exiting scout
  - `lossExitPct` (0.15): Max loss before forced exit on core
  - `promotionDelayMinutes` (15): Min time before scout can promote
  - `scoutGraceMinutes` (10): Grace period before dropping underperformer
  - `manualScoutBuyEnabled` (true): Auto-buy when manually adding tokens
- Manual token adds now trigger immediate scout purchase (same as autonomous path)
- Added "Advanced Flow Controls" section to dashboard settings UI
- All parameters wired through runtime_config.ts with database persistence
- Added descriptive tooltips to ALL 71 settings (hover over any setting for detailed explanation)

### PnL Dashboard Integration (Dec 27)
- Updated dashboard endpoints to use lot-based PnL data from pnl_engine.ts
- Added getBatchPositionCostBasis() for efficient O(1) bulk queries (addresses performance issue)
- /api/wallet-positions now includes unrealizedPnl and unrealizedPnlUsd from cost basis
- /api/slot-status (Position Health) now shows pnlUsd column alongside percentage
- getPerformanceMetrics() uses pnl_events table for accurate realized PnL instead of equity-based calculation
- All PnL calculations rely on lot-based FIFO cost tracking with USD snapshots at execution time

### Authoritative Decimals & FIFO Quarantine (Dec 30)
- **Critical Fix**: Added `getAuthoritativeDecimals()` function to fetch token decimals directly from Solana chain
  - Uses `getMint` from @solana/spl-token to bypass unreliable DexScreener metadata
  - Defaults to 6 decimals (pump.fun standard) instead of 9 if chain lookup fails
  - Applied to ALL buy paths: regime_trend_mr, opportunity_cost_rotation, reentry_momentum, autonomous_scout
- **FIFO Quantity Validation**: Validates FIFO coverage ratio (50%-150%) before using avg cost
  - Uses `pos.amount` (authoritative wallet balance) for validation
  - Coverage <50%: UNDER_COVERAGE - missing lots
  - Coverage >150%: OVER_COVERAGE - inflated lots from previous decimal bugs
  - Quarantined positions fall back to tracking entry price (set at buy time with correct decimals)
  - `hasFifoDiscrepancy` flag blocks promotions for quarantined positions
  - Logs `FIFO_QUARANTINE` with quarantine status for operator visibility
- **Dashboard P&L Alignment**: Fixed discrepancy between Portfolio Breakdown and Position Health views
  - `/api/wallet-positions` now validates FIFO coverage ratio before using cost basis
  - Falls back to `walletQty × tracking.entry_price` when coverage is unreliable
  - Both views now use consistent P&L calculation logic
- **Root Cause**: Pump.fun tokens use 6 decimals but code defaulted to 9, causing 1000x quantity undercount
- Files modified: `execution.ts` (getAuthoritativeDecimals), `rotation.ts` (quarantine), `index.ts` & `scout_auto.ts` (buy paths), `server.ts` (wallet-positions endpoint)

### Single-Source Configuration Architecture (Dec 31)
- **CRITICAL FIX**: Eliminated dual-source configuration pattern
- Circuit breaker and all runtime logic now read exclusively from `getConfig()`/bot_settings instead of hardcoded risk profile values
- Risk profiles now serve ONLY as preset loaders - selecting a profile should copy values INTO bot_settings
- Dashboard settings are the single source of truth for ALL runtime behavior
- Changes:
  - `checkCircuit()` uses `config.maxDailyDrawdownPct` and `config.maxTurnoverPctPerDay` from getConfig()
  - `executeSwap()` reads priority fee from internal getConfig() - no longer requires RiskProfile parameter
  - Removed unused `getCurrentRiskProfile()` function and `RISK` imports from index.ts
  - Replaced all `rp.*` references with `config.*` equivalents in scout_auto.ts
- Impact: User's maxDailyDrawdownPct setting of 50% will now be respected instead of hitting at 7% (old hardcoded risk profile value)

### Boolean Settings Persistence Fix (Dec 27)
- Fixed bug where boolean checkbox settings (autonomousScoutsEnabled, autonomousDryRun, reentryEnabled) weren't persisting correctly
- Root cause: String "false" from DB was coerced to truthy in JS (`!!"false"` = `true`)
- Fix: Uses strict equality checks throughout the save/load pipeline
- loadConfig() now uses fallback+coercion pattern to preserve defaults while handling strings
- populateUI() uses strict equality for checkbox state
- Added comprehensive trace logging with request correlation IDs

### Settings Architecture Refactor (Dec 26)
- Unified flat GET/PATCH /api/settings endpoints
- Proper percentage conversions (UI: whole numbers, API: decimals)
- Zod schema validation throughout
- Type-safe settings with proper defaults

### Flash Close Enhancement
- Event delegation pattern for reliable button clicks
- Works on dynamically rendered position lists

### Dust Filtering & Auto-Cleanup
- Positions under $0.50 filtered from active positions display
- Prevents clutter from leftover dust amounts
- **Automatic universe cleanup**: Tokens with < $1 value for 24+ hours are automatically removed from the trading universe (except SOL/USDC)

### Development Mode
- Live trading available in both dev and production
- Configure via dashboard Settings > Execution Mode

## Disclaimer
This bot trades real cryptocurrency on mainnet Solana. Start with paper mode and small amounts. Past performance is not indicative of future results. Trade at your own risk.
