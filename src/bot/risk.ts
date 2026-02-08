import { getConfig, getConfigHash } from "./runtime_config.js";
import { getEnvContext } from "./env_context.js";
import pino from "pino";

const logger = pino({ level: process.env.LOG_LEVEL || "info" });

export type BaselineType = "sod" | "rolling24h";

export type CircuitState = {
  day: string;
  startEquityUsd: number;
  minEquityUsd: number;
  turnoverUsd: number;
  paused: boolean;
  pauseReason?: string;
  realizedPnlUsd: number;
  baselineType: BaselineType;
  lastPauseChange?: string;
};

export interface RiskPauseState {
  paused: boolean;
  reason: string | null;
  baselineType: BaselineType;
  baselineEquityUsd: number;
  currentEquityUsd: number;
  pnlUsd: number;
  pnlPct: number;
  thresholdPct: number;
  turnoverUsd: number;
  turnoverCapUsd: number;
  day: string;
}

let lastPauseState: boolean = false;
let cachedRiskState: RiskPauseState | null = null;

export function newCircuit(today: string, equityUsd: number, baselineType: BaselineType = "sod"): CircuitState {
  return {
    day: today,
    startEquityUsd: equityUsd,
    minEquityUsd: equityUsd,
    turnoverUsd: 0,
    paused: false,
    realizedPnlUsd: 0,
    baselineType,
  };
}

export function updateCircuit(c: CircuitState, equityUsd: number, realizedPnlUsd?: number) {
  c.minEquityUsd = Math.min(c.minEquityUsd, equityUsd);
  if (realizedPnlUsd !== undefined) {
    c.realizedPnlUsd = realizedPnlUsd;
  }
}

function logPauseStateChange(
  triggered: boolean,
  reason: string,
  details: {
    baselineType: BaselineType;
    baselineEquityUsd: number;
    currentEquityUsd: number;
    pnlUsd: number;
    pnlPct: number;
    thresholdPct: number;
  }
) {
  const envCtx = getEnvContext();
  const settingsHash = getConfigHash();
  
  const event = triggered ? "RISK_PAUSE_TRIGGERED" : "RISK_PAUSE_CLEARED";
  
  logger.warn({
    event,
    reason,
    ...details,
    settingsHash,
    envName: envCtx.envName,
    timestamp: new Date().toISOString(),
  }, `${event}: ${reason}`);
}

export function checkCircuit(
  c: CircuitState, 
  equityUsd: number, 
  realizedPnlUsd?: number
) {
  const config = getConfig();
  const maxDailyDrawdownPct = config.maxDailyDrawdownPct;
  const maxTurnoverPctPerDay = config.maxTurnoverPctPerDay;
  
  const drawdownLimitUsd = c.startEquityUsd * maxDailyDrawdownPct;
  const wasPaused = c.paused;
  
  const baselineEquityUsd = c.startEquityUsd;
  const currentEquityUsd = equityUsd;
  const pnlUsd = currentEquityUsd - baselineEquityUsd;
  const pnlPct = baselineEquityUsd > 0 ? (pnlUsd / baselineEquityUsd) * 100 : 0;
  const turnoverCap = maxTurnoverPctPerDay * equityUsd;
  
  cachedRiskState = {
    paused: c.paused,
    reason: c.pauseReason || null,
    baselineType: c.baselineType,
    baselineEquityUsd,
    currentEquityUsd,
    pnlUsd,
    pnlPct,
    thresholdPct: maxDailyDrawdownPct * 100,
    turnoverUsd: c.turnoverUsd,
    turnoverCapUsd: turnoverCap,
    day: c.day,
  };
  
  const worstDrawdown = 1 - c.minEquityUsd / Math.max(1e-9, c.startEquityUsd);
  const currentDrawdown = 1 - equityUsd / Math.max(1e-9, c.startEquityUsd);
  
  if (worstDrawdown >= maxDailyDrawdownPct && !c.paused) {
    c.paused = true;
    c.pauseReason = `Daily equity drawdown hit: ${(worstDrawdown*100).toFixed(2)}% (min equity $${c.minEquityUsd.toFixed(0)} vs start $${c.startEquityUsd.toFixed(0)})`;
    c.lastPauseChange = new Date().toISOString();
    
    logger.warn({
      worstDrawdownPct: worstDrawdown * 100,
      currentDrawdownPct: currentDrawdown * 100,
      minEquity: c.minEquityUsd,
      currentEquity: equityUsd,
      startEquity: c.startEquityUsd,
      maxDrawdownPct: maxDailyDrawdownPct * 100,
    }, "CIRCUIT_BREAKER: Daily equity drawdown limit exceeded (based on intra-day low)");
  }
  
  const todayPnl = realizedPnlUsd ?? c.realizedPnlUsd;
  if (todayPnl < 0 && Math.abs(todayPnl) >= drawdownLimitUsd && !c.paused) {
    c.paused = true;
    const lossAmt = Math.abs(todayPnl);
    const lossPct = (lossAmt / c.startEquityUsd) * 100;
    c.pauseReason = `Daily realized FIFO loss hit: -$${lossAmt.toFixed(2)} (${lossPct.toFixed(2)}% of $${c.startEquityUsd.toFixed(0)} start equity)`;
    c.lastPauseChange = new Date().toISOString();
    
    logger.warn({
      realizedPnl: todayPnl,
      drawdownLimitUsd,
      startEquity: c.startEquityUsd,
      maxDrawdownPct: maxDailyDrawdownPct * 100,
    }, "CIRCUIT_BREAKER: Daily realized FIFO loss limit exceeded");
  }
  
  if (c.turnoverUsd >= turnoverCap && !c.paused) {
    c.paused = true;
    c.pauseReason = `Daily turnover cap hit: $${c.turnoverUsd.toFixed(0)} / $${turnoverCap.toFixed(0)}`;
    c.lastPauseChange = new Date().toISOString();
  }
  
  cachedRiskState = {
    paused: c.paused,
    reason: c.pauseReason || null,
    baselineType: c.baselineType,
    baselineEquityUsd,
    currentEquityUsd,
    pnlUsd,
    pnlPct,
    thresholdPct: maxDailyDrawdownPct * 100,
    turnoverUsd: c.turnoverUsd,
    turnoverCapUsd: turnoverCap,
    day: c.day,
  };
  
  if (!wasPaused && c.paused) {
    logPauseStateChange(true, c.pauseReason || "Unknown", {
      baselineType: c.baselineType,
      baselineEquityUsd,
      currentEquityUsd,
      pnlUsd,
      pnlPct,
      thresholdPct: maxDailyDrawdownPct * 100,
    });
    lastPauseState = true;
  }
}

export function clearCircuitPause(c: CircuitState, reason: string = "Manual clear") {
  if (c.paused) {
    const config = getConfig();
    const maxDailyDrawdownPct = config.maxDailyDrawdownPct;
    
    logPauseStateChange(false, reason, {
      baselineType: c.baselineType,
      baselineEquityUsd: c.startEquityUsd,
      currentEquityUsd: c.minEquityUsd,
      pnlUsd: c.minEquityUsd - c.startEquityUsd,
      pnlPct: c.startEquityUsd > 0 ? ((c.minEquityUsd - c.startEquityUsd) / c.startEquityUsd) * 100 : 0,
      thresholdPct: maxDailyDrawdownPct * 100,
    });
    
    c.paused = false;
    c.pauseReason = undefined;
    c.lastPauseChange = new Date().toISOString();
    lastPauseState = false;
    
    if (cachedRiskState) {
      cachedRiskState.paused = false;
      cachedRiskState.reason = null;
    }
  }
}

export function addTurnover(c: CircuitState, usd: number) {
  c.turnoverUsd += Math.abs(usd);
}

export function getRiskPauseState(): RiskPauseState | null {
  return cachedRiskState;
}

export function updateRiskStateFromCircuit(c: CircuitState, currentEquityUsd: number): void {
  const config = getConfig();
  const maxDailyDrawdownPct = config.maxDailyDrawdownPct;
  const maxTurnoverPctPerDay = config.maxTurnoverPctPerDay;
  
  const baselineEquityUsd = c.startEquityUsd;
  const pnlUsd = currentEquityUsd - baselineEquityUsd;
  const pnlPct = baselineEquityUsd > 0 ? (pnlUsd / baselineEquityUsd) * 100 : 0;
  const turnoverCap = maxTurnoverPctPerDay * currentEquityUsd;
  
  cachedRiskState = {
    paused: c.paused,
    reason: c.pauseReason || null,
    baselineType: c.baselineType,
    baselineEquityUsd,
    currentEquityUsd,
    pnlUsd,
    pnlPct,
    thresholdPct: maxDailyDrawdownPct * 100,
    turnoverUsd: c.turnoverUsd,
    turnoverCapUsd: turnoverCap,
    day: c.day,
  };
}
