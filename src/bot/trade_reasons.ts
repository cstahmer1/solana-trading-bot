export const TRADE_REASONS = {
  // Buy reasons
  BUY_SCOUT_AUTO: 'scout_auto_buy',
  BUY_SCOUT_MANUAL: 'scout_manual_buy',
  BUY_SNIPER: 'sniper_buy',
  BUY_REENTRY: 'reentry_buy',
  BUY_PROMOTION_TOPUP: 'promotion_topup_buy',
  BUY_DCA: 'dca_buy',
  BUY_ROTATION: 'rotation_buy',
  BUY_REGIME_TREND: 'regime_trend_buy',
  
  // Sell reasons - profit taking
  SELL_TAKE_PROFIT: 'take_profit_exit',
  SELL_SCOUT_TAKE_PROFIT: 'scout_take_profit_exit',
  SELL_SNIPER_TAKE_PROFIT: 'sniper_take_profit_exit',
  SELL_TRAILING_STOP: 'trailing_stop_exit',
  
  // Sell reasons - stop losses
  SELL_STOP_LOSS: 'stop_loss_exit',
  SELL_SCOUT_STOP_LOSS: 'scout_stop_loss_exit',
  SELL_CORE_STOP_LOSS: 'core_stop_loss_exit',
  SELL_SNIPER_STOP_LOSS: 'sniper_stop_loss_exit',
  SELL_LOSS_EXIT: 'loss_exit',
  
  // Sell reasons - rebalancing/rotation
  SELL_ROTATION: 'rotation_exit',
  SELL_REBALANCE: 'rebalance_exit',
  SELL_REGIME_MEAN_REVERT: 'regime_mean_revert_exit',
  SELL_CONCENTRATION_REBALANCE: 'concentration_rebalance',
  
  // Sell reasons - other conditions
  SELL_UNDERPERFORM_GRACE: 'scout_underperform_grace_expired',
  SELL_STALE_EXIT: 'stale_position_exit',
  SELL_TIMEOUT: 'timeout_exit',
  SELL_MANUAL: 'manual_exit',
  SELL_FLASH_SELL: 'flash_sell_exit',
  SELL_WHALE_EXIT_SIGNAL: 'whale_exit_signal',
  SELL_LOW_LIQUIDITY: 'low_liquidity_exit',
  SELL_EXIT_OTHER: 'exit_other',
  
  // Failed trades
  BUY_FAILED: 'buy_failed',
  SELL_FAILED: 'sell_failed',
  
  UNKNOWN: 'unknown',
} as const;

export type TradeReason = typeof TRADE_REASONS[keyof typeof TRADE_REASONS];

export interface SettingsSnapshot {
  scout_stop_loss_pct: number;
  core_stop_loss_pct: number;
  take_profit_pct: number;
  max_slippage_bps: number;
  max_price_impact_bps: number;
  scanner_min_liquidity: number;
  scanner_min_volume_24h: number;
  scout_buy_sol: number;
  min_trade_usd: number;
  trailing_stop_base_pct: number;
  trailing_stop_tight_pct: number;
  trailing_stop_profit_threshold: number;
  execution_mode: string;
}

export interface FeeGovernorMeta {
  priorityLevel: string;
  reason: string;
  skipRecommended?: boolean;
  effectiveRatio?: number;
}

export interface TradeAnalytics {
  reason_code: TradeReason;
  entry_score?: number;
  exit_score?: number;
  fees_lamports?: number;
  priority_fee_lamports?: number;
  route?: string;
  settings_snapshot?: SettingsSnapshot;
  liquidity_usd?: number;
  fee_governor_meta?: FeeGovernorMeta;
}
