import type { PortfolioSnapshot } from "./portfolio.js";
import { isBaseMint } from "./portfolio.js";
import { clamp } from "./math.js";
import type { SlotType } from "./persist.js";

export type TargetWeight = { mint: string; targetPct: number; rawTargetPct: number; score: number; regime: string };

export type ScalingMetadata = {
  sumRawTargetsPct: number;
  sumScaledTargetsPct: number;
  scaleFactor: number;
  clampedCount: number;
  redistributionPassesUsed: number;
  targetCount: number;
};

export type ScoresToTargetsResult = {
  targets: TargetWeight[];
  scalingMeta: ScalingMetadata;
};

export function currentWeights(snapshot: PortfolioSnapshot): Record<string, number> {
  const w: Record<string, number> = {};
  for (const [mint, v] of Object.entries(snapshot.byMint)) {
    w[mint] = snapshot.totalUsd > 0 ? v.usdValue / snapshot.totalUsd : 0;
  }
  return w;
}

/**
 * Convert scores to target weights.
 * - Core positions get at least corePositionPctTarget as a baseline (even if signal is 0)
 * - We allocate remaining risk budget across non-base assets in proportion to positive scores.
 * - Remaining goes to SOL/USDC (risk-off bucket).
 * 
 * Utilization Scaling (Lever 2):
 * If deployTargetPct > 0 and sumTargets < deployTargetPct, we scale up non-zero targets
 * proportionally to reach the deploy target, clamping each to maxPositionPctPerAsset.
 * This increases capital deployment without changing signal logic.
 */
export function scoresToTargets(args: {
  snapshot: PortfolioSnapshot;
  candidates: { mint: string; score: number; regime: string; slotType?: SlotType }[];
  maxPositionPctPerAsset: number;
  corePositionPctTarget?: number;
  deployTargetPct?: number;
  capMaxTotalExposurePct?: number;
}): ScoresToTargetsResult {
  const { 
    snapshot, 
    candidates, 
    maxPositionPctPerAsset, 
    corePositionPctTarget = 0.12,
    deployTargetPct = 0,
    capMaxTotalExposurePct = 0.55,
  } = args;

  // Risk budget: aligned with capMaxTotalExposurePct (rest in SOL/USDC)
  const riskBudget = capMaxTotalExposurePct;

  // Separate core positions that need guaranteed allocation
  const corePositions = candidates.filter((c) => !isBaseMint(c.mint) && c.slotType === 'core');

  // Reserve budget for core positions (guaranteed baseline)
  // Cores get full corePositionPctTarget until total exceeds risk budget, then prorate
  const idealCoreBaseline = Math.min(corePositionPctTarget, maxPositionPctPerAsset);
  const idealTotalCoreReserved = corePositions.length * idealCoreBaseline;
  
  // Prorate if cores would consume more than the risk budget
  let actualCoreBaseline: number;
  let totalCoreReserved: number;
  
  if (idealTotalCoreReserved > riskBudget && corePositions.length > 0) {
    // Scale down core baselines proportionally to fit within risk budget
    totalCoreReserved = riskBudget;
    actualCoreBaseline = totalCoreReserved / corePositions.length;
  } else {
    totalCoreReserved = idealTotalCoreReserved;
    actualCoreBaseline = idealCoreBaseline;
  }
  
  // Remaining budget for signal-based allocation
  const remainingBudget = Math.max(0, riskBudget - totalCoreReserved);

  // Calculate signal-based allocation for positive-score assets
  const positiveScoreAssets = candidates.filter((c) => !isBaseMint(c.mint) && c.score > 0);
  const totalPosScore = positiveScoreAssets.reduce((a, c) => a + c.score, 0);

  const targets: TargetWeight[] = [];
  
  for (const c of candidates) {
    if (isBaseMint(c.mint)) continue;
    
    let target: number;
    
    if (c.slotType === 'core') {
      // Core positions get at least the baseline, plus any signal-based bonus
      const signalBonus = totalPosScore > 0 && c.score > 0
        ? (c.score / totalPosScore) * remainingBudget
        : 0;
      target = clamp(actualCoreBaseline + signalBonus, actualCoreBaseline, maxPositionPctPerAsset);
    } else {
      // Non-core positions get signal-based allocation only
      const raw = totalPosScore > 0 && c.score > 0
        ? (c.score / totalPosScore) * remainingBudget
        : 0;
      target = clamp(raw, 0, maxPositionPctPerAsset);
    }
    
    targets.push({ mint: c.mint, targetPct: target, rawTargetPct: target, score: c.score, regime: c.regime });
  }

  // Compute sum of raw (pre-scaling) targets for metadata
  const sumRawTargetsPct = targets.reduce((sum, t) => sum + t.targetPct, 0);
  
  // Initialize scaling metadata
  let scaleFactor = 1.0;
  let clampedCount = 0;
  let redistributionPassesUsed = 0;

  // ========== UTILIZATION SCALING (Lever 2) ==========
  // If deployTargetPct is set and sumTargets < deployTargetPct, scale up non-zero targets
  // This increases capital deployment without changing signal logic
  if (deployTargetPct > 0) {
    const sumTargets = targets.reduce((sum, t) => sum + t.targetPct, 0);
    
    // Only scale if we're below the deployment target and have room to grow
    if (sumTargets > 0 && sumTargets < deployTargetPct) {
      // Cap the effective deploy target to not exceed capMaxTotalExposurePct
      const effectiveDeployTarget = Math.min(deployTargetPct, capMaxTotalExposurePct);
      
      // Track the initial scale factor (before clamping adjustments)
      scaleFactor = effectiveDeployTarget / sumTargets;
      
      // Iterative redistribution: scale targets and redistribute remaining budget after clamping
      let remaining = effectiveDeployTarget;
      const clampedMints = new Set<string>();
      
      // Sort by target descending to clamp highest first
      const sortedTargets = [...targets].filter(t => t.targetPct > 0).sort((a, b) => b.targetPct - a.targetPct);
      
      // Multi-pass redistribution: keep scaling until no more redistribution possible
      for (let pass = 0; pass < 5 && remaining > 0.001; pass++) {
        redistributionPassesUsed = pass + 1;
        
        const unclamped = sortedTargets.filter(t => !clampedMints.has(t.mint) && t.targetPct > 0);
        if (unclamped.length === 0) break;
        
        const unclampedSum = unclamped.reduce((s, t) => s + t.targetPct, 0);
        const clampedSum = targets.reduce((s, t) => clampedMints.has(t.mint) ? s + t.targetPct : s, 0);
        const targetForUnclamped = remaining - clampedSum;
        
        if (targetForUnclamped <= 0 || unclampedSum <= 0) break;
        
        const passScaleFactor = targetForUnclamped / unclampedSum;
        
        let passTotal = clampedSum;
        for (const t of unclamped) {
          const scaled = t.targetPct * passScaleFactor;
          if (scaled > maxPositionPctPerAsset) {
            t.targetPct = maxPositionPctPerAsset;
            clampedMints.add(t.mint);
          } else {
            t.targetPct = scaled;
          }
          passTotal += t.targetPct;
        }
        
        // If we've hit the deploy target or can't redistribute more, stop
        if (passTotal >= effectiveDeployTarget * 0.99 || clampedMints.size === sortedTargets.length) break;
      }
      
      // Count how many mints were clamped
      clampedCount = clampedMints.size;
    }
  }
  // ========== END UTILIZATION SCALING ==========

  // Compute sum of final (post-scaling) targets for metadata
  const sumScaledTargetsPct = targets.reduce((sum, t) => sum + t.targetPct, 0);
  
  const sortedTargets = targets.sort((a, b) => b.targetPct - a.targetPct);
  
  const scalingMeta: ScalingMetadata = {
    sumRawTargetsPct,
    sumScaledTargetsPct,
    scaleFactor,
    clampedCount,
    redistributionPassesUsed,
    targetCount: targets.length,
  };

  return { targets: sortedTargets, scalingMeta };
}
