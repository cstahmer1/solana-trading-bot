import { logger } from "../utils/logger.js";
import { clamp } from "./math.js";

export interface AllocationRampSettings {
  allocationRampEnabled: boolean;
  minTicksForFullAlloc: number;
  preFullAllocMaxPct: number;
  smoothRamp: boolean;
  hardCapBeforeFull: boolean;
  maxPositionPctPerAsset: number;
}

export interface RampResult {
  effectiveTargetPct: number;
  rawTargetPct: number;
  ticksObserved: number;
  confidence: number;
  wasReduced: boolean;
  reason: "ramp" | "hard_cap" | "none";
}

export function computeEffectiveTargetPct(args: {
  rawTargetPct: number;
  ticksObserved: number;
  settings: AllocationRampSettings;
  mint?: string;
  symbol?: string;
}): RampResult {
  const { rawTargetPct, ticksObserved, settings, mint, symbol } = args;

  const result: RampResult = {
    effectiveTargetPct: rawTargetPct,
    rawTargetPct,
    ticksObserved: ticksObserved ?? 0,
    confidence: 1.0,
    wasReduced: false,
    reason: "none",
  };

  if (!settings.allocationRampEnabled) {
    return result;
  }

  if (settings.minTicksForFullAlloc <= 0) {
    return result;
  }

  const ticks = ticksObserved ?? 0;

  let confidence = clamp(ticks / settings.minTicksForFullAlloc, 0, 1);

  if (settings.smoothRamp) {
    confidence = Math.sqrt(confidence);
  }

  let effectiveTargetPct = rawTargetPct * confidence;

  let reason: "ramp" | "hard_cap" | "none" = confidence < 1 ? "ramp" : "none";

  if (settings.hardCapBeforeFull && ticks < settings.minTicksForFullAlloc) {
    if (effectiveTargetPct > settings.preFullAllocMaxPct) {
      effectiveTargetPct = settings.preFullAllocMaxPct;
      reason = "hard_cap";
    }
  }

  effectiveTargetPct = clamp(effectiveTargetPct, 0, rawTargetPct);
  effectiveTargetPct = clamp(effectiveTargetPct, 0, settings.maxPositionPctPerAsset);

  result.effectiveTargetPct = effectiveTargetPct;
  result.confidence = confidence;
  result.wasReduced = effectiveTargetPct < rawTargetPct;
  result.reason = reason;

  const reduction = rawTargetPct - effectiveTargetPct;
  if (reduction >= 0.01) {
    logger.info({
      mint: mint ?? "unknown",
      symbol: symbol ?? "unknown",
      ticksObserved: ticks,
      rawTargetPct: (rawTargetPct * 100).toFixed(2) + "%",
      effectiveTargetPct: (effectiveTargetPct * 100).toFixed(2) + "%",
      confidence: confidence.toFixed(3),
      minTicksForFullAlloc: settings.minTicksForFullAlloc,
      preFullAllocMaxPct: (settings.preFullAllocMaxPct * 100).toFixed(2) + "%",
      reason,
      reductionPct: (reduction * 100).toFixed(2) + "%",
    }, "ALLOCATION_RAMP: Target reduced due to insufficient tick history");
  }

  return result;
}

export function applyRampToTargets(args: {
  targets: Array<{ mint: string; targetPct: number; rawTargetPct: number; score: number; regime: string }>;
  tickCountsByMint: Map<string, number>;
  settings: AllocationRampSettings;
  symbolsByMint?: Map<string, string>;
}): Array<{ mint: string; targetPct: number; rawTargetPct: number; score: number; regime: string; rampInfo?: RampResult }> {
  const { targets, tickCountsByMint, settings, symbolsByMint } = args;

  return targets.map((target) => {
    const ticksObserved = tickCountsByMint.get(target.mint) ?? 0;
    const symbol = symbolsByMint?.get(target.mint);

    const rampResult = computeEffectiveTargetPct({
      rawTargetPct: target.targetPct,
      ticksObserved,
      settings,
      mint: target.mint,
      symbol,
    });

    return {
      ...target,
      targetPct: rampResult.effectiveTargetPct,
      rampInfo: rampResult,
    };
  });
}
