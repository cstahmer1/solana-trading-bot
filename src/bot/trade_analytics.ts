import { getConfig } from "./runtime_config.js";
import type { QuoteResponse } from "./jupiter.js";
import type { SettingsSnapshot, TradeReason, TradeAnalytics } from "./trade_reasons.js";
import { TRADE_REASONS } from "./trade_reasons.js";

export function captureSettingsSnapshot(): SettingsSnapshot {
  const config = getConfig();
  return {
    scout_stop_loss_pct: config.scoutStopLossPct,
    core_stop_loss_pct: config.lossExitPct,
    take_profit_pct: config.takeProfitPct,
    max_slippage_bps: config.maxSlippageBps,
    max_price_impact_bps: config.maxPriceImpactBps,
    scanner_min_liquidity: config.scannerMinLiquidity,
    scanner_min_volume_24h: config.scannerMinVolume24h,
    scout_buy_sol: config.scoutBuySol,
    min_trade_usd: config.minTradeUsd,
    trailing_stop_base_pct: config.trailingStopBasePct,
    trailing_stop_tight_pct: config.trailingStopTightPct,
    trailing_stop_profit_threshold: config.trailingStopProfitThreshold,
    execution_mode: config.executionMode,
  };
}

export function extractRouteFromQuote(quote: QuoteResponse | null | undefined): string | null {
  if (!quote?.routePlan?.length) return null;
  
  try {
    const routeLabels = quote.routePlan
      .map((step: any) => step?.swapInfo?.label || 'unknown')
      .filter((label: string) => label !== 'unknown');
    
    if (routeLabels.length === 0) return null;
    return routeLabels.join(' → ');
  } catch {
    return null;
  }
}

export function extractPriorityFeeLamports(riskProfile: string): bigint {
  switch (riskProfile) {
    case "degen": return 5_000_000n;
    case "high": return 2_000_000n;
    case "moderate": return 1_000_000n;
    default: return 500_000n;
  }
}

const BASE_FEE_LAMPORTS = 10_000n;

/**
 * Estimates fees for a trade. Note: These are ESTIMATED fees, not actual fees paid.
 * - Base fee: Fixed 10k lamports (Jupiter platform fee estimate)
 * - Priority fee: Risk-profile based estimate (degen=5M, high=2M, moderate=1M, low=500k)
 * 
 * Jupiter quote API does not return actual fee info - actual fees are only known 
 * after transaction confirmation. These estimates are useful for:
 * - Comparing relative costs between trade types
 * - Identifying high-fee risk profiles
 * - Correlating fee estimates with trade outcomes
 */
export function extractFeesFromQuote(quote: QuoteResponse | null | undefined, riskProfile: string): { feesLamports: bigint; priorityFeeLamports: bigint } {
  const priorityFeeLamports = extractPriorityFeeLamports(riskProfile);
  const baseFee = BASE_FEE_LAMPORTS;
  
  return {
    feesLamports: baseFee,
    priorityFeeLamports,
  };
}

export type FeeDecisionInput = {
  maxLamports: number;
  priorityLevel: string;
  reason: string;
  skipRecommended?: boolean;
  effectiveRatio?: number;
};

export function buildTradeAnalytics(params: {
  reason: TradeReason;
  quote?: QuoteResponse | null;
  riskProfile?: string;
  entryScore?: number;
  exitScore?: number;
  liquidityUsd?: number;
  feeDecision?: FeeDecisionInput;
}): TradeAnalytics {
  const { reason, quote, riskProfile = 'medium', entryScore, exitScore, liquidityUsd, feeDecision } = params;
  
  let priorityFeeLamports: number;
  let feeGovernorMeta: any = undefined;
  
  if (feeDecision) {
    priorityFeeLamports = feeDecision.maxLamports;
    feeGovernorMeta = {
      priorityLevel: feeDecision.priorityLevel,
      reason: feeDecision.reason,
      skipRecommended: feeDecision.skipRecommended,
      effectiveRatio: feeDecision.effectiveRatio,
    };
  } else {
    const { priorityFeeLamports: legacyFee } = extractFeesFromQuote(quote, riskProfile);
    priorityFeeLamports = Number(legacyFee);
  }
  
  const route = extractRouteFromQuote(quote);
  const settings = captureSettingsSnapshot();
  
  return {
    reason_code: reason,
    entry_score: entryScore,
    exit_score: exitScore,
    fees_lamports: Number(BASE_FEE_LAMPORTS),
    priority_fee_lamports: priorityFeeLamports,
    route: route ?? undefined,
    settings_snapshot: settings,
    liquidity_usd: liquidityUsd,
    fee_governor_meta: feeGovernorMeta,
  };
}

export function mapReasonToCode(legacyReason: string): TradeReason {
  const mapping: Record<string, TradeReason> = {
    'take_profit': TRADE_REASONS.SELL_TAKE_PROFIT,
    'scout_stop_loss_exit': TRADE_REASONS.SELL_SCOUT_STOP_LOSS,
    'core_loss_exit': TRADE_REASONS.SELL_CORE_STOP_LOSS,
    'trailing_stop_exit': TRADE_REASONS.SELL_TRAILING_STOP,
    'stale_exit': TRADE_REASONS.SELL_STALE_EXIT,
    'rotation': TRADE_REASONS.SELL_ROTATION,
    'rotation_exit': TRADE_REASONS.SELL_ROTATION,
    'scout_underperform_exit': TRADE_REASONS.SELL_UNDERPERFORM_GRACE,
    'concentration_rebalance': TRADE_REASONS.SELL_CONCENTRATION_REBALANCE,
    'manual': TRADE_REASONS.SELL_MANUAL,
    'flash_sell': TRADE_REASONS.SELL_FLASH_SELL,
    'whale_exit': TRADE_REASONS.SELL_WHALE_EXIT_SIGNAL,
    'sniper_take_profit': TRADE_REASONS.SELL_SNIPER_TAKE_PROFIT,
    'sniper_stop_loss': TRADE_REASONS.SELL_SNIPER_STOP_LOSS,
    'low_liquidity': TRADE_REASONS.SELL_LOW_LIQUIDITY,
    
    'autonomous_scout': TRADE_REASONS.BUY_SCOUT_AUTO,
    'scout_auto': TRADE_REASONS.BUY_SCOUT_AUTO,
    'scout_queue': TRADE_REASONS.BUY_SCOUT_AUTO,
    'manual_scout': TRADE_REASONS.BUY_SCOUT_MANUAL,
    'sniper_buy': TRADE_REASONS.BUY_SNIPER,
    'sniper_new_token': TRADE_REASONS.BUY_SNIPER,
    'reentry': TRADE_REASONS.BUY_REENTRY,
    're-entry': TRADE_REASONS.BUY_REENTRY,
    'promotion_topup': TRADE_REASONS.BUY_PROMOTION_TOPUP,
    'dca': TRADE_REASONS.BUY_DCA,
  };
  
  return mapping[legacyReason] ?? TRADE_REASONS.UNKNOWN;
}
