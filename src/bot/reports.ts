import { q } from "./db.js";
import { logger } from "../utils/logger.js";

export interface WeeklyReportData {
  periodStart: Date;
  periodEnd: Date;
  summary: {
    totalTrades: number;
    buys: number;
    sells: number;
    rotations: number;
    promotions: number;
    trailingStopExits: number;
    staleExits: number;
    takeProfitExits: number;
    stopLossExits: number;
  };
  performance: {
    realizedPnlUsd: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    avgWinUsd: number;
    avgLossUsd: number;
    profitFactor: number;
  };
  rotationBreakdown: {
    reasonCode: string;
    count: number;
    avgRankDelta: number;
    totalPnlUsd: number;
  }[];
  topWinners: {
    symbol: string;
    mint: string;
    pnlUsd: number;
    strategy: string;
  }[];
  topLosers: {
    symbol: string;
    mint: string;
    pnlUsd: number;
    strategy: string;
  }[];
  slotActivity: {
    corePositionsHeld: number;
    scoutPositionsHeld: number;
    promotionCount: number;
    avgHoldTimeHours: number;
  };
}

export async function generateWeeklyReport(
  startDate?: Date,
  endDate?: Date
): Promise<WeeklyReportData> {
  const now = new Date();
  const periodEnd = endDate ?? now;
  const periodStart = startDate ?? new Date(periodEnd.getTime() - 7 * 24 * 60 * 60 * 1000);

  const trades = await q<{
    id: number;
    strategy: string;
    input_mint: string;
    output_mint: string;
    status: string;
    pnl_usd: number | null;
    meta: any;
    ts: Date;
  }>(
    `SELECT id, strategy, input_mint, output_mint, status, pnl_usd, meta, ts
     FROM bot_trades
     WHERE ts >= $1 AND ts <= $2
     ORDER BY ts`,
    [periodStart.toISOString(), periodEnd.toISOString()]
  );

  const rotationLogs = await q<{
    id: number;
    action: string;
    sold_mint: string | null;
    sold_symbol: string | null;
    bought_mint: string | null;
    bought_symbol: string | null;
    reason_code: string;
    sold_rank: number | null;
    bought_rank: number | null;
    rank_delta: number | null;
    meta: any;
    ts: Date;
  }>(
    `SELECT * FROM rotation_log
     WHERE ts >= $1 AND ts <= $2
     ORDER BY ts`,
    [periodStart.toISOString(), periodEnd.toISOString()]
  );

  const buys = trades.filter(t => t.output_mint !== "So11111111111111111111111111111111111111112");
  const sells = trades.filter(t => t.output_mint === "So11111111111111111111111111111111111111112");
  
  const rotations = rotationLogs.filter(r => r.action === 'rotation');
  const promotions = rotationLogs.filter(r => r.action === 'promotion');
  const trailingStopExits = sells.filter(t => t.strategy === 'trailing_stop_exit');
  const staleExits = sells.filter(t => 
    t.strategy === 'stale_timeout_exit' || t.strategy === 'stale_exit_no_replacement'
  );
  const takeProfitExits = sells.filter(t => t.strategy === 'take_profit');
  const stopLossExits = sells.filter(t => t.strategy === 'stop_loss');

  const pnlTrades = sells.filter(t => t.pnl_usd !== null && t.pnl_usd !== 0);
  const wins = pnlTrades.filter(t => (t.pnl_usd ?? 0) > 0);
  const losses = pnlTrades.filter(t => (t.pnl_usd ?? 0) < 0);
  
  const totalWinPnl = wins.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0);
  const totalLossPnl = losses.reduce((sum, t) => sum + Math.abs(t.pnl_usd ?? 0), 0);
  const realizedPnlUsd = pnlTrades.reduce((sum, t) => sum + (t.pnl_usd ?? 0), 0);

  const rotationByReason = new Map<string, { count: number; totalRankDelta: number; totalPnl: number }>();
  for (const rot of rotationLogs) {
    const code = rot.reason_code || 'unknown';
    const existing = rotationByReason.get(code) || { count: 0, totalRankDelta: 0, totalPnl: 0 };
    existing.count++;
    existing.totalRankDelta += rot.rank_delta ?? 0;
    
    const matchingTrade = sells.find(t => 
      t.input_mint === rot.sold_mint && 
      Math.abs(new Date(t.ts).getTime() - new Date(rot.ts).getTime()) < 60000
    );
    existing.totalPnl += matchingTrade?.pnl_usd ?? 0;
    
    rotationByReason.set(code, existing);
  }

  const rotationBreakdown = Array.from(rotationByReason.entries()).map(([code, data]) => ({
    reasonCode: code,
    count: data.count,
    avgRankDelta: data.count > 0 ? data.totalRankDelta / data.count : 0,
    totalPnlUsd: data.totalPnl,
  }));

  const positionTracking = await q<{
    mint: string;
    slot_type: string;
    entry_time: Date;
  }>(
    `SELECT mint, slot_type, entry_time FROM position_tracking`
  );

  const corePositions = positionTracking.filter(p => p.slot_type === 'core');
  const scoutPositions = positionTracking.filter(p => p.slot_type === 'scout');

  const holdTimes = positionTracking.map(p => 
    (now.getTime() - new Date(p.entry_time).getTime()) / (1000 * 60 * 60)
  );
  const avgHoldTimeHours = holdTimes.length > 0 
    ? holdTimes.reduce((a, b) => a + b, 0) / holdTimes.length 
    : 0;

  const topWinners = wins
    .sort((a, b) => (b.pnl_usd ?? 0) - (a.pnl_usd ?? 0))
    .slice(0, 5)
    .map(t => ({
      symbol: t.meta?.symbol || t.input_mint.slice(0, 6),
      mint: t.input_mint,
      pnlUsd: t.pnl_usd ?? 0,
      strategy: t.strategy,
    }));

  const topLosers = losses
    .sort((a, b) => (a.pnl_usd ?? 0) - (b.pnl_usd ?? 0))
    .slice(0, 5)
    .map(t => ({
      symbol: t.meta?.symbol || t.input_mint.slice(0, 6),
      mint: t.input_mint,
      pnlUsd: t.pnl_usd ?? 0,
      strategy: t.strategy,
    }));

  return {
    periodStart,
    periodEnd,
    summary: {
      totalTrades: trades.length,
      buys: buys.length,
      sells: sells.length,
      rotations: rotations.length,
      promotions: promotions.length,
      trailingStopExits: trailingStopExits.length,
      staleExits: staleExits.length,
      takeProfitExits: takeProfitExits.length,
      stopLossExits: stopLossExits.length,
    },
    performance: {
      realizedPnlUsd,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: pnlTrades.length > 0 ? wins.length / pnlTrades.length : 0,
      avgWinUsd: wins.length > 0 ? totalWinPnl / wins.length : 0,
      avgLossUsd: losses.length > 0 ? totalLossPnl / losses.length : 0,
      profitFactor: totalLossPnl > 0 ? totalWinPnl / totalLossPnl : totalWinPnl > 0 ? Infinity : 0,
    },
    rotationBreakdown,
    topWinners,
    topLosers,
    slotActivity: {
      corePositionsHeld: corePositions.length,
      scoutPositionsHeld: scoutPositions.length,
      promotionCount: promotions.length,
      avgHoldTimeHours,
    },
  };
}

export function formatWeeklyReport(report: WeeklyReportData): string {
  const lines: string[] = [];
  
  lines.push("=".repeat(60));
  lines.push("WEEKLY TRADING REPORT");
  lines.push(`Period: ${report.periodStart.toLocaleDateString()} - ${report.periodEnd.toLocaleDateString()}`);
  lines.push("=".repeat(60));
  lines.push("");
  
  lines.push("TRADE SUMMARY");
  lines.push("-".repeat(40));
  lines.push(`Total Trades: ${report.summary.totalTrades}`);
  lines.push(`  Buys: ${report.summary.buys}`);
  lines.push(`  Sells: ${report.summary.sells}`);
  lines.push("");
  lines.push("EXIT BREAKDOWN:");
  lines.push(`  Take Profit: ${report.summary.takeProfitExits}`);
  lines.push(`  Trailing Stop: ${report.summary.trailingStopExits}`);
  lines.push(`  Stale Exits: ${report.summary.staleExits}`);
  lines.push(`  Stop Loss: ${report.summary.stopLossExits}`);
  lines.push(`  Rotations: ${report.summary.rotations}`);
  lines.push(`  Promotions: ${report.summary.promotions}`);
  lines.push("");
  
  lines.push("PERFORMANCE");
  lines.push("-".repeat(40));
  lines.push(`Realized P&L: $${report.performance.realizedPnlUsd.toFixed(2)}`);
  lines.push(`Win Rate: ${(report.performance.winRate * 100).toFixed(1)}%`);
  lines.push(`Wins: ${report.performance.winCount} | Losses: ${report.performance.lossCount}`);
  lines.push(`Avg Win: $${report.performance.avgWinUsd.toFixed(2)}`);
  lines.push(`Avg Loss: $${report.performance.avgLossUsd.toFixed(2)}`);
  lines.push(`Profit Factor: ${report.performance.profitFactor === Infinity ? "∞" : report.performance.profitFactor.toFixed(2)}`);
  lines.push("");
  
  if (report.rotationBreakdown.length > 0) {
    lines.push("ROTATION BREAKDOWN");
    lines.push("-".repeat(40));
    for (const rb of report.rotationBreakdown) {
      lines.push(`${rb.reasonCode}: ${rb.count} trades`);
      lines.push(`  Avg Rank Delta: ${rb.avgRankDelta.toFixed(2)}`);
      lines.push(`  Total P&L: $${rb.totalPnlUsd.toFixed(2)}`);
    }
    lines.push("");
  }
  
  lines.push("SLOT ACTIVITY");
  lines.push("-".repeat(40));
  lines.push(`Core Positions: ${report.slotActivity.corePositionsHeld}`);
  lines.push(`Scout Positions: ${report.slotActivity.scoutPositionsHeld}`);
  lines.push(`Promotions This Period: ${report.slotActivity.promotionCount}`);
  lines.push(`Avg Hold Time: ${report.slotActivity.avgHoldTimeHours.toFixed(1)} hours`);
  lines.push("");
  
  if (report.topWinners.length > 0) {
    lines.push("TOP WINNERS");
    lines.push("-".repeat(40));
    for (const w of report.topWinners) {
      lines.push(`${w.symbol}: +$${w.pnlUsd.toFixed(2)} (${w.strategy})`);
    }
    lines.push("");
  }
  
  if (report.topLosers.length > 0) {
    lines.push("TOP LOSERS");
    lines.push("-".repeat(40));
    for (const l of report.topLosers) {
      lines.push(`${l.symbol}: $${l.pnlUsd.toFixed(2)} (${l.strategy})`);
    }
    lines.push("");
  }
  
  lines.push("=".repeat(60));
  
  return lines.join("\n");
}

export async function logWeeklyReport(): Promise<void> {
  try {
    const report = await generateWeeklyReport();
    const formatted = formatWeeklyReport(report);
    logger.info({ report: formatted }, "Weekly trading report generated");
    
    await q(
      `INSERT INTO weekly_reports (period_start, period_end, report_data, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT DO NOTHING`,
      [report.periodStart.toISOString(), report.periodEnd.toISOString(), JSON.stringify(report)]
    ).catch(() => {});
  } catch (err) {
    logger.error({ err }, "Failed to generate weekly report");
  }
}
