import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import { 
  upsertExitedTokenCache, 
  getExitedTokenCache, 
  isTokenInCooldown,
  incrementReentryCount,
  removeTokenFromUniverse,
  addTokenToUniverse,
  getPositionTracking,
  removePositionTracking,
} from "./persist.js";
import { MINT_SOL, MINT_USDC } from "./config.js";

export interface TokenState {
  mint: string;
  symbol?: string;
  positionUsd: number;
  hasPendingOrder?: boolean;
  slotType?: 'core' | 'scout' | null;
  isQueued?: boolean;
}

export interface ExitContext {
  reason: string;
  pnlUsd?: number;
  pnlPct?: number;
  lastPrice?: number;
  lastSignal?: number;
  lastLiquidityUsd?: number;
}

export function shouldBeActiveUniverse(state: TokenState): boolean {
  const config = getConfig();
  const dustThreshold = config.dustThresholdUsd;

  if (state.mint === MINT_SOL || state.mint === MINT_USDC) {
    return true;
  }

  if (state.positionUsd > dustThreshold) {
    return true;
  }

  if (state.hasPendingOrder) {
    return true;
  }

  if (state.slotType === 'core' || state.slotType === 'scout') {
    return true;
  }

  if (state.isQueued) {
    return true;
  }

  return false;
}

export async function handleTokenExit(
  mint: string,
  symbol: string | undefined,
  context: ExitContext
): Promise<boolean> {
  if (mint === MINT_SOL || mint === MINT_USDC) {
    return false;
  }

  const config = getConfig();
  const cooldownHours = config.scoutTokenCooldownHours;
  const telemetryHours = config.telemetryRetentionHours;

  const cooldownUntil = new Date(Date.now() + cooldownHours * 60 * 60 * 1000);

  const success = await removeTokenFromUniverse(mint);
  if (!success) {
    logger.warn({ mint }, "UNIVERSE_EXIT: Failed to deactivate token in universe");
    return false;
  }

  await upsertExitedTokenCache({
    mint,
    symbol,
    exitReason: context.reason,
    exitPnlUsd: context.pnlUsd,
    exitPnlPct: context.pnlPct,
    cooldownUntil,
    lastKnownPrice: context.lastPrice,
    lastKnownSignal: context.lastSignal,
    lastKnownLiquidityUsd: context.lastLiquidityUsd,
    telemetryRetentionHours: telemetryHours,
  });

  await removePositionTracking(mint);

  logger.info({
    mint,
    symbol,
    reason: context.reason,
    pnlUsd: context.pnlUsd,
    pnlPct: context.pnlPct,
    cooldownUntil: cooldownUntil.toISOString(),
    telemetryHours,
  }, "UNIVERSE_REMOVE_ON_EXIT");

  return true;
}

export async function checkReentryEligibility(mint: string): Promise<{
  eligible: boolean;
  reason: string;
  timesReentered?: number;
}> {
  const cached = await getExitedTokenCache(mint);

  if (!cached) {
    return { eligible: true, reason: "never_exited" };
  }

  const inCooldown = await isTokenInCooldown(mint);
  if (inCooldown) {
    return { 
      eligible: false, 
      reason: "in_cooldown", 
      timesReentered: cached.times_reentered 
    };
  }

  return { 
    eligible: true, 
    reason: "cooldown_expired", 
    timesReentered: cached.times_reentered 
  };
}

export async function handleTokenReentry(
  mint: string,
  symbol: string,
  source: string,
  slotType: 'scout' | 'core' = 'scout'
): Promise<boolean> {
  const eligibility = await checkReentryEligibility(mint);
  
  if (!eligibility.eligible) {
    logger.info({
      mint,
      symbol,
      reason: eligibility.reason,
      timesReentered: eligibility.timesReentered,
    }, "REENTRY_BLOCKED");
    return false;
  }

  const success = await addTokenToUniverse({ mint, symbol, source });
  if (!success) {
    logger.warn({ mint, symbol }, "REENTRY: Failed to add token back to universe");
    return false;
  }

  await incrementReentryCount(mint);

  logger.info({
    mint,
    symbol,
    source,
    slotType,
    timesReentered: (eligibility.timesReentered ?? 0) + 1,
  }, "UNIVERSE_ADD_ON_REENTRY");

  return true;
}

export async function reconcileUniverseMembership(
  positions: { mint: string; symbol?: string; usdValue: number }[],
  slotTypeMap: Map<string, 'core' | 'scout'>,
  pendingOrders: Set<string> = new Set(),
  queuedMints: Set<string> = new Set()
): Promise<{ removed: string[]; kept: string[] }> {
  const removed: string[] = [];
  const kept: string[] = [];
  const config = getConfig();

  for (const pos of positions) {
    if (pos.mint === MINT_SOL || pos.mint === MINT_USDC) {
      kept.push(pos.mint);
      continue;
    }

    const state: TokenState = {
      mint: pos.mint,
      symbol: pos.symbol,
      positionUsd: pos.usdValue,
      hasPendingOrder: pendingOrders.has(pos.mint),
      slotType: slotTypeMap.get(pos.mint) ?? null,
      isQueued: queuedMints.has(pos.mint),
    };

    if (shouldBeActiveUniverse(state)) {
      kept.push(pos.mint);
    } else {
      const tracking = await getPositionTracking(pos.mint);
      const exitResult = await handleTokenExit(pos.mint, pos.symbol, {
        reason: "dust_exit",
        pnlUsd: undefined,
        pnlPct: undefined,
        lastPrice: tracking?.last_price ? Number(tracking.last_price) : undefined,
      });
      
      if (exitResult) {
        removed.push(pos.mint);
      } else {
        kept.push(pos.mint);
      }
    }
  }

  if (removed.length > 0) {
    logger.info({
      removedCount: removed.length,
      keptCount: kept.length,
      removed,
    }, "ALLOCATION_ELIGIBLE_SET");
  }

  return { removed, kept };
}

export function filterActiveUniverseOnly<T extends { mint: string }>(
  candidates: T[],
  activeUniverseMints: Set<string>
): T[] {
  const filtered = candidates.filter(c => {
    if (c.mint === MINT_SOL || c.mint === MINT_USDC) return true;
    return activeUniverseMints.has(c.mint);
  });
  
  const excludedCount = candidates.length - filtered.length;
  if (excludedCount > 0) {
    logger.debug({
      totalCandidates: candidates.length,
      filteredCandidates: filtered.length,
      excludedCount,
    }, "ALLOCATION_DILUTION_GUARD");
  }
  
  return filtered;
}
