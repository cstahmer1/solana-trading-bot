import type { BotState } from "./state.js";
import { pool } from "./db.js";
import { env } from "./config.js";

export type SignalData = {
  mint: string;
  symbol: string;
  score: number;
  regime: "trend" | "range";
  targetPct: number;
  currentPct: number;
  priceUsd: number;
  priceChange1h?: number;
  priceChange24h?: number;
  lastUpdate: number;
};

export type CircuitData = {
  drawdownPct: number;
  drawdownLimit: number;
  turnoverUsd: number;
  turnoverLimit: number;
  startEquityUsd: number;
  paused: boolean;
  pauseReason?: string;
};

export type PositionData = {
  mint: string;
  symbol: string;
  amount: number;
  valueUsd: number;
  pctOfPortfolio: number;
  priceUsd: number;
  costBasis?: number;
  unrealizedPnl?: number;
  unrealizedPnlUsd?: number;
};

export type TradeRecord = {
  id: number;
  timestamp: string;
  strategy: string;
  riskProfile: string;
  mode: string;
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string | null;
  estOutAmount: string;
  priceImpactPct: number;
  slippageBps: number;
  txSig: string | null;
  status: string;
};

export type PriceHistory = {
  timestamp: number;
  price: number;
  signal?: number;
  regime?: string;
};

export type TelemetrySnapshot = {
  timestamp: number;
  mode: "paper" | "live";
  riskProfile: string;
  paused: boolean;
  pauseReason?: string;
  equity: {
    current: number;
    start: number;
    pnlUsd: number;
    pnlPct: number;
  };
  circuit: CircuitData;
  positions: PositionData[];
  signals: SignalData[];
  recentTrades: TradeRecord[];
};

const signalHistory: Map<string, SignalData[]> = new Map();
const priceHistory: Map<string, PriceHistory[]> = new Map();
const MAX_HISTORY = 1000;

export function recordSignal(signal: SignalData) {
  const history = signalHistory.get(signal.mint) ?? [];
  history.push({ ...signal, lastUpdate: Date.now() });
  if (history.length > MAX_HISTORY) history.shift();
  signalHistory.set(signal.mint, history);
}

export function recordPrice(mint: string, price: number, signal?: number, regime?: string) {
  const history = priceHistory.get(mint) ?? [];
  history.push({ timestamp: Date.now(), price, signal, regime });
  if (history.length > MAX_HISTORY) history.shift();
  priceHistory.set(mint, history);
}

export function getSignalHistory(mint: string, limit = 100): SignalData[] {
  const history = signalHistory.get(mint) ?? [];
  return history.slice(-limit);
}

export function getPriceHistory(mint: string, limit = 100): PriceHistory[] {
  const history = priceHistory.get(mint) ?? [];
  return history.slice(-limit);
}

export function getAllPriceHistory(): Map<string, PriceHistory[]> {
  return priceHistory;
}

export function getAllSignalHistory(limit = 100): { mint: string; symbol: string; history: SignalData[] }[] {
  const result: { mint: string; symbol: string; history: SignalData[] }[] = [];
  for (const [mint, history] of signalHistory) {
    if (history.length > 0) {
      const symbol = history[history.length - 1]?.symbol ?? mint.slice(0, 6);
      result.push({
        mint,
        symbol,
        history: history.slice(-limit),
      });
    }
  }
  return result;
}

export function getRecentSignalHistory(limit = 100): SignalData[] {
  const allSignals: SignalData[] = [];
  for (const [_mint, history] of signalHistory) {
    allSignals.push(...history);
  }
  allSignals.sort((a, b) => a.lastUpdate - b.lastUpdate);
  return allSignals.slice(-limit);
}

let latestSnapshot: TelemetrySnapshot | null = null;
let latestSignals: SignalData[] = [];
let latestPositions: PositionData[] = [];

// Clear all telemetry history for complete reset
export function clearAllTelemetryHistory(): void {
  signalHistory.clear();
  priceHistory.clear();
  // Also reset the latest snapshot so dashboard starts fresh
  latestSnapshot = null;
  latestSignals = [];
  latestPositions = [];
  console.log("Cleared all telemetry history and snapshots (signals, prices, latest state)");
}

export function updateTelemetry(snapshot: Partial<TelemetrySnapshot>) {
  if (snapshot.signals) latestSignals = snapshot.signals;
  if (snapshot.positions) latestPositions = snapshot.positions;
  latestSnapshot = {
    timestamp: Date.now(),
    mode: env.EXECUTION_MODE,
    riskProfile: "medium",
    paused: false,
    equity: { current: 0, start: 0, pnlUsd: 0, pnlPct: 0 },
    circuit: {
      drawdownPct: 0,
      drawdownLimit: env.MAX_DAILY_DRAWDOWN_PCT,
      turnoverUsd: 0,
      turnoverLimit: env.MAX_TURNOVER_PCT_PER_DAY,
      startEquityUsd: 0,
      paused: false,
    },
    positions: [],
    signals: [],
    recentTrades: [],
    ...latestSnapshot,
    ...snapshot,
  };
}

export function getLatestTelemetry(): TelemetrySnapshot | null {
  return latestSnapshot;
}

export function getLatestSignals(): SignalData[] {
  return latestSignals;
}

export function getLatestPositions(): PositionData[] {
  return latestPositions;
}

export async function getRecentTrades(limit = 50): Promise<TradeRecord[]> {
  try {
    const result = await pool.query(
      `SELECT id, created_at as timestamp, strategy, risk_profile, mode,
              input_mint, output_mint, in_amount, out_amount, est_out_amount,
              price_impact_pct, slippage_bps, tx_sig, status
       FROM trades
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return result.rows.map((row: any) => ({
      id: row.id,
      timestamp: row.timestamp,
      strategy: row.strategy,
      riskProfile: row.risk_profile,
      mode: row.mode,
      inputMint: row.input_mint,
      outputMint: row.output_mint,
      inAmount: row.in_amount,
      outAmount: row.out_amount,
      estOutAmount: row.est_out_amount,
      priceImpactPct: parseFloat(row.price_impact_pct) || 0,
      slippageBps: row.slippage_bps,
      txSig: row.tx_sig,
      status: row.status,
    }));
  } catch (err) {
    return [];
  }
}

export async function getEquityHistory(hours = 24): Promise<Array<{ timestamp: string; equity: number }>> {
  try {
    const result = await pool.query(
      `SELECT created_at as timestamp, total_usd as equity
       FROM equity_snapshots
       WHERE created_at > NOW() - INTERVAL '${hours} hours'
       ORDER BY created_at ASC`
    );
    return result.rows;
  } catch (err) {
    return [];
  }
}
