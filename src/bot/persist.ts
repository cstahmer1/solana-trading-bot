import { q } from "./db.js";
import type { PortfolioSnapshot } from "./portfolio.js";
import type { RiskProfile } from "./risk_profiles.js";
import { getCSTDate, getCSTMidnightToday } from "../utils/timezone.js";
import { 
  getPnLEventsForPeriod, 
  getTotalRealizedPnL, 
  getTodayRealizedPnL,
  getPositionCostBasis
} from "./pnl_engine.js";
import { logger } from "../utils/logger.js";

export interface RiskProfileDB {
  name: string;
  max_pos_pct: number;
  max_drawdown: number;
  entry_z: number;
  take_profit_pct: number;
  stop_loss_pct: number;
  max_turnover: number;
  slippage_bps: number;
  max_single_swap_sol: number;
  min_trade_usd: number;
  cooldown_seconds: number;
  is_default: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function loadRiskProfilesFromDB(): Promise<RiskProfileDB[]> {
  return await q<RiskProfileDB>(`SELECT * FROM risk_profiles ORDER BY name`);
}

export async function loadRiskProfileByName(name: string): Promise<RiskProfileDB | null> {
  const rows = await q<RiskProfileDB>(`SELECT * FROM risk_profiles WHERE name = $1`, [name]);
  return rows[0] ?? null;
}

export async function upsertRiskProfile(profile: {
  name: string;
  maxPositionPctPerAsset: number;
  maxDailyDrawdownPct: number;
  entryZ: number;
  takeProfitPct: number;
  stopLossPct: number;
  maxTurnoverPctPerDay: number;
  slippageBps: number;
  maxSingleSwapSol: number;
  minTradeUsd: number;
  cooldownSeconds: number;
  isDefault?: boolean;
}): Promise<boolean> {
  try {
    await q(
      `INSERT INTO risk_profiles (name, max_pos_pct, max_drawdown, entry_z, take_profit_pct, stop_loss_pct, max_turnover, slippage_bps, max_single_swap_sol, min_trade_usd, cooldown_seconds, is_default, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW())
       ON CONFLICT (name) DO UPDATE SET
         max_pos_pct = $2,
         max_drawdown = $3,
         entry_z = $4,
         take_profit_pct = $5,
         stop_loss_pct = $6,
         max_turnover = $7,
         slippage_bps = $8,
         max_single_swap_sol = $9,
         min_trade_usd = $10,
         cooldown_seconds = $11,
         updated_at = NOW()`,
      [
        profile.name,
        profile.maxPositionPctPerAsset,
        profile.maxDailyDrawdownPct,
        profile.entryZ,
        profile.takeProfitPct,
        profile.stopLossPct,
        profile.maxTurnoverPctPerDay,
        profile.slippageBps,
        profile.maxSingleSwapSol,
        profile.minTradeUsd,
        profile.cooldownSeconds,
        profile.isDefault ?? false,
      ]
    );
    return true;
  } catch (e) {
    console.error("Failed to upsert risk profile:", e);
    return false;
  }
}

export async function deleteRiskProfile(name: string): Promise<{ success: boolean; error?: string }> {
  try {
    const rows = await q<RiskProfileDB>(`SELECT is_default FROM risk_profiles WHERE name = $1`, [name]);
    if (rows.length === 0) {
      return { success: false, error: "Profile not found" };
    }
    if (rows[0].is_default) {
      return { success: false, error: "Cannot delete default profile" };
    }
    await q(`DELETE FROM risk_profiles WHERE name = $1`, [name]);
    return { success: true };
  } catch (e) {
    console.error("Failed to delete risk profile:", e);
    return { success: false, error: "Database error" };
  }
}

export async function insertPrices(rows: { mint: string; ts: Date; usd_price: number; block_id: number | null }[]): Promise<{ attempted: number; inserted: number; filtered: number; dbError: string | null }> {
  if (!rows.length) return { attempted: 0, inserted: 0, filtered: 0, dbError: null };
  
  // Filter out invalid rows (NaN, undefined, or zero prices)
  const validRows = rows.filter(r => {
    if (!r.mint || typeof r.mint !== 'string') return false;
    if (!(r.ts instanceof Date) || isNaN(r.ts.getTime())) return false;
    if (typeof r.usd_price !== 'number' || isNaN(r.usd_price) || r.usd_price <= 0) return false;
    return true;
  });
  
  const filtered = rows.length - validRows.length;
  if (filtered > 0) {
    logger.warn({ 
      totalRows: rows.length, 
      filtered, 
      validRows: validRows.length,
      sampleInvalid: rows.find(r => !validRows.includes(r)),
    }, "insertPrices: Some rows filtered out");
  }
  
  if (!validRows.length) {
    return { attempted: rows.length, inserted: 0, filtered, dbError: null };
  }
  
  try {
    // Use RETURNING to count actual inserts (not conflicts)
    const values = validRows.map((r) => `('${r.mint}', '${r.ts.toISOString()}', ${r.usd_price}, ${r.block_id ?? "null"})`).join(",");
    const result = await q<{ mint: string }>(
      `INSERT INTO prices(mint, ts, usd_price, block_id) VALUES ${values} ON CONFLICT DO NOTHING RETURNING mint`
    );
    const actualInserted = result.length;
    
    if (actualInserted === 0 && validRows.length > 0) {
      logger.warn({
        validRows: validRows.length,
        actualInserted: 0,
        sampleTs: validRows[0]?.ts?.toISOString(),
        reason: "All rows conflicted (duplicate mint+ts)"
      }, "insertPrices: Zero rows inserted");
    }
    
    return { attempted: validRows.length, inserted: actualInserted, filtered, dbError: null };
  } catch (e) {
    const errMsg = String(e);
    logger.error({ 
      error: errMsg, 
      sampleRow: validRows[0],
      rowCount: validRows.length 
    }, "insertPrices FAILED");
    return { attempted: validRows.length, inserted: 0, filtered, dbError: errMsg };
  }
}

export async function insertFeatures(mint: string, ts: Date, features: any) {
  await q(`insert into features(mint, ts, features) values ($1,$2,$3) on conflict do nothing`, [mint, ts.toISOString(), features]);
}

export async function insertTrade(row: {
  strategy: string;
  risk_profile: string;
  mode: string;
  input_mint: string;
  output_mint: string;
  in_amount: string;
  out_amount?: string | null;
  est_out_amount?: string | null;
  price_impact_pct?: string | null;
  slippage_bps?: number | null;
  tx_sig?: string | null;
  status: string;
  meta?: any;
  pnl_usd?: number | null;
  reason_code?: string | null;
  entry_score?: number | null;
  exit_score?: number | null;
  fees_lamports?: number | null;
  priority_fee_lamports?: number | null;
  route?: string | null;
  settings_snapshot?: any;
  liquidity_usd?: number | null;
  peak_pnl_pct?: number | null;
  peak_pnl_usd?: number | null;
  trailing_base_pct?: number | null;
  trailing_tight_pct?: number | null;
  trailing_threshold_pct?: number | null;
  threshold_in_effect?: string | null;
  promoted_at?: Date | null;
}): Promise<boolean> {
  try {
    await q(
      `insert into bot_trades(strategy, risk_profile, mode, input_mint, output_mint, in_amount, out_amount, est_out_amount, price_impact_pct, slippage_bps, tx_sig, status, meta, pnl_usd, reason_code, entry_score, exit_score, fees_lamports, priority_fee_lamports, route, settings_snapshot, liquidity_usd, peak_pnl_pct, peak_pnl_usd, trailing_base_pct, trailing_tight_pct, trailing_threshold_pct, threshold_in_effect, promoted_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
      [
        row.strategy, row.risk_profile, row.mode,
        row.input_mint, row.output_mint, row.in_amount,
        row.out_amount ?? null, row.est_out_amount ?? null,
        row.price_impact_pct ?? null, row.slippage_bps ?? null,
        row.tx_sig ?? null, row.status,
        row.meta ?? {},
        row.pnl_usd ?? 0,
        row.reason_code ?? null,
        row.entry_score ?? null,
        row.exit_score ?? null,
        row.fees_lamports ?? null,
        row.priority_fee_lamports ?? null,
        row.route ?? null,
        row.settings_snapshot ?? null,
        row.liquidity_usd ?? null,
        row.peak_pnl_pct ?? null,
        row.peak_pnl_usd ?? null,
        row.trailing_base_pct ?? null,
        row.trailing_tight_pct ?? null,
        row.trailing_threshold_pct ?? null,
        row.threshold_in_effect ?? null,
        row.promoted_at ?? null,
      ]
    );
    return true;
  } catch (e) {
    console.error("INSERT_TRADE_ERROR:", {
      error: String(e),
      strategy: row.strategy,
      input_mint: row.input_mint,
      output_mint: row.output_mint,
      tx_sig: row.tx_sig,
    });
    return false;
  }
}

export async function upsertEquity(s: PortfolioSnapshot) {
  await q(
    `insert into equity_snapshots(ts, total_usd, total_sol_equiv, breakdown)
     values ($1,$2,$3,$4)
     on conflict (ts) do nothing`,
    [new Date(s.ts).toISOString(), s.totalUsd, s.totalSolEquiv, s.byMint]
  );
}

export async function updateTradePnl(txSig: string, pnlUsd: number, peakPnlPct?: number, peakPnlUsd?: number): Promise<boolean> {
  try {
    await q(
      `UPDATE bot_trades SET 
         pnl_usd = $2,
         peak_pnl_pct = COALESCE($3, peak_pnl_pct),
         peak_pnl_usd = COALESCE($4, peak_pnl_usd)
       WHERE tx_sig = $1`,
      [txSig, pnlUsd, peakPnlPct ?? null, peakPnlUsd ?? null]
    );
    return true;
  } catch (e) {
    console.error("UPDATE_TRADE_PNL_ERROR:", { error: String(e), txSig, pnlUsd });
    return false;
  }
}

export async function validateTradePnlConsistency(txSig: string, fifoPnlUsd: number): Promise<{ consistent: boolean; botTradesPnl: number | null; fifoPnl: number; discrepancy: number }> {
  try {
    const tradeRows = await q<{ pnl_usd: string | number }>(
      `SELECT pnl_usd FROM bot_trades WHERE tx_sig = $1`,
      [txSig]
    );
    
    if (tradeRows.length === 0) {
      return { consistent: false, botTradesPnl: null, fifoPnl: fifoPnlUsd, discrepancy: fifoPnlUsd };
    }
    
    const botTradesPnl = Number(tradeRows[0].pnl_usd) || 0;
    const discrepancy = Math.abs(botTradesPnl - fifoPnlUsd);
    const consistent = discrepancy < 0.01;
    
    return { consistent, botTradesPnl, fifoPnl: fifoPnlUsd, discrepancy };
  } catch (e) {
    console.error("VALIDATE_TRADE_PNL_ERROR:", { error: String(e), txSig });
    return { consistent: false, botTradesPnl: null, fifoPnl: fifoPnlUsd, discrepancy: fifoPnlUsd };
  }
}

export async function insertOpportunity(row: {
  mint: string;
  symbol?: string;
  name?: string;
  score: number;
  volume_24h?: number;
  holders?: number;
  price_usd?: number;
  market_cap?: number;
  liquidity?: number;
  price_change_24h?: number;
  source?: string;
  meta?: any;
}) {
  await q(
    `insert into scanner_opportunities(mint, symbol, name, score, volume_24h, holders, price_usd, market_cap, liquidity, price_change_24h, source, meta)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      row.mint, row.symbol ?? null, row.name ?? null, row.score,
      row.volume_24h ?? null, row.holders ?? null, row.price_usd ?? null,
      row.market_cap ?? null, row.liquidity ?? null, row.price_change_24h ?? null,
      row.source ?? null, row.meta ?? {},
    ]
  );
}

export async function insertTokenMetrics(row: {
  mint: string;
  holders?: number;
  volume_24h?: number;
  liquidity?: number;
  price_usd?: number;
  market_cap?: number;
  transfers_24h?: number;
  top_holder_pct?: number;
  meta?: any;
}) {
  await q(
    `insert into token_metrics(mint, holders, volume_24h, liquidity, price_usd, market_cap, transfers_24h, top_holder_pct, meta)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      row.mint, row.holders ?? null, row.volume_24h ?? null,
      row.liquidity ?? null, row.price_usd ?? null, row.market_cap ?? null,
      row.transfers_24h ?? null, row.top_holder_pct ?? null, row.meta ?? {},
    ]
  );
}

export async function insertTrendingToken(row: {
  mint: string;
  symbol?: string;
  name?: string;
  rank: number;
  price_usd?: number;
  holders?: number;
  volume_24h?: number;
  source?: string;
}) {
  await q(
    `insert into trending_tokens(mint, symbol, name, rank, price_usd, holders, volume_24h, source)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      row.mint, row.symbol ?? null, row.name ?? null, row.rank,
      row.price_usd ?? null, row.holders ?? null, row.volume_24h ?? null, row.source ?? null,
    ]
  );
}

export async function loadRecentPrices(mint: string, limit: number): Promise<{ ts: Date; usd_price: number }[]> {
  return await q(`select ts, usd_price from prices where mint=$1 order by ts desc limit $2`, [mint, limit]);
}

export async function loadRecentTrades(limit = 50) {
  return await q(`select * from bot_trades order by ts desc limit $1`, [limit]);
}

export async function loadLatestEquity() {
  const rows = await q(`select * from equity_snapshots order by ts desc limit 1`);
  return rows[0] ?? null;
}

export async function loadRecentOpportunities(limit = 100) {
  return await q(`select * from scanner_opportunities order by ts desc limit $1`, [limit]);
}

export async function loadTokenMetricsHistory(mint: string, limit = 100) {
  return await q(`select * from token_metrics where mint=$1 order by ts desc limit $2`, [mint, limit]);
}

export async function loadRecentTrending(limit = 50) {
  return await q(`select * from trending_tokens order by ts desc limit $1`, [limit]);
}

export async function loadTradingUniverse(): Promise<{ mint: string; symbol: string; name: string | null; source: string | null; added_at: Date }[]> {
  return await q(`SELECT mint, symbol, name, source, added_at FROM trading_universe WHERE active = true ORDER BY added_at`);
}

export async function addTokenToUniverse(row: {
  mint: string;
  symbol: string;
  name?: string | null;
  source?: string;
}): Promise<boolean> {
  try {
    await q(
      `INSERT INTO trading_universe (mint, symbol, name, source, active)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (mint) DO UPDATE SET active = true, symbol = $2, name = $3, source = $4`,
      [row.mint, row.symbol, row.name ?? null, row.source ?? 'manual']
    );
    return true;
  } catch {
    return false;
  }
}

export async function removeTokenFromUniverse(mint: string): Promise<boolean> {
  try {
    await q(`UPDATE trading_universe SET active = false WHERE mint = $1`, [mint]);
    return true;
  } catch {
    return false;
  }
}

export async function isTokenInUniverse(mint: string): Promise<boolean> {
  const rows = await q(`SELECT 1 FROM trading_universe WHERE mint = $1 AND active = true`, [mint]);
  return rows.length > 0;
}

// ============================================================================
// EXITED TOKEN CACHE - tracks tokens removed from active universe
// ============================================================================

export interface ExitedTokenRecord {
  mint: string;
  symbol: string | null;
  last_exit_time: Date;
  last_exit_reason: string | null;
  last_exit_pnl_usd: number | null;
  last_exit_pnl_pct: number | null;
  cooldown_until: Date | null;
  times_reentered: number;
  last_known_signal: number | null;
  last_known_liquidity_usd: number | null;
  last_known_price: number | null;
  last_seen_time: Date | null;
  telemetry_until: Date | null;
  notes: string | null;
}

export async function upsertExitedTokenCache(params: {
  mint: string;
  symbol?: string;
  exitReason?: string;
  exitPnlUsd?: number;
  exitPnlPct?: number;
  cooldownUntil?: Date;
  lastKnownSignal?: number;
  lastKnownLiquidityUsd?: number;
  lastKnownPrice?: number;
  telemetryRetentionHours?: number;
}): Promise<boolean> {
  try {
    const telemetryUntil = params.telemetryRetentionHours
      ? new Date(Date.now() + params.telemetryRetentionHours * 60 * 60 * 1000)
      : null;
    
    await q(
      `INSERT INTO exited_token_cache (
        mint, symbol, last_exit_time, last_exit_reason, last_exit_pnl_usd, last_exit_pnl_pct,
        cooldown_until, last_known_signal, last_known_liquidity_usd, last_known_price, 
        last_seen_time, telemetry_until
      ) VALUES ($1, $2, NOW(), $3, $4, $5, $6, $7, $8, $9, NOW(), $10)
      ON CONFLICT (mint) DO UPDATE SET
        symbol = COALESCE($2, exited_token_cache.symbol),
        last_exit_time = NOW(),
        last_exit_reason = COALESCE($3, exited_token_cache.last_exit_reason),
        last_exit_pnl_usd = COALESCE($4, exited_token_cache.last_exit_pnl_usd),
        last_exit_pnl_pct = COALESCE($5, exited_token_cache.last_exit_pnl_pct),
        cooldown_until = COALESCE($6, exited_token_cache.cooldown_until),
        last_known_signal = COALESCE($7, exited_token_cache.last_known_signal),
        last_known_liquidity_usd = COALESCE($8, exited_token_cache.last_known_liquidity_usd),
        last_known_price = COALESCE($9, exited_token_cache.last_known_price),
        last_seen_time = NOW(),
        telemetry_until = COALESCE($10, exited_token_cache.telemetry_until)`,
      [
        params.mint,
        params.symbol ?? null,
        params.exitReason ?? null,
        params.exitPnlUsd ?? null,
        params.exitPnlPct ?? null,
        params.cooldownUntil ?? null,
        params.lastKnownSignal ?? null,
        params.lastKnownLiquidityUsd ?? null,
        params.lastKnownPrice ?? null,
        telemetryUntil,
      ]
    );
    return true;
  } catch (e) {
    console.error("Failed to upsert exited token cache:", e);
    return false;
  }
}

export async function getExitedTokenCache(mint: string): Promise<ExitedTokenRecord | null> {
  const rows = await q<ExitedTokenRecord>(
    `SELECT * FROM exited_token_cache WHERE mint = $1`,
    [mint]
  );
  return rows[0] ?? null;
}

export async function getRecentExitedTokens(limit = 50): Promise<ExitedTokenRecord[]> {
  return await q<ExitedTokenRecord>(
    `SELECT * FROM exited_token_cache ORDER BY last_exit_time DESC LIMIT $1`,
    [limit]
  );
}

export async function getTokensNeedingTelemetry(): Promise<ExitedTokenRecord[]> {
  return await q<ExitedTokenRecord>(
    `SELECT * FROM exited_token_cache WHERE telemetry_until > NOW() ORDER BY last_exit_time DESC`
  );
}

export async function incrementReentryCount(mint: string): Promise<void> {
  await q(
    `UPDATE exited_token_cache SET times_reentered = times_reentered + 1 WHERE mint = $1`,
    [mint]
  );
}

export async function isTokenInCooldown(mint: string): Promise<boolean> {
  const rows = await q<{ count: number }>(
    `SELECT 1 as count FROM exited_token_cache WHERE mint = $1 AND cooldown_until > NOW()`,
    [mint]
  );
  return rows.length > 0;
}

// ============================================================================
// TOKEN TELEMETRY - time series for post-exit analysis
// ============================================================================

export interface TokenTelemetryRecord {
  id: number;
  mint: string;
  ts: Date;
  price: number | null;
  liquidity_usd: number | null;
  volume_24h: number | null;
  holders: number | null;
  signal: number | null;
  features: any;
}

export async function insertTokenTelemetry(params: {
  mint: string;
  price?: number;
  liquidityUsd?: number;
  volume24h?: number;
  holders?: number;
  signal?: number;
  features?: any;
}): Promise<boolean> {
  try {
    await q(
      `INSERT INTO token_telemetry (mint, ts, price, liquidity_usd, volume_24h, holders, signal, features)
       VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7)`,
      [
        params.mint,
        params.price ?? null,
        params.liquidityUsd ?? null,
        params.volume24h ?? null,
        params.holders ?? null,
        params.signal ?? null,
        params.features ? JSON.stringify(params.features) : null,
      ]
    );
    return true;
  } catch (e) {
    console.error("Failed to insert token telemetry:", e);
    return false;
  }
}

export async function getTokenTelemetry(mint: string, limit = 100): Promise<TokenTelemetryRecord[]> {
  return await q<TokenTelemetryRecord>(
    `SELECT * FROM token_telemetry WHERE mint = $1 ORDER BY ts DESC LIMIT $2`,
    [mint, limit]
  );
}

export async function cleanupOldTelemetry(retentionDays = 7): Promise<number> {
  const result = await q<{ count: number }>(
    `WITH deleted AS (
       DELETE FROM token_telemetry WHERE ts < NOW() - INTERVAL '${retentionDays} days'
       RETURNING 1
     ) SELECT COUNT(*)::int as count FROM deleted`
  );
  return result[0]?.count ?? 0;
}

export interface PerformanceMetrics {
  totalPnL: number;
  percentReturn: number;
  winRate: number;
  winCount: number;
  lossCount: number;
  totalTrades: number;
  avgTradeSize: number;
  bestTrade: number;
  worstTrade: number;
  maxDrawdown: number;
  turnover: number;
  period: string;
  startDate: string;
  endDate: string;
}

function getStartDateForPeriod(period: string): Date {
  const now = new Date();
  
  switch (period) {
    case 'daily':
      return new Date(now.getTime() - 24 * 60 * 60 * 1000);
    case 'weekly':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case 'monthly':
      return new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    case 'yearly':
      return new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    case 'all':
    default:
      return new Date(0);
  }
}

export async function getPerformanceMetrics(period: string = 'all'): Promise<PerformanceMetrics> {
  const startDate = getStartDateForPeriod(period);
  const endDate = new Date();

  const MINT_SOL = 'So11111111111111111111111111111111111111112';
  const MINT_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const MINT_USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

  const solPriceRows = await q(`SELECT usd_price FROM prices WHERE mint = '${MINT_SOL}' ORDER BY ts DESC LIMIT 1`);
  const solPrice = Number(solPriceRows[0]?.usd_price) || 200;

  const pnlData = await getPnLEventsForPeriod(startDate);
  const realizedPnL = pnlData.totalRealized;
  
  const whereClause = period === 'all' ? '' : `WHERE ts >= $1`;
  const params = period === 'all' ? [] : [startDate.toISOString()];
  
  const statsQuery = `
    SELECT 
      COUNT(*) as total_trades,
      COALESCE(AVG(
        CASE 
          WHEN (meta->>'tradeValueUsd')::numeric > 0 THEN (meta->>'tradeValueUsd')::numeric
          WHEN input_mint = '${MINT_USDC}' THEN CAST(in_amount AS numeric) / 1000000.0
          WHEN input_mint = '${MINT_USDT}' THEN CAST(in_amount AS numeric) / 1000000.0
          WHEN input_mint = '${MINT_SOL}' THEN (CAST(in_amount AS numeric) / 1000000000.0) * ${solPrice}
          ELSE 0
        END
      ), 0) as avg_trade_size,
      COALESCE(SUM(
        CASE 
          WHEN (meta->>'tradeValueUsd')::numeric > 0 THEN (meta->>'tradeValueUsd')::numeric
          WHEN input_mint = '${MINT_USDC}' THEN CAST(in_amount AS numeric) / 1000000.0
          WHEN input_mint = '${MINT_USDT}' THEN CAST(in_amount AS numeric) / 1000000.0
          WHEN input_mint = '${MINT_SOL}' THEN (CAST(in_amount AS numeric) / 1000000000.0) * ${solPrice}
          ELSE 0
        END
      ), 0) as turnover
    FROM bot_trades
    ${whereClause}
  `;
  const statsRows = await q(statsQuery, params);
  const stats = statsRows[0] || {};

  let startingEquity = 0;
  
  if (period === 'all') {
    const allEquityRows = await q<{ total_usd: number }>(
      `SELECT total_usd FROM equity_snapshots ORDER BY ts LIMIT 1`
    );
    startingEquity = Number(allEquityRows[0]?.total_usd) || 0;
  } else {
    const beforeRows = await q<{ total_usd: number }>(
      `SELECT total_usd FROM equity_snapshots WHERE ts <= $1 ORDER BY ts DESC LIMIT 1`,
      [startDate.toISOString()]
    );
    if (beforeRows.length > 0) {
      startingEquity = Number(beforeRows[0].total_usd) || 0;
    } else {
      const afterRows = await q<{ total_usd: number }>(
        `SELECT total_usd FROM equity_snapshots ORDER BY ts LIMIT 1`
      );
      startingEquity = Number(afterRows[0]?.total_usd) || 0;
    }
  }

  const percentReturn = startingEquity > 0 
    ? (realizedPnL / startingEquity) * 100 
    : 0;

  const equitySeriesQuery = period === 'all'
    ? `SELECT total_usd FROM equity_snapshots ORDER BY ts`
    : `SELECT total_usd FROM equity_snapshots WHERE ts >= $1 ORDER BY ts`;
  
  const equitySeries = await q(equitySeriesQuery, period === 'all' ? [] : [startDate.toISOString()]);
  
  let maxDrawdown = 0;
  let peak = 0;
  for (const row of equitySeries) {
    const equity = Number(row.total_usd);
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
  }

  const totalTrades = Number(stats.total_trades) || 0;
  const totalPnlTrades = pnlData.wins + pnlData.losses;
  const winRate = totalPnlTrades > 0 ? (pnlData.wins / totalPnlTrades) * 100 : 0;

  return {
    totalPnL: realizedPnL,
    percentReturn,
    winRate,
    winCount: pnlData.wins,
    lossCount: pnlData.losses,
    totalTrades,
    avgTradeSize: Number(stats.avg_trade_size) || 0,
    bestTrade: pnlData.bestTrade,
    worstTrade: pnlData.worstTrade,
    maxDrawdown,
    turnover: Number(stats.turnover) || 0,
    period,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
  };
}

export async function loadEquitySeriesWithRange(range: string = '24h', maxPoints: number = 200): Promise<{ ts: Date; total_usd: number }[]> {
  let intervalMs: number;
  let limit: number;

  switch (range) {
    case '24h':
      intervalMs = 24 * 60 * 60 * 1000;
      limit = 500;
      break;
    case 'week':
      intervalMs = 7 * 24 * 60 * 60 * 1000;
      limit = 1000;
      break;
    case 'month':
      intervalMs = 30 * 24 * 60 * 60 * 1000;
      limit = 2000;
      break;
    case 'year':
      intervalMs = 365 * 24 * 60 * 60 * 1000;
      limit = 5000;
      break;
    case 'all':
    default:
      intervalMs = 0;
      limit = 10000;
      break;
  }

  const startTime = intervalMs > 0 ? new Date(Date.now() - intervalMs) : new Date(0);

  const query = range === 'all'
    ? `SELECT ts, total_usd FROM equity_snapshots ORDER BY ts DESC LIMIT $1`
    : `SELECT ts, total_usd FROM equity_snapshots WHERE ts >= $1 ORDER BY ts DESC LIMIT $2`;

  const params = range === 'all' ? [limit] : [startTime.toISOString(), limit];
  const rows = await q(query, params);

  const reversed = rows.reverse();

  if (reversed.length <= maxPoints) {
    return reversed;
  }

  const step = Math.ceil(reversed.length / maxPoints);
  const downsampled: { ts: Date; total_usd: number }[] = [];
  
  for (let i = 0; i < reversed.length; i += step) {
    downsampled.push(reversed[i]);
  }

  if (downsampled[downsampled.length - 1]?.ts !== reversed[reversed.length - 1]?.ts) {
    downsampled.push(reversed[reversed.length - 1]);
  }

  return downsampled;
}

export interface TickTelemetry {
  configSnapshot: any;
  riskProfile: string;
  solPriceUsd: number;
  totalEquityUsd: number;
  positionCount: number;
  portfolioSnapshot: any;
  targets: any[];
  regimeDecisions: any;
  signals: any;
}

export async function insertTickTelemetry(t: TickTelemetry) {
  await q(
    `INSERT INTO bot_tick_telemetry(config_snapshot, risk_profile, sol_price_usd, total_equity_usd, position_count, portfolio_snapshot, targets, regime_decisions, signals)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      JSON.stringify(t.configSnapshot),
      t.riskProfile,
      t.solPriceUsd,
      t.totalEquityUsd,
      t.positionCount,
      JSON.stringify(t.portfolioSnapshot),
      JSON.stringify(t.targets),
      JSON.stringify(t.regimeDecisions),
      JSON.stringify(t.signals),
    ]
  );
}

export async function insertConfigHistory(row: {
  changeSource: string;
  configSnapshot: any;
  changedFields?: any;
}) {
  await q(
    `INSERT INTO bot_config_history(change_source, config_snapshot, changed_fields)
     VALUES ($1, $2, $3)`,
    [row.changeSource, JSON.stringify(row.configSnapshot), row.changedFields ? JSON.stringify(row.changedFields) : null]
  );
}

export async function loadTickTelemetry(startDate: Date, endDate: Date, limit = 10000) {
  return await q(
    `SELECT * FROM bot_tick_telemetry WHERE ts >= $1 AND ts <= $2 ORDER BY ts LIMIT $3`,
    [startDate.toISOString(), endDate.toISOString(), limit]
  );
}

export async function loadConfigHistory(startDate: Date, endDate: Date) {
  return await q(
    `SELECT * FROM bot_config_history WHERE ts >= $1 AND ts <= $2 ORDER BY ts`,
    [startDate.toISOString(), endDate.toISOString()]
  );
}

export async function loadTradesForExport(startDate: Date, endDate: Date) {
  return await q(
    `SELECT * FROM bot_trades WHERE ts >= $1 AND ts <= $2 ORDER BY ts`,
    [startDate.toISOString(), endDate.toISOString()]
  );
}

export interface EnrichedTradeExport {
  id: number;
  ts: Date;
  strategy: string;
  risk_profile: string;
  mode: string;
  input_mint: string;
  output_mint: string;
  in_amount: string;
  out_amount: string | null;
  est_out_amount: string | null;
  price_impact_pct: string | null;
  slippage_bps: number | null;
  tx_sig: string | null;
  status: string;
  meta: any;
  pnl_usd: number | null;
  input_symbol: string | null;
  output_symbol: string | null;
  entry_price_usd: number | null;
  exit_price_usd: number | null;
  quantity: number | null;
  cost_basis_usd: number | null;
  proceeds_usd: number | null;
  realized_pnl: number | null;
  peak_pnl_pct: number | null;
  peak_pnl_usd: number | null;
  trailing_base_pct: number | null;
  trailing_tight_pct: number | null;
  trailing_threshold_pct: number | null;
  threshold_in_effect: string | null;
  promoted_at: Date | null;
}

export async function loadEnrichedTradesForExport(startDate: Date, endDate: Date): Promise<EnrichedTradeExport[]> {
  const trades = await q<any>(
    `SELECT 
      t.*,
      tu_in.symbol as input_symbol,
      tu_out.symbol as output_symbol
     FROM bot_trades t
     LEFT JOIN trading_universe tu_in ON t.input_mint = tu_in.mint
     LEFT JOIN trading_universe tu_out ON t.output_mint = tu_out.mint
     WHERE t.ts >= $1 AND t.ts <= $2 
     ORDER BY t.ts`,
    [startDate.toISOString(), endDate.toISOString()]
  );
  
  if (trades.length === 0) return [];
  
  const txSigs = trades.map(t => t.tx_sig).filter(Boolean);
  
  let lotsMap = new Map<string, any>();
  if (txSigs.length > 0) {
    const placeholders = txSigs.map((_, i) => `$${i + 1}`).join(',');
    const lots = await q<any>(
      `SELECT * FROM trade_lots WHERE tx_sig IN (${placeholders})`,
      txSigs
    );
    for (const lot of lots) {
      lotsMap.set(lot.tx_sig, lot);
    }
  }
  
  const enrichedTrades: EnrichedTradeExport[] = [];
  
  for (const trade of trades) {
    const isSell = trade.output_mint === 'So11111111111111111111111111111111111111112';
    
    const matchingLot = trade.tx_sig ? lotsMap.get(trade.tx_sig) : null;
    
    let entryPriceUsd: number | null = null;
    let exitPriceUsd: number | null = null;
    let quantity: number | null = null;
    let costBasisUsd: number | null = null;
    let proceedsUsd: number | null = null;
    let realizedPnl: number | null = null;
    
    if (matchingLot) {
      quantity = matchingLot.quantity;
      if (isSell) {
        exitPriceUsd = matchingLot.unit_price_usd;
        proceedsUsd = matchingLot.usd_value;
      } else {
        entryPriceUsd = matchingLot.unit_price_usd;
        costBasisUsd = matchingLot.usd_value;
      }
    }
    
    if (trade.meta) {
      if (trade.meta.entryPrice) entryPriceUsd = trade.meta.entryPrice;
      if (trade.meta.currentPrice && isSell) exitPriceUsd = trade.meta.currentPrice;
      if (trade.meta.costBasis) costBasisUsd = trade.meta.costBasis;
      if (trade.meta.proceedsUsd) proceedsUsd = trade.meta.proceedsUsd;
      if (trade.meta.realizedPnl) realizedPnl = trade.meta.realizedPnl;
      if (trade.meta.tradeValueUsd) {
        if (isSell) proceedsUsd = proceedsUsd ?? trade.meta.tradeValueUsd;
        else costBasisUsd = costBasisUsd ?? trade.meta.tradeValueUsd;
      }
    }
    
    enrichedTrades.push({
      ...trade,
      input_symbol: trade.input_symbol,
      output_symbol: trade.output_symbol,
      entry_price_usd: entryPriceUsd,
      exit_price_usd: exitPriceUsd,
      quantity,
      cost_basis_usd: costBasisUsd,
      proceeds_usd: proceedsUsd,
      realized_pnl: realizedPnl ?? (trade.pnl_usd ? Number(trade.pnl_usd) : null),
    });
  }
  
  return enrichedTrades;
}

export async function loadPricesForTradeWindow(
  mint: string, 
  tradeTime: Date, 
  windowMinutes: number = 60
): Promise<any[]> {
  const startTime = new Date(tradeTime.getTime() - windowMinutes * 60 * 1000);
  const endTime = new Date(tradeTime.getTime() + windowMinutes * 60 * 1000);
  
  return await q(
    `SELECT ts, mint, price_usd, market_cap, volume_24h 
     FROM prices 
     WHERE mint = $1 AND ts >= $2 AND ts <= $3 
     ORDER BY ts`,
    [mint, startTime.toISOString(), endTime.toISOString()]
  );
}

export async function loadTradesWithPriceContext(
  startDate: Date, 
  endDate: Date, 
  priceWindowMinutes: number = 60
): Promise<any[]> {
  const trades = await loadEnrichedTradesForExport(startDate, endDate);
  
  if (trades.length === 0) return [];
  
  const uniqueMints = new Set<string>();
  for (const trade of trades) {
    const isSell = trade.output_mint === 'So11111111111111111111111111111111111111112';
    uniqueMints.add(isSell ? trade.input_mint : trade.output_mint);
  }
  
  const windowMs = priceWindowMinutes * 60 * 1000;
  const expandedStart = new Date(new Date(startDate).getTime() - windowMs);
  const expandedEnd = new Date(new Date(endDate).getTime() + windowMs);
  
  const mintList = Array.from(uniqueMints);
  const mintPlaceholders = mintList.map((_, i) => `$${i + 3}`).join(',');
  
  const allPrices = await q<any>(
    `SELECT ts, mint, price_usd, market_cap, volume_24h 
     FROM prices 
     WHERE mint IN (${mintPlaceholders}) AND ts >= $1 AND ts <= $2 
     ORDER BY ts`,
    [expandedStart.toISOString(), expandedEnd.toISOString(), ...mintList]
  );
  
  const pricesByMint = new Map<string, any[]>();
  for (const price of allPrices) {
    if (!pricesByMint.has(price.mint)) {
      pricesByMint.set(price.mint, []);
    }
    pricesByMint.get(price.mint)!.push(price);
  }
  
  const tradesWithContext = [];
  
  for (const trade of trades) {
    const isSell = trade.output_mint === 'So11111111111111111111111111111111111111112';
    const mint = isSell ? trade.input_mint : trade.output_mint;
    
    const allMintPrices = pricesByMint.get(mint) || [];
    const tradeTime = new Date(trade.ts).getTime();
    
    const priceHistory = allMintPrices.filter((p: any) => {
      const priceTime = new Date(p.ts).getTime();
      return Math.abs(priceTime - tradeTime) <= windowMs;
    });
    
    tradesWithContext.push({
      trade,
      mint,
      symbol: isSell ? trade.input_symbol : trade.output_symbol,
      side: isSell ? 'sell' : 'buy',
      priceHistory,
      priceAtTrade: priceHistory.find((p: any) => 
        Math.abs(new Date(p.ts).getTime() - tradeTime) < 120000
      )?.price_usd ?? null,
      priceWindowMinutes,
    });
  }
  
  return tradesWithContext;
}

export async function loadConfigSnapshotsForExport(startDate: Date, endDate: Date) {
  const telemetry = await q(
    `SELECT ts, config_snapshot, risk_profile, sol_price_usd, total_equity_usd, position_count
     FROM bot_tick_telemetry 
     WHERE ts >= $1 AND ts <= $2 
     ORDER BY ts`,
    [startDate.toISOString(), endDate.toISOString()]
  );
  
  const configChanges: any[] = [];
  let lastConfigHash = '';
  
  for (const row of telemetry) {
    const configHash = JSON.stringify(row.config_snapshot);
    if (configHash !== lastConfigHash) {
      configChanges.push({
        ts: row.ts,
        config: row.config_snapshot,
        risk_profile: row.risk_profile,
        sol_price_usd: row.sol_price_usd,
        total_equity_usd: row.total_equity_usd,
        position_count: row.position_count,
      });
      lastConfigHash = configHash;
    }
  }
  
  return configChanges;
}

export interface AnalysisBundleExport {
  exportedAt: string;
  dateRange: { start: string; end: string };
  summary: {
    totalTrades: number;
    totalBuys: number;
    totalSells: number;
    totalRealizedPnl: number;
    winRate: number;
    avgTradeUsd: number;
    uniqueTokens: number;
  };
  trades: any[];
  configSnapshots: any[];
  equitySnapshots: any[];
}

export async function loadAnalysisBundleForExport(
  startDate: Date, 
  endDate: Date,
  priceWindowMinutes: number = 30
): Promise<AnalysisBundleExport> {
  const [tradesWithContext, configSnapshots, equitySnapshots] = await Promise.all([
    loadTradesWithPriceContext(startDate, endDate, priceWindowMinutes),
    loadConfigSnapshotsForExport(startDate, endDate),
    loadEquityForExport(startDate, endDate),
  ]);
  
  const buys = tradesWithContext.filter(t => t.side === 'buy');
  const sells = tradesWithContext.filter(t => t.side === 'sell');
  
  const totalRealizedPnl = sells.reduce((sum, t) => sum + (t.trade.realized_pnl ?? 0), 0);
  const winningTrades = sells.filter(t => (t.trade.realized_pnl ?? 0) > 0);
  const winRate = sells.length > 0 ? winningTrades.length / sells.length : 0;
  
  const allValues = tradesWithContext.map(t => 
    t.trade.proceeds_usd ?? t.trade.cost_basis_usd ?? 0
  ).filter(v => v > 0);
  const avgTradeUsd = allValues.length > 0 
    ? allValues.reduce((a, b) => a + b, 0) / allValues.length 
    : 0;
    
  const uniqueTokens = new Set(tradesWithContext.map(t => t.mint)).size;
  
  return {
    exportedAt: new Date().toISOString(),
    dateRange: {
      start: startDate.toISOString(),
      end: endDate.toISOString(),
    },
    summary: {
      totalTrades: tradesWithContext.length,
      totalBuys: buys.length,
      totalSells: sells.length,
      totalRealizedPnl,
      winRate,
      avgTradeUsd,
      uniqueTokens,
    },
    trades: tradesWithContext,
    configSnapshots,
    equitySnapshots,
  };
}

export async function loadPricesForExport(startDate: Date, endDate: Date, mints?: string[]) {
  if (mints && mints.length > 0) {
    const placeholders = mints.map((_, i) => `$${i + 3}`).join(',');
    return await q(
      `SELECT * FROM prices WHERE ts >= $1 AND ts <= $2 AND mint IN (${placeholders}) ORDER BY ts`,
      [startDate.toISOString(), endDate.toISOString(), ...mints]
    );
  }
  return await q(
    `SELECT * FROM prices WHERE ts >= $1 AND ts <= $2 ORDER BY ts`,
    [startDate.toISOString(), endDate.toISOString()]
  );
}

export async function loadEquityForExport(startDate: Date, endDate: Date) {
  return await q(
    `SELECT * FROM equity_snapshots WHERE ts >= $1 AND ts <= $2 ORDER BY ts`,
    [startDate.toISOString(), endDate.toISOString()]
  );
}

export async function recordWalletTransfer(
  transferType: 'deposit' | 'withdrawal',
  amountSol: number,
  amountUsd: number,
  previousBalanceSol: number,
  newBalanceSol: number,
  detectedReason: string
) {
  await q(
    `INSERT INTO wallet_transfers (transfer_type, amount_sol, amount_usd, previous_balance_sol, new_balance_sol, detected_reason)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [transferType, amountSol, amountUsd, previousBalanceSol, newBalanceSol, detectedReason]
  );
}

export async function getTotalTransfers(startDate?: Date): Promise<{ deposits: number; withdrawals: number }> {
  const whereClause = startDate ? `WHERE ts >= $1` : '';
  const params = startDate ? [startDate.toISOString()] : [];
  
  const rows = await q(
    `SELECT 
      COALESCE(SUM(CASE WHEN transfer_type = 'deposit' THEN amount_usd ELSE 0 END), 0) as deposits,
      COALESCE(SUM(CASE WHEN transfer_type = 'withdrawal' THEN amount_usd ELSE 0 END), 0) as withdrawals
     FROM wallet_transfers ${whereClause}`,
    params
  );
  
  return {
    deposits: Number(rows[0]?.deposits) || 0,
    withdrawals: Number(rows[0]?.withdrawals) || 0
  };
}

export async function getRecentTransfers(limit = 20) {
  return await q(
    `SELECT * FROM wallet_transfers ORDER BY ts DESC LIMIT $1`,
    [limit]
  );
}

export type SlotType = 'core' | 'scout';
export type PositionSource = 'bot' | 'sniper';

export interface PositionTrackingRow {
  mint: string;
  entry_time: Date;
  entry_price: number;
  peak_price: number;
  peak_time: Date;
  last_price: number;
  last_update: Date;
  total_tokens: number;
  slot_type: SlotType;
  promotion_count: number;
  source: PositionSource;
  peak_pnl_pct: number;
}

export async function upsertPositionTracking(row: {
  mint: string;
  entryPrice: number;
  currentPrice: number;
  totalTokens: number;
  slotType?: SlotType;
  entryTime?: string;
  source?: PositionSource;
}): Promise<void> {
  const now = new Date().toISOString();
  const entryTime = row.entryTime || now;
  const source = row.source ?? 'bot';
  const currentPnlPct = row.entryPrice > 0 ? ((row.currentPrice - row.entryPrice) / row.entryPrice) * 100 : 0;
  await q(
    `INSERT INTO position_tracking (mint, entry_time, entry_price, peak_price, peak_time, last_price, last_update, total_tokens, slot_type, source, peak_pnl_pct)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (mint) DO UPDATE SET
       last_price = $6,
       last_update = $7,
       total_tokens = $8,
       peak_price = GREATEST(position_tracking.peak_price, $6),
       peak_time = CASE WHEN $6 > position_tracking.peak_price THEN $7 ELSE position_tracking.peak_time END,
       peak_pnl_pct = GREATEST(COALESCE(position_tracking.peak_pnl_pct, 0), $11)`,
    [row.mint, entryTime, row.entryPrice, row.currentPrice, now, row.currentPrice, now, row.totalTokens, row.slotType ?? 'scout', source, currentPnlPct]
  );
}

export async function getEarliestTradeTime(mint: string): Promise<string | null> {
  try {
    const rows = await q<{ timestamp: Date }>(
      `SELECT timestamp FROM reconciled_trades 
       WHERE out_mint = $1 
       ORDER BY timestamp ASC LIMIT 1`,
      [mint]
    );
    if (rows.length > 0 && rows[0].timestamp) {
      return new Date(rows[0].timestamp).toISOString();
    }
    return null;
  } catch {
    return null;
  }
}

export async function backfillPositionEntryTimes(): Promise<number> {
  let updated = 0;
  try {
    const tableCheck = await q<{ exists: boolean }>(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'reconciled_trades') as exists`
    );
    
    if (tableCheck[0]?.exists) {
      const result = await q(
        `UPDATE position_tracking pt
         SET entry_time = earliest.min_ts
         FROM (
           SELECT out_mint, MIN(timestamp) as min_ts
           FROM reconciled_trades
           GROUP BY out_mint
         ) earliest
         WHERE pt.mint = earliest.out_mint
         AND pt.entry_time > earliest.min_ts`
      );
      updated = (result as any).rowCount || 0;
    }
  } catch (err) {
    console.log('Entry time backfill skipped - reconciled_trades table not available yet');
  }
  return updated;
}

export async function backfillPositionTrackingFromLots(): Promise<{ created: number; mints: string[] }> {
  const createdMints: string[] = [];
  try {
    const openLots = await q<{ 
      mint: string; 
      total_qty: number; 
      avg_cost: number;
      min_entry: Date;
    }>(
      `SELECT 
         mint,
         SUM(remaining_qty) as total_qty,
         SUM(remaining_qty * unit_cost_usd) / NULLIF(SUM(remaining_qty), 0) as avg_cost,
         MIN(entry_timestamp) as min_entry
       FROM position_lots
       WHERE is_closed = false AND remaining_qty > 0
       GROUP BY mint
       HAVING SUM(remaining_qty) > 0`
    );
    
    const existingTracking = await q<{ mint: string }>(`SELECT mint FROM position_tracking`);
    const existingMints = new Set(existingTracking.map(t => t.mint));
    
    const now = new Date().toISOString();
    
    for (const lot of openLots) {
      if (existingMints.has(lot.mint)) continue;
      
      const entryTime = lot.min_entry ? new Date(lot.min_entry).toISOString() : now;
      const entryPrice = lot.avg_cost || 0;
      
      if (entryPrice <= 0 || lot.total_qty <= 0) continue;
      
      await q(
        `INSERT INTO position_tracking 
         (mint, entry_time, entry_price, peak_price, peak_time, last_price, last_update, total_tokens, slot_type, source, peak_pnl_pct)
         VALUES ($1, $2, $3, $3, $4, $3, $4, $5, 'scout', 'backfill', 0)
         ON CONFLICT (mint) DO NOTHING`,
        [lot.mint, entryTime, entryPrice, now, lot.total_qty]
      );
      
      createdMints.push(lot.mint);
    }
    
    if (createdMints.length > 0) {
      console.warn(`BACKFILL_WARNING: Created ${createdMints.length} position_tracking entries from position_lots. All defaulted to slot_type='scout'. Core positions may need reclassification.`);
    } else {
      console.log('Position tracking backfill: no missing entries found');
    }
  } catch (err) {
    console.error('Position tracking backfill failed:', err);
  }
  
  return { created: createdMints.length, mints: createdMints };
}

export async function ensurePositionTrackingHealth(): Promise<{ openCount: number; trackedCount: number; missingCount: number; createdMints: string[] }> {
  const createdMints: string[] = [];
  try {
    const openMintRows = await q<{ mint: string }>(
      `SELECT DISTINCT mint FROM position_lots WHERE is_closed = false`
    );
    const openMints = new Set(openMintRows.map(r => r.mint));
    
    const trackedMintRows = await q<{ mint: string }>(
      `SELECT DISTINCT mint FROM position_tracking`
    );
    const trackedMints = new Set(trackedMintRows.map(r => r.mint));
    
    const missingMints: string[] = [];
    for (const mint of openMints) {
      if (!trackedMints.has(mint)) {
        missingMints.push(mint);
      }
    }
    
    const now = new Date().toISOString();
    
    for (const mint of missingMints) {
      const lotData = await q<{ 
        total_qty: number; 
        weighted_cost: number;
        min_entry: Date;
      }>(
        `SELECT 
           SUM(remaining_qty) as total_qty,
           SUM(remaining_qty * unit_cost_usd) as weighted_cost,
           MIN(entry_timestamp) as min_entry
         FROM position_lots
         WHERE mint = $1 AND is_closed = false AND remaining_qty > 0`,
        [mint]
      );
      
      const data = lotData[0];
      if (!data || !data.total_qty || data.total_qty <= 0) continue;
      
      const entryPrice = data.weighted_cost / data.total_qty;
      if (entryPrice <= 0) continue;
      
      const entryTime = data.min_entry ? new Date(data.min_entry).toISOString() : now;
      
      await q(
        `INSERT INTO position_tracking 
         (mint, entry_time, entry_price, peak_price, peak_time, last_price, last_update, total_tokens, slot_type, source, peak_pnl_pct)
         VALUES ($1, $2, $3, $3, $4, $3, $4, $5, 'scout', 'health_backfill', 0)
         ON CONFLICT (mint) DO NOTHING`,
        [mint, entryTime, entryPrice, now, data.total_qty]
      );
      
      createdMints.push(mint);
    }
    
    logger.info({
      openCount: openMints.size,
      trackedCount: trackedMints.size,
      missingCount: missingMints.length,
      created: createdMints.length,
      createdMints: createdMints.slice(0, 10),
    }, "TRACKING_BACKFILL: Position tracking health check completed");
    
    return {
      openCount: openMints.size,
      trackedCount: trackedMints.size,
      missingCount: missingMints.length,
      createdMints,
    };
  } catch (err) {
    logger.error({ error: String(err) }, "TRACKING_BACKFILL: Health check failed");
    return { openCount: 0, trackedCount: 0, missingCount: 0, createdMints: [] };
  }
}

export async function updatePositionPrice(mint: string, currentPrice: number): Promise<void> {
  const now = new Date().toISOString();
  await q(
    `UPDATE position_tracking SET
       last_price = $2,
       last_update = $3,
       peak_price = GREATEST(peak_price, $2),
       peak_time = CASE WHEN $2 > peak_price THEN $3 ELSE peak_time END,
       peak_pnl_pct = GREATEST(
         COALESCE(peak_pnl_pct, 0),
         CASE WHEN entry_price > 0 THEN (($2 - entry_price) / entry_price) * 100 ELSE 0 END
       )
     WHERE mint = $1`,
    [mint, currentPrice, now]
  );
}

export async function getPositionTracking(mint: string): Promise<PositionTrackingRow | null> {
  const rows = await q<PositionTrackingRow>(
    `SELECT * FROM position_tracking WHERE mint = $1`,
    [mint]
  );
  return rows[0] ?? null;
}

export async function getAllPositionTracking(): Promise<PositionTrackingRow[]> {
  return await q<PositionTrackingRow>(`SELECT * FROM position_tracking ORDER BY entry_time`);
}

export async function deletePositionTracking(mint: string): Promise<void> {
  await q(`DELETE FROM position_tracking WHERE mint = $1`, [mint]);
}

export async function updatePositionSlotType(
  mint: string, 
  slotType: SlotType,
  options?: { resetPeakToPrice?: number }
): Promise<void> {
  if (options?.resetPeakToPrice !== undefined && options.resetPeakToPrice > 0) {
    await q(
      `UPDATE position_tracking 
       SET slot_type = $2, 
           promotion_count = promotion_count + 1,
           peak_price = $3,
           peak_time = NOW()
       WHERE mint = $1`,
      [mint, slotType, options.resetPeakToPrice]
    );
  } else {
    await q(
      `UPDATE position_tracking SET slot_type = $2, promotion_count = promotion_count + 1 WHERE mint = $1`,
      [mint, slotType]
    );
  }
}

export async function getSlotCounts(): Promise<{ core: number; scout: number }> {
  const rows = await q<{ slot_type: string; count: string }>(
    `SELECT slot_type, COUNT(*) as count FROM position_tracking WHERE COALESCE(source, 'bot') != 'sniper' GROUP BY slot_type`
  );
  const result = { core: 0, scout: 0 };
  for (const row of rows) {
    if (row.slot_type === 'core') result.core = parseInt(row.count, 10);
    else if (row.slot_type === 'scout') result.scout = parseInt(row.count, 10);
  }
  return result;
}

export async function insertRotationLog(row: {
  action: string;
  soldMint?: string;
  soldSymbol?: string;
  boughtMint?: string;
  boughtSymbol?: string;
  reasonCode: string;
  soldRank?: number;
  boughtRank?: number;
  rankDelta?: number;
  meta?: any;
}): Promise<void> {
  await q(
    `INSERT INTO rotation_log (action, sold_mint, sold_symbol, bought_mint, bought_symbol, reason_code, sold_rank, bought_rank, rank_delta, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      row.action,
      row.soldMint ?? null,
      row.soldSymbol ?? null,
      row.boughtMint ?? null,
      row.boughtSymbol ?? null,
      row.reasonCode,
      row.soldRank ?? null,
      row.boughtRank ?? null,
      row.rankDelta ?? null,
      row.meta ?? {},
    ]
  );
}

export async function getRecentRotations(limit = 50): Promise<any[]> {
  return await q(`SELECT * FROM rotation_log ORDER BY ts DESC LIMIT $1`, [limit]);
}

export async function getRotationStats(startDate?: Date): Promise<{
  totalRotations: number;
  staleExits: number;
  trailingStops: number;
  opportunityCostSwaps: number;
  promotions: number;
}> {
  const whereClause = startDate ? `WHERE ts >= $1` : '';
  const params = startDate ? [startDate.toISOString()] : [];
  
  const rows = await q<{ reason_code: string; count: string }>(
    `SELECT reason_code, COUNT(*) as count FROM rotation_log ${whereClause} GROUP BY reason_code`,
    params
  );
  
  const stats = {
    totalRotations: 0,
    staleExits: 0,
    trailingStops: 0,
    opportunityCostSwaps: 0,
    promotions: 0,
  };
  
  for (const row of rows) {
    const count = parseInt(row.count, 10);
    stats.totalRotations += count;
    if (row.reason_code.includes('stale')) stats.staleExits += count;
    else if (row.reason_code.includes('trailing')) stats.trailingStops += count;
    else if (row.reason_code.includes('opportunity') || row.reason_code.includes('rotation')) stats.opportunityCostSwaps += count;
    else if (row.reason_code.includes('promotion')) stats.promotions += count;
  }
  
  return stats;
}

export async function loadTradingUniverseWithSlots(): Promise<{ 
  mint: string; 
  symbol: string; 
  name: string | null; 
  source: string | null; 
  added_at: Date;
  slot_type: SlotType;
}[]> {
  return await q(`SELECT mint, symbol, name, source, added_at, COALESCE(slot_type, 'scout') as slot_type FROM trading_universe WHERE active = true ORDER BY added_at`);
}

export async function updateUniverseSlotType(mint: string, slotType: SlotType): Promise<boolean> {
  try {
    await q(`UPDATE trading_universe SET slot_type = $2 WHERE mint = $1`, [mint, slotType]);
    return true;
  } catch {
    return false;
  }
}

export interface RuntimeStatusRow {
  id: string;
  manual_pause: boolean;
  execution_mode: string;
  last_heartbeat: Date;
  last_transition_at: Date;
  last_transition_by: string | null;
  instance_id: string | null;
}

export async function getRuntimeStatus(): Promise<RuntimeStatusRow | null> {
  const rows = await q<RuntimeStatusRow>(`SELECT * FROM bot_runtime_status WHERE id = 'global'`);
  return rows[0] ?? null;
}

export async function updateHeartbeat(instanceId: string): Promise<void> {
  await q(
    `INSERT INTO bot_runtime_status (id, last_heartbeat, instance_id)
     VALUES ('global', NOW(), $1)
     ON CONFLICT (id) DO UPDATE SET last_heartbeat = NOW(), instance_id = $1`,
    [instanceId]
  );
}

export async function setPauseState(paused: boolean, reason?: string): Promise<void> {
  await q(
    `UPDATE bot_runtime_status SET 
       manual_pause = $1, 
       last_transition_at = NOW(), 
       last_transition_by = $2
     WHERE id = 'global'`,
    [paused, reason ?? (paused ? 'manual_pause' : 'resume')]
  );
}

export async function initRuntimeStatusRow(): Promise<void> {
  await q(
    `INSERT INTO bot_runtime_status (id) VALUES ('global') ON CONFLICT (id) DO NOTHING`
  );
}

export interface ScoutQueueItem {
  id?: number;
  mint: string;
  symbol?: string;
  name?: string;
  score: number;
  reasons?: any;
  discovered_at?: Date;
  queued_at?: Date;
  status?: string;
  last_error?: string;
  cooldown_until?: Date;
  buy_attempts?: number;
  warmup_attempts?: number;
  tx_sig?: string;
  spend_sol?: number;
  in_progress_at?: Date;
  next_attempt_at?: Date;
  last_attempt_at?: Date;
  created_at?: Date;
  updated_at?: Date;
}

export interface InsertQueueResult {
  inserted: boolean;
  refreshed: boolean;
  existing?: {
    status: string;
    ageMin: number;
    inProgressAgeMin: number | null;
    attempts: number;
    nextAttemptAt: Date | null;
  };
}

export async function insertScoutQueueItem(item: {
  mint: string;
  symbol?: string;
  name?: string;
  score: number;
  reasons?: any;
  spendSol?: number;
}): Promise<InsertQueueResult> {
  try {
    const existing = await q<{ 
      status: string; 
      queued_at: Date; 
      created_at: Date;
      in_progress_at: Date | null;
      next_attempt_at: Date | null;
      buy_attempts: number;
    }>(
      `SELECT status, queued_at, created_at, in_progress_at, next_attempt_at, buy_attempts 
       FROM scout_queue WHERE mint = $1`,
      [item.mint]
    );
    
    if (existing.length === 0) {
      await q(
        `INSERT INTO scout_queue (mint, symbol, name, score, reasons, spend_sol, status, queued_at, warmup_attempts)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW(), 0)`,
        [item.mint, item.symbol ?? null, item.name ?? null, item.score, 
         item.reasons ? JSON.stringify(item.reasons) : null, item.spendSol ?? null]
      );
      return { inserted: true, refreshed: false };
    }
    
    const row = existing[0];
    const queuedAgeMinutes = row.queued_at 
      ? (Date.now() - new Date(row.queued_at).getTime()) / 60000 
      : (Date.now() - new Date(row.created_at).getTime()) / 60000;
    const inProgressAgeMinutes = row.in_progress_at 
      ? (Date.now() - new Date(row.in_progress_at).getTime()) / 60000 
      : null;
    
    const existingDetails = {
      status: row.status,
      ageMin: Math.round(queuedAgeMinutes * 10) / 10,
      inProgressAgeMin: inProgressAgeMinutes !== null ? Math.round(inProgressAgeMinutes * 10) / 10 : null,
      attempts: row.buy_attempts ?? 0,
      nextAttemptAt: row.next_attempt_at,
    };
    
    const shouldRefresh = 
      ['SKIPPED', 'FAILED', 'EXPIRED', 'BOUGHT', 'DONE'].includes(row.status) ||
      (row.status === 'PENDING' && queuedAgeMinutes > 15) ||
      (row.status === 'IN_PROGRESS' && (inProgressAgeMinutes ?? 0) > 10);
    
    if (shouldRefresh) {
      await q(
        `UPDATE scout_queue SET 
           score = $2, reasons = $3, status = 'PENDING', 
           queued_at = NOW(), in_progress_at = NULL, next_attempt_at = NULL,
           buy_attempts = 0, warmup_attempts = 0, last_error = NULL, updated_at = NOW()
         WHERE mint = $1`,
        [item.mint, item.score, item.reasons ? JSON.stringify(item.reasons) : null]
      );
      return { inserted: false, refreshed: true };
    }
    
    return { inserted: false, refreshed: false, existing: existingDetails };
  } catch {
    return { inserted: false, refreshed: false };
  }
}

export async function getNextQueuedScout(): Promise<ScoutQueueItem | null> {
  const rows = await q<ScoutQueueItem>(
    `SELECT * FROM scout_queue 
     WHERE status = 'PENDING' 
       AND (cooldown_until IS NULL OR cooldown_until < NOW())
       AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
     ORDER BY queued_at ASC 
     LIMIT 1`
  );
  return rows[0] ?? null;
}

export async function updateScoutQueueStatus(
  mint: string,
  status: string,
  error?: string,
  txSig?: string
): Promise<void> {
  await q(
    `UPDATE scout_queue SET 
       status = $2, 
       last_error = $3,
       tx_sig = $4,
       in_progress_at = CASE WHEN $2 IN ('DONE', 'SKIPPED', 'FAILED', 'BOUGHT') THEN NULL ELSE in_progress_at END,
       updated_at = NOW()
     WHERE mint = $1`,
    [mint, status, error ?? null, txSig ?? null]
  );
}

export async function incrementBuyAttempts(mint: string): Promise<void> {
  await q(
    `UPDATE scout_queue SET buy_attempts = buy_attempts + 1, updated_at = NOW() WHERE mint = $1`,
    [mint]
  );
}

export async function rescheduleScoutQueueItem(
  mint: string,
  error: string,
  backoffMinutes: number = 5,
  isWarmup: boolean = false
): Promise<Date> {
  const nextAttemptAt = new Date(Date.now() + backoffMinutes * 60 * 1000);
  if (isWarmup) {
    await q(
      `UPDATE scout_queue SET 
         status = 'PENDING',
         last_error = $2,
         next_attempt_at = $3,
         warmup_attempts = COALESCE(warmup_attempts, 0) + 1,
         in_progress_at = NULL,
         updated_at = NOW()
       WHERE mint = $1`,
      [mint, error, nextAttemptAt.toISOString()]
    );
  } else {
    await q(
      `UPDATE scout_queue SET 
         status = 'PENDING',
         last_error = $2,
         next_attempt_at = $3,
         in_progress_at = NULL,
         updated_at = NOW()
       WHERE mint = $1`,
      [mint, error, nextAttemptAt.toISOString()]
    );
  }
  return nextAttemptAt;
}

export async function getScoutQueueStats(): Promise<Record<string, number>> {
  const rows = await q<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM scout_queue GROUP BY status`
  );
  const stats: Record<string, number> = {};
  for (const row of rows) {
    stats[row.status] = parseInt(row.count, 10);
  }
  return stats;
}

export async function getQueueHealth(): Promise<{
  total: number;
  byStatus: Record<string, number>;
  oldestPendingAgeMin: number | null;
  oldestInProgressAgeMin: number | null;
}> {
  const stats = await getScoutQueueStats();
  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  
  const oldestPending = await q<{ age_min: number }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - queued_at)) / 60 as age_min 
     FROM scout_queue WHERE status = 'PENDING' 
     ORDER BY queued_at ASC LIMIT 1`
  );
  
  const oldestInProgress = await q<{ age_min: number }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - in_progress_at)) / 60 as age_min 
     FROM scout_queue WHERE status = 'IN_PROGRESS' 
     ORDER BY in_progress_at ASC LIMIT 1`
  );
  
  return {
    total,
    byStatus: stats,
    oldestPendingAgeMin: oldestPending[0]?.age_min ?? null,
    oldestInProgressAgeMin: oldestInProgress[0]?.age_min ?? null,
  };
}

export async function recoverStuckItems(): Promise<{ recoveredInProgress: number; expiredStale: number }> {
  const recovered = await q<{ mint: string }>(
    `UPDATE scout_queue 
     SET status = 'PENDING', in_progress_at = NULL, next_attempt_at = NULL, updated_at = NOW()
     WHERE status = 'IN_PROGRESS' 
       AND in_progress_at < NOW() - INTERVAL '5 minutes'
     RETURNING mint`
  );
  
  const expired = await q<{ mint: string }>(
    `UPDATE scout_queue 
     SET status = 'EXPIRED', updated_at = NOW()
     WHERE status = 'PENDING'
       AND queued_at < NOW() - INTERVAL '60 minutes'
     RETURNING mint`
  );
  
  return { recoveredInProgress: recovered.length, expiredStale: expired.length };
}

export async function claimNextQueuedScout(): Promise<ScoutQueueItem | null> {
  const rows = await q<ScoutQueueItem>(
    `UPDATE scout_queue 
     SET status = 'IN_PROGRESS', 
         in_progress_at = NOW(), 
         last_attempt_at = NOW(),
         updated_at = NOW()
     WHERE id = (
       SELECT id FROM scout_queue 
       WHERE status = 'PENDING' 
         AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
         AND (cooldown_until IS NULL OR cooldown_until < NOW())
       ORDER BY queued_at ASC 
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`
  );
  return rows[0] ?? null;
}

export async function countTodayScoutEntries(): Promise<number> {
  const todayStart = getCSTMidnightToday();
  const rows = await q<{ count: string }>(
    `SELECT COUNT(*) as count FROM scout_queue 
     WHERE status = 'BOUGHT' AND updated_at >= $1`,
    [todayStart.toISOString()]
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}

export async function isScoutOnCooldown(mint: string): Promise<boolean> {
  const rows = await q<{ on_cooldown: boolean }>(
    `SELECT (cooldown_until IS NOT NULL AND cooldown_until > NOW()) as on_cooldown
     FROM scout_queue WHERE mint = $1`,
    [mint]
  );
  return rows[0]?.on_cooldown ?? false;
}

export async function getMintsOnCooldown(): Promise<Set<string>> {
  const rows = await q<{ mint: string }>(
    `SELECT mint FROM scout_queue 
     WHERE cooldown_until IS NOT NULL AND cooldown_until > NOW()`
  );
  return new Set(rows.map(r => r.mint));
}

export async function setScoutCooldown(mint: string, hours: number): Promise<void> {
  await q(
    `UPDATE scout_queue SET 
       cooldown_until = NOW() + INTERVAL '1 hour' * $2,
       updated_at = NOW()
     WHERE mint = $1`,
    [mint, hours]
  );
}

export async function getScoutQueue(): Promise<ScoutQueueItem[]> {
  return await q<ScoutQueueItem>(
    `SELECT * FROM scout_queue ORDER BY score DESC, queued_at ASC`
  );
}

export async function updateDustSince(mint: string, isDust: boolean): Promise<void> {
  if (isDust) {
    await q(
      `UPDATE position_tracking 
       SET dust_since = COALESCE(dust_since, NOW())
       WHERE mint = $1`,
      [mint]
    );
  } else {
    await q(
      `UPDATE position_tracking SET dust_since = NULL WHERE mint = $1`,
      [mint]
    );
  }
}

export async function getDustPositionsForCleanup(thresholdHours: number = 24): Promise<{ mint: string; dust_since: Date }[]> {
  return await q<{ mint: string; dust_since: Date }>(
    `SELECT mint, dust_since FROM position_tracking 
     WHERE dust_since IS NOT NULL 
       AND dust_since < NOW() - INTERVAL '1 hour' * $1`,
    [thresholdHours]
  );
}

export async function removePositionTracking(mint: string): Promise<void> {
  await q(`DELETE FROM position_tracking WHERE mint = $1`, [mint]);
}

export type DecisionActionType = 'enter' | 'add' | 'trim' | 'exit' | 'rebalance';

export interface PositionDecision {
  mint: string;
  symbol?: string;
  actionType: DecisionActionType;
  reasonCode: string;
  reasonDetail?: string;
  triggeredBy?: string;
  txSig?: string;
  qtyBefore?: number;
  qtyAfter?: number;
  qtyDelta?: number;
  usdValueBefore?: number;
  usdValueAfter?: number;
  targetPctBefore?: number;
  targetPctAfter?: number;
  confidenceScore?: number;
  ticksObserved?: number;
  signalSnapshot?: any;
  journeyId?: string;
}

export async function logDecision(decision: PositionDecision): Promise<string> {
  const rows = await q<{ decision_id: string }>(
    `INSERT INTO position_decisions (
      mint, symbol, action_type, reason_code, reason_detail, triggered_by, tx_sig,
      qty_before, qty_after, qty_delta, usd_value_before, usd_value_after,
      target_pct_before, target_pct_after, confidence_score, ticks_observed,
      signal_snapshot, journey_id
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING decision_id`,
    [
      decision.mint,
      decision.symbol ?? null,
      decision.actionType,
      decision.reasonCode,
      decision.reasonDetail ?? null,
      decision.triggeredBy ?? null,
      decision.txSig ?? null,
      decision.qtyBefore ?? null,
      decision.qtyAfter ?? null,
      decision.qtyDelta ?? null,
      decision.usdValueBefore ?? null,
      decision.usdValueAfter ?? null,
      decision.targetPctBefore ?? null,
      decision.targetPctAfter ?? null,
      decision.confidenceScore ?? null,
      decision.ticksObserved ?? null,
      decision.signalSnapshot ? JSON.stringify(decision.signalSnapshot) : null,
      decision.journeyId ?? null,
    ]
  );
  return rows[0]?.decision_id ?? '';
}

export async function updateTradeLotDecisionId(txSig: string, decisionId: string): Promise<void> {
  await q(
    `UPDATE trade_lots SET decision_id = $2 WHERE tx_sig = $1`,
    [txSig, decisionId]
  );
}

export async function getPositionDecisions(mint?: string, limit = 100): Promise<any[]> {
  if (mint) {
    return await q(
      `SELECT * FROM position_decisions WHERE mint = $1 ORDER BY ts DESC LIMIT $2`,
      [mint, limit]
    );
  }
  return await q(
    `SELECT * FROM position_decisions ORDER BY ts DESC LIMIT $1`,
    [limit]
  );
}

export async function getDecisionsByJourney(journeyId: string): Promise<any[]> {
  return await q(
    `SELECT * FROM position_decisions WHERE journey_id = $1 ORDER BY ts ASC`,
    [journeyId]
  );
}

export async function getSellsWithoutDecisions(hours = 24): Promise<any[]> {
  return await q(
    `SELECT tl.* FROM trade_lots tl 
     LEFT JOIN position_decisions pd ON tl.decision_id = pd.decision_id
     WHERE tl.side = 'sell' 
       AND tl.timestamp > NOW() - INTERVAL '1 hour' * $1
       AND pd.decision_id IS NULL
     ORDER BY tl.timestamp DESC`,
    [hours]
  );
}

export async function getPromotionsWithoutExits(hours = 48): Promise<any[]> {
  return await q(
    `SELECT pd_promo.* 
     FROM position_decisions pd_promo
     WHERE pd_promo.action_type = 'enter' 
       AND pd_promo.reason_code LIKE '%promotion%'
       AND pd_promo.ts > NOW() - INTERVAL '1 hour' * $1
       AND NOT EXISTS (
         SELECT 1 FROM position_decisions pd_exit 
         WHERE pd_exit.mint = pd_promo.mint 
           AND pd_exit.action_type = 'exit'
           AND pd_exit.ts > pd_promo.ts
       )
       AND NOT EXISTS (
         SELECT 1 FROM position_tracking pt 
         WHERE pt.mint = pd_promo.mint
       )
     ORDER BY pd_promo.ts DESC`,
    [hours]
  );
}

export async function getTradesWithNullSource(hours = 24): Promise<any[]> {
  return await q(
    `SELECT * FROM trade_lots 
     WHERE source IS NULL 
       AND timestamp > NOW() - INTERVAL '1 hour' * $1
     ORDER BY timestamp DESC`,
    [hours]
  );
}

export interface RemainingExposure {
  mint: string;
  remainingQty: number;
  remainingUsd: number;
  lotCount: number;
}

export async function getRemainingExposure(mint: string, currentPriceUsd?: number): Promise<RemainingExposure> {
  const rows = await q<{ total_remaining: string; lot_count: string }>(
    `SELECT COALESCE(SUM(remaining_qty), 0) as total_remaining,
            COUNT(*) as lot_count
     FROM position_lots 
     WHERE mint = $1 AND is_closed = false AND remaining_qty > 0`,
    [mint]
  );
  
  const remainingQty = parseFloat(rows[0]?.total_remaining ?? '0');
  const lotCount = parseInt(rows[0]?.lot_count ?? '0', 10);
  
  let remainingUsd = 0;
  if (currentPriceUsd && currentPriceUsd > 0) {
    remainingUsd = remainingQty * currentPriceUsd;
  } else {
    const priceRows = await q<{ usd_price: string }>(
      `SELECT usd_price FROM prices WHERE mint = $1 ORDER BY ts DESC LIMIT 1`,
      [mint]
    );
    const price = parseFloat(priceRows[0]?.usd_price ?? '0');
    remainingUsd = remainingQty * price;
  }
  
  return { mint, remainingQty, remainingUsd, lotCount };
}

export interface PartialExitEvent {
  mint: string;
  symbol?: string;
  remainingQty: number;
  remainingUsd: number;
  parentReasonCode: string;
  retriesUsed: number;
  lastTradeTxSig?: string;
  notes?: string;
}

export async function insertPartialExitEvent(event: PartialExitEvent): Promise<string> {
  const rows = await q<{ event_id: string }>(
    `INSERT INTO pnl_events (
      mint, symbol, event_type, quantity, proceeds_usd, cost_basis_usd, realized_pnl_usd, notes
    ) VALUES ($1, $2, 'partial_exit_remaining', $3, 0, 0, 0, $4)
    RETURNING event_id`,
    [
      event.mint,
      event.symbol ?? null,
      event.remainingQty,
      JSON.stringify({
        parentReasonCode: event.parentReasonCode,
        retriesUsed: event.retriesUsed,
        remainingUsd: event.remainingUsd,
        lastTradeTxSig: event.lastTradeTxSig,
        notes: event.notes,
      }),
    ]
  );
  return rows[0]?.event_id ?? '';
}

// ============================================================================
// WATCH CANDIDATES - tracks tokens that failed INSUFFICIENT_BARS for re-evaluation
// ============================================================================

export interface WatchCandidate {
  mint: string;
  symbol: string | null;
  first_seen_ts: Date;
  last_seen_ts: Date;
  last_bar_count: number;
  created_at: Date;
}

export async function upsertWatchCandidate(mint: string, symbol: string, barCount: number): Promise<boolean> {
  try {
    await q(
      `INSERT INTO watch_candidates (mint, symbol, first_seen_ts, last_seen_ts, last_bar_count, created_at)
       VALUES ($1, $2, NOW(), NOW(), $3, NOW())
       ON CONFLICT (mint) DO UPDATE SET
         symbol = COALESCE($2, watch_candidates.symbol),
         last_seen_ts = NOW(),
         last_bar_count = $3`,
      [mint, symbol, barCount]
    );
    return true;
  } catch (e) {
    logger.error({ error: String(e), mint, symbol, barCount }, "UPSERT_WATCH_CANDIDATE_ERROR");
    return false;
  }
}

export async function getWatchCandidates(): Promise<WatchCandidate[]> {
  return await q<WatchCandidate>(
    `SELECT mint, symbol, first_seen_ts, last_seen_ts, last_bar_count, created_at 
     FROM watch_candidates 
     ORDER BY first_seen_ts ASC`
  );
}

export async function getWatchCandidateAge(mint: string): Promise<number | null> {
  const rows = await q<{ age_minutes: number }>(
    `SELECT EXTRACT(EPOCH FROM (NOW() - first_seen_ts)) / 60 as age_minutes 
     FROM watch_candidates 
     WHERE mint = $1`,
    [mint]
  );
  return rows[0]?.age_minutes ?? null;
}

export async function removeWatchCandidate(mint: string): Promise<boolean> {
  try {
    await q(`DELETE FROM watch_candidates WHERE mint = $1`, [mint]);
    return true;
  } catch (e) {
    logger.error({ error: String(e), mint }, "REMOVE_WATCH_CANDIDATE_ERROR");
    return false;
  }
}

export async function cleanupOldWatchCandidates(maxAgeMinutes: number): Promise<number> {
  try {
    const result = await q<{ count: number }>(
      `WITH deleted AS (
         DELETE FROM watch_candidates 
         WHERE first_seen_ts < NOW() - INTERVAL '1 minute' * $1
         RETURNING 1
       ) SELECT COUNT(*)::int as count FROM deleted`,
      [maxAgeMinutes]
    );
    return result[0]?.count ?? 0;
  } catch (e) {
    logger.error({ error: String(e), maxAgeMinutes }, "CLEANUP_WATCH_CANDIDATES_ERROR");
    return 0;
  }
}

export async function getOpenLotMints(): Promise<Set<string>> {
  const rows = await q<{ mint: string }>(
    `SELECT DISTINCT mint FROM position_lots WHERE is_closed = false`
  );
  return new Set(rows.map(r => r.mint));
}

export async function getQueuedScoutMints(): Promise<Set<string>> {
  const rows = await q<{ mint: string }>(
    `SELECT mint FROM scout_queue WHERE status IN ('PENDING', 'IN_PROGRESS')`
  );
  return new Set(rows.map(r => r.mint));
}
