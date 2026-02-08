import { logger } from "../utils/logger.js";
import { getConfig, type RuntimeConfig } from "./runtime_config.js";
import { getEnhancedTransactions, isHeliusConfigured } from "./helius.js";
import { getTokenPairs } from "./dexscreener.js";

export interface WhaleFlowResult {
  netflowUsd: number;
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  txCount: number;
  largestTxUsd: number;
  timestamp: Date;
}

export interface MarketConfirmation {
  confirmed: boolean;
  netflowUsd: number;
  priceChangePct: number;
  reason: string;
}

export interface ExitSignal {
  shouldExit: boolean;
  netflowUsd: number;
  reason: string;
}

export interface WhaleStatusEntry {
  mint: string;
  netflowUsd: number;
  isPositive: boolean;
  isNegative: boolean;
  lastChecked: Date;
  txCount: number;
}

const whaleStatusCache = new Map<string, WhaleStatusEntry>();

export function getWhaleStatusCache(): Map<string, WhaleStatusEntry> {
  return whaleStatusCache;
}

export function getWhaleStatus(mint: string): WhaleStatusEntry | null {
  return whaleStatusCache.get(mint) || null;
}

function updateWhaleStatusCache(mint: string, netflowUsd: number, txCount: number): void {
  whaleStatusCache.set(mint, {
    mint,
    netflowUsd,
    isPositive: netflowUsd > 0,
    isNegative: netflowUsd < 0,
    lastChecked: new Date(),
    txCount,
  });
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const flowCache = new Map<string, CacheEntry<WhaleFlowResult>>();

function getCached<T>(cache: Map<string, CacheEntry<T>>, key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache<T>(cache: Map<string, CacheEntry<T>>, key: string, data: T, ttlMs: number) {
  cache.set(key, { data, expiresAt: Date.now() + ttlMs });
}

function getDefaultFlowResult(): WhaleFlowResult {
  return {
    netflowUsd: 0,
    buyVolumeUsd: 0,
    sellVolumeUsd: 0,
    txCount: 0,
    largestTxUsd: 0,
    timestamp: new Date(),
  };
}

export async function getTokenNetflow(
  mint: string,
  windowMinutes: number
): Promise<WhaleFlowResult> {
  const config = getConfig();
  const cacheKey = `${mint}:${windowMinutes}`;
  const cacheTtlMs = config.whaleConfirmPollSeconds * 1000;
  
  const cached = getCached(flowCache, cacheKey);
  if (cached) {
    return cached;
  }

  if (!isHeliusConfigured()) {
    logger.debug({ mint }, "Helius not configured, using DexScreener fallback for netflow");
    return await getNetflowFromDexScreener(mint, windowMinutes, cacheTtlMs);
  }

  try {
    const pairs = await getTokenPairs(mint);
    if (!pairs || pairs.length === 0) {
      logger.debug({ mint }, "No pairs found for token");
      const result = getDefaultFlowResult();
      setCache(flowCache, cacheKey, result, cacheTtlMs);
      return result;
    }

    const bestPair = pairs.reduce((best, p) => {
      const bestLiq = best.liquidity?.usd || 0;
      const pLiq = p.liquidity?.usd || 0;
      return pLiq > bestLiq ? p : best;
    }, pairs[0]);

    const priceUsd = parseFloat(bestPair.priceUsd) || 0;
    if (priceUsd <= 0) {
      const result = getDefaultFlowResult();
      setCache(flowCache, cacheKey, result, cacheTtlMs);
      return result;
    }

    const pairAddress = bestPair.pairAddress;
    const txs = await getEnhancedTransactions(pairAddress, { limit: 100 });
    
    if (!txs || txs.length === 0) {
      return await getNetflowFromDexScreener(mint, windowMinutes, cacheTtlMs);
    }

    const cutoffTime = Date.now() - windowMinutes * 60 * 1000;
    let buyVolumeUsd = 0;
    let sellVolumeUsd = 0;
    let txCount = 0;
    let largestTxUsd = 0;

    for (const tx of txs) {
      const txTime = tx.timestamp * 1000;
      if (txTime < cutoffTime) continue;

      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint !== mint) continue;

        const tokenAmount = transfer.tokenAmount || 0;
        const txValueUsd = tokenAmount * priceUsd;

        if (txValueUsd > largestTxUsd) {
          largestTxUsd = txValueUsd;
        }

        const isBuy = transfer.toUserAccount && !transfer.fromUserAccount;
        const isSell = transfer.fromUserAccount && !transfer.toUserAccount;

        if (isBuy || tx.type === "SWAP" && transfer.toUserAccount) {
          buyVolumeUsd += txValueUsd;
        } else if (isSell || tx.type === "SWAP" && transfer.fromUserAccount) {
          sellVolumeUsd += txValueUsd;
        }
        
        txCount++;
      }
    }

    const netflowUsd = buyVolumeUsd - sellVolumeUsd;
    
    const result: WhaleFlowResult = {
      netflowUsd,
      buyVolumeUsd,
      sellVolumeUsd,
      txCount,
      largestTxUsd,
      timestamp: new Date(),
    };

    logger.debug({
      mint: mint.slice(0, 8),
      netflowUsd: netflowUsd.toFixed(2),
      txCount,
      windowMinutes,
    }, "Token netflow calculated");

    setCache(flowCache, cacheKey, result, cacheTtlMs);
    return result;
  } catch (err) {
    logger.error({ err: String(err), mint: mint.slice(0, 8) }, "Failed to calculate token netflow");
    return getDefaultFlowResult();
  }
}

async function getNetflowFromDexScreener(
  mint: string,
  windowMinutes: number,
  cacheTtlMs: number
): Promise<WhaleFlowResult> {
  const cacheKey = `${mint}:${windowMinutes}`;
  
  try {
    const pairs = await getTokenPairs(mint);
    if (!pairs || pairs.length === 0) {
      const result = getDefaultFlowResult();
      setCache(flowCache, cacheKey, result, cacheTtlMs);
      return result;
    }

    const bestPair = pairs.reduce((best, p) => {
      const bestLiq = best.liquidity?.usd || 0;
      const pLiq = p.liquidity?.usd || 0;
      return pLiq > bestLiq ? p : best;
    }, pairs[0]);

    const txns = windowMinutes <= 5 ? bestPair.txns.m5 :
                 windowMinutes <= 60 ? bestPair.txns.h1 :
                 windowMinutes <= 360 ? bestPair.txns.h6 : bestPair.txns.h24;
    
    const volume = windowMinutes <= 5 ? bestPair.volume.m5 :
                   windowMinutes <= 60 ? bestPair.volume.h1 :
                   windowMinutes <= 360 ? bestPair.volume.h6 : bestPair.volume.h24;

    const buys = txns?.buys || 0;
    const sells = txns?.sells || 0;
    const totalTxns = buys + sells;
    
    const buyRatio = totalTxns > 0 ? buys / totalTxns : 0.5;
    const sellRatio = totalTxns > 0 ? sells / totalTxns : 0.5;
    
    const buyVolumeUsd = volume * buyRatio;
    const sellVolumeUsd = volume * sellRatio;
    const netflowUsd = buyVolumeUsd - sellVolumeUsd;

    const result: WhaleFlowResult = {
      netflowUsd,
      buyVolumeUsd,
      sellVolumeUsd,
      txCount: totalTxns,
      largestTxUsd: totalTxns > 0 ? volume / totalTxns : 0,
      timestamp: new Date(),
    };

    setCache(flowCache, cacheKey, result, cacheTtlMs);
    return result;
  } catch (err) {
    logger.error({ err: String(err), mint: mint.slice(0, 8) }, "Failed to get netflow from DexScreener");
    return getDefaultFlowResult();
  }
}

export async function checkMarketConfirmation(
  mint: string,
  config: RuntimeConfig
): Promise<MarketConfirmation> {
  if (!config.whaleConfirmEnabled) {
    return {
      confirmed: true,
      netflowUsd: 0,
      priceChangePct: 0,
      reason: "Whale confirmation disabled",
    };
  }

  try {
    const [flowResult, pairs] = await Promise.all([
      getTokenNetflow(mint, config.whaleWindowMinutes),
      getTokenPairs(mint),
    ]);

    const bestPair = pairs && pairs.length > 0
      ? pairs.reduce((best, p) => {
          const bestLiq = best.liquidity?.usd || 0;
          const pLiq = p.liquidity?.usd || 0;
          return pLiq > bestLiq ? p : best;
        }, pairs[0])
      : null;

    const priceChangePct = bestPair?.priceChange?.h1 || 0;
    const netflowUsd = flowResult.netflowUsd;

    const hasWhaleActivity = flowResult.largestTxUsd >= config.whaleMinUsd;
    const meetsNetflowThreshold = netflowUsd >= config.whaleNetflowTriggerUsd;
    const meetsMarketConfirm = priceChangePct >= config.marketConfirmPct;

    const confirmed = meetsNetflowThreshold && (hasWhaleActivity || meetsMarketConfirm);

    let reason: string;
    if (confirmed) {
      reason = `Confirmed: netflow $${netflowUsd.toFixed(0)}, price +${priceChangePct.toFixed(1)}%`;
    } else if (!meetsNetflowThreshold) {
      reason = `Netflow $${netflowUsd.toFixed(0)} < trigger $${config.whaleNetflowTriggerUsd}`;
    } else if (!hasWhaleActivity && !meetsMarketConfirm) {
      reason = `No whale tx >= $${config.whaleMinUsd} and price change ${priceChangePct.toFixed(1)}% < ${config.marketConfirmPct}%`;
    } else {
      reason = "Confirmation criteria not met";
    }

    logger.debug({
      mint: mint.slice(0, 8),
      confirmed,
      netflowUsd: netflowUsd.toFixed(0),
      priceChangePct: priceChangePct.toFixed(2),
    }, "Market confirmation check");

    updateWhaleStatusCache(mint, netflowUsd, flowResult.txCount);

    return {
      confirmed,
      netflowUsd,
      priceChangePct,
      reason,
    };
  } catch (err) {
    logger.error({ err: String(err), mint: mint.slice(0, 8) }, "Market confirmation check failed");
    return {
      confirmed: false,
      netflowUsd: 0,
      priceChangePct: 0,
      reason: `Error: ${String(err)}`,
    };
  }
}

export async function checkExitSignal(
  mint: string,
  config: RuntimeConfig
): Promise<ExitSignal> {
  if (!config.whaleConfirmEnabled) {
    return {
      shouldExit: false,
      netflowUsd: 0,
      reason: "Whale confirmation disabled",
    };
  }

  try {
    const flowResult = await getTokenNetflow(mint, config.whaleWindowMinutes);
    const netflowUsd = flowResult.netflowUsd;
    
    const shouldExit = netflowUsd <= config.exitNetflowUsd;
    
    let reason: string;
    if (shouldExit) {
      reason = `Exit signal: netflow $${netflowUsd.toFixed(0)} <= threshold $${config.exitNetflowUsd}`;
    } else {
      reason = `No exit signal: netflow $${netflowUsd.toFixed(0)} > threshold $${config.exitNetflowUsd}`;
    }

    logger.debug({
      mint: mint.slice(0, 8),
      shouldExit,
      netflowUsd: netflowUsd.toFixed(0),
      threshold: config.exitNetflowUsd,
    }, "Exit signal check");

    updateWhaleStatusCache(mint, netflowUsd, flowResult.txCount);

    return {
      shouldExit,
      netflowUsd,
      reason,
    };
  } catch (err) {
    logger.error({ err: String(err), mint: mint.slice(0, 8) }, "Exit signal check failed");
    return {
      shouldExit: false,
      netflowUsd: 0,
      reason: `Error: ${String(err)}`,
    };
  }
}

const cooldownCache = new Map<string, Date>();

export function isOnWhaleCooldown(
  mint: string,
  lastActionAt: Date | null,
  cooldownMinutes: number
): boolean {
  const cachedCooldown = cooldownCache.get(mint);
  if (cachedCooldown) {
    const cooldownEnd = new Date(cachedCooldown.getTime() + cooldownMinutes * 60 * 1000);
    if (new Date() < cooldownEnd) {
      const remainingMs = cooldownEnd.getTime() - Date.now();
      logger.debug({
        mint: mint.slice(0, 8),
        remainingMinutes: (remainingMs / 60000).toFixed(1),
      }, "Token on whale cooldown (cache)");
      return true;
    }
  }
  
  if (!lastActionAt) return false;
  
  const cooldownEnd = new Date(lastActionAt.getTime() + cooldownMinutes * 60 * 1000);
  const isOnCooldown = new Date() < cooldownEnd;

  if (isOnCooldown) {
    const remainingMs = cooldownEnd.getTime() - Date.now();
    logger.debug({
      mint: mint.slice(0, 8),
      remainingMinutes: (remainingMs / 60000).toFixed(1),
    }, "Token on whale cooldown");
  }

  return isOnCooldown;
}

export function setWhaleCooldown(mint: string): void {
  cooldownCache.set(mint, new Date());
  logger.debug({ mint: mint.slice(0, 8) }, "Whale cooldown set");
}

export function clearFlowCache(): void {
  flowCache.clear();
}

// Clear all whale-related caches for complete reset
export function clearAllWhaleCaches(): void {
  flowCache.clear();
  cooldownCache.clear();
  whaleStatusCache.clear();
  logger.info({}, "Cleared all whale caches (flow, cooldown, status)");
}
