import { logger } from "../utils/logger.js";
import type { RuntimeConfig } from "./runtime_config.js";
import type { PositionTrackingRow, SlotType } from "./persist.js";
import { evaluatePromotionContinuation } from "./price_metrics.js";

export interface RankablePosition {
  mint: string;
  symbol: string;
  signalScore: number;
  regime: "trend" | "range";
  currentPrice: number;
  entryPrice: number;
  peakPrice: number;
  entryTimeMs: number;
  lastUpdateMs: number;
  usdValue: number;
  slotType: SlotType;
  isHeld: true;
  hasFifoDiscrepancy?: boolean;
}

export interface RankableCandidate {
  mint: string;
  symbol: string;
  signalScore: number;
  regime: "trend" | "range";
  currentPrice: number;
  scannerScore: number;
  volume24h: number;
  liquidity: number;
  priceChange24h: number;
  freshness: number;
  isHeld: false;
}

export type Rankable = RankablePosition | RankableCandidate;

export interface RankedItem {
  mint: string;
  symbol: string;
  rank: number;
  isHeld: boolean;
  slotType?: SlotType;
  pnlPct?: number; // Current PnL percentage for exit logic
  hoursHeld?: number; // Hours held for underperformance tracking
  components: {
    signalComponent: number;
    momentumComponent: number;
    timeComponent: number;
    trailingComponent: number;
    freshnessComponent: number;
    qualityComponent: number;
  };
  flags: {
    isStale: boolean;
    trailingStopTriggered: boolean;
    eligibleForPromotion: boolean;
    eligibleForRotation: boolean;
    // NEW: Stop loss and underperformance flags
    scoutStopLossTriggered: boolean; // Scout hit stop loss (scoutStopLossPct)
    coreLossExitTriggered: boolean; // Core hit loss exit threshold (lossExitPct)
    scoutUnderperforming: boolean; // Scout underperforming for scoutUnderperformMinutes
    scoutGraceExpired: boolean; // Underperforming scout exceeded grace period
    // Break-even lock: once trade works, it should never become a loss
    breakEvenLocked: boolean; // Position reached +6% and stop is now at entry
    breakEvenExitTriggered: boolean; // Break-even locked position dropped below entry floor (-0.5%)
  };
}


export function rankPosition(
  pos: RankablePosition,
  config: RuntimeConfig
): RankedItem {
  const nowMs = Date.now();
  const hoursHeld = (nowMs - pos.entryTimeMs) / (1000 * 60 * 60);
  const hoursSinceUpdate = (nowMs - pos.lastUpdateMs) / (1000 * 60 * 60);
  
  const signalComponent = pos.signalScore * config.rankingSignalWeight;
  
  // SAFETY: Log warning when entry price is missing - stop losses won't work correctly
  if (pos.entryPrice <= 0 && pos.usdValue >= 1) {
    logger.warn({
      mint: pos.mint,
      symbol: pos.symbol,
      entryPrice: pos.entryPrice,
      currentPrice: pos.currentPrice,
      usdValue: pos.usdValue,
      slotType: pos.slotType,
    }, "RANKING_WARNING: Position has no valid entry price - P&L calculations will be unreliable, stop losses disabled");
  }
  
  const pnlPct = pos.entryPrice > 0 
    ? (pos.currentPrice - pos.entryPrice) / pos.entryPrice 
    : 0;
  const momentumComponent = Math.tanh(pnlPct * 5) * config.rankingMomentumWeight;
  
  let timeComponent = 0;
  if (hoursHeld > config.stalePositionHours) {
    const staleHours = hoursHeld - config.stalePositionHours;
    timeComponent = -Math.min(staleHours / 24, 2) * config.rankingTimeDecayWeight;
  }
  
  const isStale = hoursHeld > config.stalePositionHours && Math.abs(pnlPct) < config.stalePnlBandPct;
  if (isStale) {
    timeComponent += config.rankingStalePenalty;
  }
  
  let trailingComponent = 0;
  let trailingStopTriggered = false;
  
  // Trailing stop exit only applies to CORE positions
  // Scouts should be allowed to run - only simple stop losses apply to them
  if (pos.slotType === 'core' && pos.peakPrice > 0 && pos.currentPrice > 0) {
    const dropFromPeak = (pos.peakPrice - pos.currentPrice) / pos.peakPrice;
    
    const trailingThreshold = pnlPct >= config.trailingStopProfitThreshold
      ? config.trailingStopTightPct
      : config.trailingStopBasePct;
    
    if (dropFromPeak > trailingThreshold) {
      // GUARD: Only trigger trailing stop exit if position is actually losing money
      // or has dropped below a minimum profit floor (takeProfitPct / 2).
      const profitFloor = Math.max(0, config.takeProfitPct * 0.5);
      const shouldTriggerExit = pnlPct < profitFloor;
      
      if (shouldTriggerExit) {
        trailingStopTriggered = true;
        trailingComponent = config.rankingTrailingStopPenalty;
      } else {
        // Position dropped from peak but still above profit floor - apply ranking penalty only
        trailingComponent = -dropFromPeak * config.rankingTrailingWeight * 2;
      }
    } else if (dropFromPeak > trailingThreshold * 0.5) {
      trailingComponent = -dropFromPeak * config.rankingTrailingWeight * 2;
    }
  }
  
  // NEW: Stop loss exit logic for scouts (scoutStopLossPct)
  // If a scout position drops below the stop loss threshold, flag for immediate exit
  const scoutStopLossTriggered = 
    pos.slotType === 'scout' && 
    pnlPct < 0 && 
    Math.abs(pnlPct) >= config.scoutStopLossPct;
  
  // NEW: Core loss exit logic (lossExitPct)
  // If a core position drops below the loss exit threshold, flag for forced exit
  const coreLossExitTriggered = 
    pos.slotType === 'core' && 
    pnlPct < 0 && 
    Math.abs(pnlPct) >= config.lossExitPct;
  
  // NEW: Scout underperformance logic (scoutUnderperformMinutes + scoutGraceMinutes)
  // Scout is underperforming if held for X minutes and still in negative PnL
  const minutesHeld = hoursHeld * 60;
  const scoutUnderperforming = 
    pos.slotType === 'scout' && 
    pnlPct < 0 && 
    minutesHeld >= config.scoutUnderperformMinutes;
  
  // Grace period expired = underperforming + held beyond grace period
  const scoutGraceExpired = 
    scoutUnderperforming && 
    minutesHeld >= (config.scoutUnderperformMinutes + config.scoutGraceMinutes);
  
  // BREAK-EVEN LOCK: Once a position reaches +6% (breakEvenLockProfitPct), 
  // the effective stop becomes entry price. This means the trade should never become a loss.
  // If position was at +6% and drops below entry (pnlPct < 0), trigger exit.
  const breakEvenLockThreshold = config.breakEvenLockProfitPct;
  const breakEvenLocked = pnlPct >= breakEvenLockThreshold || 
    (pos.peakPrice > 0 && pos.entryPrice > 0 && 
     ((pos.peakPrice - pos.entryPrice) / pos.entryPrice) >= breakEvenLockThreshold);
  
  // BREAK-EVEN EXIT: Dedicated flag for break-even lock exit
  // This is SEPARATE from trailingStopTriggered to avoid conflicts with core trailing stop logic
  // Use -0.005 (0.5%) as buffer for fees/slippage instead of exact 0
  const breakEvenExitThreshold = -0.005;
  const breakEvenExitTriggered = breakEvenLocked && pnlPct < breakEvenExitThreshold;
  
  if (breakEvenExitTriggered) {
    // Add ranking penalty for immediate visibility in rotation
    trailingComponent = config.rankingTrailingStopPenalty;
    logger.info({
      mint: pos.mint,
      symbol: pos.symbol,
      pnlPct: (pnlPct * 100).toFixed(2) + '%',
      breakEvenLockThreshold: (breakEvenLockThreshold * 100).toFixed(0) + '%',
      exitThreshold: (breakEvenExitThreshold * 100).toFixed(1) + '%',
    }, "BREAK_EVEN_EXIT: Position dropped below entry after hitting profit threshold - flagged for immediate exit");
  }
  
  // Minimum hours required before promotion (use promotionMinHoursHeld setting)
  const minHoursRequired = config.promotionMinHoursHeld;
  
  // Basic promotion eligibility (additional continuation filters applied async in evaluatePromotionWithContinuation)
  const eligibleForPromotion = 
    pos.slotType === 'scout' &&
    pos.regime === 'trend' &&
    pnlPct >= config.promotionMinPnlPct &&
    pos.signalScore >= config.promotionMinSignalScore &&
    hoursHeld >= minHoursRequired &&
    !pos.hasFifoDiscrepancy; // Block promotion if FIFO/tracking entry prices differ significantly
  
  const rank = signalComponent + momentumComponent + timeComponent + trailingComponent;
  
  logger.debug({
    mint: pos.mint,
    symbol: pos.symbol,
    rank,
    weights: {
      signal: config.rankingSignalWeight,
      momentum: config.rankingMomentumWeight,
      trailing: config.rankingTrailingWeight,
    },
    penalties: {
      stale: config.rankingStalePenalty,
      trailingStop: config.rankingTrailingStopPenalty,
    },
    components: {
      signalComponent,
      momentumComponent,
      timeComponent,
      trailingComponent,
    },
  }, "Position ranked");
  
  return {
    mint: pos.mint,
    symbol: pos.symbol,
    rank,
    isHeld: true,
    slotType: pos.slotType,
    pnlPct,
    hoursHeld,
    components: {
      signalComponent,
      momentumComponent,
      timeComponent,
      trailingComponent,
      freshnessComponent: 0,
      qualityComponent: 0,
    },
    flags: {
      isStale,
      trailingStopTriggered,
      eligibleForPromotion,
      eligibleForRotation: rank < 0,
      scoutStopLossTriggered,
      coreLossExitTriggered,
      scoutUnderperforming,
      scoutGraceExpired,
      breakEvenLocked,
      breakEvenExitTriggered,
    },
  };
}

export function rankCandidate(
  candidate: RankableCandidate,
  config: RuntimeConfig
): RankedItem {
  const signalComponent = candidate.signalScore * config.rankingSignalWeight;
  
  const momentumNorm = Math.tanh(candidate.priceChange24h / 100);
  const momentumComponent = momentumNorm * config.rankingMomentumWeight;
  
  const freshnessComponent = candidate.freshness * config.rankingFreshnessWeight;
  
  let qualityComponent = 0;
  if (candidate.volume24h > 1000000) qualityComponent += 0.5;
  else if (candidate.volume24h > 100000) qualityComponent += 0.25;
  
  if (candidate.liquidity > 100000) qualityComponent += 0.5;
  else if (candidate.liquidity > 50000) qualityComponent += 0.25;
  
  qualityComponent += Math.min(candidate.scannerScore / 10, 1.0);
  qualityComponent *= config.rankingQualityWeight;
  
  const rank = signalComponent + momentumComponent + freshnessComponent + qualityComponent;
  
  logger.debug({
    mint: candidate.mint,
    symbol: candidate.symbol,
    rank,
    weights: {
      signal: config.rankingSignalWeight,
      momentum: config.rankingMomentumWeight,
      freshness: config.rankingFreshnessWeight,
      quality: config.rankingQualityWeight,
    },
    components: {
      signalComponent,
      momentumComponent,
      freshnessComponent,
      qualityComponent,
    },
  }, "Candidate ranked");
  
  return {
    mint: candidate.mint,
    symbol: candidate.symbol,
    rank,
    isHeld: false,
    components: {
      signalComponent,
      momentumComponent,
      timeComponent: 0,
      trailingComponent: 0,
      freshnessComponent,
      qualityComponent,
    },
    flags: {
      isStale: false,
      trailingStopTriggered: false,
      eligibleForPromotion: false,
      eligibleForRotation: false,
      scoutStopLossTriggered: false,
      coreLossExitTriggered: false,
      scoutUnderperforming: false,
      scoutGraceExpired: false,
      breakEvenLocked: false,
      breakEvenExitTriggered: false,
    },
  };
}

export interface RotationDecision {
  shouldRotate: boolean;
  sellMint?: string;
  sellSymbol?: string;
  sellRank?: number;
  buyMint?: string;
  buySymbol?: string;
  buyRank?: number;
  rankDelta?: number;
  reasonCode: string;
}

export function evaluateRotation(
  heldPositions: RankedItem[],
  candidates: RankedItem[],
  config: RuntimeConfig,
  slotCounts: { core: number; scout: number }
): RotationDecision {
  // PRIORITY 0: BREAK-EVEN LOCK EXIT - HIGHEST PRIORITY
  // Positions that hit +6% but dropped below entry (-0.5%) must exit FIRST
  // Uses dedicated breakEvenExitTriggered flag to avoid conflicts with core trailing stop
  const breakEvenExitPositions = heldPositions
    .filter(p => p.flags.breakEvenExitTriggered)
    .sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0)); // Worst first
  
  if (breakEvenExitPositions.length > 0) {
    const worst = breakEvenExitPositions[0];
    logger.info({
      mint: worst.mint,
      symbol: worst.symbol,
      pnlPct: worst.pnlPct,
      slotType: worst.slotType,
    }, "BREAK_EVEN_EXIT: Position dropped below entry after hitting profit threshold - IMMEDIATE EXIT");
    return {
      shouldRotate: true,
      sellMint: worst.mint,
      sellSymbol: worst.symbol,
      sellRank: worst.rank,
      reasonCode: 'break_even_lock_exit',
    };
  }
  
  // PRIORITY 1: Check for immediate exit triggers (stop loss, loss exit, grace expired)
  // These take precedence over normal rotation logic
  
  // Scout stop loss - high priority exit
  const scoutStopLossPositions = heldPositions
    .filter(p => p.flags.scoutStopLossTriggered)
    .sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0)); // Worst loss first
  
  if (scoutStopLossPositions.length > 0) {
    const worst = scoutStopLossPositions[0];
    logger.info({
      mint: worst.mint,
      symbol: worst.symbol,
      pnlPct: worst.pnlPct,
      threshold: config.scoutStopLossPct,
    }, "SCOUT_STOP_LOSS: Triggered immediate exit");
    return {
      shouldRotate: true,
      sellMint: worst.mint,
      sellSymbol: worst.symbol,
      sellRank: worst.rank,
      reasonCode: 'scout_stop_loss_exit',
    };
  }
  
  // Core loss exit - high priority for core positions
  const coreLossExitPositions = heldPositions
    .filter(p => p.flags.coreLossExitTriggered)
    .sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0)); // Worst loss first
  
  if (coreLossExitPositions.length > 0) {
    const worst = coreLossExitPositions[0];
    logger.info({
      mint: worst.mint,
      symbol: worst.symbol,
      pnlPct: worst.pnlPct,
      threshold: config.lossExitPct,
    }, "CORE_LOSS_EXIT: Triggered forced exit");
    return {
      shouldRotate: true,
      sellMint: worst.mint,
      sellSymbol: worst.symbol,
      sellRank: worst.rank,
      reasonCode: 'core_loss_exit',
    };
  }
  
  // Scout grace expired - underperforming scout past grace period (but NOT break-even locked)
  const scoutGraceExpiredPositions = heldPositions
    .filter(p => p.flags.scoutGraceExpired && !p.flags.breakEvenLocked)
    .sort((a, b) => (a.pnlPct ?? 0) - (b.pnlPct ?? 0)); // Worst loss first
  
  if (scoutGraceExpiredPositions.length > 0) {
    const worst = scoutGraceExpiredPositions[0];
    logger.info({
      mint: worst.mint,
      symbol: worst.symbol,
      pnlPct: worst.pnlPct,
      hoursHeld: worst.hoursHeld,
      underperformMinutes: config.scoutUnderperformMinutes,
      graceMinutes: config.scoutGraceMinutes,
    }, "SCOUT_GRACE_EXPIRED: Underperforming scout dropped");
    return {
      shouldRotate: true,
      sellMint: worst.mint,
      sellSymbol: worst.symbol,
      sellRank: worst.rank,
      reasonCode: 'scout_underperform_grace_expired',
    };
  }
  
  // PRIORITY 2: Normal rotation logic (trailing stops, stale positions)
  // BREAK-EVEN LOCK: Protect profitable positions from stale/churn exits but allow opportunity-cost rotations
  const eligibleForRotation = heldPositions
    .filter(p => {
      // Trailing stops (core only, excludes break-even which was already handled in Priority 0)
      if (p.flags.trailingStopTriggered && p.slotType === 'core') {
        return true;
      }
      
      // BREAK-EVEN LOCKED POSITIONS:
      // - Protected from stale exits (handled below by excluding isStale)
      // - Still eligible for opportunity-cost rotation via rotationThreshold
      // - Include ALL break-even locked positions so they can be evaluated against candidates
      if (p.flags.breakEvenLocked) {
        // Always include - rotation threshold check will gate actual exit
        return true;
      }
      
      // Non-break-even-locked positions: stale exits and regular rotation apply
      return p.flags.eligibleForRotation || p.flags.isStale;
    })
    .sort((a, b) => a.rank - b.rank);
  
  if (eligibleForRotation.length === 0) {
    return { shouldRotate: false, reasonCode: 'no_eligible_positions' };
  }
  
  const worstHeld = eligibleForRotation[0];
  
  if (worstHeld.flags.trailingStopTriggered) {
    return {
      shouldRotate: true,
      sellMint: worstHeld.mint,
      sellSymbol: worstHeld.symbol,
      sellRank: worstHeld.rank,
      reasonCode: 'trailing_stop_exit',
    };
  }
  
  if (worstHeld.flags.isStale && !worstHeld.flags.breakEvenLocked) {
    const hoursStale = -worstHeld.components.timeComponent / config.rankingTimeDecayWeight * 24 + config.stalePositionHours;
    if (hoursStale >= config.staleExitHours) {
      return {
        shouldRotate: true,
        sellMint: worstHeld.mint,
        sellSymbol: worstHeld.symbol,
        sellRank: worstHeld.rank,
        reasonCode: 'stale_timeout_exit',
      };
    }
  }
  
  const totalSlots = config.coreSlots + config.scoutSlots;
  const currentPositions = slotCounts.core + slotCounts.scout;
  
  if (currentPositions < totalSlots && candidates.length > 0) {
    return { shouldRotate: false, reasonCode: 'slots_available_no_rotation_needed' };
  }
  
  const viableCandidates = candidates
    .filter(c => c.rank > 0 && !c.isHeld)
    .sort((a, b) => b.rank - a.rank);
  
  if (viableCandidates.length === 0) {
    // Trailing stops can exit without replacement
    if (worstHeld.flags.trailingStopTriggered) {
      return {
        shouldRotate: true,
        sellMint: worstHeld.mint,
        sellSymbol: worstHeld.symbol,
        sellRank: worstHeld.rank,
        reasonCode: 'trailing_stop_exit',
      };
    }
    // Stale exits without replacement - but NOT for break-even locked positions
    if (worstHeld.flags.isStale && !worstHeld.flags.breakEvenLocked) {
      return {
        shouldRotate: true,
        sellMint: worstHeld.mint,
        sellSymbol: worstHeld.symbol,
        sellRank: worstHeld.rank,
        reasonCode: 'stale_exit_no_replacement',
      };
    }
    return { shouldRotate: false, reasonCode: 'no_viable_candidates' };
  }
  
  const bestCandidate = viableCandidates[0];
  const rankDelta = bestCandidate.rank - worstHeld.rank;
  
  if (rankDelta >= config.rotationThreshold) {
    return {
      shouldRotate: true,
      sellMint: worstHeld.mint,
      sellSymbol: worstHeld.symbol,
      sellRank: worstHeld.rank,
      buyMint: bestCandidate.mint,
      buySymbol: bestCandidate.symbol,
      buyRank: bestCandidate.rank,
      rankDelta,
      reasonCode: 'opportunity_cost_rotation',
    };
  }
  
  // Stale rotation with any positive delta - but NOT for break-even locked positions
  if (worstHeld.flags.isStale && !worstHeld.flags.breakEvenLocked && rankDelta > 0) {
    return {
      shouldRotate: true,
      sellMint: worstHeld.mint,
      sellSymbol: worstHeld.symbol,
      sellRank: worstHeld.rank,
      buyMint: bestCandidate.mint,
      buySymbol: bestCandidate.symbol,
      buyRank: bestCandidate.rank,
      rankDelta,
      reasonCode: 'stale_rotation_with_replacement',
    };
  }
  
  return { shouldRotate: false, reasonCode: 'threshold_not_met' };
}

export function evaluatePromotion(
  heldPositions: RankedItem[],
  config: RuntimeConfig,
  slotCounts: { core: number; scout: number }
): { shouldPromote: boolean; mint?: string; symbol?: string } {
  if (slotCounts.core >= config.coreSlots) {
    return { shouldPromote: false };
  }
  
  const eligibleForPromotion = heldPositions
    .filter(p => p.flags.eligibleForPromotion && p.slotType === 'scout')
    .sort((a, b) => b.rank - a.rank);
  
  if (eligibleForPromotion.length === 0) {
    return { shouldPromote: false };
  }
  
  const best = eligibleForPromotion[0];
  return {
    shouldPromote: true,
    mint: best.mint,
    symbol: best.symbol,
  };
}

export interface PromotionEvalResult {
  shouldPromote: boolean;
  mint?: string;
  symbol?: string;
  failReason?: string;
  metrics?: {
    pnlPct: number;
    hoursHeld: number;
    signalScore: number;
    ret15: number | null;
    ret60: number | null;
    drawdown30: number | null;
    sma60: number | null;
  };
}

export async function evaluatePromotionWithContinuation(
  heldPositions: RankedItem[],
  config: RuntimeConfig,
  slotCounts: { core: number; scout: number }
): Promise<PromotionEvalResult> {
  if (slotCounts.core >= config.coreSlots) {
    return { shouldPromote: false, failReason: 'CORE_SLOTS_FULL' };
  }
  
  const eligibleForPromotion = heldPositions
    .filter(p => p.flags.eligibleForPromotion && p.slotType === 'scout')
    .sort((a, b) => b.rank - a.rank);
  
  if (eligibleForPromotion.length === 0) {
    return { shouldPromote: false, failReason: 'NO_ELIGIBLE_CANDIDATES' };
  }
  
  for (const candidate of eligibleForPromotion) {
    const continuationEval = await evaluatePromotionContinuation(candidate.mint, {
      promotionRequireRet60Min: config.promotionRequireRet60Min,
      promotionRequireRet15Min: config.promotionRequireRet15Min,
      promotionAvoidTopDrawdown30: config.promotionAvoidTopDrawdown30,
      promotionSmaMinutes: config.promotionSmaMinutes,
      promotionRequireAboveSma: config.promotionRequireAboveSma,
    });
    
    logger.info({
      mint: candidate.mint,
      symbol: candidate.symbol,
      pnlPct: candidate.pnlPct,
      hoursHeld: candidate.hoursHeld,
      ret15: continuationEval.metrics.ret15,
      ret60: continuationEval.metrics.ret60,
      drawdown30: continuationEval.metrics.drawdown30,
      sma60: continuationEval.metrics.sma60,
      pass: continuationEval.pass,
      failReason: continuationEval.failReason,
    }, "PROMO_EVAL");
    
    if (continuationEval.pass) {
      return {
        shouldPromote: true,
        mint: candidate.mint,
        symbol: candidate.symbol,
        metrics: {
          pnlPct: candidate.pnlPct ?? 0,
          hoursHeld: candidate.hoursHeld ?? 0,
          signalScore: candidate.components.signalComponent,
          ret15: continuationEval.metrics.ret15,
          ret60: continuationEval.metrics.ret60,
          drawdown30: continuationEval.metrics.drawdown30,
          sma60: continuationEval.metrics.sma60,
        },
      };
    }
  }
  
  return { 
    shouldPromote: false, 
    failReason: 'ALL_CANDIDATES_FAILED_CONTINUATION' 
  };
}

export function buildPositionFromTracking(
  tracking: PositionTrackingRow,
  signalScore: number,
  regime: "trend" | "range",
  currentPrice: number,
  usdValue: number,
  symbol: string,
  hasFifoDiscrepancy: boolean = false
): RankablePosition {
  return {
    mint: tracking.mint,
    symbol,
    signalScore,
    regime,
    currentPrice,
    entryPrice: Number(tracking.entry_price),
    peakPrice: Number(tracking.peak_price),
    entryTimeMs: new Date(tracking.entry_time).getTime(),
    lastUpdateMs: new Date(tracking.last_update).getTime(),
    usdValue,
    slotType: tracking.slot_type,
    isHeld: true,
    hasFifoDiscrepancy,
  };
}

export function buildCandidateFromScanner(
  scannerToken: {
    mint: string;
    symbol: string;
    score: number;
    volume24h: number;
    liquidity: number;
    priceChange24h: number;
    price: number;
  },
  signalScore: number,
  regime: "trend" | "range",
  freshness: number = 1.0
): RankableCandidate {
  return {
    mint: scannerToken.mint,
    symbol: scannerToken.symbol,
    signalScore,
    regime,
    currentPrice: scannerToken.price,
    scannerScore: scannerToken.score,
    volume24h: scannerToken.volume24h,
    liquidity: scannerToken.liquidity,
    priceChange24h: scannerToken.priceChange24h,
    freshness,
    isHeld: false,
  };
}
