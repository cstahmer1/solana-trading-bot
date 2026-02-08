import archiver from "archiver";
import { Writable, PassThrough } from "stream";
import { execSync } from "child_process";
import { q } from "../bot/db.js";
import { getConfig } from "../bot/runtime_config.js";
import { logger } from "../utils/logger.js";

const PAGE_SIZE = 5000;

interface DateRange {
  start: Date;
  end: Date;
}

interface CursorColumnConfig {
  tsColumn: string;
  idColumn: string | null;
}

const CURSOR_CONFIG: Record<string, CursorColumnConfig> = {
  equity_snapshots: { tsColumn: "ts", idColumn: null },
  bot_trades: { tsColumn: "ts", idColumn: "id" },
  trade_lots: { tsColumn: "timestamp", idColumn: "id" },
  pnl_events: { tsColumn: "timestamp", idColumn: "id" },
  rotation_log: { tsColumn: "ts", idColumn: "id" },
  position_lots: { tsColumn: "entry_timestamp", idColumn: "id" },
};

interface Cursor {
  ts: string;
  id: number | null;
}

async function* paginatedQueryWithConfig<T>(
  tableName: string,
  dateRange: DateRange,
  selectColumns: string = "*",
  whereClause: string = "",
  pageSize: number = PAGE_SIZE
): AsyncGenerator<T> {
  const config = CURSOR_CONFIG[tableName];
  if (!config) {
    throw new Error(`No cursor config for table: ${tableName}`);
  }

  const { tsColumn, idColumn } = config;
  let cursor: Cursor | null = null;
  let hasMore = true;

  while (hasMore) {
    let query: string;
    let params: any[];

    if (idColumn) {
      if (cursor && cursor.id !== null) {
        query = `
          SELECT ${selectColumns} FROM ${tableName}
          WHERE ${tsColumn} >= $1 AND ${tsColumn} <= $2
            AND (${tsColumn}, ${idColumn}) > ($3, $4)
            ${whereClause ? `AND ${whereClause}` : ""}
          ORDER BY ${tsColumn}, ${idColumn}
          LIMIT $5
        `;
        params = [dateRange.start.toISOString(), dateRange.end.toISOString(), cursor.ts, cursor.id, pageSize];
      } else {
        query = `
          SELECT ${selectColumns} FROM ${tableName}
          WHERE ${tsColumn} >= $1 AND ${tsColumn} <= $2
            ${whereClause ? `AND ${whereClause}` : ""}
          ORDER BY ${tsColumn}, ${idColumn}
          LIMIT $3
        `;
        params = [dateRange.start.toISOString(), dateRange.end.toISOString(), pageSize];
      }
    } else {
      if (cursor) {
        query = `
          SELECT ${selectColumns} FROM ${tableName}
          WHERE ${tsColumn} >= $1 AND ${tsColumn} <= $2 AND ${tsColumn} > $3
            ${whereClause ? `AND ${whereClause}` : ""}
          ORDER BY ${tsColumn}
          LIMIT $4
        `;
        params = [dateRange.start.toISOString(), dateRange.end.toISOString(), cursor.ts, pageSize];
      } else {
        query = `
          SELECT ${selectColumns} FROM ${tableName}
          WHERE ${tsColumn} >= $1 AND ${tsColumn} <= $2
            ${whereClause ? `AND ${whereClause}` : ""}
          ORDER BY ${tsColumn}
          LIMIT $3
        `;
        params = [dateRange.start.toISOString(), dateRange.end.toISOString(), pageSize];
      }
    }

    const rows = await q<T & Record<string, any>>(query, params);

    if (rows.length === 0) {
      hasMore = false;
    } else {
      for (const row of rows) {
        yield row as T;
      }
      const lastRow = rows[rows.length - 1];
      cursor = {
        ts: new Date(lastRow[tsColumn]).toISOString(),
        id: idColumn ? lastRow[idColumn] : null,
      };
      hasMore = rows.length === pageSize;
    }
  }
}

interface EquityRow {
  ts: Date;
  total_usd: number;
  total_sol_equiv: number;
  breakdown: any;
}

interface TradeLotRow {
  id: number;
  lot_id: string;
  tx_sig: string;
  timestamp: Date;
  ts?: Date;
  slot: number;
  mint: string;
  side: string;
  quantity: number;
  usd_value: number;
  unit_price_usd: number;
  sol_price_usd: number;
  fee_usd: number;
  source: string;
  status: string;
}

interface PnlEventRow {
  id: number;
  event_id: string;
  timestamp: Date;
  ts?: Date;
  mint: string;
  symbol: string;
  event_type: string;
  quantity: number;
  proceeds_usd: number;
  cost_basis_usd: number;
  realized_pnl_usd: number;
  fee_usd: number;
  sell_lot_id: string;
  buy_lot_id: string;
}

interface BotTradeRow {
  id: number;
  ts: Date;
  tx_sig: string;
  reason_code: string;
  status: string;
  price_impact_pct: string;
  slippage_bps: number;
  fees_lamports: number;
  priority_fee_lamports: number;
  liquidity_usd: number;
  input_mint: string;
  output_mint: string;
  in_amount: string;
  out_amount: string;
}

interface RotationLogRow {
  id: number;
  ts: Date;
  action: string;
  sold_mint: string;
  bought_mint: string;
  reason_code: string;
  meta: any;
}

interface PositionLotRow {
  id: number;
  lot_id: string;
  mint: string;
  original_qty: number;
  remaining_qty: number;
  cost_basis_usd: number;
  unit_cost_usd: number;
  entry_timestamp: Date;
  is_closed: boolean;
}

interface FileRowCounts {
  [fileName: string]: { rowCount: number };
}

async function streamNdjsonToArchive(
  archive: archiver.Archiver,
  fileName: string,
  generator: AsyncGenerator<any>
): Promise<number> {
  const passThrough = new PassThrough();
  archive.append(passThrough, { name: fileName });

  let count = 0;
  for await (const row of generator) {
    passThrough.write(JSON.stringify(row) + "\n");
    count++;
  }
  passThrough.end();
  return count;
}

async function streamArrayToArchive(
  archive: archiver.Archiver,
  fileName: string,
  data: any[]
): Promise<number> {
  const content = data.map((row) => JSON.stringify(row)).join("\n");
  archive.append(content + (data.length > 0 ? "\n" : ""), { name: fileName });
  return data.length;
}

async function appendJsonToArchive(
  archive: archiver.Archiver,
  fileName: string,
  data: any
): Promise<number> {
  archive.append(JSON.stringify(data, null, 2), { name: fileName });
  const rowCount = Array.isArray(data) ? data.length : 1;
  return rowCount;
}

function getGitSha(): string | null {
  try {
    if (process.env.GIT_SHA) {
      return process.env.GIT_SHA;
    }
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    return sha || null;
  } catch {
    return null;
  }
}

function getBotVersion(): string {
  try {
    const pkg = require("../../package.json");
    return pkg.version || "1.0.0";
  } catch {
    return "1.0.0";
  }
}

async function* getEquityTimeseries(dateRange: DateRange): AsyncGenerator<any> {
  for await (const row of paginatedQueryWithConfig<EquityRow>("equity_snapshots", dateRange)) {
    const breakdown = typeof row.breakdown === "string" ? JSON.parse(row.breakdown) : row.breakdown;
    const positionCount = breakdown ? Object.keys(breakdown).length : 0;
    const nonSolUsd = breakdown
      ? Object.entries(breakdown)
          .filter(([mint]) => mint !== "So11111111111111111111111111111111111111112")
          .reduce((sum, [, val]: [string, any]) => sum + (val?.usdValue || 0), 0)
      : 0;

    yield {
      ts: new Date(row.ts).toISOString(),
      total_usd: parseFloat(String(row.total_usd)),
      sol_price_usd: null,
      position_count: positionCount,
      non_sol_usd: nonSolUsd,
    };
  }
}

async function* getTradeLots(dateRange: DateRange): AsyncGenerator<any> {
  const selectColumns = "id, tx_sig, timestamp, side, mint, usd_value, sol_price_usd, status";
  for await (const row of paginatedQueryWithConfig<TradeLotRow>("trade_lots", dateRange, selectColumns)) {
    yield {
      timestamp: new Date(row.timestamp).toISOString(),
      tx_sig: row.tx_sig,
      side: row.side,
      mint: row.mint,
      usd_value: parseFloat(String(row.usd_value)),
      sol_price_usd: row.sol_price_usd ? parseFloat(String(row.sol_price_usd)) : null,
      status: row.status,
    };
  }
}

async function* getPnlEvents(dateRange: DateRange): AsyncGenerator<any> {
  const selectColumns = "id, timestamp, event_id, mint, symbol, event_type, proceeds_usd, cost_basis_usd, realized_pnl_usd, sell_lot_id, buy_lot_id";
  for await (const row of paginatedQueryWithConfig<PnlEventRow>("pnl_events", dateRange, selectColumns)) {
    yield {
      timestamp: new Date(row.timestamp).toISOString(),
      tx_sig: row.sell_lot_id || row.buy_lot_id || null,
      mint: row.mint,
      proceeds_usd: parseFloat(String(row.proceeds_usd)),
      cost_basis_usd: parseFloat(String(row.cost_basis_usd)),
      realized_pnl_usd: parseFloat(String(row.realized_pnl_usd)),
      event_type: row.event_type,
    };
  }
}

async function* getBotTrades(dateRange: DateRange): AsyncGenerator<any> {
  for await (const row of paginatedQueryWithConfig<BotTradeRow>("bot_trades", dateRange)) {
    yield {
      ts: new Date(row.ts).toISOString(),
      tx_sig: row.tx_sig,
      reason_code: row.reason_code,
      status: row.status,
      price_impact_pct: row.price_impact_pct ? parseFloat(row.price_impact_pct) : null,
      slippage_bps: row.slippage_bps,
      fees_lamports: row.fees_lamports ? parseInt(String(row.fees_lamports)) : 0,
      priority_fee_lamports: row.priority_fee_lamports ? parseInt(String(row.priority_fee_lamports)) : 0,
      liquidity_usd: row.liquidity_usd ? parseFloat(String(row.liquidity_usd)) : null,
    };
  }
}

async function* getRotationLog(dateRange: DateRange): AsyncGenerator<any> {
  for await (const row of paginatedQueryWithConfig<RotationLogRow>("rotation_log", dateRange)) {
    yield {
      ts: new Date(row.ts).toISOString(),
      mint: row.sold_mint || row.bought_mint,
      reason_code: row.reason_code,
      details: row.meta,
    };
  }
}

async function getOpenPositionLots(): Promise<any[]> {
  const rows = await q<PositionLotRow>(`
    SELECT id, lot_id, mint, original_qty, remaining_qty, cost_basis_usd, unit_cost_usd, entry_timestamp, is_closed
    FROM position_lots
    WHERE is_closed = false OR remaining_qty > 0
    ORDER BY entry_timestamp
  `);

  return rows.map((row) => ({
    lot_id: row.lot_id,
    mint: row.mint,
    original_qty: parseFloat(String(row.original_qty)),
    remaining_qty: parseFloat(String(row.remaining_qty)),
    cost_basis_usd: parseFloat(String(row.cost_basis_usd)),
    unit_cost_usd: parseFloat(String(row.unit_cost_usd)),
    entry_timestamp: new Date(row.entry_timestamp).toISOString(),
    is_closed: row.is_closed,
  }));
}

async function getEndPositions(dateRange: DateRange): Promise<any[]> {
  const rows = await q<{
    mint: string;
    symbol: string;
    total_tokens: number;
    last_price: number;
    slot_type: string;
  }>(`
    SELECT pt.mint, tu.symbol, pt.total_tokens, pt.last_price, pt.slot_type
    FROM position_tracking pt
    LEFT JOIN trading_universe tu ON tu.mint = pt.mint
    WHERE pt.total_tokens > 0
    ORDER BY pt.last_update DESC
  `);

  return rows.map((row) => ({
    mint: row.mint,
    symbol: row.symbol || "UNKNOWN",
    amount: parseFloat(String(row.total_tokens)),
    usdValue: parseFloat(String(row.total_tokens)) * parseFloat(String(row.last_price || 0)),
    slot_type: row.slot_type,
  }));
}

async function computeAggregates(dateRange: DateRange): Promise<any> {
  const config = getConfig();
  
  const startEquityRows = await q<{ total_usd: number; ts: Date }>(`
    SELECT total_usd, ts FROM equity_snapshots
    WHERE ts >= $1 AND ts <= $2
    ORDER BY ts ASC
    LIMIT 1
  `, [dateRange.start.toISOString(), dateRange.end.toISOString()]);

  const endEquityRows = await q<{ total_usd: number; ts: Date }>(`
    SELECT total_usd, ts FROM equity_snapshots
    WHERE ts >= $1 AND ts <= $2
    ORDER BY ts DESC
    LIMIT 1
  `, [dateRange.start.toISOString(), dateRange.end.toISOString()]);

  const startEquity = startEquityRows[0]?.total_usd ? parseFloat(String(startEquityRows[0].total_usd)) : 0;
  const endEquity = endEquityRows[0]?.total_usd ? parseFloat(String(endEquityRows[0].total_usd)) : 0;
  const startTs = startEquityRows[0]?.ts ? new Date(startEquityRows[0].ts) : dateRange.start;
  const endTs = endEquityRows[0]?.ts ? new Date(endEquityRows[0].ts) : dateRange.end;
  const hours = (endTs.getTime() - startTs.getTime()) / (1000 * 60 * 60);
  const pnlUsd = endEquity - startEquity;
  const slopePerHour = hours > 0 ? pnlUsd / hours : 0;

  const maxDrawdownRows = await q<{ max_dd: number }>(`
    WITH equity_series AS (
      SELECT ts, total_usd,
        MAX(total_usd) OVER (ORDER BY ts ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) as peak
      FROM equity_snapshots
      WHERE ts >= $1 AND ts <= $2
    )
    SELECT COALESCE(MIN((total_usd - peak) / NULLIF(peak, 0)), 0) as max_dd
    FROM equity_series
  `, [dateRange.start.toISOString(), dateRange.end.toISOString()]);
  const maxDrawdown = maxDrawdownRows[0]?.max_dd ? parseFloat(String(maxDrawdownRows[0].max_dd)) : 0;

  const reasonCodeStats = await q<{
    reason_code: string;
    count: number;
    total_pnl: number;
    avg_price_impact: number;
    avg_slippage: number;
    wins: number;
  }>(`
    SELECT 
      reason_code,
      COUNT(*)::int as count,
      COALESCE(SUM(pnl_usd), 0) as total_pnl,
      COALESCE(AVG(NULLIF(price_impact_pct::numeric, 0)), 0) as avg_price_impact,
      COALESCE(AVG(slippage_bps), 0) as avg_slippage,
      COUNT(*) FILTER (WHERE pnl_usd > 0)::int as wins
    FROM bot_trades
    WHERE ts >= $1 AND ts <= $2 AND reason_code IS NOT NULL
    GROUP BY reason_code
  `, [dateRange.start.toISOString(), dateRange.end.toISOString()]);

  const byReasonCode: Record<string, any> = {};
  for (const row of reasonCodeStats) {
    byReasonCode[row.reason_code || "unknown"] = {
      count: row.count,
      realized_pnl_usd: parseFloat(String(row.total_pnl)),
      avg_price_impact: parseFloat(String(row.avg_price_impact)),
      avg_slippage_bps: parseFloat(String(row.avg_slippage)),
      winrate: row.count > 0 ? row.wins / row.count : 0,
    };
  }

  const feesSummary = await q<{
    total_fees_lamports: number;
    total_priority_fees_lamports: number;
  }>(`
    SELECT 
      COALESCE(SUM(fees_lamports), 0) as total_fees_lamports,
      COALESCE(SUM(priority_fee_lamports), 0) as total_priority_fees_lamports
    FROM bot_trades
    WHERE ts >= $1 AND ts <= $2
  `, [dateRange.start.toISOString(), dateRange.end.toISOString()]);

  const solPriceRows = await q<{ sol_price_usd: number }>(`
    SELECT sol_price_usd FROM trade_lots
    WHERE timestamp >= $1 AND timestamp <= $2 AND sol_price_usd IS NOT NULL
    ORDER BY timestamp DESC
    LIMIT 1
  `, [dateRange.start.toISOString(), dateRange.end.toISOString()]);
  const solPrice = solPriceRows[0]?.sol_price_usd ? parseFloat(String(solPriceRows[0].sol_price_usd)) : 150;

  const totalFeesLamports = parseInt(String(feesSummary[0]?.total_fees_lamports || 0));
  const totalPriorityFeesLamports = parseInt(String(feesSummary[0]?.total_priority_fees_lamports || 0));
  const totalFeesSol = (totalFeesLamports + totalPriorityFeesLamports) / 1e9;

  const priceImpactStats = await q<{
    p50: number;
    p90: number;
    max_impact: number;
    total_trades: number;
    exceeding_count: number;
  }>(`
    WITH impacts AS (
      SELECT price_impact_pct::numeric as impact
      FROM bot_trades
      WHERE ts >= $1 AND ts <= $2 
        AND price_impact_pct IS NOT NULL 
        AND price_impact_pct != ''
    )
    SELECT 
      COALESCE(PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY impact), 0) as p50,
      COALESCE(PERCENTILE_CONT(0.9) WITHIN GROUP (ORDER BY impact), 0) as p90,
      COALESCE(MAX(impact), 0) as max_impact,
      COUNT(*)::int as total_trades,
      COUNT(*) FILTER (WHERE impact > $3)::int as exceeding_count
    FROM impacts
  `, [dateRange.start.toISOString(), dateRange.end.toISOString(), (config.maxPriceImpactBps || 300) / 100]);

  const priceImpactSummary = {
    p50: parseFloat(String(priceImpactStats[0]?.p50 || 0)),
    p90: parseFloat(String(priceImpactStats[0]?.p90 || 0)),
    max: parseFloat(String(priceImpactStats[0]?.max_impact || 0)),
    trades_exceeding_threshold_pct: priceImpactStats[0]?.total_trades > 0
      ? (priceImpactStats[0].exceeding_count / priceImpactStats[0].total_trades) * 100
      : 0,
  };

  const realizedLosers = await q<{
    mint: string;
    symbol: string;
    total_pnl: number;
    last_seen: Date;
  }>(`
    SELECT 
      pe.mint,
      pe.symbol,
      SUM(pe.realized_pnl_usd) as total_pnl,
      MAX(pe.timestamp) as last_seen
    FROM pnl_events pe
    WHERE pe.timestamp >= $1 AND pe.timestamp <= $2
    GROUP BY pe.mint, pe.symbol
    HAVING SUM(pe.realized_pnl_usd) < 0
    ORDER BY SUM(pe.realized_pnl_usd) ASC
    LIMIT 20
  `, [dateRange.start.toISOString(), dateRange.end.toISOString()]);

  const lastActionsMints = realizedLosers.map(r => r.mint);
  const lastActionsMap: Record<string, string> = {};
  if (lastActionsMints.length > 0) {
    const lastActions = await q<{ mint: string; action: string }>(`
      SELECT DISTINCT ON (mint) mint, reason_code as action
      FROM (
        SELECT input_mint as mint, reason_code, ts FROM bot_trades WHERE input_mint = ANY($1)
        UNION ALL
        SELECT output_mint as mint, reason_code, ts FROM bot_trades WHERE output_mint = ANY($1)
        UNION ALL
        SELECT sold_mint as mint, action as reason_code, ts FROM rotation_log WHERE sold_mint = ANY($1)
        UNION ALL
        SELECT bought_mint as mint, action as reason_code, ts FROM rotation_log WHERE bought_mint = ANY($1)
      ) combined
      ORDER BY mint, ts DESC
    `, [lastActionsMints]);
    for (const la of lastActions) {
      lastActionsMap[la.mint] = la.action;
    }
  }

  const unrealizedLosers = await q<{
    mint: string;
    remaining_qty: number;
    cost_basis_usd: number;
    entry_timestamp: Date;
    last_price: number;
    symbol: string;
  }>(`
    SELECT 
      pl.mint,
      pl.remaining_qty,
      pl.cost_basis_usd,
      pl.entry_timestamp,
      COALESCE(pt.last_price, 0) as last_price,
      COALESCE(tu.symbol, 'UNKNOWN') as symbol
    FROM position_lots pl
    LEFT JOIN position_tracking pt ON pt.mint = pl.mint
    LEFT JOIN trading_universe tu ON tu.mint = pl.mint
    WHERE pl.remaining_qty > 0 AND pl.is_closed = false
    ORDER BY (pl.remaining_qty * COALESCE(pt.last_price, 0) - pl.cost_basis_usd) ASC
    LIMIT 20
  `);

  const unrealizedMints = unrealizedLosers.map(u => u.mint);
  const unrealizedActionsMap: Record<string, string> = {};
  if (unrealizedMints.length > 0) {
    const unrealizedActions = await q<{ mint: string; action: string }>(`
      SELECT DISTINCT ON (mint) mint, reason_code as action
      FROM (
        SELECT input_mint as mint, reason_code, ts FROM bot_trades WHERE input_mint = ANY($1)
        UNION ALL
        SELECT output_mint as mint, reason_code, ts FROM bot_trades WHERE output_mint = ANY($1)
        UNION ALL
        SELECT sold_mint as mint, action as reason_code, ts FROM rotation_log WHERE sold_mint = ANY($1)
        UNION ALL
        SELECT bought_mint as mint, action as reason_code, ts FROM rotation_log WHERE bought_mint = ANY($1)
      ) combined
      ORDER BY mint, ts DESC
    `, [unrealizedMints]);
    for (const ua of unrealizedActions) {
      unrealizedActionsMap[ua.mint] = ua.action;
    }
  }

  const byMintTopLosses = {
    realized_losers: realizedLosers.map(r => ({
      mint: r.mint,
      symbol: r.symbol || "UNKNOWN",
      pnl_usd: parseFloat(String(r.total_pnl)),
      last_seen: new Date(r.last_seen).toISOString(),
      last_action: lastActionsMap[r.mint] || null,
    })),
    unrealized_dust_losers: unrealizedLosers.map(u => {
      const currentValue = parseFloat(String(u.remaining_qty)) * parseFloat(String(u.last_price));
      const unrealizedPnl = currentValue - parseFloat(String(u.cost_basis_usd));
      return {
        mint: u.mint,
        symbol: u.symbol,
        pnl_usd: unrealizedPnl,
        last_seen: new Date(u.entry_timestamp).toISOString(),
        last_action: unrealizedActionsMap[u.mint] || null,
      };
    }).filter(u => u.pnl_usd < 0),
  };

  const walletNoLots = await q<{ mint: string; symbol: string; total_tokens: number; last_price: number }>(`
    SELECT pt.mint, tu.symbol, pt.total_tokens, pt.last_price
    FROM position_tracking pt
    LEFT JOIN trading_universe tu ON tu.mint = pt.mint
    WHERE pt.total_tokens > 0
      AND NOT EXISTS (
        SELECT 1 FROM position_lots pl 
        WHERE pl.mint = pt.mint AND pl.remaining_qty > 0 AND pl.is_closed = false
      )
  `);

  const lotsNoWallet = await q<{ mint: string; lot_id: string; remaining_qty: number; cost_basis_usd: number }>(`
    SELECT pl.mint, pl.lot_id, pl.remaining_qty, pl.cost_basis_usd
    FROM position_lots pl
    WHERE pl.remaining_qty > 0 AND pl.is_closed = false
      AND NOT EXISTS (
        SELECT 1 FROM position_tracking pt 
        WHERE pt.mint = pl.mint AND pt.total_tokens > 0
      )
  `);

  const heldNotTargeted = await q<{ mint: string; symbol: string; total_tokens: number; last_price: number }>(`
    SELECT pt.mint, tu.symbol, pt.total_tokens, pt.last_price
    FROM position_tracking pt
    LEFT JOIN trading_universe tu ON tu.mint = pt.mint
    WHERE pt.total_tokens > 0
      AND NOT EXISTS (
        SELECT 1 FROM trading_universe active_tu 
        WHERE active_tu.mint = pt.mint AND active_tu.active = true
      )
  `);

  const dustStats = await q<{ count: number; total_value: number }>(`
    SELECT COUNT(*)::int as count, COALESCE(SUM(total_tokens * COALESCE(last_price, 0)), 0) as total_value
    FROM position_tracking
    WHERE total_tokens > 0 AND total_tokens * COALESCE(last_price, 0) < 0.50
  `);

  return {
    run_summary: {
      start_equity_usd: startEquity,
      end_equity_usd: endEquity,
      hours,
      pnl_usd: pnlUsd,
      slope_per_hour: slopePerHour,
      r2: null,
      max_drawdown: maxDrawdown,
    },
    by_reason_code: byReasonCode,
    fees_summary: {
      total_fees_sol: totalFeesSol,
      total_fees_usd_estimate: totalFeesSol * solPrice,
      base_fees_lamports: totalFeesLamports,
      priority_fees_lamports: totalPriorityFeesLamports,
    },
    price_impact_summary: priceImpactSummary,
    by_mint_top_losses: byMintTopLosses,
    orphans: {
      wallet_no_lots: walletNoLots.map(p => ({
        mint: p.mint,
        symbol: p.symbol || "UNKNOWN",
        value_usd: parseFloat(String(p.total_tokens)) * parseFloat(String(p.last_price || 0)),
      })),
      lots_no_wallet: lotsNoWallet.map(l => ({
        mint: l.mint,
        lot_id: l.lot_id,
        remaining_qty: parseFloat(String(l.remaining_qty)),
        cost_basis_usd: parseFloat(String(l.cost_basis_usd)),
      })),
      held_not_targeted: heldNotTargeted.map(p => ({
        mint: p.mint,
        symbol: p.symbol || "UNKNOWN",
        value_usd: parseFloat(String(p.total_tokens)) * parseFloat(String(p.last_price || 0)),
      })),
    },
    dust: {
      positions_under_usd: {
        count: parseInt(String(dustStats[0]?.count || 0)),
        total_value_usd: parseFloat(String(dustStats[0]?.total_value || 0)),
        threshold_usd: 0.50,
      },
    },
  };
}

interface ManifestFile {
  schemaVersion: string;
  generatedAt: string;
  exportRange: { start: string; end: string };
  environment: {
    mode: string;
    env: string;
    gitSha: string | null;
    botVersion: string;
  };
  files: FileRowCounts;
  totalRows: number;
}

export async function createExportLiteZip(
  startDate: Date,
  endDate: Date
): Promise<{ buffer: Buffer; fileCount: number; totalRows: number }> {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const dateRange: DateRange = { start: startDate, end: endDate };
  const config = getConfig();

  let totalRows = 0;
  let fileCount = 0;
  const fileCounts: FileRowCounts = {};
  const chunks: Buffer[] = [];

  const bufferStream = new PassThrough();
  bufferStream.on("data", (chunk: Buffer) => chunks.push(chunk));

  archive.pipe(bufferStream);

  let archiveError: Error | null = null;
  archive.on("error", (err) => {
    logger.error({ err: err?.message, stack: err?.stack }, "Archive error during export lite");
    archiveError = err;
  });

  try {
    logger.info({ startDate, endDate }, "Starting export lite - fetching equity_timeseries");
    const equityCount = await streamNdjsonToArchive(archive, "equity_timeseries.jsonl", getEquityTimeseries(dateRange));
    totalRows += equityCount;
    fileCount++;
    fileCounts["equity_timeseries.jsonl"] = { rowCount: equityCount };
    logger.info({ equityCount }, "Exported equity_timeseries.jsonl");

    logger.info("Fetching trade_lots");
    const tradeLotsCount = await streamNdjsonToArchive(archive, "trade_lots.jsonl", getTradeLots(dateRange));
    totalRows += tradeLotsCount;
    fileCount++;
    fileCounts["trade_lots.jsonl"] = { rowCount: tradeLotsCount };
    logger.info({ tradeLotsCount }, "Exported trade_lots.jsonl");

    logger.info("Fetching pnl_events");
    const pnlCount = await streamNdjsonToArchive(archive, "pnl_events.jsonl", getPnlEvents(dateRange));
    totalRows += pnlCount;
    fileCount++;
    fileCounts["pnl_events.jsonl"] = { rowCount: pnlCount };
    logger.info({ pnlCount }, "Exported pnl_events.jsonl");

    logger.info("Fetching bot_trades");
    const botTradesCount = await streamNdjsonToArchive(archive, "bot_trades.jsonl", getBotTrades(dateRange));
    totalRows += botTradesCount;
    fileCount++;
    fileCounts["bot_trades.jsonl"] = { rowCount: botTradesCount };
    logger.info({ botTradesCount }, "Exported bot_trades.jsonl");

    logger.info("Fetching rotation_log");
    const rotationCount = await streamNdjsonToArchive(archive, "rotation_log.jsonl", getRotationLog(dateRange));
    totalRows += rotationCount;
    fileCount++;
    fileCounts["rotation_log.jsonl"] = { rowCount: rotationCount };
    logger.info({ rotationCount }, "Exported rotation_log.jsonl");

    logger.info("Fetching position_lots_open");
    const openLots = await getOpenPositionLots();
    const openLotsCount = await streamArrayToArchive(archive, "position_lots_open.jsonl", openLots);
    totalRows += openLotsCount;
    fileCount++;
    fileCounts["position_lots_open.jsonl"] = { rowCount: openLotsCount };
    logger.info({ openLotsCount }, "Exported position_lots_open.jsonl");

    logger.info("Adding settings_effective.json");
    const settingsCount = await appendJsonToArchive(archive, "settings_effective.json", config);
    totalRows += settingsCount;
    fileCount++;
    fileCounts["settings_effective.json"] = { rowCount: settingsCount };
    logger.info("Exported settings_effective.json");

    logger.info("Fetching positions_end");
    const endPositions = await getEndPositions(dateRange);
    const positionsCount = await appendJsonToArchive(archive, "positions_end.json", endPositions);
    totalRows += positionsCount;
    fileCount++;
    fileCounts["positions_end.json"] = { rowCount: positionsCount };
    logger.info({ positionsCount: endPositions.length }, "Exported positions_end.json");

    logger.info("Computing aggregates");
    const aggregates = await computeAggregates(dateRange);
    const aggregatesCount = await appendJsonToArchive(archive, "aggregates.json", aggregates);
    totalRows += aggregatesCount;
    fileCount++;
    fileCounts["aggregates.json"] = { rowCount: aggregatesCount };
    logger.info("Exported aggregates.json");

    const manifest: ManifestFile = {
      schemaVersion: "1.0.0",
      generatedAt: new Date().toISOString(),
      exportRange: {
        start: startDate.toISOString(),
        end: endDate.toISOString(),
      },
      environment: {
        mode: config.executionMode,
        env: process.env.NODE_ENV || "development",
        gitSha: getGitSha(),
        botVersion: getBotVersion(),
      },
      files: fileCounts,
      totalRows,
    };
    await appendJsonToArchive(archive, "manifest.json", manifest);
    fileCount++;
    logger.info("Exported manifest.json");

    const streamEndPromise = new Promise<void>((resolve, reject) => {
      bufferStream.on("end", resolve);
      bufferStream.on("error", reject);
      archive.on("error", reject);
    });

    await archive.finalize();
    await streamEndPromise;

    if (archiveError) {
      throw archiveError;
    }

    const buffer = Buffer.concat(chunks);
    logger.info({ fileCount, totalRows, bufferSize: buffer.length }, "Export lite zip created successfully");

    return { buffer, fileCount, totalRows };
  } catch (err: any) {
    logger.error({ err: err?.message, stack: err?.stack }, "Error creating export lite zip");
    archive.abort();
    throw err;
  }
}
