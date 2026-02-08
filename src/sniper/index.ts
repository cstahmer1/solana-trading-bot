import { fetch } from "undici";
import { logger } from "../utils/logger.js";
import { getHeliusApiKey, getHeliusRpcUrl } from "./config.js";
import { 
  connect as wsConnect, 
  disconnect as wsDisconnect, 
  onNewToken, 
  onNewPool,
  isConnected,
  getSubscriptionCount,
} from "./helius_ws.js";
import { 
  startMonitoring, 
  stopMonitoring, 
  getAllPositions, 
  getClosedPositions,
  getStats,
  clearPositions,
} from "./position_tracker.js";
import { executeSniperBuy } from "./executor.js";
import { SNIPER_CONFIG, type DetectedToken } from "./config.js";

let isRunning = false;
const pendingTokens = new Map<string, DetectedToken>();
const processedTokens = new Set<string>();
const recentMints = new Map<string, number>(); // mint -> timestamp when InitializeMint was seen
const checkedMints = new Map<string, { fresh: boolean; checkedAt: number }>(); // RPC check results cache
const DEDUP_WINDOW_MS = 60_000;
const RECENT_MINT_WINDOW_MS = 5 * 60_000; // 5 minutes - only buy pools for tokens created in last 5 min
const MAX_TOKEN_AGE_MS = 10 * 60_000; // 10 minutes - tokens older than this are considered "old"
const CHECKED_MINT_CACHE_TTL = 5 * 60_000; // Cache RPC results for 5 minutes

// Metrics for monitoring
let metrics = {
  cacheHits: 0,
  rpcChecks: 0,
  rpcFresh: 0,
  rpcOld: 0,
  rpcErrors: 0,
  skipped: 0,
  executed: 0,
};

async function checkMintFreshness(mint: string): Promise<{ isFresh: boolean; ageMs?: number }> {
  const cached = checkedMints.get(mint);
  if (cached && (Date.now() - cached.checkedAt) < CHECKED_MINT_CACHE_TTL) {
    return { isFresh: cached.fresh };
  }

  const rpcUrl = getHeliusRpcUrl();
  if (!rpcUrl) {
    logger.warn({ mint: mint.slice(0, 8) }, "SNIPER: No RPC URL for freshness check");
    return { isFresh: false };
  }

  try {
    metrics.rpcChecks++;
    
    const response = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getSignaturesForAddress",
        params: [
          mint,
          { limit: 1 }
        ],
      }),
    });

    const data = (await response.json()) as { result?: Array<{ blockTime?: number; signature?: string }> };
    
    if (!data.result || data.result.length === 0) {
      logger.info({ mint: mint.slice(0, 8) }, "SNIPER: No signatures found for mint - treating as FRESH (brand new)");
      checkedMints.set(mint, { fresh: true, checkedAt: Date.now() });
      metrics.rpcFresh++;
      return { isFresh: true, ageMs: 0 };
    }

    const firstSig = data.result[0];
    const blockTime = firstSig.blockTime;
    
    if (!blockTime) {
      logger.info({ mint: mint.slice(0, 8) }, "SNIPER: No blockTime in signature - treating as FRESH");
      checkedMints.set(mint, { fresh: true, checkedAt: Date.now() });
      metrics.rpcFresh++;
      return { isFresh: true, ageMs: 0 };
    }

    const tokenAgeMs = Date.now() - (blockTime * 1000);
    const isFresh = tokenAgeMs < MAX_TOKEN_AGE_MS;

    logger.info({
      mint: mint.slice(0, 8),
      tokenAgeMs,
      tokenAgeSec: Math.round(tokenAgeMs / 1000),
      isFresh,
      threshold: MAX_TOKEN_AGE_MS / 1000,
    }, `SNIPER: RPC freshness check - token is ${isFresh ? 'FRESH' : 'OLD'}`);

    checkedMints.set(mint, { fresh: isFresh, checkedAt: Date.now() });
    
    if (isFresh) {
      metrics.rpcFresh++;
    } else {
      metrics.rpcOld++;
    }

    return { isFresh, ageMs: tokenAgeMs };
  } catch (err) {
    logger.error({ err, mint: mint.slice(0, 8) }, "SNIPER: RPC freshness check failed");
    metrics.rpcErrors++;
    return { isFresh: false };
  }
}

function cleanCheckedMintsCache(): void {
  const now = Date.now();
  for (const [mint, data] of checkedMints.entries()) {
    if (now - data.checkedAt > CHECKED_MINT_CACHE_TTL) {
      checkedMints.delete(mint);
    }
  }
}

async function handleNewToken(token: DetectedToken): Promise<void> {
  recentMints.set(token.mint, Date.now());
  
  setTimeout(() => {
    recentMints.delete(token.mint);
  }, RECENT_MINT_WINDOW_MS);

  if (processedTokens.has(token.mint)) {
    logger.debug({ mint: token.mint.slice(0, 8) }, "SNIPER: Token already processed (dedup)");
    return;
  }

  pendingTokens.set(token.mint, token);
  processedTokens.add(token.mint);

  setTimeout(() => {
    processedTokens.delete(token.mint);
  }, DEDUP_WINDOW_MS);

  logger.info({
    mint: token.mint.slice(0, 8),
    signature: token.signature.slice(0, 16),
    slot: token.slot,
  }, "SNIPER: New token mint detected (InitializeMint), added to recent cache and queuing buy");

  try {
    await executeSniperBuy(token);
  } catch (err) {
    logger.error({ err, mint: token.mint.slice(0, 8) }, "SNIPER: Error executing buy");
  } finally {
    pendingTokens.delete(token.mint);
  }
}

async function handleNewPool(data: { mint: string; poolAddress: string; signature: string }): Promise<void> {
  cleanCheckedMintsCache();
  
  if (processedTokens.has(data.mint)) {
    logger.debug({ mint: data.mint.slice(0, 8) }, "SNIPER: Pool token already processed");
    return;
  }

  const mintSeenAt = recentMints.get(data.mint);
  let isFresh = false;
  let ageMs = 0;
  let source = "";

  if (mintSeenAt && (Date.now() - mintSeenAt) < RECENT_MINT_WINDOW_MS) {
    isFresh = true;
    ageMs = Date.now() - mintSeenAt;
    source = "cache";
    metrics.cacheHits++;
    logger.info({
      mint: data.mint.slice(0, 8),
      ageMs,
      source,
    }, "SNIPER: Mint found in recent cache - FRESH");
  } else {
    logger.info({
      mint: data.mint.slice(0, 8),
      poolAddress: data.poolAddress?.slice(0, 8),
    }, "SNIPER: Mint not in cache, performing RPC freshness check...");
    
    const freshness = await checkMintFreshness(data.mint);
    isFresh = freshness.isFresh;
    ageMs = freshness.ageMs || 0;
    source = "rpc";
  }

  if (!isFresh) {
    metrics.skipped++;
    logger.info({
      mint: data.mint.slice(0, 8),
      poolAddress: data.poolAddress?.slice(0, 8),
      signature: data.signature.slice(0, 16),
      ageMs,
      source,
      metrics,
    }, "SNIPER: Pool detected but token is OLD - SKIPPING");
    return;
  }

  processedTokens.add(data.mint);
  setTimeout(() => {
    processedTokens.delete(data.mint);
  }, DEDUP_WINDOW_MS);

  metrics.executed++;
  logger.info({
    mint: data.mint.slice(0, 8),
    poolAddress: data.poolAddress?.slice(0, 8),
    signature: data.signature.slice(0, 16),
    ageMs,
    source,
    metrics,
  }, "SNIPER: Pool creation for FRESH token detected - EXECUTING BUY");

  const token: DetectedToken = {
    mint: data.mint,
    signature: data.signature,
    slot: 0,
    timestamp: new Date(),
    poolAddress: data.poolAddress,
  };

  try {
    await executeSniperBuy(token, true);
  } catch (err) {
    logger.error({ err, mint: data.mint.slice(0, 8) }, "SNIPER: Error executing pool buy");
  }
}

export async function startSniper(): Promise<boolean> {
  if (isRunning) {
    logger.warn("SNIPER: Already running");
    return true;
  }

  const apiKey = getHeliusApiKey();
  if (!apiKey) {
    logger.error("SNIPER: Cannot start - Helius API key not configured in SOLANA_RPC_URL");
    return false;
  }

  logger.info({
    buyAmountSol: SNIPER_CONFIG.buyAmountSol,
    takeProfitPct: SNIPER_CONFIG.takeProfitPct,
    stopLossPct: SNIPER_CONFIG.stopLossPct,
    maxPositions: SNIPER_CONFIG.maxConcurrentPositions,
  }, "SNIPER: Starting sniper module");

  onNewToken(handleNewToken);
  onNewPool(handleNewPool);

  const connected = await wsConnect();
  if (!connected) {
    logger.error("SNIPER: Failed to connect WebSocket");
    return false;
  }

  startMonitoring();

  isRunning = true;
  logger.info("SNIPER: Module started successfully");
  return true;
}

export function stopSniper(): void {
  if (!isRunning) {
    logger.warn("SNIPER: Not running");
    return;
  }

  stopMonitoring();
  wsDisconnect();
  
  isRunning = false;
  logger.info("SNIPER: Module stopped");
}

export function getSniperStatus(): {
  running: boolean;
  connected: boolean;
  subscriptions: number;
  activePositions: number;
  closedPositions: number;
  pendingTokens: number;
  config: typeof SNIPER_CONFIG;
  stats: ReturnType<typeof getStats>;
} {
  return {
    running: isRunning,
    connected: isConnected(),
    subscriptions: getSubscriptionCount(),
    activePositions: getAllPositions().length,
    closedPositions: getClosedPositions().length,
    pendingTokens: pendingTokens.size,
    config: SNIPER_CONFIG,
    stats: getStats(),
  };
}

export function getSniperPositions(): {
  active: ReturnType<typeof getAllPositions>;
  closed: ReturnType<typeof getClosedPositions>;
} {
  return {
    active: getAllPositions(),
    closed: getClosedPositions(),
  };
}

export function resetSniper(): void {
  clearPositions();
  pendingTokens.clear();
  processedTokens.clear();
  logger.info("SNIPER: Reset complete");
}

export { 
  SNIPER_CONFIG,
  type SniperPosition,
  type DetectedToken,
} from "./config.js";
