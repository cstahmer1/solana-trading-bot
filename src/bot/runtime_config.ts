import { q } from "./db.js";
import { env, type RiskProfileName, type ExecutionMode } from "./config.js";
import { logger } from "../utils/logger.js";
import { insertConfigHistory, setPauseState } from "./persist.js";
import { computeConfigHash, setEffectiveConfigInfo, getEnvContext, type EffectiveConfigInfo } from "./env_context.js";
import { parseBool } from "./parse_bool.js";

// Comprehensive descriptions for all bot settings - auto-populated on startup if missing
const settingDescriptions: Record<string, string> = {
  risk_profile: "Sets overall trading aggressiveness. Conservative = smaller positions, tighter stops; Aggressive = larger positions, wider stops.",
  execution_mode: "Paper mode simulates trades without real execution. Live mode executes real trades on Solana.",
  loop_seconds: "How often the bot evaluates positions and executes trades. Lower = more responsive but higher API usage.",
  max_daily_drawdown_pct: "Circuit breaker that pauses all trading if daily losses exceed this threshold.",
  max_position_pct_per_asset: "Maximum percentage of portfolio that can be allocated to any single token.",
  max_turnover_pct_per_day: "Limits daily trading volume as a percentage of portfolio to prevent overtrading.",
  max_slippage_bps: "Maximum acceptable slippage in basis points for trade execution.",
  max_single_swap_sol: "Maximum SOL that can be used in a single swap transaction.",
  min_trade_usd: "Minimum trade size in USD. Trades below this are skipped to avoid dust.",
  max_positions: "Maximum number of positions the portfolio can hold simultaneously.",
  max_top3_concentration_pct: "Maximum combined weight of the top 3 positions in the portfolio.",
  max_portfolio_volatility: "Maximum acceptable portfolio volatility before reducing exposure.",
  take_profit_pct: "Profit target percentage at which to take profits on positions.",
  scanner_min_liquidity: "Minimum liquidity in USD for tokens to be considered by the scanner.",
  scanner_min_volume_24h: "Minimum 24-hour volume in USD for tokens to be considered.",
  scanner_min_holders: "Minimum number of token holders required for consideration.",
  scanner_max_price_change_24h: "Maximum 24-hour price change percentage filter.",
  scanner_min_price_change_24h: "Minimum 24-hour price change percentage filter.",
  manual_pause: "When enabled, all trading activity is paused.",
  core_slots: "Number of core position slots available for high-conviction holdings.",
  scout_slots: "Number of scout position slots for testing new tokens.",
  core_position_pct_target: "Target allocation percentage for each core position.",
  scout_position_pct: "Maximum allocation percentage for scout positions.",
  rotation_threshold: "Minimum rank difference required before rotating positions.",
  stale_position_hours: "Hours before a flat position starts receiving ranking penalties.",
  stale_exit_hours: "Hours after which flat positions are force-exited.",
  trailing_stop_base_pct: "Base trailing stop percentage for protecting profits.",
  trailing_stop_tight_pct: "Tighter trailing stop applied after profit threshold is reached.",
  trailing_stop_profit_threshold: "Profit level at which trailing stop tightens.",
  ranking_signal_weight: "Weight given to signal score in position ranking.",
  ranking_momentum_weight: "Weight given to momentum in position ranking.",
  ranking_time_decay_weight: "Weight for time-based decay in position ranking.",
  ranking_trailing_weight: "Weight for trailing stop proximity in ranking.",
  ranking_freshness_weight: "Weight for position freshness in ranking.",
  ranking_quality_weight: "Weight for position quality metrics in ranking.",
  ranking_stale_penalty: "Penalty applied to stale positions in ranking.",
  ranking_trailing_stop_penalty: "Penalty for positions near trailing stop in ranking.",
  reentry_enabled: "When enabled, bot can re-buy tokens it recently sold if they show renewed strength.",
  reentry_cooldown_minutes: "Minutes to wait after exit before considering re-entry.",
  reentry_window_minutes: "Time window after exit during which re-entry is allowed.",
  reentry_min_momentum_score: "Minimum momentum score required to trigger re-entry.",
  reentry_size_multiplier: "Multiplier for position size on re-entry.",
  reentry_max_sol_pct: "Maximum percentage of SOL limit for re-entry positions.",
  promotion_min_pnl_pct: "Minimum profit percentage required to promote scout to core.",
  promotion_min_signal_score: "Minimum signal score required for promotion (bypassed when scoutPromotionBypass is enabled).",
  strategy_trend_threshold: "Threshold for trend detection in strategy engine.",
  strategy_momentum_factor: "Momentum factor used in strategy calculations.",
  strategy_band: "Band size for strategy-based trading decisions.",
  concentration_rebalance_max_pct: "Maximum percentage adjustment per rebalance cycle.",
  transfer_threshold_usd: "Minimum USD value for transfer operations.",
  autonomous_scouts_enabled: "When enabled, bot automatically discovers and buys promising new tokens.",
  autonomous_dry_run: "When enabled, autonomous scouts simulate trades without executing.",
  scout_auto_queue_score: "Minimum scanner score to auto-queue a token for scout entry.",
  scout_buy_sol: "SOL amount to spend on each autonomous scout buy.",
  min_sol_reserve: "Minimum SOL to keep in reserve for transaction fees.",
  scout_token_cooldown_hours: "Hours to wait before re-entering a token after exit.",
  scout_daily_limit: "Maximum number of new scout entries per day.",
  scout_queue_poll_seconds: "Interval between scout queue processing cycles.",
  scout_queue_stale_minutes: "Minutes before scout queue item considered stale.",
  scout_queue_max_buy_attempts: "Max buy attempts before marking scout queue item as skipped.",
  scan_interval_minutes: "Minutes between market scanning cycles.",
  whale_confirm_enabled: "When enabled, gates trading decisions with whale flow signals.",
  whale_confirm_dry_run: "When enabled, whale signals are logged without blocking trades.",
  whale_confirm_poll_seconds: "Interval for polling whale flow data.",
  whale_window_minutes: "Time window for analyzing whale activity.",
  whale_min_usd: "Minimum USD value to consider a transaction as whale activity.",
  whale_netflow_trigger_usd: "Netflow threshold to trigger whale confirmation.",
  market_confirm_pct: "Market confirmation percentage threshold.",
  max_price_impact_bps: "Maximum acceptable price impact in basis points.",
  exit_netflow_usd: "Negative netflow threshold that triggers exit consideration.",
  exit_trail_drawdown_pct: "Drawdown percentage that triggers exit on whale signal.",
  scout_underperform_minutes: "Minutes of underperformance before scout is flagged.",
  whale_cooldown_minutes: "Cooldown between whale-triggered actions.",
  stale_pnl_band_pct: "PnL band for considering a position as flat/stale.",
  dust_threshold_usd: "USD value below which positions are considered dust.",
  min_position_usd: "Minimum USD value for a valid position.",
  tx_fee_buffer_sol: "SOL buffer reserved for transaction fees.",
  scout_stop_loss_pct: "Stop loss percentage for scout positions.",
  scout_take_profit_pct: "Take profit threshold for scouts (0.10 = 10%).",
  scout_tp_min_hold_minutes: "Minimum hold time (minutes) before scout take-profit eligible.",
  loss_exit_pct: "Loss percentage that triggers forced exit for core positions.",
  promotion_delay_minutes: "Minutes a scout must be held before promotion is eligible.",
  scout_grace_minutes: "Grace period minutes for underperforming scouts.",
  manual_scout_buy_enabled: "When enabled, manually adding a token triggers immediate scout purchase.",
  min_ticks_for_signals: "Minimum price ticks required before computing trading signals.",
  allocation_ramp_enabled: "Enable gradual allocation ramp-up based on tick history confidence.",
  min_ticks_for_full_alloc: "Minimum price ticks required before allowing full allocation sizing.",
  pre_full_alloc_max_pct: "Maximum allocation % allowed before reaching min tick threshold.",
  smooth_ramp: "Use sqrt-based confidence ramp instead of binary threshold.",
  hard_cap_before_full: "Strictly enforce allocation cap until tick threshold reached.",
  sniper_enabled: "Enable autonomous token sniper for new token launches.",
  telemetry_retention_hours: "Hours to retain universe telemetry data.",
  telemetry_cache_poll_seconds: "Interval (seconds) for telemetry cache polling.",
  exit_invariant_enabled: "Enable post-exit cleanup to ensure positions fully close.",
  exit_invariant_max_retries: "Maximum retry attempts for exit invariant cleanup.",
  exit_invariant_retry_delay_ms: "Delay (ms) between exit invariant retry attempts.",
  exit_invariant_min_remaining_qty: "Quantity threshold below which position considered closed.",
  exit_invariant_min_remaining_usd: "USD threshold below which position considered closed.",
  exit_invariant_slippage_bps: "Slippage tolerance (bps) for exit invariant cleanup swaps.",
  exit_invariant_force_exact_close: "Force exact close even if below dust threshold.",
  scout_chase_ret15_max: "Max 15-min return to avoid chasing pumps (0.25 = 25%).",
  scout_impulse_ret15_min: "Min 15-min return impulse required before pullback entry.",
  scout_pullback_from_high15_min: "Min pullback from 15-min high required for entry.",
  scout_entry_sma_minutes: "SMA lookback period (minutes) for scout entry filter.",
  scout_entry_require_above_sma: "Require price above SMA for scout entry.",
  scout_entry_trend_sma_minutes: "Minutes for trend SMA to confirm uptrend (hard fail if insufficient history).",
  promotion_min_hours_held: "Minimum hours held before promotion eligible.",
  promotion_require_ret60_min: "Min 60-min return required for promotion (continuation filter).",
  promotion_require_ret15_min: "Min 15-min return required for promotion.",
  promotion_avoid_top_drawdown30: "Skip promotion if recent 30-min drawdown exceeds threshold.",
  promotion_sma_minutes: "SMA lookback period (minutes) for promotion filter.",
  promotion_require_above_sma: "Require price above SMA for promotion.",
  min_position_usd_for_pricing: "Minimum USD position value to include in price fetching.",
  max_price_fetch_mints: "Maximum mints to fetch prices for per tick (performance limit).",
  equity_price_coverage_min: "Minimum price coverage ratio (0.75=75%) for risk/drawdown updates.",
  equity_price_coverage_min_usd: "USD threshold below which tokens excluded from coverage denominator.",
  execution_price_coverage_min: "Minimum price coverage ratio (0.60=60%) to allow trade execution.",
  orphan_exit_grace_ticks: "Ticks to wait before liquidating positions not in target universe.",
  prebuy_roundtrip_min_ratio: "Minimum buy/sell roundtrip ratio (0.92 = 8% max loss to honeypot).",
  prebuy_max_sell_impact_pct: "Max acceptable sell price impact (0.03 = 3%).",
  break_even_lock_profit_pct: "Profit threshold to lock in break-even stop (0.06 = 6%).",
  capital_mgmt_enabled: "Enable capacity-aware sizing that prevents scaling into negative EV.",
  cap_max_total_exposure_pct: "Maximum total portfolio exposure as % of equity.",
  cap_max_core_exposure_pct: "Maximum core positions exposure as % of equity.",
  cap_max_scout_exposure_pct: "Maximum scout positions exposure as % of equity.",
  cap_max_mint_exposure_pct: "Maximum single asset exposure as % of equity.",
  cap_risk_per_trade_scout_pct: "Maximum risk budget per scout trade as % of equity.",
  cap_risk_per_trade_core_pct: "Maximum risk budget per core trade as % of equity.",
  cap_entry_max_impact_pct_scout: "Maximum price impact allowed on scout entry trades.",
  cap_exit_max_impact_pct_scout: "Maximum price impact allowed on scout exit trades.",
  cap_entry_max_impact_pct_core: "Maximum price impact allowed on core entry trades.",
  cap_exit_max_impact_pct_core: "Maximum price impact allowed on core exit trades.",
  cap_roundtrip_min_ratio_scout: "Minimum roundtrip efficiency (1=no slippage) for scout trades.",
  cap_roundtrip_min_ratio_core: "Minimum roundtrip efficiency (1=no slippage) for core trades.",
  cap_liquidity_safety_haircut: "Safety multiplier applied to quoted liquidity (0.8 = 20% haircut).",
  cap_max_participation_5m_vol_pct: "Max % of 5-minute volume to participate in per trade.",
  cap_max_participation_1h_vol_pct: "Max % of 1-hour volume to participate in per trade.",
  cap_min_pool_tvl_usd_scout: "Minimum pool TVL (USD) required for scout entries.",
  cap_min_pool_tvl_usd_core: "Minimum pool TVL (USD) required for core entries.",
  cap_min_5m_vol_usd_scout: "Minimum 5-minute volume (USD) required for scout entries.",
  cap_min_5m_vol_usd_core: "Minimum 5-minute volume (USD) required for core entries.",
  cap_scout_size_min_usd: "Minimum scout position size in USD.",
  cap_scout_size_max_usd: "Maximum scout position size in USD.",
  cap_scout_size_base_usd: "Base scout size in USD for sublinear scaling calculation.",
  cap_scout_size_base_equity: "Equity level at which scout size equals base_usd (for sqrt scaling).",
  cap_edge_buffer_pct: "Buffer % subtracted from edge for fee/slippage uncertainty.",
  cap_size_sweep_multipliers: "JSON array of multipliers for size sweep quotes [0.5,1,2,4,8].",
  fee_governor_enabled: "Enable notional-aware priority fee computation for optimal tx inclusion.",
  fee_ratio_per_leg_scout: "Target fee as % of notional per leg for scout trades (e.g. 0.003 = 0.3%).",
  fee_ratio_per_leg_core: "Target fee as % of notional per leg for core trades (e.g. 0.002 = 0.2%).",
  min_priority_fee_lamports_entry: "Minimum priority fee (lamports) for entry trades.",
  min_priority_fee_lamports_exit: "Minimum priority fee (lamports) for exit trades (higher for urgency).",
  max_priority_fee_lamports_scout: "Maximum priority fee cap (lamports) for scout trades.",
  max_priority_fee_lamports_core: "Maximum priority fee cap (lamports) for core trades.",
  retry_ladder_multipliers: "JSON array of fee multipliers for retry attempts [1,2,4,8].",
  fee_safety_haircut: "Safety multiplier applied to computed fees (0.85 = 15% headroom).",
  max_fee_ratio_hard_per_leg: "Hard cap on fee as % of notional per leg (1% default).",
  fee_ratio_guard_enabled: "Skip trades where effective fee ratio exceeds hard cap.",
  deploy_target_pct: "Target % of equity to deploy in positions (scales all non-zero targets).",
  allocation_stuck_watchdog_enabled: "Enable watchdog to detect and skip repeatedly-failing allocations.",
  allocation_stuck_min_gap_pct: "Minimum allocation gap % to count as a failed attempt.",
  allocation_stuck_max_attempts: "Max consecutive failures before marking target as stuck.",
  allocation_stuck_backoff_minutes_base: "Base minutes for exponential backoff on stuck targets.",
  rebalance_sell_min_hold_minutes: "Minimum minutes a position must be held before rebalance sells are allowed. Prevents instant churn.",
  rebalance_sell_target_drop_confirm_ticks: "Number of consecutive ticks target must be below current before rebalance sell allowed.",
  rebalance_sell_min_trim_usd: "Minimum USD value for rebalance trim sells. Smaller trims are skipped to avoid fee bleed.",
  exit_liquidity_check_enabled: "Enable exit liquidity checks before scout/core entries and promotions.",
  exit_liq_max_impact_pct_scout: "Max acceptable exit price impact for scout entries (0.08 = 8%).",
  exit_liq_max_impact_pct_core: "Max acceptable exit price impact for core entries (0.05 = 5%).",
  exit_liq_min_round_trip_scout: "Min round-trip ratio for scouts (0.94 = max 6% loss on immediate exit).",
  exit_liq_min_round_trip_core: "Min round-trip ratio for cores (0.96 = max 4% loss on immediate exit).",
  exit_liq_max_hops_scout: "Max route hops for scout exit routes.",
  exit_liq_max_hops_core: "Max route hops for core exit routes.",
  exit_liq_safety_haircut: "Safety haircut for exit size simulation (0.90 = test 90% of position).",
  exit_liq_disallow_mints: "Comma-separated list of mints to disallow as intermediate route hops.",
};

// Populate missing descriptions in the database
async function populateMissingDescriptions(): Promise<number> {
  let updated = 0;
  for (const [key, description] of Object.entries(settingDescriptions)) {
    const result = await q<{ count: string }>(
      `UPDATE bot_settings SET description = $1 WHERE key = $2 AND (description IS NULL OR description = '') RETURNING key`,
      [description, key]
    );
    if (result.length > 0) {
      updated++;
    }
  }
  return updated;
}

let lastSettingsReloadAt: string = new Date().toISOString();
let configRefreshIntervalId: NodeJS.Timeout | null = null;
const CONFIG_REFRESH_INTERVAL_MS = 60_000;

export interface RuntimeConfig {
  riskProfile: RiskProfileName;
  executionMode: ExecutionMode;
  loopSeconds: number;
  maxDailyDrawdownPct: number;
  maxPositionPctPerAsset: number;
  maxTurnoverPctPerDay: number;
  maxSlippageBps: number;
  maxSingleSwapSol: number;
  minTradeUsd: number;
  maxPositions: number;
  maxTop3ConcentrationPct: number;
  maxPortfolioVolatility: number;
  takeProfitPct: number;
  scannerMinLiquidity: number;
  scannerMinVolume24h: number;
  scannerMinHolders: number;
  scannerMaxPriceChange24h: number;
  scannerMinPriceChange24h: number;
  manualPause: boolean;
  // Slot-based portfolio rotation
  coreSlots: number;
  scoutSlots: number;
  corePositionPctTarget: number;
  scoutPositionPct: number;
  rotationThreshold: number;
  stalePositionHours: number;
  staleExitHours: number;
  trailingStopBasePct: number;
  trailingStopTightPct: number;
  trailingStopProfitThreshold: number;
  // Ranking weights
  rankingSignalWeight: number;
  rankingMomentumWeight: number;
  rankingTimeDecayWeight: number;
  rankingTrailingWeight: number;
  rankingFreshnessWeight: number;
  rankingQualityWeight: number;
  rankingStalePenalty: number;
  rankingTrailingStopPenalty: number;
  // Re-entry controls
  reentryEnabled: boolean;
  reentryCooldownMinutes: number;
  reentryWindowMinutes: number;
  reentryMinMomentumScore: number;
  reentrySizeMultiplier: number;
  reentryMaxSolPct: number;
  // Promotion criteria (scout to core)
  promotionMinPnlPct: number;
  promotionMinSignalScore: number;
  // Strategy engine
  strategyTrendThreshold: number;
  strategyMomentumFactor: number;
  strategyBand: number;
  // Operational
  concentrationRebalanceMaxPct: number;
  transferThresholdUsd: number;
  // Autonomous scout system
  autonomousScoutsEnabled: boolean;
  autonomousDryRun: boolean;
  scoutAutoQueueScore: number;
  scoutBuySol: number;
  minSolReserve: number;
  scoutTokenCooldownHours: number;
  scoutDailyLimit: number;
  scoutQueuePollSeconds: number;
  scoutQueueStaleMinutes: number;
  scoutQueueMaxBuyAttempts: number;
  scanIntervalMinutes: number;
  // Whale confirmation feature flags
  whaleConfirmEnabled: boolean;
  whaleConfirmDryRun: boolean;
  whaleConfirmPollSeconds: number;
  whaleWindowMinutes: number;
  whaleMinUsd: number;
  whaleNetflowTriggerUsd: number;
  marketConfirmPct: number;
  maxPriceImpactBps: number;
  exitNetflowUsd: number;
  exitTrailDrawdownPct: number;
  scoutUnderperformMinutes: number;
  whaleCooldownMinutes: number;
  // Advanced Flow Controls
  stalePnlBandPct: number;
  dustThresholdUsd: number;
  minPositionUsd: number;
  txFeeBufferSol: number;
  scoutStopLossPct: number;
  scoutTakeProfitPct: number;
  scoutTpMinHoldMinutes: number;
  lossExitPct: number;
  promotionDelayMinutes: number;
  scoutGraceMinutes: number;
  manualScoutBuyEnabled: boolean;
  minTicksForSignals: number;
  // Allocation Ramp - prevents over-allocation on low tick count tokens
  allocationRampEnabled: boolean;
  minTicksForFullAlloc: number;
  preFullAllocMaxPct: number;
  smoothRamp: boolean;
  hardCapBeforeFull: boolean;
  // Sniper feature flag
  sniperEnabled: boolean;
  // Universe telemetry settings
  telemetryRetentionHours: number;
  telemetryCachePollSeconds: number;
  // Exit Invariant - ensures positions close completely
  exitInvariantEnabled: boolean;
  exitInvariantMaxRetries: number;
  exitInvariantRetryDelayMs: number;
  exitInvariantMinRemainingQty: number;
  exitInvariantMinRemainingUsd: number;
  exitInvariantSlippageBps: number;
  exitInvariantForceExactClose: boolean;
  // Scout Entry - No-chase + Pullback gating
  scoutChaseRet15Max: number;
  scoutImpulseRet15Min: number;
  scoutPullbackFromHigh15Min: number;
  scoutEntrySmaMinutes: number;
  scoutEntryRequireAboveSma: boolean;
  scoutEntryTrendSmaMinutes: number;
  // Promotion - Continuation-only with avoid-top filter
  promotionMinHoursHeld: number;
  promotionRequireRet60Min: number;
  promotionRequireRet15Min: number;
  promotionAvoidTopDrawdown30: number;
  promotionSmaMinutes: number;
  promotionRequireAboveSma: boolean;
  // Price fetch optimization
  minPositionUsdForPricing: number;
  maxPriceFetchMints: number;
  equityPriceCoverageMin: number;
  equityPriceCoverageMinUsd: number;
  executionPriceCoverageMin: number;
  // Orphan position management - liquidate held positions not in target universe
  orphanExitGraceTicks: number;
  // Sellability / Honeypot Filter (MANDATORY)
  prebuyRoundtripMinRatio: number;
  prebuyMaxSellImpactPct: number;
  // Break-Even Lock
  breakEvenLockProfitPct: number;
  // Capital Management - Capacity-aware sizing
  capitalMgmtEnabled: boolean;
  capMaxTotalExposurePct: number;
  capMaxCoreExposurePct: number;
  capMaxScoutExposurePct: number;
  capMaxMintExposurePct: number;
  capRiskPerTradeScoutPct: number;
  capRiskPerTradeCorePct: number;
  capEntryMaxImpactPctScout: number;
  capExitMaxImpactPctScout: number;
  capEntryMaxImpactPctCore: number;
  capExitMaxImpactPctCore: number;
  capRoundtripMinRatioScout: number;
  capRoundtripMinRatioCore: number;
  capLiquiditySafetyHaircut: number;
  capMaxParticipation5mVolPct: number;
  capMaxParticipation1hVolPct: number;
  capMinPoolTvlUsdScout: number;
  capMinPoolTvlUsdCore: number;
  capMin5mVolUsdScout: number;
  capMin5mVolUsdCore: number;
  capScoutSizeMinUsd: number;
  capScoutSizeMaxUsd: number;
  capScoutSizeBaseUsd: number;
  capScoutSizeBaseEquity: number;
  capEdgeBufferPct: number;
  capSizeSweepMultipliers: number[];
  feeGovernorEnabled: boolean;
  feeRatioPerLegScout: number;
  feeRatioPerLegCore: number;
  minPriorityFeeLamportsEntry: number;
  minPriorityFeeLamportsExit: number;
  maxPriorityFeeLamportsScout: number;
  maxPriorityFeeLamportsCore: number;
  retryLadderMultipliers: number[];
  feeSafetyHaircut: number;
  maxFeeRatioHardPerLeg: number;
  feeRatioGuardEnabled: boolean;
  // Utilization Scaling - Lever 2: Deploy more capital by scaling up non-zero targets
  deployTargetPct: number;
  // Stuck Target Watchdog - prevents repeated attempts on unfillable allocations
  allocationStuckWatchdogEnabled: boolean;
  allocationStuckMinGapPct: number;
  allocationStuckMaxAttempts: number;
  allocationStuckBackoffMinutesBase: number;
  // Rebalance Sell Hysteresis - prevents churn from volatile target allocations
  rebalanceSellMinHoldMinutes: number;
  rebalanceSellTargetDropConfirmTicks: number;
  rebalanceSellMinTrimUsd: number;
  // Exit Liquidity Check - prevents entry when exit would be too costly
  exitLiquidityCheckEnabled: boolean;
  exitLiqMaxImpactPctScout: number;
  exitLiqMaxImpactPctCore: number;
  exitLiqMinRoundTripScout: number;
  exitLiqMinRoundTripCore: number;
  exitLiqMaxHopsScout: number;
  exitLiqMaxHopsCore: number;
  exitLiqSafetyHaircut: number;
  exitLiqDisallowMints: string;
}

const configCache: RuntimeConfig = {
  riskProfile: env.RISK_PROFILE,
  executionMode: env.EXECUTION_MODE,
  loopSeconds: env.LOOP_SECONDS,
  maxDailyDrawdownPct: env.MAX_DAILY_DRAWDOWN_PCT,
  maxPositionPctPerAsset: env.MAX_POSITION_PCT_PER_ASSET,
  maxTurnoverPctPerDay: env.MAX_TURNOVER_PCT_PER_DAY,
  maxSlippageBps: env.MAX_SLIPPAGE_BPS,
  maxSingleSwapSol: env.MAX_SINGLE_SWAP_SOL,
  minTradeUsd: env.MIN_TRADE_USD,
  maxPositions: env.MAX_POSITIONS,
  maxTop3ConcentrationPct: env.MAX_TOP3_CONCENTRATION_PCT,
  maxPortfolioVolatility: env.MAX_PORTFOLIO_VOLATILITY,
  takeProfitPct: 0.05,
  scannerMinLiquidity: 10000,
  scannerMinVolume24h: 5000,
  scannerMinHolders: 0,
  scannerMaxPriceChange24h: 500,
  scannerMinPriceChange24h: -50,
  manualPause: false,
  // Slot-based portfolio rotation defaults
  coreSlots: 5,
  scoutSlots: 10,
  corePositionPctTarget: 0.12,
  scoutPositionPct: 0.03,
  rotationThreshold: 2.5,
  stalePositionHours: 48,
  staleExitHours: 2,
  trailingStopBasePct: 0.20,
  trailingStopTightPct: 0.10,
  trailingStopProfitThreshold: 0.12,
  // Ranking weights (existing constants from ranking.ts)
  rankingSignalWeight: 3.0,
  rankingMomentumWeight: 2.0,
  rankingTimeDecayWeight: 1.0,
  rankingTrailingWeight: 2.5,
  rankingFreshnessWeight: 1.5,
  rankingQualityWeight: 1.0,
  rankingStalePenalty: -2.0,
  rankingTrailingStopPenalty: -10.0,
  // Re-entry controls (existing constants from index.ts)
  reentryEnabled: true,
  reentryCooldownMinutes: 3,
  reentryWindowMinutes: 30,
  reentryMinMomentumScore: 7.0,
  reentrySizeMultiplier: 3.0,
  reentryMaxSolPct: 0.5,
  // Promotion criteria
  promotionMinPnlPct: 0.03,
  promotionMinSignalScore: 2.0,
  // Strategy engine
  strategyTrendThreshold: 0.75,
  strategyMomentumFactor: 0.25,
  strategyBand: 0.05,
  // Operational
  concentrationRebalanceMaxPct: 0.25,
  transferThresholdUsd: 5,
  // Autonomous scout system
  autonomousScoutsEnabled: false,
  autonomousDryRun: true,
  scoutAutoQueueScore: 10,
  scoutBuySol: 0.02,
  minSolReserve: 0.1,
  scoutTokenCooldownHours: 24,
  scoutDailyLimit: 5,
  scoutQueuePollSeconds: 60,
  scoutQueueStaleMinutes: 5,
  scoutQueueMaxBuyAttempts: 3,
  scanIntervalMinutes: 5,
  // Whale confirmation feature flags
  whaleConfirmEnabled: false,
  whaleConfirmDryRun: true,
  whaleConfirmPollSeconds: 30,
  whaleWindowMinutes: 10,
  whaleMinUsd: 5000,
  whaleNetflowTriggerUsd: 8000,
  marketConfirmPct: 1.5,
  maxPriceImpactBps: 150,
  exitNetflowUsd: -7000,
  exitTrailDrawdownPct: 8,
  scoutUnderperformMinutes: 90,
  whaleCooldownMinutes: 60,
  // Advanced Flow Controls
  stalePnlBandPct: 0.02,
  dustThresholdUsd: 0.50,
  minPositionUsd: 1.0,
  txFeeBufferSol: 0.01,
  scoutStopLossPct: 0.07,
  scoutTakeProfitPct: 0.10,
  scoutTpMinHoldMinutes: 5,
  lossExitPct: 0.15,
  promotionDelayMinutes: 75,
  scoutGraceMinutes: 20,
  manualScoutBuyEnabled: true,
  minTicksForSignals: 60,
  // Allocation Ramp - prevents over-allocation on low tick count tokens
  allocationRampEnabled: true,
  minTicksForFullAlloc: 30,
  preFullAllocMaxPct: 0.08,
  smoothRamp: true,
  hardCapBeforeFull: true,
  // Sniper feature flag - OFF by default
  sniperEnabled: false,
  // Universe telemetry settings
  telemetryRetentionHours: 72,
  telemetryCachePollSeconds: 60,
  // Exit Invariant - ensures positions close completely
  exitInvariantEnabled: true,
  exitInvariantMaxRetries: 2,
  exitInvariantRetryDelayMs: 1200,
  exitInvariantMinRemainingQty: 0,
  exitInvariantMinRemainingUsd: 0.50,
  exitInvariantSlippageBps: 300,
  exitInvariantForceExactClose: false,
  // Scout Entry - No-chase + Pullback gating
  scoutChaseRet15Max: 0.25,
  scoutImpulseRet15Min: 0.10,
  scoutPullbackFromHigh15Min: 0.08,
  scoutEntrySmaMinutes: 30,
  scoutEntryRequireAboveSma: true,
  scoutEntryTrendSmaMinutes: 240,
  // Promotion - Continuation-only with avoid-top filter
  promotionMinHoursHeld: 1,
  promotionRequireRet60Min: 0.12,
  promotionRequireRet15Min: 0.00,
  promotionAvoidTopDrawdown30: 0.10,
  promotionSmaMinutes: 60,
  promotionRequireAboveSma: true,
  // Price fetch optimization
  minPositionUsdForPricing: 1,
  maxPriceFetchMints: 250,
  equityPriceCoverageMin: 0.75,
  equityPriceCoverageMinUsd: 1.00,
  executionPriceCoverageMin: 0.60,
  // Orphan position management - liquidate held positions not in target universe
  orphanExitGraceTicks: 2,
  // Sellability / Honeypot Filter (MANDATORY)
  prebuyRoundtripMinRatio: 0.92,
  prebuyMaxSellImpactPct: 0.03,
  // Break-Even Lock
  breakEvenLockProfitPct: 0.06,
  // Capital Management - Capacity-aware sizing
  capitalMgmtEnabled: true,
  capMaxTotalExposurePct: 0.55,
  capMaxCoreExposurePct: 0.40,
  capMaxScoutExposurePct: 0.20,
  capMaxMintExposurePct: 0.12,
  capRiskPerTradeScoutPct: 0.0035,
  capRiskPerTradeCorePct: 0.0060,
  capEntryMaxImpactPctScout: 0.008,
  capExitMaxImpactPctScout: 0.010,
  capEntryMaxImpactPctCore: 0.005,
  capExitMaxImpactPctCore: 0.007,
  capRoundtripMinRatioScout: 0.94,
  capRoundtripMinRatioCore: 0.96,
  capLiquiditySafetyHaircut: 0.80,
  capMaxParticipation5mVolPct: 0.005,
  capMaxParticipation1hVolPct: 0.002,
  capMinPoolTvlUsdScout: 25000,
  capMinPoolTvlUsdCore: 150000,
  capMin5mVolUsdScout: 5000,
  capMin5mVolUsdCore: 25000,
  capScoutSizeMinUsd: 15,
  capScoutSizeMaxUsd: 60,
  capScoutSizeBaseUsd: 20,
  capScoutSizeBaseEquity: 400,
  capEdgeBufferPct: 0.01,
  capSizeSweepMultipliers: [0.5, 1, 2, 4, 8],
  feeGovernorEnabled: false,
  feeRatioPerLegScout: 0.003,
  feeRatioPerLegCore: 0.002,
  minPriorityFeeLamportsEntry: 0,
  minPriorityFeeLamportsExit: 100_000,
  maxPriorityFeeLamportsScout: 400_000,
  maxPriorityFeeLamportsCore: 1_000_000,
  retryLadderMultipliers: [1, 2, 4, 8],
  feeSafetyHaircut: 0.85,
  maxFeeRatioHardPerLeg: 0.01,
  feeRatioGuardEnabled: false,
  // Utilization Scaling - Lever 2: Deploy more capital by scaling up non-zero targets
  // Set to 0.35 (35%) as recommended starting point; scale up as confidence grows
  deployTargetPct: 0.35,
  // Stuck Target Watchdog - prevents repeated attempts on unfillable allocations
  allocationStuckWatchdogEnabled: false,
  allocationStuckMinGapPct: 0.02,
  allocationStuckMaxAttempts: 5,
  allocationStuckBackoffMinutesBase: 5,
  // Rebalance Sell Hysteresis - prevents churn from volatile target allocations
  rebalanceSellMinHoldMinutes: 15,
  rebalanceSellTargetDropConfirmTicks: 3,
  rebalanceSellMinTrimUsd: 20,
  // Exit Liquidity Check defaults
  exitLiquidityCheckEnabled: true,
  exitLiqMaxImpactPctScout: 0.08,
  exitLiqMaxImpactPctCore: 0.05,
  exitLiqMinRoundTripScout: 0.94,
  exitLiqMinRoundTripCore: 0.96,
  exitLiqMaxHopsScout: 3,
  exitLiqMaxHopsCore: 2,
  exitLiqSafetyHaircut: 0.90,
  exitLiqDisallowMints: "",
};

const configListeners: Array<(config: RuntimeConfig) => void> = [];

// Flag to indicate if execution mode is locked (e.g., for development enforcement)
let executionModeLocked = false;

// Track the source of each config value
const configSources: Record<keyof RuntimeConfig, "default" | "profile" | "env" | "db"> = {} as any;

// Initialize all sources as "default"
for (const key of Object.keys(configCache) as Array<keyof RuntimeConfig>) {
  configSources[key] = "default";
}
// Mark env-sourced values
configSources.riskProfile = "env";
configSources.executionMode = "env";
configSources.loopSeconds = "env";
configSources.maxDailyDrawdownPct = "env";
configSources.maxPositionPctPerAsset = "env";
configSources.maxTurnoverPctPerDay = "env";
configSources.maxSlippageBps = "env";
configSources.maxSingleSwapSol = "env";
configSources.minTradeUsd = "env";
configSources.maxPositions = "env";
configSources.maxTop3ConcentrationPct = "env";
configSources.maxPortfolioVolatility = "env";

let settingsRowCount = 0;
let lastConfigLoadTime = new Date().toISOString();

export function onConfigChange(listener: (config: RuntimeConfig) => void) {
  configListeners.push(listener);
}

function notifyListeners() {
  for (const listener of configListeners) {
    try {
      listener(configCache);
    } catch (e) {
      logger.error({ error: e }, "Config change listener error");
    }
  }
}

const keyMapping: Record<string, keyof RuntimeConfig> = {
  risk_profile: "riskProfile",
  execution_mode: "executionMode",
  loop_seconds: "loopSeconds",
  max_daily_drawdown_pct: "maxDailyDrawdownPct",
  max_position_pct_per_asset: "maxPositionPctPerAsset",
  max_turnover_pct_per_day: "maxTurnoverPctPerDay",
  max_slippage_bps: "maxSlippageBps",
  max_single_swap_sol: "maxSingleSwapSol",
  min_trade_usd: "minTradeUsd",
  max_positions: "maxPositions",
  max_top3_concentration_pct: "maxTop3ConcentrationPct",
  max_portfolio_volatility: "maxPortfolioVolatility",
  take_profit_pct: "takeProfitPct",
  scanner_min_liquidity: "scannerMinLiquidity",
  scanner_min_volume_24h: "scannerMinVolume24h",
  scanner_min_holders: "scannerMinHolders",
  scanner_max_price_change_24h: "scannerMaxPriceChange24h",
  scanner_min_price_change_24h: "scannerMinPriceChange24h",
  manual_pause: "manualPause",
  // Slot-based portfolio rotation
  core_slots: "coreSlots",
  scout_slots: "scoutSlots",
  core_position_pct_target: "corePositionPctTarget",
  scout_position_pct: "scoutPositionPct",
  rotation_threshold: "rotationThreshold",
  stale_position_hours: "stalePositionHours",
  stale_exit_hours: "staleExitHours",
  trailing_stop_base_pct: "trailingStopBasePct",
  trailing_stop_tight_pct: "trailingStopTightPct",
  trailing_stop_profit_threshold: "trailingStopProfitThreshold",
  ranking_signal_weight: "rankingSignalWeight",
  ranking_momentum_weight: "rankingMomentumWeight",
  ranking_time_decay_weight: "rankingTimeDecayWeight",
  ranking_trailing_weight: "rankingTrailingWeight",
  ranking_freshness_weight: "rankingFreshnessWeight",
  ranking_quality_weight: "rankingQualityWeight",
  ranking_stale_penalty: "rankingStalePenalty",
  ranking_trailing_stop_penalty: "rankingTrailingStopPenalty",
  reentry_enabled: "reentryEnabled",
  reentry_cooldown_minutes: "reentryCooldownMinutes",
  reentry_window_minutes: "reentryWindowMinutes",
  reentry_min_momentum_score: "reentryMinMomentumScore",
  reentry_size_multiplier: "reentrySizeMultiplier",
  reentry_max_sol_pct: "reentryMaxSolPct",
  promotion_min_pnl_pct: "promotionMinPnlPct",
  promotion_min_signal_score: "promotionMinSignalScore",
  strategy_trend_threshold: "strategyTrendThreshold",
  strategy_momentum_factor: "strategyMomentumFactor",
  strategy_band: "strategyBand",
  concentration_rebalance_max_pct: "concentrationRebalanceMaxPct",
  transfer_threshold_usd: "transferThresholdUsd",
  autonomous_scouts_enabled: "autonomousScoutsEnabled",
  autonomous_dry_run: "autonomousDryRun",
  scout_auto_queue_score: "scoutAutoQueueScore",
  scout_buy_sol: "scoutBuySol",
  min_sol_reserve: "minSolReserve",
  scout_token_cooldown_hours: "scoutTokenCooldownHours",
  scout_daily_limit: "scoutDailyLimit",
  scout_queue_poll_seconds: "scoutQueuePollSeconds",
  scout_queue_stale_minutes: "scoutQueueStaleMinutes",
  scout_queue_max_buy_attempts: "scoutQueueMaxBuyAttempts",
  scan_interval_minutes: "scanIntervalMinutes",
  // Whale confirmation feature flags
  whale_confirm_enabled: "whaleConfirmEnabled",
  whale_confirm_dry_run: "whaleConfirmDryRun",
  whale_confirm_poll_seconds: "whaleConfirmPollSeconds",
  whale_window_minutes: "whaleWindowMinutes",
  whale_min_usd: "whaleMinUsd",
  whale_netflow_trigger_usd: "whaleNetflowTriggerUsd",
  market_confirm_pct: "marketConfirmPct",
  max_price_impact_bps: "maxPriceImpactBps",
  exit_netflow_usd: "exitNetflowUsd",
  exit_trail_drawdown_pct: "exitTrailDrawdownPct",
  scout_underperform_minutes: "scoutUnderperformMinutes",
  whale_cooldown_minutes: "whaleCooldownMinutes",
  // Advanced Flow Controls
  stale_pnl_band_pct: "stalePnlBandPct",
  dust_threshold_usd: "dustThresholdUsd",
  min_position_usd: "minPositionUsd",
  tx_fee_buffer_sol: "txFeeBufferSol",
  scout_stop_loss_pct: "scoutStopLossPct",
  scout_take_profit_pct: "scoutTakeProfitPct",
  scout_tp_min_hold_minutes: "scoutTpMinHoldMinutes",
  loss_exit_pct: "lossExitPct",
  promotion_delay_minutes: "promotionDelayMinutes",
  scout_grace_minutes: "scoutGraceMinutes",
  manual_scout_buy_enabled: "manualScoutBuyEnabled",
  min_ticks_for_signals: "minTicksForSignals",
  allocation_ramp_enabled: "allocationRampEnabled",
  min_ticks_for_full_alloc: "minTicksForFullAlloc",
  pre_full_alloc_max_pct: "preFullAllocMaxPct",
  smooth_ramp: "smoothRamp",
  hard_cap_before_full: "hardCapBeforeFull",
  sniper_enabled: "sniperEnabled",
  telemetry_retention_hours: "telemetryRetentionHours",
  telemetry_cache_poll_seconds: "telemetryCachePollSeconds",
  // Exit Invariant
  exit_invariant_enabled: "exitInvariantEnabled",
  exit_invariant_max_retries: "exitInvariantMaxRetries",
  exit_invariant_retry_delay_ms: "exitInvariantRetryDelayMs",
  exit_invariant_min_remaining_qty: "exitInvariantMinRemainingQty",
  exit_invariant_min_remaining_usd: "exitInvariantMinRemainingUsd",
  exit_invariant_slippage_bps: "exitInvariantSlippageBps",
  exit_invariant_force_exact_close: "exitInvariantForceExactClose",
  // Scout Entry - No-chase + Pullback gating
  scout_chase_ret15_max: "scoutChaseRet15Max",
  scout_impulse_ret15_min: "scoutImpulseRet15Min",
  scout_pullback_from_high15_min: "scoutPullbackFromHigh15Min",
  scout_entry_sma_minutes: "scoutEntrySmaMinutes",
  scout_entry_require_above_sma: "scoutEntryRequireAboveSma",
  scout_entry_trend_sma_minutes: "scoutEntryTrendSmaMinutes",
  // Promotion - Continuation-only with avoid-top filter
  promotion_min_hours_held: "promotionMinHoursHeld",
  promotion_require_ret60_min: "promotionRequireRet60Min",
  promotion_require_ret15_min: "promotionRequireRet15Min",
  promotion_avoid_top_drawdown30: "promotionAvoidTopDrawdown30",
  promotion_sma_minutes: "promotionSmaMinutes",
  promotion_require_above_sma: "promotionRequireAboveSma",
  min_position_usd_for_pricing: "minPositionUsdForPricing",
  max_price_fetch_mints: "maxPriceFetchMints",
  equity_price_coverage_min: "equityPriceCoverageMin",
  equity_price_coverage_min_usd: "equityPriceCoverageMinUsd",
  execution_price_coverage_min: "executionPriceCoverageMin",
  orphan_exit_grace_ticks: "orphanExitGraceTicks",
  // Sellability / Honeypot Filter
  prebuy_roundtrip_min_ratio: "prebuyRoundtripMinRatio",
  prebuy_max_sell_impact_pct: "prebuyMaxSellImpactPct",
  // Break-Even Lock
  break_even_lock_profit_pct: "breakEvenLockProfitPct",
  // Capital Management
  capital_mgmt_enabled: "capitalMgmtEnabled",
  cap_max_total_exposure_pct: "capMaxTotalExposurePct",
  cap_max_core_exposure_pct: "capMaxCoreExposurePct",
  cap_max_scout_exposure_pct: "capMaxScoutExposurePct",
  cap_max_mint_exposure_pct: "capMaxMintExposurePct",
  cap_risk_per_trade_scout_pct: "capRiskPerTradeScoutPct",
  cap_risk_per_trade_core_pct: "capRiskPerTradeCorePct",
  cap_entry_max_impact_pct_scout: "capEntryMaxImpactPctScout",
  cap_exit_max_impact_pct_scout: "capExitMaxImpactPctScout",
  cap_entry_max_impact_pct_core: "capEntryMaxImpactPctCore",
  cap_exit_max_impact_pct_core: "capExitMaxImpactPctCore",
  cap_roundtrip_min_ratio_scout: "capRoundtripMinRatioScout",
  cap_roundtrip_min_ratio_core: "capRoundtripMinRatioCore",
  cap_liquidity_safety_haircut: "capLiquiditySafetyHaircut",
  cap_max_participation_5m_vol_pct: "capMaxParticipation5mVolPct",
  cap_max_participation_1h_vol_pct: "capMaxParticipation1hVolPct",
  cap_min_pool_tvl_usd_scout: "capMinPoolTvlUsdScout",
  cap_min_pool_tvl_usd_core: "capMinPoolTvlUsdCore",
  cap_min_5m_vol_usd_scout: "capMin5mVolUsdScout",
  cap_min_5m_vol_usd_core: "capMin5mVolUsdCore",
  cap_scout_size_min_usd: "capScoutSizeMinUsd",
  cap_scout_size_max_usd: "capScoutSizeMaxUsd",
  cap_scout_size_base_usd: "capScoutSizeBaseUsd",
  cap_scout_size_base_equity: "capScoutSizeBaseEquity",
  cap_edge_buffer_pct: "capEdgeBufferPct",
  cap_size_sweep_multipliers: "capSizeSweepMultipliers",
  fee_governor_enabled: "feeGovernorEnabled",
  fee_ratio_per_leg_scout: "feeRatioPerLegScout",
  fee_ratio_per_leg_core: "feeRatioPerLegCore",
  min_priority_fee_lamports_entry: "minPriorityFeeLamportsEntry",
  min_priority_fee_lamports_exit: "minPriorityFeeLamportsExit",
  max_priority_fee_lamports_scout: "maxPriorityFeeLamportsScout",
  max_priority_fee_lamports_core: "maxPriorityFeeLamportsCore",
  retry_ladder_multipliers: "retryLadderMultipliers",
  fee_safety_haircut: "feeSafetyHaircut",
  max_fee_ratio_hard_per_leg: "maxFeeRatioHardPerLeg",
  fee_ratio_guard_enabled: "feeRatioGuardEnabled",
  // Utilization Scaling
  deploy_target_pct: "deployTargetPct",
  // Stuck Target Watchdog
  allocation_stuck_watchdog_enabled: "allocationStuckWatchdogEnabled",
  allocation_stuck_min_gap_pct: "allocationStuckMinGapPct",
  allocation_stuck_max_attempts: "allocationStuckMaxAttempts",
  allocation_stuck_backoff_minutes_base: "allocationStuckBackoffMinutesBase",
  // Rebalance Sell Hysteresis
  rebalance_sell_min_hold_minutes: "rebalanceSellMinHoldMinutes",
  rebalance_sell_target_drop_confirm_ticks: "rebalanceSellTargetDropConfirmTicks",
  rebalance_sell_min_trim_usd: "rebalanceSellMinTrimUsd",
  exit_liquidity_check_enabled: "exitLiquidityCheckEnabled",
  exit_liq_max_impact_pct_scout: "exitLiqMaxImpactPctScout",
  exit_liq_max_impact_pct_core: "exitLiqMaxImpactPctCore",
  exit_liq_min_round_trip_scout: "exitLiqMinRoundTripScout",
  exit_liq_min_round_trip_core: "exitLiqMinRoundTripCore",
  exit_liq_max_hops_scout: "exitLiqMaxHopsScout",
  exit_liq_max_hops_core: "exitLiqMaxHopsCore",
  exit_liq_safety_haircut: "exitLiqSafetyHaircut",
  exit_liq_disallow_mints: "exitLiqDisallowMints",
};

const reverseKeyMapping: Record<keyof RuntimeConfig, string> = Object.fromEntries(
  Object.entries(keyMapping).map(([k, v]) => [v, k])
) as Record<keyof RuntimeConfig, string>;

function parseValue(key: keyof RuntimeConfig, value: string): any {
  switch (key) {
    case "riskProfile":
      return value as RiskProfileName;
    case "executionMode":
      return value as ExecutionMode;
    case "manualPause":
    case "reentryEnabled":
    case "autonomousScoutsEnabled":
    case "autonomousDryRun":
    case "whaleConfirmEnabled":
    case "whaleConfirmDryRun":
    case "sniperEnabled":
    case "allocationRampEnabled":
    case "exitInvariantEnabled":
    case "capitalMgmtEnabled":
    case "feeGovernorEnabled":
    case "feeRatioGuardEnabled":
    case "allocationStuckWatchdogEnabled":
      return parseBool(value);
    case "smoothRamp":
    case "hardCapBeforeFull":
    case "exitInvariantForceExactClose":
    case "scoutEntryRequireAboveSma":
    case "promotionRequireAboveSma":
      return value === "true" || value === "1";
    case "loopSeconds":
    case "maxSlippageBps":
    case "maxPositions":
    case "scannerMinHolders":
    case "coreSlots":
    case "scoutSlots":
    case "stalePositionHours":
    case "staleExitHours":
    case "reentryCooldownMinutes":
    case "reentryWindowMinutes":
    case "scoutTokenCooldownHours":
    case "scoutDailyLimit":
    case "scoutQueuePollSeconds":
    case "scoutQueueStaleMinutes":
    case "scoutQueueMaxBuyAttempts":
    case "scanIntervalMinutes":
    case "whaleConfirmPollSeconds":
    case "whaleWindowMinutes":
    case "maxPriceImpactBps":
    case "scoutUnderperformMinutes":
    case "whaleCooldownMinutes":
    case "promotionDelayMinutes":
    case "scoutGraceMinutes":
    case "scoutTpMinHoldMinutes":
    case "minTicksForSignals":
    case "minTicksForFullAlloc":
    case "allocationStuckMaxAttempts":
    case "allocationStuckBackoffMinutesBase":
    case "telemetryRetentionHours":
    case "telemetryCachePollSeconds":
    case "exitInvariantMaxRetries":
    case "exitInvariantRetryDelayMs":
    case "exitInvariantSlippageBps":
    case "scoutEntrySmaMinutes":
    case "scoutEntryTrendSmaMinutes":
    case "promotionSmaMinutes":
    case "maxPriceFetchMints":
    case "orphanExitGraceTicks":
    case "capMinPoolTvlUsdScout":
    case "capMinPoolTvlUsdCore":
    case "capMin5mVolUsdScout":
    case "capMin5mVolUsdCore":
    case "capScoutSizeBaseEquity":
    case "minPriorityFeeLamportsEntry":
    case "minPriorityFeeLamportsExit":
    case "maxPriorityFeeLamportsScout":
    case "maxPriorityFeeLamportsCore":
    case "rebalanceSellMinHoldMinutes":
    case "rebalanceSellTargetDropConfirmTicks":
      return parseInt(value, 10);
    case "maxDailyDrawdownPct":
    case "maxPositionPctPerAsset":
    case "maxTurnoverPctPerDay":
    case "maxSingleSwapSol":
    case "minTradeUsd":
    case "maxTop3ConcentrationPct":
    case "maxPortfolioVolatility":
    case "takeProfitPct":
    case "scannerMinLiquidity":
    case "scannerMinVolume24h":
    case "scannerMaxPriceChange24h":
    case "scannerMinPriceChange24h":
    case "corePositionPctTarget":
    case "scoutPositionPct":
    case "rotationThreshold":
    case "trailingStopBasePct":
    case "trailingStopTightPct":
    case "trailingStopProfitThreshold":
    case "rankingSignalWeight":
    case "rankingMomentumWeight":
    case "rankingTimeDecayWeight":
    case "rankingTrailingWeight":
    case "rankingFreshnessWeight":
    case "rankingQualityWeight":
    case "rankingStalePenalty":
    case "rankingTrailingStopPenalty":
    case "reentryMinMomentumScore":
    case "reentrySizeMultiplier":
    case "reentryMaxSolPct":
    case "promotionMinPnlPct":
    case "promotionMinSignalScore":
    case "strategyTrendThreshold":
    case "strategyMomentumFactor":
    case "strategyBand":
    case "concentrationRebalanceMaxPct":
    case "transferThresholdUsd":
    case "scoutAutoQueueScore":
    case "scoutBuySol":
    case "minSolReserve":
    case "whaleMinUsd":
    case "whaleNetflowTriggerUsd":
    case "marketConfirmPct":
    case "exitNetflowUsd":
    case "exitTrailDrawdownPct":
    case "stalePnlBandPct":
    case "dustThresholdUsd":
    case "minPositionUsd":
    case "txFeeBufferSol":
    case "scoutStopLossPct":
    case "scoutTakeProfitPct":
    case "lossExitPct":
    case "preFullAllocMaxPct":
    case "exitInvariantMinRemainingQty":
    case "exitInvariantMinRemainingUsd":
    case "scoutChaseRet15Max":
    case "scoutImpulseRet15Min":
    case "scoutPullbackFromHigh15Min":
    case "promotionMinHoursHeld":
    case "promotionRequireRet60Min":
    case "promotionRequireRet15Min":
    case "promotionAvoidTopDrawdown30":
    case "minPositionUsdForPricing":
    case "equityPriceCoverageMin":
    case "equityPriceCoverageMinUsd":
    case "executionPriceCoverageMin":
    case "prebuyRoundtripMinRatio":
    case "prebuyMaxSellImpactPct":
    case "breakEvenLockProfitPct":
    case "capMaxTotalExposurePct":
    case "capMaxCoreExposurePct":
    case "capMaxScoutExposurePct":
    case "capMaxMintExposurePct":
    case "capRiskPerTradeScoutPct":
    case "capRiskPerTradeCorePct":
    case "capEntryMaxImpactPctScout":
    case "capExitMaxImpactPctScout":
    case "capEntryMaxImpactPctCore":
    case "capExitMaxImpactPctCore":
    case "capRoundtripMinRatioScout":
    case "capRoundtripMinRatioCore":
    case "capLiquiditySafetyHaircut":
    case "capMaxParticipation5mVolPct":
    case "capMaxParticipation1hVolPct":
    case "capScoutSizeMinUsd":
    case "capScoutSizeMaxUsd":
    case "capScoutSizeBaseUsd":
    case "capEdgeBufferPct":
    case "feeRatioPerLegScout":
    case "feeRatioPerLegCore":
    case "feeSafetyHaircut":
    case "maxFeeRatioHardPerLeg":
    case "deployTargetPct":
    case "allocationStuckMinGapPct":
    case "rebalanceSellMinTrimUsd":
    case "exitLiqMaxImpactPctScout":
    case "exitLiqMaxImpactPctCore":
    case "exitLiqMinRoundTripScout":
    case "exitLiqMinRoundTripCore":
    case "exitLiqSafetyHaircut":
      return parseFloat(value);
    case "exitLiqMaxHopsScout":
    case "exitLiqMaxHopsCore":
      return parseInt(value, 10);
    case "capSizeSweepMultipliers":
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.every(v => typeof v === 'number')) {
          return parsed;
        }
        return [0.5, 1, 2, 4, 8]; // fallback default
      } catch {
        return [0.5, 1, 2, 4, 8]; // fallback default
      }
    case "retryLadderMultipliers":
      try {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed) && parsed.every(v => typeof v === 'number')) {
          return parsed;
        }
        return [1, 2, 4, 8]; // fallback default
      } catch {
        return [1, 2, 4, 8]; // fallback default
      }
    case "manualScoutBuyEnabled":
      return value === "true" || value === "1" || value === "on";
    default:
      return value;
  }
}

export async function initRuntimeConfig(): Promise<void> {
  try {
    await q(`
      CREATE TABLE IF NOT EXISTS bot_settings (
        key text primary key,
        value text not null,
        updated_at timestamptz default now()
      )
    `);
    
    // Ensure description column exists
    await q(`
      ALTER TABLE bot_settings ADD COLUMN IF NOT EXISTS description text
    `);
    
    // Auto-populate missing descriptions
    const descriptionsUpdated = await populateMissingDescriptions();
    if (descriptionsUpdated > 0) {
      logger.info({ descriptionsUpdated }, "BOT_SETTINGS: Populated missing descriptions");
    }

    const rows = await q<{ key: string; value: string }>(
      `SELECT key, value FROM bot_settings`
    );

    settingsRowCount = rows.length;
    lastConfigLoadTime = new Date().toISOString();

    for (const row of rows) {
      const configKey = keyMapping[row.key];
      if (configKey) {
        (configCache as any)[configKey] = parseValue(configKey, row.value);
        configSources[configKey] = "db";
      }
    }

    updateEffectiveConfigInfo();
    logger.info({ config: configCache }, "Runtime config initialized from DB");
    
    // Log warmup requirements for debugging
    logger.info({
      minTicksForSignals: configCache.minTicksForSignals,
      minBarsRequired: 15,
      lookbackMinutes: 65,
      loopSeconds: configCache.loopSeconds,
    }, "WARMUP_CONFIG");
    
    logger.info({
      event: "GATE_CONFIG_SNAPSHOT",
      manualPause: {
        raw: rows.find(r => r.key === 'manual_pause')?.value,
        rawType: typeof rows.find(r => r.key === 'manual_pause')?.value,
        parsed: configCache.manualPause,
        source: configSources.manualPause,
      },
      autonomousScoutsEnabled: {
        raw: rows.find(r => r.key === 'autonomous_scouts_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'autonomous_scouts_enabled')?.value,
        parsed: configCache.autonomousScoutsEnabled,
        source: configSources.autonomousScoutsEnabled,
      },
      autonomousDryRun: {
        raw: rows.find(r => r.key === 'autonomous_dry_run')?.value,
        rawType: typeof rows.find(r => r.key === 'autonomous_dry_run')?.value,
        parsed: configCache.autonomousDryRun,
        source: configSources.autonomousDryRun,
      },
      whaleConfirmEnabled: {
        raw: rows.find(r => r.key === 'whale_confirm_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'whale_confirm_enabled')?.value,
        parsed: configCache.whaleConfirmEnabled,
        source: configSources.whaleConfirmEnabled,
      },
      whaleConfirmDryRun: {
        raw: rows.find(r => r.key === 'whale_confirm_dry_run')?.value,
        rawType: typeof rows.find(r => r.key === 'whale_confirm_dry_run')?.value,
        parsed: configCache.whaleConfirmDryRun,
        source: configSources.whaleConfirmDryRun,
      },
      reentryEnabled: {
        raw: rows.find(r => r.key === 'reentry_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'reentry_enabled')?.value,
        parsed: configCache.reentryEnabled,
        source: configSources.reentryEnabled,
      },
      allocationRampEnabled: {
        raw: rows.find(r => r.key === 'allocation_ramp_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'allocation_ramp_enabled')?.value,
        parsed: configCache.allocationRampEnabled,
        source: configSources.allocationRampEnabled,
      },
      exitInvariantEnabled: {
        raw: rows.find(r => r.key === 'exit_invariant_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'exit_invariant_enabled')?.value,
        parsed: configCache.exitInvariantEnabled,
        source: configSources.exitInvariantEnabled,
      },
      capitalMgmtEnabled: {
        raw: rows.find(r => r.key === 'capital_mgmt_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'capital_mgmt_enabled')?.value,
        parsed: configCache.capitalMgmtEnabled,
        source: configSources.capitalMgmtEnabled,
      },
      feeGovernorEnabled: {
        raw: rows.find(r => r.key === 'fee_governor_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'fee_governor_enabled')?.value,
        parsed: configCache.feeGovernorEnabled,
        source: configSources.feeGovernorEnabled,
      },
      feeRatioGuardEnabled: {
        raw: rows.find(r => r.key === 'fee_ratio_guard_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'fee_ratio_guard_enabled')?.value,
        parsed: configCache.feeRatioGuardEnabled,
        source: configSources.feeRatioGuardEnabled,
      },
      allocationStuckWatchdogEnabled: {
        raw: rows.find(r => r.key === 'allocation_stuck_watchdog_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'allocation_stuck_watchdog_enabled')?.value,
        parsed: configCache.allocationStuckWatchdogEnabled,
        source: configSources.allocationStuckWatchdogEnabled,
      },
      sniperEnabled: {
        raw: rows.find(r => r.key === 'sniper_enabled')?.value,
        rawType: typeof rows.find(r => r.key === 'sniper_enabled')?.value,
        parsed: configCache.sniperEnabled,
        source: configSources.sniperEnabled,
      },
      equityPriceCoverageMin: {
        raw: rows.find(r => r.key === 'equity_price_coverage_min')?.value,
        rawType: typeof rows.find(r => r.key === 'equity_price_coverage_min')?.value,
        parsed: configCache.equityPriceCoverageMin,
        source: configSources.equityPriceCoverageMin,
      },
      executionPriceCoverageMin: {
        raw: rows.find(r => r.key === 'execution_price_coverage_min')?.value,
        rawType: typeof rows.find(r => r.key === 'execution_price_coverage_min')?.value,
        parsed: configCache.executionPriceCoverageMin,
        source: configSources.executionPriceCoverageMin,
      },
    }, "GATE_CONFIG_SNAPSHOT: Startup gate configuration");
    
    // Seed any missing settings into the database with defaults (non-blocking)
    seedMissingSettings(rows.map(r => r.key)).catch(seedErr => {
      logger.warn({ error: String(seedErr) }, "Failed to seed missing settings, but config loaded successfully");
    });
  } catch (e) {
    logger.warn({ error: e }, "Failed to load runtime config from DB, using defaults");
  }
}

async function seedMissingSettings(existingDbKeys: string[]): Promise<void> {
  const existingKeySet = new Set(existingDbKeys);
  const missingKeys: Array<{ dbKey: string; configKey: keyof RuntimeConfig; value: any }> = [];
  
  for (const [dbKey, configKey] of Object.entries(keyMapping)) {
    if (!existingKeySet.has(dbKey)) {
      // Use configCache which has defaults at this point
      const defaultValue = (configCache as any)[configKey];
      if (defaultValue !== undefined) {
        missingKeys.push({ dbKey, configKey: configKey as keyof RuntimeConfig, value: defaultValue });
      }
    }
  }
  
  if (missingKeys.length === 0) {
    return;
  }
  
  logger.info({ count: missingKeys.length, keys: missingKeys.map(k => k.dbKey) }, "Seeding missing settings into database");
  
  for (const { dbKey, configKey, value } of missingKeys) {
    try {
      let stringValue: string;
      if (typeof value === "boolean") {
        stringValue = value ? "true" : "false";
      } else if (typeof value === "object") {
        stringValue = JSON.stringify(value);
      } else {
        stringValue = String(value);
      }
      
      await q(
        `INSERT INTO bot_settings (key, value, updated_at) 
         VALUES ($1, $2, now()) 
         ON CONFLICT (key) DO NOTHING`,
        [dbKey, stringValue]
      );
      
      logger.debug({ dbKey, configKey, value: stringValue }, "Seeded missing setting");
    } catch (e) {
      logger.warn({ error: e, dbKey, configKey }, "Failed to seed setting");
    }
  }
  
  logger.info({ count: missingKeys.length }, "Finished seeding missing settings");
}

function updateEffectiveConfigInfo(): void {
  const configObj = { ...configCache } as Record<string, any>;
  setEffectiveConfigInfo({
    config: configObj,
    configHash: computeConfigHash(configObj),
    sources: { ...configSources },
    lastLoadedAt: lastConfigLoadTime,
    settingsRowCount,
  });
}

function valuesEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object' && a !== null && b !== null) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return false;
}

export async function refreshConfigFromDb(): Promise<void> {
  try {
    const rows = await q<{ key: string; value: string }>(
      `SELECT key, value FROM bot_settings`
    );

    let changesDetected = false;
    for (const row of rows) {
      const configKey = keyMapping[row.key];
      if (configKey) {
        // Skip execution_mode updates when locked (e.g., dev environment forcing paper mode)
        if (configKey === "executionMode" && executionModeLocked) {
          continue;
        }
        const newValue = parseValue(configKey, row.value);
        const oldValue = (configCache as any)[configKey];
        if (!valuesEqual(newValue, oldValue)) {
          (configCache as any)[configKey] = newValue;
          changesDetected = true;
          logger.info({ key: configKey, oldValue, newValue }, "Config hot-reloaded");
        }
      }
    }

    if (changesDetected) {
      updateEffectiveConfigInfo();
      notifyListeners();
    }
  } catch (e) {
    logger.warn({ error: e }, "Failed to refresh config from DB");
  }
}

export function getConfig(): RuntimeConfig {
  return { ...configCache };
}

export function getConfigSources(): Record<keyof RuntimeConfig, "default" | "profile" | "env" | "db"> {
  return { ...configSources };
}

export function getConfigHash(): string {
  return computeConfigHash({ ...configCache } as Record<string, any>);
}

export function getSettingsRowCount(): number {
  return settingsRowCount;
}

export function forceExecutionMode(mode: ExecutionMode, lock: boolean = true): void {
  if (lock) {
    executionModeLocked = true;
    logger.info({ mode }, "Execution mode locked");
  }
  if (configCache.executionMode !== mode) {
    logger.info({ oldMode: configCache.executionMode, newMode: mode }, "Forcing execution mode");
    configCache.executionMode = mode;
    notifyListeners();
  }
}

export function isExecutionModeLocked(): boolean {
  return executionModeLocked;
}

export async function updateConfig(
  key: keyof RuntimeConfig,
  value: any
): Promise<boolean> {
  // Prevent execution_mode updates when locked (e.g., dev environment)
  if (key === "executionMode" && executionModeLocked) {
    logger.warn({ key, value }, "Cannot update execution mode - mode is locked in development");
    return false;
  }

  const dbKey = reverseKeyMapping[key];
  if (!dbKey) {
    logger.error({ key }, "Unknown config key - not in reverseKeyMapping");
    return false;
  }

  // CRITICAL: Convert value to string properly - handle booleans explicitly
  let stringValue: string;
  if (typeof value === "boolean") {
    stringValue = value ? "true" : "false";
  } else {
    stringValue = String(value);
  }

  // TRACE: Log boolean writes specifically
  if (key === "autonomousScoutsEnabled" || key === "autonomousDryRun" || key === "reentryEnabled" || key === "manualPause") {
    logger.info({ 
      key, 
      dbKey,
      originalValue: value,
      originalType: typeof value,
      stringValue 
    }, "updateConfig - writing boolean to DB");
  }

  try {
    await q(
      `INSERT INTO bot_settings (key, value, updated_at) 
       VALUES ($1, $2, now()) 
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
      [dbKey, stringValue]
    );

    const oldValue = (configCache as any)[key];
    const newParsedValue = parseValue(key, stringValue);
    (configCache as any)[key] = newParsedValue;
    notifyListeners();
    
    // TRACE: Log boolean updates specifically
    if (key === "autonomousScoutsEnabled" || key === "autonomousDryRun" || key === "reentryEnabled" || key === "manualPause") {
      logger.info({ key, dbKey, stringValue, parsedValue: newParsedValue, oldValue }, "Config boolean updated successfully");
    } else {
      logger.info({ key, value: stringValue }, "Config updated");
    }
    
    insertConfigHistory({
      changeSource: 'dashboard',
      configSnapshot: { ...configCache },
      changedFields: { [key]: { old: oldValue, new: parseValue(key, stringValue) } },
    }).catch(e => logger.warn({ error: e }, "Failed to log config change"));
    
    if (key === "manualPause") {
      const paused = parseValue(key, stringValue) as boolean;
      setPauseState(paused, 'dashboard').catch(e => logger.warn({ error: e }, "Failed to update pause state in DB"));
    }
    
    return true;
  } catch (e) {
    logger.error({ error: e, key, value: stringValue }, "Failed to update config");
    return false;
  }
}

export async function updateConfigBatch(
  updates: Partial<RuntimeConfig>
): Promise<boolean> {
  const entries = Object.entries(updates) as [keyof RuntimeConfig, any][];
  let allSuccess = true;
  
  const hashBefore = getConfigHash();
  const changedKeys: string[] = [];

  for (const [key, value] of entries) {
    if (value !== undefined) {
      const oldValue = (configCache as any)[key];
      const success = await updateConfig(key, value);
      if (!success) {
        allSuccess = false;
      } else if (!valuesEqual(oldValue, value)) {
        changedKeys.push(key);
      }
    }
  }

  if (changedKeys.length > 0) {
    const hashAfter = getConfigHash();
    const envCtx = getEnvContext();
    
    logger.info({
      event: "SETTINGS_UPDATED",
      changedKeys,
      settingsHashBefore: hashBefore,
      settingsHashAfter: hashAfter,
      envName: envCtx.envName,
      execMode: configCache.executionMode,
    }, `SETTINGS_UPDATED: ${changedKeys.length} keys changed, hash ${hashBefore} -> ${hashAfter}`);
    
    lastSettingsReloadAt = new Date().toISOString();
    updateEffectiveConfigInfo();
  }

  return allSuccess;
}

export async function getAllSettings(): Promise<
  Array<{ key: string; value: string; updated_at: Date }>
> {
  try {
    const rows = await q<{ key: string; value: string; updated_at: Date }>(
      `SELECT key, value, updated_at FROM bot_settings ORDER BY key`
    );
    return rows;
  } catch (e) {
    return [];
  }
}

export function getConfigForApi() {
  const c = getConfig();
  return {
    riskProfile: c.riskProfile,
    executionMode: c.executionMode,
    loopSeconds: c.loopSeconds,
    manualPause: c.manualPause,
    limits: {
      maxDailyDrawdownPct: c.maxDailyDrawdownPct,
      maxPositionPctPerAsset: c.maxPositionPctPerAsset,
      maxTurnoverPctPerDay: c.maxTurnoverPctPerDay,
      maxSlippageBps: c.maxSlippageBps,
      maxSingleSwapSol: c.maxSingleSwapSol,
      minTradeUsd: c.minTradeUsd,
      takeProfitPct: c.takeProfitPct,
    },
    portfolioLimits: {
      maxPositions: c.maxPositions,
      maxTop3ConcentrationPct: c.maxTop3ConcentrationPct,
      maxPortfolioVolatility: c.maxPortfolioVolatility,
    },
    scanner: {
      minLiquidity: c.scannerMinLiquidity,
      minVolume24h: c.scannerMinVolume24h,
      minHolders: c.scannerMinHolders,
      maxPriceChange24h: c.scannerMaxPriceChange24h,
      minPriceChange24h: c.scannerMinPriceChange24h,
    },
    rotation: {
      coreSlots: c.coreSlots,
      scoutSlots: c.scoutSlots,
      corePositionPctTarget: c.corePositionPctTarget,
      scoutPositionPct: c.scoutPositionPct,
      rotationThreshold: c.rotationThreshold,
      stalePositionHours: c.stalePositionHours,
      staleExitHours: c.staleExitHours,
      trailingStopBasePct: c.trailingStopBasePct,
      trailingStopTightPct: c.trailingStopTightPct,
      trailingStopProfitThreshold: c.trailingStopProfitThreshold,
    },
    ranking: {
      signalWeight: c.rankingSignalWeight,
      momentumWeight: c.rankingMomentumWeight,
      timeDecayWeight: c.rankingTimeDecayWeight,
      trailingWeight: c.rankingTrailingWeight,
      freshnessWeight: c.rankingFreshnessWeight,
      qualityWeight: c.rankingQualityWeight,
      stalePenalty: c.rankingStalePenalty,
      trailingStopPenalty: c.rankingTrailingStopPenalty,
    },
    reentry: {
      enabled: c.reentryEnabled,
      cooldownMinutes: c.reentryCooldownMinutes,
      windowMinutes: c.reentryWindowMinutes,
      minMomentumScore: c.reentryMinMomentumScore,
      sizeMultiplier: c.reentrySizeMultiplier,
      maxSolPct: c.reentryMaxSolPct,
    },
    promotion: {
      minPnlPct: c.promotionMinPnlPct,
      minSignalScore: c.promotionMinSignalScore,
      delayMinutes: c.promotionDelayMinutes,
    },
    strategy: {
      trendThreshold: c.strategyTrendThreshold,
      momentumFactor: c.strategyMomentumFactor,
      band: c.strategyBand,
    },
    operational: {
      concentrationRebalanceMaxPct: c.concentrationRebalanceMaxPct,
      transferThresholdUsd: c.transferThresholdUsd,
    },
    autonomousScouts: {
      enabled: c.autonomousScoutsEnabled,
      dryRun: c.autonomousDryRun,
      autoQueueScore: c.scoutAutoQueueScore,
      buySol: c.scoutBuySol,
      minSolReserve: c.minSolReserve,
      tokenCooldownHours: c.scoutTokenCooldownHours,
      dailyLimit: c.scoutDailyLimit,
      queuePollSeconds: c.scoutQueuePollSeconds,
    },
  };
}

export function getScannerConfig() {
  const c = getConfig();
  return {
    minLiquidity: c.scannerMinLiquidity,
    minVolume24h: c.scannerMinVolume24h,
    minHolders: c.scannerMinHolders,
    maxPriceChange24h: c.scannerMaxPriceChange24h,
    minPriceChange24h: c.scannerMinPriceChange24h,
  };
}

export function getLastSettingsReloadAt(): string {
  return lastSettingsReloadAt;
}

export async function getDbSettings(): Promise<Record<string, { value: string; updated_at: Date }>> {
  try {
    const rows = await q<{ key: string; value: string; updated_at: Date }>(
      `SELECT key, value, updated_at FROM bot_settings ORDER BY key`
    );
    const result: Record<string, { value: string; updated_at: Date }> = {};
    for (const row of rows) {
      result[row.key] = { value: row.value, updated_at: row.updated_at };
    }
    return result;
  } catch (e) {
    logger.warn({ error: e }, "Failed to get DB settings");
    return {};
  }
}

export interface SettingsDiffRow {
  key: string;
  dbKey: string;
  dbValue: string | null;
  effectiveValue: any;
  source: "default" | "profile" | "env" | "db";
}

export async function getSettingsDiff(): Promise<SettingsDiffRow[]> {
  const dbSettings = await getDbSettings();
  const effective = getConfig();
  const sources = getConfigSources();
  const diffs: SettingsDiffRow[] = [];

  for (const [configKey, source] of Object.entries(sources) as [keyof RuntimeConfig, string][]) {
    const dbKey = reverseKeyMapping[configKey];
    if (!dbKey) continue;

    const dbEntry = dbSettings[dbKey];
    const effectiveValue = effective[configKey];
    
    if (!dbEntry) {
      if (source !== "db") {
        diffs.push({
          key: configKey,
          dbKey,
          dbValue: null,
          effectiveValue,
          source: source as any,
        });
      }
    } else {
      const parsedDbValue = parseValue(configKey, dbEntry.value);
      if (!valuesEqual(parsedDbValue, effectiveValue)) {
        diffs.push({
          key: configKey,
          dbKey,
          dbValue: dbEntry.value,
          effectiveValue,
          source: source as any,
        });
      }
    }
  }

  return diffs;
}

export function startPeriodicConfigRefresh(): void {
  if (configRefreshIntervalId) {
    return;
  }
  configRefreshIntervalId = setInterval(async () => {
    try {
      await refreshConfigFromDb();
      lastSettingsReloadAt = new Date().toISOString();
    } catch (e) {
      logger.warn({ error: e }, "Periodic config refresh failed");
    }
  }, CONFIG_REFRESH_INTERVAL_MS);
  logger.info({ intervalMs: CONFIG_REFRESH_INTERVAL_MS }, "Started periodic config refresh");
}

export function stopPeriodicConfigRefresh(): void {
  if (configRefreshIntervalId) {
    clearInterval(configRefreshIntervalId);
    configRefreshIntervalId = null;
    logger.info("Stopped periodic config refresh");
  }
}

export function getKeyMapping(): Record<string, keyof RuntimeConfig> {
  return { ...keyMapping };
}

export function getReverseKeyMapping(): Record<keyof RuntimeConfig, string> {
  return { ...reverseKeyMapping };
}
