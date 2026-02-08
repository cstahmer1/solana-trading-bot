import { logger } from "../utils/logger.js";
import { SNIPER_CONFIG, type SniperPosition } from "./config.js";
import { getTokenPrice, clearPoolCache } from "./pool_detector.js";
import { executeSniperSell } from "./executor.js";

const activePositions = new Map<string, SniperPosition>();
const closedPositions: SniperPosition[] = [];
let monitorInterval: NodeJS.Timeout | null = null;
let isMonitoring = false;

export function addPosition(position: SniperPosition): void {
  activePositions.set(position.mint, position);
  logger.info({
    mint: position.mint.slice(0, 8),
    symbol: position.symbol,
    entryPriceUsd: position.entryPriceUsd.toFixed(8),
    costBasisSol: position.costBasisSol.toFixed(4),
    quantity: position.tokenQuantity.toFixed(4),
  }, "SNIPER: Position opened");
}

export function getPosition(mint: string): SniperPosition | undefined {
  return activePositions.get(mint);
}

export function getAllPositions(): SniperPosition[] {
  return Array.from(activePositions.values());
}

export function getClosedPositions(): SniperPosition[] {
  return closedPositions;
}

export function removePosition(mint: string): SniperPosition | undefined {
  const position = activePositions.get(mint);
  if (position) {
    activePositions.delete(mint);
    closedPositions.push(position);
  }
  return position;
}

export function hasPosition(mint: string): boolean {
  return activePositions.has(mint);
}

export function getPositionCount(): number {
  return activePositions.size;
}

async function checkAndClosePosition(position: SniperPosition): Promise<void> {
  const currentPriceUsd = await getTokenPrice(position.mint);
  
  if (currentPriceUsd === null) {
    logger.debug({ mint: position.mint.slice(0, 8) }, "SNIPER: Could not fetch price for position");
    return;
  }

  const pnlPct = ((currentPriceUsd - position.entryPriceUsd) / position.entryPriceUsd) * 100;
  
  logger.debug({
    mint: position.mint.slice(0, 8),
    symbol: position.symbol,
    entryPrice: position.entryPriceUsd.toFixed(8),
    currentPrice: currentPriceUsd.toFixed(8),
    pnlPct: pnlPct.toFixed(2),
  }, "SNIPER: Position check");

  if (pnlPct >= SNIPER_CONFIG.takeProfitPct) {
    logger.info({
      mint: position.mint.slice(0, 8),
      symbol: position.symbol,
      pnlPct: pnlPct.toFixed(2),
      target: SNIPER_CONFIG.takeProfitPct,
    }, "SNIPER: Take profit triggered");
    
    await executeSniperSell(position, currentPriceUsd, "take_profit");
    return;
  }

  if (pnlPct <= -SNIPER_CONFIG.stopLossPct) {
    logger.info({
      mint: position.mint.slice(0, 8),
      symbol: position.symbol,
      pnlPct: pnlPct.toFixed(2),
      target: -SNIPER_CONFIG.stopLossPct,
    }, "SNIPER: Stop loss triggered");
    
    await executeSniperSell(position, currentPriceUsd, "stop_loss");
    return;
  }
}

async function monitorPositions(): Promise<void> {
  if (!isMonitoring) return;

  const positions = Array.from(activePositions.values());
  
  if (positions.length === 0) {
    logger.debug("SNIPER: No active positions to monitor");
    return;
  }

  logger.debug({ count: positions.length }, "SNIPER: Monitoring positions");

  for (const position of positions) {
    try {
      await checkAndClosePosition(position);
    } catch (err) {
      logger.error({ err, mint: position.mint.slice(0, 8) }, "SNIPER: Error checking position");
    }
  }
}

export function startMonitoring(): void {
  if (isMonitoring) return;
  
  isMonitoring = true;
  logger.info({ intervalMs: SNIPER_CONFIG.priceCheckIntervalMs }, "SNIPER: Position monitoring started");
  
  monitorInterval = setInterval(async () => {
    try {
      await monitorPositions();
    } catch (err) {
      logger.error({ err }, "SNIPER: Error in position monitor loop");
    }
  }, SNIPER_CONFIG.priceCheckIntervalMs);
}

export function stopMonitoring(): void {
  isMonitoring = false;
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  logger.info("SNIPER: Position monitoring stopped");
}

export function getStats(): {
  activeCount: number;
  closedCount: number;
  totalPnlUsd: number;
  winCount: number;
  lossCount: number;
} {
  let totalPnlUsd = 0;
  let winCount = 0;
  let lossCount = 0;

  for (const pos of closedPositions) {
    if (pos.pnlUsd !== undefined) {
      totalPnlUsd += pos.pnlUsd;
      if (pos.pnlUsd > 0) winCount++;
      else if (pos.pnlUsd < 0) lossCount++;
    }
  }

  return {
    activeCount: activePositions.size,
    closedCount: closedPositions.length,
    totalPnlUsd,
    winCount,
    lossCount,
  };
}

export function clearPositions(): void {
  activePositions.clear();
  clearPoolCache();
  logger.info("SNIPER: All positions cleared");
}
