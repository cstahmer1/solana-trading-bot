import { logger } from "../utils/logger.js";

export interface RebalanceHysteresisState {
  consecutiveTicksBelowCurrent: number;
  lastUpdatedAt: number;
}

export type RebalanceSellSkipReason = 
  | "MIN_HOLD_BEFORE_REBALANCE_SELL"
  | "TARGET_DROP_NOT_PERSISTENT"
  | "TRIM_TOO_SMALL";

export interface RebalanceSellGateResult {
  allowed: boolean;
  skipReason: RebalanceSellSkipReason | null;
  ageMinutes: number;
  confirmTicks: number;
  proceedsUsd: number;
}

const targetStateMap = new Map<string, RebalanceHysteresisState>();

export function updateTargetState(
  mint: string,
  targetPct: number,
  currentPct: number
): void {
  const now = Date.now();
  const existing = targetStateMap.get(mint);
  
  if (targetPct < currentPct) {
    if (existing) {
      existing.consecutiveTicksBelowCurrent++;
      existing.lastUpdatedAt = now;
    } else {
      targetStateMap.set(mint, {
        consecutiveTicksBelowCurrent: 1,
        lastUpdatedAt: now,
      });
    }
  } else {
    if (existing) {
      existing.consecutiveTicksBelowCurrent = 0;
      existing.lastUpdatedAt = now;
    }
  }
}

export function getConsecutiveTicksBelowCurrent(mint: string): number {
  return targetStateMap.get(mint)?.consecutiveTicksBelowCurrent ?? 0;
}

export function clearTargetState(mint: string): void {
  targetStateMap.delete(mint);
}

export function clearAllTargetStates(): void {
  targetStateMap.clear();
}

export function evaluateRebalanceSellGate(params: {
  mint: string;
  symbol: string;
  entryTimeMs: number | null;
  targetPct: number;
  currentPct: number;
  proceedsUsd: number;
  minHoldMinutes: number;
  confirmTicks: number;
  minTrimUsd: number;
}): RebalanceSellGateResult {
  const {
    mint,
    symbol,
    entryTimeMs,
    targetPct,
    currentPct,
    proceedsUsd,
    minHoldMinutes,
    confirmTicks,
    minTrimUsd,
  } = params;

  const now = Date.now();
  const ageMinutes = entryTimeMs ? (now - entryTimeMs) / (1000 * 60) : Infinity;
  const currentConfirmTicks = getConsecutiveTicksBelowCurrent(mint);

  if (ageMinutes < minHoldMinutes) {
    logger.info({
      mint,
      symbol,
      ageMinutes: ageMinutes.toFixed(1),
      minHoldMinutes,
      targetPct: (targetPct * 100).toFixed(2),
      currentPct: (currentPct * 100).toFixed(2),
    }, "REBALANCE_SELL_GATED: MIN_HOLD_BEFORE_REBALANCE_SELL");
    
    return {
      allowed: false,
      skipReason: "MIN_HOLD_BEFORE_REBALANCE_SELL",
      ageMinutes,
      confirmTicks: currentConfirmTicks,
      proceedsUsd,
    };
  }

  if (currentConfirmTicks < confirmTicks) {
    logger.info({
      mint,
      symbol,
      currentConfirmTicks,
      requiredConfirmTicks: confirmTicks,
      targetPct: (targetPct * 100).toFixed(2),
      currentPct: (currentPct * 100).toFixed(2),
    }, "REBALANCE_SELL_GATED: TARGET_DROP_NOT_PERSISTENT");
    
    return {
      allowed: false,
      skipReason: "TARGET_DROP_NOT_PERSISTENT",
      ageMinutes,
      confirmTicks: currentConfirmTicks,
      proceedsUsd,
    };
  }

  if (proceedsUsd < minTrimUsd) {
    logger.info({
      mint,
      symbol,
      proceedsUsd: proceedsUsd.toFixed(2),
      minTrimUsd,
      targetPct: (targetPct * 100).toFixed(2),
      currentPct: (currentPct * 100).toFixed(2),
    }, "REBALANCE_SELL_GATED: TRIM_TOO_SMALL");
    
    return {
      allowed: false,
      skipReason: "TRIM_TOO_SMALL",
      ageMinutes,
      confirmTicks: currentConfirmTicks,
      proceedsUsd,
    };
  }

  return {
    allowed: true,
    skipReason: null,
    ageMinutes,
    confirmTicks: currentConfirmTicks,
    proceedsUsd,
  };
}

export function getTargetStateSnapshot(): Map<string, RebalanceHysteresisState> {
  return new Map(targetStateMap);
}
