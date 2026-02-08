import { logger } from "../utils/logger.js";
import { getConfig } from "./runtime_config.js";
import { MINT_SOL } from "./config.js";

export interface OrphanInfo {
  mint: string;
  symbol: string;
  usdValue: number;
  ticksMissing: number;
  firstMissingAt: Date;
  lastManaged?: Date;
}

export interface OrphanScanResult {
  orphans: OrphanInfo[];
  readyForExit: OrphanInfo[];
  unmanagedHeldCount: number;
  unmanagedHeldUsd: number;
}

const orphanTickCounts = new Map<string, { ticksMissing: number; firstMissingAt: Date; symbol: string; lastUsdValue: number }>();

export function updateOrphanTracking(
  walletHoldings: { mint: string; symbol: string; usdValue: number }[],
  targetMints: Set<string>,
  minTradeUsd: number
): OrphanScanResult {
  const config = getConfig();
  const graceTicks = config.orphanExitGraceTicks;
  
  const readyForExit: OrphanInfo[] = [];
  const orphans: OrphanInfo[] = [];
  let unmanagedHeldCount = 0;
  let unmanagedHeldUsd = 0;

  const currentHeldMints = new Set<string>();

  for (const holding of walletHoldings) {
    if (holding.mint === MINT_SOL) continue;
    if (holding.usdValue < minTradeUsd) continue;

    currentHeldMints.add(holding.mint);

    if (!targetMints.has(holding.mint)) {
      unmanagedHeldCount++;
      unmanagedHeldUsd += holding.usdValue;
      
      const existing = orphanTickCounts.get(holding.mint);
      if (existing) {
        existing.ticksMissing++;
        existing.lastUsdValue = holding.usdValue;
        existing.symbol = holding.symbol;
      } else {
        orphanTickCounts.set(holding.mint, {
          ticksMissing: 1,
          firstMissingAt: new Date(),
          symbol: holding.symbol,
          lastUsdValue: holding.usdValue,
        });
      }

      const tracker = orphanTickCounts.get(holding.mint)!;
      const orphanInfo: OrphanInfo = {
        mint: holding.mint,
        symbol: tracker.symbol,
        usdValue: tracker.lastUsdValue,
        ticksMissing: tracker.ticksMissing,
        firstMissingAt: tracker.firstMissingAt,
      };

      orphans.push(orphanInfo);

      if (tracker.ticksMissing >= graceTicks) {
        readyForExit.push(orphanInfo);
        logger.warn({
          mint: holding.mint,
          symbol: tracker.symbol,
          usdValue: tracker.lastUsdValue,
          ticksMissing: tracker.ticksMissing,
          graceTicks,
          firstMissingAt: tracker.firstMissingAt.toISOString(),
        }, "ORPHAN_READY_FOR_EXIT: Position held but not in target universe for grace period");
      } else {
        logger.info({
          mint: holding.mint,
          symbol: tracker.symbol,
          usdValue: tracker.lastUsdValue,
          ticksMissing: tracker.ticksMissing,
          graceTicks,
          ticksRemaining: graceTicks - tracker.ticksMissing,
        }, "ORPHAN_TRACKING: Position missing from targets (waiting for grace period)");
      }
    } else {
      if (orphanTickCounts.has(holding.mint)) {
        const prev = orphanTickCounts.get(holding.mint)!;
        logger.info({
          mint: holding.mint,
          symbol: holding.symbol,
          ticksWasMissing: prev.ticksMissing,
        }, "ORPHAN_RESOLVED: Position back in target universe");
        orphanTickCounts.delete(holding.mint);
      }
    }
  }

  for (const [mint] of orphanTickCounts) {
    if (!currentHeldMints.has(mint)) {
      orphanTickCounts.delete(mint);
    }
  }

  if (unmanagedHeldCount > 0) {
    logger.info({
      unmanagedHeldCount,
      unmanagedHeldUsd: unmanagedHeldUsd.toFixed(2),
      orphansPending: orphans.length - readyForExit.length,
      orphansReadyForExit: readyForExit.length,
    }, "ORPHAN_TELEMETRY: Unmanaged held positions summary");
  }

  return {
    orphans,
    readyForExit,
    unmanagedHeldCount,
    unmanagedHeldUsd,
  };
}

export function clearOrphanTracking(mint: string): void {
  if (orphanTickCounts.has(mint)) {
    logger.debug({ mint }, "Cleared orphan tracking for mint");
    orphanTickCounts.delete(mint);
  }
}

export function clearAllOrphanTracking(): void {
  const count = orphanTickCounts.size;
  orphanTickCounts.clear();
  if (count > 0) {
    logger.info({ clearedCount: count }, "Cleared all orphan tracking data");
  }
}

export function getOrphanTrackingState(): Map<string, { ticksMissing: number; firstMissingAt: Date; symbol: string; lastUsdValue: number }> {
  return new Map(orphanTickCounts);
}
