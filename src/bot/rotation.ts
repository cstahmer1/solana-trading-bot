import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import {
  rankPosition,
  rankCandidate,
  evaluateRotation,
  evaluatePromotion,
  evaluatePromotionWithContinuation,
  buildPositionFromTracking,
  buildCandidateFromScanner,
  type RankedItem,
  type RotationDecision,
} from "./ranking.js";
import {
  getAllPositionTracking,
  getSlotCounts,
  upsertPositionTracking,
  updatePositionPrice,
  deletePositionTracking,
  updatePositionSlotType,
  insertRotationLog,
  getEarliestTradeTime,
  type PositionTrackingRow,
  type SlotType,
} from "./persist.js";
import { MINT_SOL, MINT_USDC } from "./config.js";
import { broadcastRotation, type RotationEvent } from "../dashboard/server.js";
import { insertTradeLot, getBatchPositionCostBasis } from "./pnl_engine.js";

export interface PositionInfo {
  mint: string;
  symbol: string;
  amount: number;
  usdValue: number;
  priceUsd: number;
}

export interface SignalInfo {
  mint: string;
  score: number;
  regime: "trend" | "range";
}

export interface CandidateInfo {
  mint: string;
  symbol: string;
  score: number;
  volume24h: number;
  liquidity: number;
  priceChange24h: number;
  price: number;
}

export interface RotationContext {
  positions: PositionInfo[];
  signals: Map<string, SignalInfo>;
  candidates: CandidateInfo[];
  entryPrices: Map<string, { avgCostUsd: number; totalTokens: number }>;
}

export interface RotationResult {
  rankedPositions: RankedItem[];
  rankedCandidates: RankedItem[];
  decision: RotationDecision;
  promotionCandidate?: { mint: string; symbol: string };
  trailingStopTriggers: RankedItem[];
  staleExitTriggers: RankedItem[];
  scoutStopLossTriggers: RankedItem[];
  coreLossExitTriggers: RankedItem[];
  scoutUnderperformTriggers: RankedItem[];
  slotCounts: { core: number; scout: number };
}

export interface WalletHolding {
  mint: string;
  amount: number;
  priceUsd: number;
  symbol: string;
}

export async function syncPositionTracking(
  entryPrices: Map<string, { avgCostUsd: number; totalTokens: number }>,
  walletHoldings: WalletHolding[]
): Promise<void> {
  const existingTracking = await getAllPositionTracking();
  const existingMints = new Set(existingTracking.map(t => t.mint));
  const trackingMap = new Map<string, PositionTrackingRow>();
  for (const t of existingTracking) {
    trackingMap.set(t.mint, t);
  }
  
  // Build a map of wallet holdings (raw token amounts from wallet)
  const holdingsMap = new Map<string, WalletHolding>();
  for (const h of walletHoldings) {
    holdingsMap.set(h.mint, h);
  }
  
  const config = getConfig();
  const MIN_USD_VALUE = config.minPositionUsd;
  const DUST_USD_THRESHOLD = config.dustThresholdUsd;

  // WALLET-DRIVEN: For every token in wallet with value >= $1, ensure position exists
  for (const holding of walletHoldings) {
    if (holding.mint === MINT_SOL || holding.mint === MINT_USDC) continue;
    
    // Skip if no valid price data
    if (!holding.priceUsd || holding.priceUsd <= 0) {
      // If we already have tracking, keep it but don't update price
      if (existingMints.has(holding.mint)) {
        logger.debug({ mint: holding.mint, symbol: holding.symbol }, "Position has no price - keeping existing tracking");
      }
      continue;
    }
    
    const usdValue = holding.amount * holding.priceUsd;
    
    // Skip if USD value is below minimum tracking threshold
    if (usdValue < MIN_USD_VALUE) continue;

    const entry = entryPrices.get(holding.mint);
    const entryPrice = entry?.avgCostUsd ?? holding.priceUsd;
    const totalTokens = entry?.totalTokens ?? holding.amount;

    if (existingMints.has(holding.mint)) {
      // Update existing position with current price
      await updatePositionPrice(holding.mint, holding.priceUsd);
    } else {
      // CREATE NEW POSITION - token is in wallet but not tracked yet
      // Look up earliest trade time from reconciled_trades to preserve real entry time
      const earliestTradeTime = await getEarliestTradeTime(holding.mint);
      const entryTime = earliestTradeTime 
        ? (typeof earliestTradeTime === 'string' ? new Date(earliestTradeTime) : earliestTradeTime)
        : new Date();
      
      await upsertPositionTracking({
        mint: holding.mint,
        entryPrice,
        currentPrice: holding.priceUsd,
        totalTokens,
        slotType: 'scout',
        entryTime: earliestTradeTime || undefined,
      });
      
      // CRITICAL: Also create position_lot for FIFO PnL tracking
      // This ensures discovered wallet tokens have proper cost basis for PnL calculation
      const costBasisUsd = entryPrice * totalTokens;
      await insertTradeLot({
        tx_sig: `DISCOVER_${holding.mint.slice(0, 8)}_${Date.now()}`,
        timestamp: entryTime,
        mint: holding.mint,
        side: 'buy',
        quantity: totalTokens,
        usd_value: costBasisUsd,
        unit_price_usd: entryPrice,
        sol_price_usd: null,
        source: 'wallet_discovery',
        status: 'confirmed',
      });
      
      logger.info({ 
        mint: holding.mint, 
        symbol: holding.symbol,
        entryPrice,
        amount: holding.amount,
        usdValue,
        costBasisUsd,
        entryTime: earliestTradeTime || 'now',
      }, "Created position tracking and lot for wallet token");
    }
  }

  // CLEANUP: Remove positions where USD value is dust (essentially sold)
  // Skip sniper positions - they are managed by the sniper module
  for (const tracking of existingTracking) {
    if ((tracking as any).source === 'sniper') continue;
    
    const holding = holdingsMap.get(tracking.mint);
    
    if (!holding) {
      // Token not in wallet at all - definitely sold
      await deletePositionTracking(tracking.mint);
      logger.info({ mint: tracking.mint }, "Removed position tracking for exited position (not in wallet)");
      continue;
    }
    
    // Calculate USD value using current price from wallet or last tracked price
    const priceUsd = holding.priceUsd > 0 ? holding.priceUsd : tracking.last_price;
    const usdValue = holding.amount * priceUsd;
    
    if (usdValue < DUST_USD_THRESHOLD) {
      // Position is effectively dust - delete tracking
      await deletePositionTracking(tracking.mint);
      logger.info({ mint: tracking.mint, usdValue }, "Removed position tracking for dust position");
    }
  }
}

export async function evaluatePortfolio(ctx: RotationContext): Promise<RotationResult> {
  const config = getConfig();
  const allTrackingRaw = await getAllPositionTracking();
  // Filter out sniper positions - they have independent TP/SL management
  const allTracking = allTrackingRaw.filter(t => (t as any).source !== 'sniper');
  const slotCounts = await getSlotCounts();
  
  const trackingMap = new Map<string, PositionTrackingRow>();
  for (const t of allTracking) {
    trackingMap.set(t.mint, t);
  }

  // CRITICAL: Fetch authoritative FIFO cost basis from position_lots
  // This prevents incorrect PnL% calculations when position_tracking.entry_price is corrupted
  const positionMints = ctx.positions
    .filter(p => p.mint !== MINT_SOL && p.mint !== MINT_USDC && p.usdValue >= 1)
    .map(p => p.mint);
  const fifoCostBasis = await getBatchPositionCostBasis(positionMints);

  const rankedPositions: RankedItem[] = [];
  const trailingStopTriggers: RankedItem[] = [];
  const staleExitTriggers: RankedItem[] = [];
  const scoutStopLossTriggers: RankedItem[] = [];
  const coreLossExitTriggers: RankedItem[] = [];
  const scoutUnderperformTriggers: RankedItem[] = [];

  for (const pos of ctx.positions) {
    if (pos.mint === MINT_SOL || pos.mint === MINT_USDC) continue;
    if (pos.usdValue < 1) continue;

    const tracking = trackingMap.get(pos.mint);
    if (!tracking) continue;

    const signal = ctx.signals.get(pos.mint);
    const signalScore = signal?.score ?? 0;
    const regime = signal?.regime ?? "range";

    // Use FIFO cost basis as authoritative source, fallback to tracking.entry_price
    const fifoData = fifoCostBasis.get(pos.mint);
    let entryPriceToUse = Number(tracking.entry_price);
    let hasFifoDiscrepancy = false;
    let fifoQuantityMismatch = false;
    
    // CRITICAL FIX: Validate FIFO quantity against authoritative wallet balance
    // Use pos.amount (direct from wallet) NOT pos.usdValue/pos.priceUsd (derived/unreliable)
    if (fifoData && fifoData.avgCostUsd > 0 && fifoData.totalQuantity > 0) {
      const walletTokenQty = pos.amount;
      const fifoCoverageRatio = walletTokenQty > 0 ? fifoData.totalQuantity / walletTokenQty : 1;
      
      // Check both bounds: <50% (missing lots) OR >150% (inflated lots from decimal errors)
      const coverageIsReliable = fifoCoverageRatio >= 0.5 && fifoCoverageRatio <= 1.5;
      
      if (!coverageIsReliable && walletTokenQty > 0) {
        fifoQuantityMismatch = true;
        hasFifoDiscrepancy = true;
        
        // QUARANTINE: Use tracking entry price (from position_tracking table)
        // This was set at buy time before the FIFO corruption occurred
        // Gate promotions via hasFifoDiscrepancy flag
        const trackingPrice = Number(tracking.entry_price);
        
        if (trackingPrice > 0) {
          entryPriceToUse = trackingPrice;
        } else {
          // No tracking price - use current price as last resort
          entryPriceToUse = pos.priceUsd;
        }
        
        logger.error({
          mint: pos.mint,
          symbol: pos.symbol,
          fifoTotalQty: fifoData.totalQuantity,
          walletTokenQty,
          fifoCoverageRatio: (fifoCoverageRatio * 100).toFixed(1) + '%',
          fifoAvgCost: fifoData.avgCostUsd,
          trackingEntryPrice: trackingPrice,
          selectedEntryPrice: entryPriceToUse,
          currentPrice: pos.priceUsd,
          failureType: fifoCoverageRatio < 0.5 ? 'UNDER_COVERAGE' : 'OVER_COVERAGE',
          quarantined: true,
        }, "FIFO_QUARANTINE: Coverage outside 50%-150% - using tracking price, promotion blocked");
      } else if (!coverageIsReliable) {
        // walletTokenQty is 0 - can't validate, use tracking
        hasFifoDiscrepancy = true;
        const trackingPrice = Number(tracking.entry_price);
        entryPriceToUse = trackingPrice > 0 ? trackingPrice : pos.priceUsd;
      } else {
        // FIFO coverage is acceptable (50%-150%), use FIFO avg cost
        entryPriceToUse = fifoData.avgCostUsd;
        
        // Log if there's a significant discrepancy for debugging
        const trackingPrice = Number(tracking.entry_price);
        if (trackingPrice > 0 && Math.abs(entryPriceToUse - trackingPrice) / trackingPrice > 0.5) {
          hasFifoDiscrepancy = true; // Mark as having significant discrepancy - blocks promotion
          logger.warn({
            mint: pos.mint,
            symbol: pos.symbol,
            fifoAvgCost: entryPriceToUse,
            trackingEntryPrice: trackingPrice,
            discrepancyPct: ((entryPriceToUse - trackingPrice) / trackingPrice * 100).toFixed(1),
            fifoCoverageRatio: (fifoCoverageRatio * 100).toFixed(1) + '%',
            promotionBlocked: true,
          }, "Significant entry price discrepancy - using FIFO cost basis, promotion BLOCKED");
        }
      }
    } else if (fifoData && fifoData.avgCostUsd > 0) {
      // FIFO has avg cost but no quantity - use with caution
      entryPriceToUse = fifoData.avgCostUsd;
    } else if (entryPriceToUse <= 0) {
      // If both FIFO and tracking are invalid, use current price as last resort
      logger.warn({
        mint: pos.mint,
        symbol: pos.symbol,
        fifoData,
        trackingEntryPrice: tracking.entry_price,
      }, "No valid cost basis found - using current price as fallback");
      entryPriceToUse = pos.priceUsd;
    }

    // Create a modified tracking row with correct entry price
    const correctedTracking: PositionTrackingRow = {
      ...tracking,
      entry_price: entryPriceToUse,
    };

    const rankable = buildPositionFromTracking(
      correctedTracking,
      signalScore,
      regime,
      pos.priceUsd,
      pos.usdValue,
      pos.symbol,
      hasFifoDiscrepancy
    );

    const ranked = rankPosition(rankable, config);
    rankedPositions.push(ranked);

    if (ranked.flags.trailingStopTriggered) {
      trailingStopTriggers.push(ranked);
    }
    if (ranked.flags.isStale) {
      const hoursHeld = (Date.now() - rankable.entryTimeMs) / (1000 * 60 * 60);
      if (hoursHeld >= config.staleExitHours) {
        staleExitTriggers.push(ranked);
      }
    }
    if (ranked.flags.scoutStopLossTriggered) {
      scoutStopLossTriggers.push(ranked);
    }
    if (ranked.flags.coreLossExitTriggered) {
      coreLossExitTriggers.push(ranked);
    }
    if (ranked.flags.scoutGraceExpired) {
      scoutUnderperformTriggers.push(ranked);
    }
  }

  const rankedCandidates: RankedItem[] = [];
  const heldMints = new Set(ctx.positions.map(p => p.mint));

  for (const candidate of ctx.candidates) {
    if (heldMints.has(candidate.mint)) continue;

    const signal = ctx.signals.get(candidate.mint);
    const signalScore = signal?.score ?? 0;
    const regime = signal?.regime ?? "range";

    const hasScannerScore = candidate.score > 0;
    const hasPositiveMomentum = candidate.priceChange24h > 0;
    const hasGoodLiquidity = candidate.liquidity >= config.scannerMinLiquidity;
    
    if (!hasScannerScore && signalScore <= 0 && !hasPositiveMomentum) continue;
    if (!hasGoodLiquidity) continue;

    const rankable = buildCandidateFromScanner(
      candidate,
      signalScore,
      regime,
      1.0
    );

    const ranked = rankCandidate(rankable, config);
    if (ranked.rank > 0.5) {
      rankedCandidates.push(ranked);
    }
  }

  rankedPositions.sort((a, b) => b.rank - a.rank);
  rankedCandidates.sort((a, b) => b.rank - a.rank);

  const decision = evaluateRotation(rankedPositions, rankedCandidates, config, slotCounts);

  // Use continuation-only promotion filter with avoid-top and SMA checks
  const promotionResult = await evaluatePromotionWithContinuation(rankedPositions, config, slotCounts);
  const promotionCandidate = promotionResult.shouldPromote
    ? { mint: promotionResult.mint!, symbol: promotionResult.symbol! }
    : undefined;

  return {
    rankedPositions,
    rankedCandidates,
    decision,
    promotionCandidate,
    trailingStopTriggers,
    staleExitTriggers,
    scoutStopLossTriggers,
    coreLossExitTriggers,
    scoutUnderperformTriggers,
    slotCounts,
  };
}

export async function executePromotion(
  mint: string, 
  symbol: string,
  currentPrice?: number
): Promise<void> {
  await updatePositionSlotType(mint, 'core', { 
    resetPeakToPrice: currentPrice 
  });
  await insertRotationLog({
    action: 'promotion',
    boughtMint: mint,
    boughtSymbol: symbol,
    reasonCode: 'scout_to_core_promotion',
    meta: { 
      promotedAt: new Date().toISOString(),
      peakResetToPrice: currentPrice ?? null,
    },
  });
  
  try {
    broadcastRotation({
      action: 'promotion',
      boughtMint: mint,
      boughtSymbol: symbol,
      reasonCode: 'scout_to_core_promotion',
      slotType: 'core',
      ts: new Date().toISOString(),
    });
  } catch (e) {
    logger.debug({ error: e }, "Failed to broadcast promotion event");
  }
  
  logger.info({ 
    mint, 
    symbol,
    peakResetToPrice: currentPrice ?? 'not provided'
  }, "Promoted scout to core position (peak price reset for fresh trailing stop)");
}

export async function logRotationDecision(
  decision: RotationDecision,
  meta?: Record<string, any>
): Promise<void> {
  if (!decision.shouldRotate) return;

  const action = decision.buyMint ? 'rotation' : 'exit';
  
  await insertRotationLog({
    action,
    soldMint: decision.sellMint,
    soldSymbol: decision.sellSymbol,
    boughtMint: decision.buyMint,
    boughtSymbol: decision.buySymbol,
    reasonCode: decision.reasonCode,
    soldRank: decision.sellRank,
    boughtRank: decision.buyRank,
    rankDelta: decision.rankDelta,
    meta: meta ?? {},
  });
  
  try {
    const broadcastAction = decision.reasonCode.includes('trailing_stop') ? 'trailing_stop' 
      : decision.reasonCode.includes('stale') ? 'stale_exit'
      : decision.reasonCode.includes('scout_stop_loss') ? 'scout_stop_loss'
      : decision.reasonCode.includes('core_loss_exit') ? 'core_loss_exit'
      : decision.reasonCode.includes('underperform') ? 'scout_underperform'
      : 'rotation';
    
    broadcastRotation({
      action: broadcastAction,
      soldMint: decision.sellMint,
      soldSymbol: decision.sellSymbol,
      boughtMint: decision.buyMint,
      boughtSymbol: decision.buySymbol,
      reasonCode: decision.reasonCode,
      rankDelta: decision.rankDelta,
      ts: new Date().toISOString(),
    });
  } catch (e) {
    logger.debug({ error: e }, "Failed to broadcast rotation event");
  }
}

export function getRotationSummary(result: RotationResult): string {
  const lines: string[] = [];
  
  lines.push(`Slots: ${result.slotCounts.core} core / ${result.slotCounts.scout} scout`);
  lines.push(`Positions ranked: ${result.rankedPositions.length}`);
  lines.push(`Candidates ranked: ${result.rankedCandidates.length}`);
  
  if (result.trailingStopTriggers.length > 0) {
    lines.push(`Trailing stop triggers: ${result.trailingStopTriggers.map(t => t.symbol).join(', ')}`);
  }
  
  if (result.staleExitTriggers.length > 0) {
    lines.push(`Stale exit triggers: ${result.staleExitTriggers.map(t => t.symbol).join(', ')}`);
  }
  
  if (result.scoutStopLossTriggers.length > 0) {
    lines.push(`Scout stop loss: ${result.scoutStopLossTriggers.map(t => `${t.symbol} (${((t.pnlPct ?? 0) * 100).toFixed(1)}%)`).join(', ')}`);
  }
  
  if (result.coreLossExitTriggers.length > 0) {
    lines.push(`Core loss exit: ${result.coreLossExitTriggers.map(t => `${t.symbol} (${((t.pnlPct ?? 0) * 100).toFixed(1)}%)`).join(', ')}`);
  }
  
  if (result.scoutUnderperformTriggers.length > 0) {
    lines.push(`Scout underperform: ${result.scoutUnderperformTriggers.map(t => `${t.symbol} (${t.hoursHeld?.toFixed(1)}h)`).join(', ')}`);
  }
  
  if (result.promotionCandidate) {
    lines.push(`Promotion candidate: ${result.promotionCandidate.symbol}`);
  }
  
  if (result.decision.shouldRotate) {
    if (result.decision.buyMint) {
      lines.push(`Rotation: SELL ${result.decision.sellSymbol} (rank ${result.decision.sellRank?.toFixed(2)}) -> BUY ${result.decision.buySymbol} (rank ${result.decision.buyRank?.toFixed(2)})`);
    } else {
      lines.push(`Exit: SELL ${result.decision.sellSymbol} (${result.decision.reasonCode})`);
    }
  } else {
    lines.push(`No rotation: ${result.decision.reasonCode}`);
  }
  
  return lines.join(' | ');
}

export type ReasonCode = 
  | 'trailing_stop_exit'
  | 'stale_timeout_exit'
  | 'stale_exit_no_replacement'
  | 'stale_rotation_with_replacement'
  | 'opportunity_cost_rotation'
  | 'scout_to_core_promotion'
  | 'take_profit'
  | 'concentration_rebalance'
  | 'regime_trend_mr'
  | 'reentry_momentum'
  | 'scout_stop_loss_exit'
  | 'core_loss_exit'
  | 'scout_underperform_grace_expired';

export function isValidReasonCode(code: string): code is ReasonCode {
  const validCodes: ReasonCode[] = [
    'trailing_stop_exit',
    'stale_timeout_exit',
    'stale_exit_no_replacement',
    'stale_rotation_with_replacement',
    'opportunity_cost_rotation',
    'scout_to_core_promotion',
    'take_profit',
    'concentration_rebalance',
    'regime_trend_mr',
    'reentry_momentum',
    'scout_stop_loss_exit',
    'core_loss_exit',
    'scout_underperform_grace_expired',
  ];
  return validCodes.includes(code as ReasonCode);
}
