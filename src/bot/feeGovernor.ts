import { logger } from "../utils/logger.js";

export type Lane = "scout" | "core";
export type Side = "buy" | "sell";
export type Urgency = "normal" | "high";
export type PriorityLevel = "low" | "medium" | "high" | "veryHigh";

export interface TradeContext {
  lane: Lane;
  side: Side;
  notionalSol: number;
  urgency: Urgency;
  attempt: number;
}

export interface FeeSettings {
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
}

export interface FeeDecision {
  maxLamports: number;
  priorityLevel: PriorityLevel;
  reason: string;
  skipRecommended: boolean;
  clampedToMin: boolean;
  clampedToMax: boolean;
  effectiveRatio: number;
}

export const DEFAULT_FEE_SETTINGS: FeeSettings = {
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
};

export function getPriorityFeeLamports(
  ctx: TradeContext,
  settings: FeeSettings
): FeeDecision {
  const notionalLamports = ctx.notionalSol * 1e9;
  
  const baseRatio = ctx.lane === "scout" 
    ? settings.feeRatioPerLegScout 
    : settings.feeRatioPerLegCore;
  
  const baseFee = notionalLamports * baseRatio * settings.feeSafetyHaircut;
  
  const ladderIdx = Math.min(
    ctx.attempt - 1, 
    settings.retryLadderMultipliers.length - 1
  );
  const multiplier = settings.retryLadderMultipliers[Math.max(0, ladderIdx)] ?? 1;
  
  let fee = baseFee * multiplier;
  
  const minFee = ctx.side === "sell" 
    ? settings.minPriorityFeeLamportsExit 
    : settings.minPriorityFeeLamportsEntry;
  
  const maxFee = ctx.lane === "scout"
    ? settings.maxPriorityFeeLamportsScout
    : settings.maxPriorityFeeLamportsCore;
  
  let clampedToMin = false;
  let clampedToMax = false;
  const reasons: string[] = [];
  
  if (fee < minFee) {
    fee = minFee;
    clampedToMin = true;
    reasons.push(`clamped_to_min_${ctx.side === "sell" ? "exit" : "entry"}=${minFee}`);
  }
  
  if (fee > maxFee) {
    fee = maxFee;
    clampedToMax = true;
    reasons.push(`clamped_to_max_${ctx.lane}=${maxFee}`);
  }
  
  const maxLamports = Math.round(fee);
  const effectiveRatio = notionalLamports > 0 ? maxLamports / notionalLamports : 0;
  
  let skipRecommended = false;
  if (settings.feeRatioGuardEnabled && effectiveRatio > settings.maxFeeRatioHardPerLeg) {
    skipRecommended = true;
    reasons.push(`fee_ratio_${(effectiveRatio * 100).toFixed(2)}%_exceeds_hard_cap_${(settings.maxFeeRatioHardPerLeg * 100).toFixed(2)}%`);
  }
  
  const priorityLevel: PriorityLevel = 
    ctx.urgency === "high" || ctx.side === "sell" ? "high" : "medium";
  
  if (reasons.length === 0) {
    reasons.push("computed_from_notional");
  }
  
  if (ctx.attempt > 1) {
    reasons.push(`retry_attempt_${ctx.attempt}_multiplier_${multiplier}x`);
  }
  
  return {
    maxLamports,
    priorityLevel,
    reason: reasons.join("; "),
    skipRecommended,
    clampedToMin,
    clampedToMax,
    effectiveRatio,
  };
}

export function logFeeDecision(
  ctx: TradeContext,
  decision: FeeDecision,
  actualFeePaid?: number
): void {
  const logData = {
    lane: ctx.lane,
    side: ctx.side,
    notionalSol: ctx.notionalSol,
    attempt: ctx.attempt,
    urgency: ctx.urgency,
    priorityLevel: decision.priorityLevel,
    maxLamports: decision.maxLamports,
    maxLamportsSol: (decision.maxLamports / 1e9).toFixed(6),
    effectiveRatioPct: (decision.effectiveRatio * 100).toFixed(4),
    reason: decision.reason,
    clampedToMin: decision.clampedToMin,
    clampedToMax: decision.clampedToMax,
    skipRecommended: decision.skipRecommended,
    ...(actualFeePaid !== undefined && {
      actualFeePaid,
      actualFeePaidSol: (actualFeePaid / 1e9).toFixed(6),
      feeEfficiency: decision.maxLamports > 0 
        ? ((1 - actualFeePaid / decision.maxLamports) * 100).toFixed(2) + "% saved"
        : "N/A",
    }),
  };
  
  if (decision.skipRecommended) {
    logger.warn(logData, "Fee governor: SKIP RECOMMENDED - fee ratio too high");
  } else {
    logger.info(logData, "Fee governor: computed priority fee");
  }
}

export function getFallbackPriorityFeeLamports(riskProfile: string): number {
  switch (riskProfile) {
    case "degen": return 5_000_000;
    case "high": return 2_000_000;
    case "moderate": return 1_000_000;
    default: return 500_000;
  }
}

export function getFallbackPriorityLevel(riskProfile: string): PriorityLevel {
  switch (riskProfile) {
    case "degen": return "veryHigh";
    case "high": return "high";
    default: return "medium";
  }
}
